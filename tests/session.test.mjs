// Tests for app/js/net/session.js's state machine: join, leave, a host
// disappearing mid-session, plus the content-hash refusal and digest ->
// resync repair path that make "silent dropping is safe" true.
//
// NetSession takes an injected `link` ({send(to,msg), close()}), which is the
// whole point of the design (see session.js's header) - this file's Hub is a
// small in-memory router standing in for real sockets, and every session runs
// against a virtual clock so timing-sensitive behaviour (rate limits, the
// heartbeat, resync) is exact rather than flaky.

import assert from 'node:assert/strict';
import { NetSession } from '../app/js/net/session.js';
import { EditLog } from '../app/js/editlog.js';
import { contentHash, HEARTBEAT_S } from '../app/js/net/protocol.js';

// -------------------------------------------------------------------- runner
let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok    ${name}`); }
  catch (e) { fail++; failures.push([name, e]); console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

console.log('\nsession.test.mjs\n');

// ------------------------------------------------------------------- Hub
// A minimal stand-in for lan.js + preload's ipcLink(): frames are queued per
// endpoint and only actually delivered on flush(), so tests control ordering
// exactly the way the spec's convergence proof does with its own LoopHub.
// `to` follows the real IPC contract - a specific peer id, or the strings
// 'all' / 'others' - resolved against every OTHER attached endpoint, which is
// exactly what those strings mean from a single sender's point of view.
class Hub {
  constructor() {
    this.byName = new Map();   // name -> {id, session, queue}
    this.idToName = new Map(); // transport id -> name
  }

  attach(name, id, session) {
    this.byName.set(name, { id, session, queue: [] });
    this.idToName.set(id, name);
  }

  link(name) {
    return {
      send: (to, msg) => this.byName.get(name).queue.push({ to, msg: structuredClone(msg) }),
      close: () => {},
    };
  }

  /** Deliver up to `n` queued frames, round-robin across endpoints. Returns the count delivered. */
  flush(n = Infinity) {
    let delivered = 0, progress = true;
    while (delivered < n && progress) {
      progress = false;
      for (const [name, ep] of this.byName) {
        if (delivered >= n || !ep.queue.length) continue;
        const { to, msg } = ep.queue.shift();
        this._route(name, ep.id, to, msg);
        delivered++; progress = true;
      }
    }
    return delivered;
  }

  _route(fromName, fromId, to, msg) {
    const targets = (to === 'all' || to === 'others')
      ? [...this.byName.keys()].filter((n) => n !== fromName)
      : [this.idToName.get(to)].filter(Boolean);
    for (const name of targets) this.byName.get(name).session.handle(fromId, msg);
  }
}

/** A virtual clock: `now()` reads it, `tick(ms)` advances it. Both roles' `now` share one clock per test. */
function clock(start = 0) {
  let t = start;
  const now = () => t;
  now.tick = (ms) => { t += ms; };
  return now;
}

/** Wires one host + N guest NetSessions onto a fresh Hub, with real EditLogs behind hooks.applyEdit/digest. */
function makeWorld(guestCount, { now = clock() } = {}) {
  const hub = new Hub();
  const hostLog = new EditLog();
  const events = { hostJoins: [], hostLeaves: [], guestDisconnects: {} };

  const hostHooks = {
    snapshot: () => ({ seed: 20260821, mode: 'survival', time: 300, spawn: { x: 0.5, y: 64, z: 0.5 }, edits: hostLog.serialize(), stations: { furnaces: [], life: [] }, drops: [] }),
    applyEdit: (x, y, z, id) => hostLog.set(x, y, z, id),
    digest: () => hostLog.digest,
    playerState: () => ({ x: 0.5, y: 64, z: 0.5, yaw: 0, pitch: 0, f: 1 }),
    onPeerJoin: (id, name) => events.hostJoins.push({ id, name }),
    onPeerLeave: (id, reason) => events.hostLeaves.push({ id, reason }),
  };
  const host = new NetSession({ role: 'host', link: hub.link('host'), hooks: hostHooks, now, worldUid: 'uid1', hostName: 'Jan', planetId: 'luna' });
  hub.attach('host', 0, host);

  const guests = [];
  for (let i = 0; i < guestCount; i++) {
    const name = 'guest' + i;
    const id = i + 1;
    const log = new EditLog();
    const welcomes = [];
    const disconnects = [];
    const leaves = [];
    const hooks = {
      onWelcome: (w) => welcomes.push(w),
      applyEdit: (x, y, z, eid) => log.set(x, y, z, eid),
      digest: () => log.digest,
      onDisconnect: (reason) => disconnects.push(reason),
      onPeerLeave: (pid, reason) => leaves.push({ id: pid, reason }),
    };
    const session = new NetSession({ role: 'client', link: hub.link(name), hooks, now });
    hub.attach(name, id, session);
    guests.push({ name, id, session, log, welcomes, disconnects, leaves });
  }

  /** Simulates the transport delivering a guest's `hello` straight to the host. */
  const helloFrom = (guest, opts = {}) => host.handle(guest.id, {
    t: 'hello', proto: 1, hash: contentHash(), name: guest.name, code: null, ...opts,
  });

  return { hub, host, hostLog, events, guests, now, helloFrom };
}

// ---------------------------------------------------------------------- join

t('join: hello -> welcome, host.players and the guest session converge', () => {
  const { hub, host, hostLog, events, guests, helloFrom } = makeWorld(1);
  const g = guests[0];
  host.peerConnected(g.id, '192.168.1.50');
  helloFrom(g);
  hub.flush();

  assert.equal(g.welcomes.length, 1);
  assert.equal(g.welcomes[0].i, g.id);
  assert.equal(g.welcomes[0].worldUid, 'uid1');
  assert.equal(g.welcomes[0].hostName, 'Jan');
  assert.equal(g.welcomes[0].planetId, 'luna');
  assert.equal(g.welcomes[0].seed, 20260821);
  assert.equal(g.welcomes[0].digest, hostLog.digest);
  assert.equal(g.session.selfId, g.id);

  assert.deepEqual([...host.players.keys()], [g.id]);
  assert.equal(host.players.get(g.id).name, g.name);
  assert.deepEqual(events.hostJoins, [{ id: g.id, name: g.name }]);

  // The guest's welcome carried the host's live position (id 0) - it should
  // already be in the guest's own players map, ready for an avatar.
  assert.deepEqual([...g.session.players.keys()], [0]);
});

t('join: a second guest sees the first one, via welcome.players', () => {
  const { host, guests, helloFrom, hub } = makeWorld(2);
  helloFrom(guests[0]); hub.flush();
  // guest0 sends a move so it has a live position by the time guest1 joins.
  guests[0].session.sendMove({ pos: { x: 3, y: 64, z: 3 }, yaw: 0, pitch: 0 }, 1);
  hub.flush();
  host.tick();
  hub.flush();

  helloFrom(guests[1]); hub.flush();
  const w = guests[1].welcomes[0];
  const ids = w.players.map((p) => p.i).sort();
  assert.deepEqual(ids, [0, 1]);
});

t('join: wrong content hash refuses the join with no welcome', () => {
  const { host, guests, hub } = makeWorld(1);
  const g = guests[0];
  host.handle(g.id, { t: 'hello', proto: 1, hash: 'deadbeef', name: g.name, code: null });
  hub.flush();
  assert.equal(g.welcomes.length, 0, 'no welcome for a mismatched build');
  assert.equal(host.players.size, 0);
});

t('join: a bad join code refuses the join', () => {
  const hub = new Hub();
  const host = new NetSession({
    role: 'host', link: hub.link('host'), code: 'friends-only',
    hooks: { snapshot: () => ({}), digest: () => '00000000', playerState: () => null },
  });
  hub.attach('host', 0, host);
  const welcomes = [];
  const guest = new NetSession({ role: 'client', link: hub.link('g'), hooks: { onWelcome: (w) => welcomes.push(w) } });
  hub.attach('g', 1, guest);

  host.handle(1, { t: 'hello', proto: 1, hash: contentHash(), name: 'x', code: 'wrong' });
  hub.flush();
  assert.equal(welcomes.length, 0);
  assert.equal(host.players.size, 0);
});

// --------------------------------------------------------------------- leave

t('leave: host.peerGone removes the peer, fires onPeerLeave, and every remaining guest sees `left`', () => {
  const { host, events, guests, helloFrom, hub } = makeWorld(2);
  helloFrom(guests[0]); helloFrom(guests[1]);
  hub.flush();
  assert.deepEqual([...host.players.keys()].sort(), [1, 2]);

  host.peerGone(guests[0].id, 'disconnected');
  assert.equal(host.players.has(guests[0].id), false, 'removed synchronously, before any flush');
  assert.deepEqual(events.hostLeaves, [{ id: guests[0].id, reason: 'disconnected' }]);

  hub.flush();
  assert.deepEqual(guests[1].leaves, [{ id: guests[0].id, reason: 'disconnected' }]);
  assert.equal(guests[1].session.players.has(guests[0].id), false);
  // The peer who left never receives their own `left` (nothing left to tell them).
  assert.equal(guests[0].leaves.length, 0);
});

t('leave: a released furnace lock is not silently kept by a peer who left', () => {
  const { host, guests, helloFrom, hub } = makeWorld(1);
  const g = guests[0];
  helloFrom(g); hub.flush();
  g.session.openFurnace('1,2,3');
  hub.flush();
  assert.equal(host._furnaceLocks.get('1,2,3').peer, g.id);

  host.peerGone(g.id, 'disconnected');
  assert.equal(host._furnaceLocks.has('1,2,3'), false);
});

t('leave: a silent peer past the timeout is dropped and told apart from a clean disconnect', () => {
  const now = clock();
  const { host, events, guests, helloFrom, hub } = makeWorld(1, { now });
  helloFrom(guests[0]); hub.flush();

  now.tick(20000);            // no pong ever arrives
  host.tick();
  assert.deepEqual(events.hostLeaves, [{ id: guests[0].id, reason: 'timeout' }]);
  assert.equal(host.players.size, 0);
});

// ---------------------------------------------------- host disappearing mid-session

t('host-gone: close() fires onDisconnect exactly once and is safe to call again', () => {
  const { guests, host, helloFrom, hub } = makeWorld(1);
  helloFrom(guests[0]); hub.flush();
  const g = guests[0];

  g.session.close('host-gone');
  assert.deepEqual(g.disconnects, ['host-gone']);

  g.session.close('host-gone');   // e.g. a second transport event racing the first
  assert.deepEqual(g.disconnects, ['host-gone'], 'onDisconnect must not fire twice');
});

t('host-gone: the guest keeps its full local mirror - close() never touches the EditLog', () => {
  const { guests, host, hostLog, helloFrom, hub } = makeWorld(1);
  const g = guests[0];
  helloFrom(g); hub.flush();

  hostLog.set(2, 64, 2, 7);
  host.sendEdit(2, 64, 2, 7, 0);
  host.tick();
  hub.flush();
  const digestBefore = g.log.digest;
  assert.equal(digestBefore, hostLog.digest, 'converged before the host vanished');

  g.session.close('host-gone');
  assert.equal(g.log.digest, digestBefore, 'the guest still has everything it built - nothing was cleared');
  assert.equal(g.log.get(2, 64, 2), 7);
});

t('host-gone: outbound calls on a closed client session are inert, not thrown', () => {
  const { guests, helloFrom, hub } = makeWorld(1);
  const g = guests[0];
  helloFrom(g); hub.flush();
  g.session.close('host-gone');

  assert.doesNotThrow(() => {
    g.session.sendMove({ pos: { x: 1, y: 1, z: 1 }, yaw: 0, pitch: 0 }, 0);
    g.session.sendEdit(0, 1, 0, 1, 0);
    g.session.sendChat('hello?');
    g.session.handle(0, { t: 'welcome', i: 1, players: [] });   // late frame after teardown
  });
  assert.equal(g.disconnects.length, 1, 'a second, redundant teardown must not re-fire the hook');
});

t('host-gone: a host closing its own session is inert too (no peer to notify from nothing)', () => {
  const { host, guests, helloFrom, hub } = makeWorld(1);
  helloFrom(guests[0]); hub.flush();
  assert.doesNotThrow(() => host.close('unhosting'));
  assert.doesNotThrow(() => host.tick());
});

// -------------------------------------------------------- digest -> resync

t('digest: two consecutive mismatches with no edit in flight trigger a resync request', () => {
  const now = clock();
  const { host, guests, hostLog, helloFrom, hub } = makeWorld(1, { now });
  const g = guests[0];
  helloFrom(g); hub.flush();

  // Diverge the guest's log from the host's without ever sending an edit -
  // exactly the "a frame was silently dropped" scenario the heartbeat exists
  // to catch, since a real drop looks identical to this from the guest's side.
  g.log.set(9, 9, 9, 9);
  hostLog.set(1, 1, 1, 1);

  let resyncs = 0;
  const origSend = g.session.link.send;
  g.session.link.send = (to, msg) => { if (msg.t === 'resync') resyncs++; origSend(to, msg); };

  now.tick(HEARTBEAT_S * 1000);
  host.tick(); hub.flush();
  assert.equal(resyncs, 0, 'one mismatch alone must not resync - it could just be an echo in flight');

  now.tick(HEARTBEAT_S * 1000);
  host.tick(); hub.flush();
  assert.equal(resyncs, 1);
});

t('digest: onResyncNeeded delivers a fresh snapshot and clears the pending-edit buffer', () => {
  const { host, guests, helloFrom, hub } = makeWorld(1);
  const g = guests[0];
  helloFrom(g); hub.flush();

  let snapshot = null;
  g.session.hooks.onResyncNeeded = (payload) => { snapshot = payload; };
  g.session._pendingEdits.push([0, 1, 0, 2, 0]);   // pretend something was mid-flight

  host.handle(g.id, { t: 'resync' });
  hub.flush();

  assert.ok(snapshot, 'onResyncNeeded must fire');
  assert.equal(snapshot.t, 'snapshot');
  assert.equal(snapshot.seed, 20260821);
  assert.equal(g.session._pendingEdits.length, 0);
});

// ----------------------------------------------------------- id trust / rate

t('id stamping: a guest cannot claim another id - the transport-provided `from` always wins', () => {
  const { host, guests, helloFrom, hub } = makeWorld(1);
  const g = guests[0];
  helloFrom(g); hub.flush();

  host.handle(g.id, { t: 'move', i: 99, x: 5, y: 64, z: 5, yaw: 0, pitch: 0, f: 0 });
  const rec = host.players.get(g.id);
  assert.equal(rec.buf.length, 1, 'the sample landed under the real id');
  assert.equal(host.players.has(99), false, 'no ghost player was created under the spoofed id');
});

t('rate limit: a burst of edits from one peer is capped, not all silently applied', () => {
  const { host, guests, helloFrom, hub } = makeWorld(1);
  const g = guests[0];
  helloFrom(g); hub.flush();

  let applied = 0;
  host.hooks.applyEdit = () => { applied++; };
  for (let i = 0; i < 200; i++) host.handle(g.id, { t: 'edit', x: i % 20, y: 1, z: 0, b: 1, tool: 0 });
  assert.ok(applied < 200 && applied > 0, `expected a capped subset, got ${applied}`);
});

t('host-gone: a transport disconnect closes the client session', () => {
  const { guests, helloFrom, hub } = makeWorld(1);
  helloFrom(guests[0]); hub.flush();
  guests[0].session.peerGone(0, 'closed');
  assert.deepEqual(guests[0].disconnects, ['closed']);
});

t('host-gone: bye preserves the host reason and closes once', () => {
  const { guests } = makeWorld(1);
  guests[0].session.handle(0, { t: 'bye', reason: 'not-hosting' });
  guests[0].session.peerGone(0, 'closed');
  assert.deepEqual(guests[0].disconnects, ['not-hosting']);
});

{
  let finish;
  const { host, guests, helloFrom, hub } = makeWorld(1);
  const g = guests[0];
  g.session.hooks.onWelcome = () => new Promise((resolve) => { finish = resolve; });
  helloFrom(g); hub.flush();
  host.sendEdit(2, 64, 2, 7, 0); host.tick(); hub.flush();
  t('loading: edits wait for the asynchronous world load', () => {
    assert.equal(g.log.get(2, 64, 2), null);
    assert.equal(g.session._ready, false);
  });
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  t('loading: queued edits replay after the asynchronous world load', () => {
    assert.equal(g.log.get(2, 64, 2), 7);
    assert.equal(g.session._ready, true);
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nfailures:');
  for (const [name, e] of failures) console.log(`  ${name}: ${e.stack}`);
}
process.exit(fail ? 1 : 0);
