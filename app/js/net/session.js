// NetSession: the only new game logic LAN co-op adds. No THREE, no DOM, no
// `window`, no sockets - it takes an injected `link` ({send(to,msg), close()}),
// which is what makes the convergence proof (tests/net.test.mjs) runnable
// headlessly and is why this file can be unit-tested in plain node.
//
// The design it implements, in one sentence: whoever acts applies an edit to
// their own world immediately, the host re-broadcasts every edit it receives
// (including its own) in the order it received them, and every peer applies
// every echo unconditionally - so there is no reject path and no rollback,
// only a digest heartbeat that notices when two logs have quietly diverged.
//
// Two constructor options beyond the four in the spec's own `new NetSession({
// role, link, hooks, now })` line: `code` (the optional join code a host may
// require) and `worldUid`/`hostName`/`planetId` (identity fields the `welcome`
// frame needs that `hooks.snapshot()` does not carry, since snapshot() is
// "current game state", not "which world/host this is"). Flagged in the
// report for the integrator to confirm.

import {
  PROTOCOL, MAX_PEERS, HEARTBEAT_S, TIME_EVERY_S, FURNACE_HZ, DROPS_HZ,
  contentHash, validEdit, validStack, validMove, Bucket,
} from './protocol.js';

const RING = 8;                 // avatars.js's interpolation sample ring
const EDIT_RATE = 40, EDIT_BURST = 60;             // per guest, section 10
const NAME_CAP = 16, CHAT_CAP = 200;
const RESYNC_MISMATCHES = 2;                       // consecutive digest disagreements
const RESYNC_QUIET_MS = 1000;                      // no local edit in flight
const PING_EVERY_MS = 1000, PEER_TIMEOUT_MS = 15000;
const GRAB_RANGE = 1.35 + 1.2;   // drops.js PICKUP_RANGE + one interpolation frame's slack
const PLAYER_MID = 0.9;          // drops.js: pickup is measured to the chest, not the feet

const round2 = (v) => Math.round(v * 100) / 100;
const round3 = (v) => Math.round(v * 1000) / 1000;
const clampStr = (s, n) => (typeof s === 'string' ? s.slice(0, n) : '');
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** "x,y,z" -> {x,y,z} of integers, or null. Mirrors stations.js's own parseKey. */
function parseAt(at) {
  if (typeof at !== 'string') return null;
  const p = at.split(',');
  if (p.length !== 3) return null;
  const x = Number(p[0]), y = Number(p[1]), z = Number(p[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) };
}

const cloneStackOrNull = (s) => (validStack(s) ? { item: s.item, count: s.count, dur: s.dur ?? null } : null);

export class NetSession {
  constructor({ role, link, hooks = {}, now = () => Date.now(), code = null, worldUid = null, hostName = null, planetId = null }) {
    this.role = role;                 // 'host' | 'client'
    this.link = link;
    this.hooks = hooks;
    this.now = now;
    this.selfId = role === 'host' ? 0 : null;

    this._code = code;
    this._worldUid = worldUid;
    this._hostName = hostName;
    this._planetId = planetId;

    /** @type {Map<number, {name:string, buf:Array<object>, lastSeen:number}>} */
    this.players = new Map();

    // host-only per-peer bookkeeping, kept out of the public `players` shape
    this._peers = new Map();          // id -> {address, joined, editBucket, lastPos, knownDrops, lastPongAt, lastPingAt}
    this._outbox = [];                // pending [x,y,z,b,by] edits, flushed on tick()
    this._furnaceLocks = new Map();   // "x,y,z" -> {peer, lastSeq}
    this._lastDigestAt = 0;
    this._lastTimeAt = 0;
    this._lastFurnaceAt = 0;
    this._lastDropsAt = 0;

    // client-only
    this._ready = role !== 'client';
    this._pendingEdits = [];
    this._pendingMessages = [];
    this._lastMoveAt = null;
    this._lastMove = null;
    this._lastLocalEditAt = 0;
    this._digestMismatches = 0;
    this._openFurnaceAt = null;
    this._furnaceSetSeq = 0;

    this._closed = false;
  }

  // ------------------------------------------------------------- host peers
  _peer(id) {
    let p = this._peers.get(id);
    if (!p) {
      p = {
        address: null, joined: false, editBucket: new Bucket(EDIT_RATE, EDIT_BURST),
        lastPos: null, knownDrops: new Set(), lastPongAt: this.now(), lastPingAt: 0,
        attackBucket: new Bucket(3, 1),
      };
      this._peers.set(id, p);
    }
    return p;
  }

  /** A raw socket connected, before (or instead of) sending `hello`. Host only. */
  peerConnected(id, address) {
    if (this.role !== 'host') return;
    this._peer(id).address = address ?? null;
  }

  /** The transport reports a socket gone. Host only - this is how a guest "leaves". */
  peerGone(id, reason) {
    if (this.role === 'client') { this.close(reason ?? 'disconnected'); return; }
    this._removePeer(id, reason ?? 'disconnected');
  }

  _removePeer(id, reason) {
    const p = this._peers.get(id);
    const wasJoined = !!p?.joined;
    this._peers.delete(id);
    this.players.delete(id);
    for (const [at, lock] of this._furnaceLocks) if (lock.peer === id) this._furnaceLocks.delete(at);
    if (wasJoined) {
      this.hooks.onPeerLeave?.(id, reason);
      for (const other of this.players.keys()) this.link.send(other, { t: 'left', i: id, reason });
    }
  }

  // ---------------------------------------------------------------- inbound
  handle(from, msg) {
    if (this._closed || !isPlainObject(msg) || typeof msg.t !== 'string' || msg.t.length > 32) return;
    if (this.role === 'client' && !this._ready && !['welcome', 'bye', 'ping'].includes(msg.t)) {
      this._pendingMessages.push([from, msg]);
      return;
    }
    const fn = (this.role === 'host' ? HOST_HANDLERS : CLIENT_HANDLERS)[msg.t];
    if (!fn) return;
    try { fn.call(this, from, msg); } catch { /* one malformed frame must never take the session down */ }
  }

  // =================================================================== HOST

  _onHello(from, msg) {
    if (this._peers.get(from)?.joined) return;
    if (msg.proto !== PROTOCOL) return this.link.send(from, { t: 'bye', reason: 'proto' });
    if (msg.hash !== contentHash()) return this.link.send(from, { t: 'bye', reason: 'content-mismatch' });
    if (this._code && msg.code !== this._code) return this.link.send(from, { t: 'bye', reason: 'bad-code' });
    if (this.players.size >= MAX_PEERS - 1) return this.link.send(from, { t: 'bye', reason: 'full' });

    const name = clampStr(msg.name, NAME_CAP) || ('Guest ' + from);
    const snap = this.hooks.snapshot?.() ?? {};
    const p = this._peer(from);
    p.joined = true;

    this.players.set(from, { name, buf: [], lastSeen: this.now() });

    const selfState = this.hooks.playerState?.();
    const playersList = [];
    if (selfState) {
      playersList.push({
        i: 0, name: this._hostName, x: round2(selfState.x), y: round2(selfState.y), z: round2(selfState.z),
        yaw: round3(selfState.yaw), pitch: round3(selfState.pitch), f: selfState.f ?? 0,
      });
    }
    for (const [id, rec] of this.players) {
      if (id === from) continue;
      const s = rec.buf[rec.buf.length - 1];
      if (s) playersList.push({ i: id, name: rec.name, x: s.x, y: s.y, z: s.z, yaw: s.yaw, pitch: s.pitch, f: s.f });
    }

    this.link.send(from, {
      t: 'welcome', i: from, worldUid: this._worldUid, hostName: this._hostName, planetId: this._planetId,
      seed: snap.seed, mode: snap.mode, time: snap.time, spawn: snap.spawn,
      edits: snap.edits, stations: snap.stations, drops: snap.drops,
      players: playersList, digest: this.hooks.digest?.() ?? null,
    });

    for (const other of this.players.keys()) if (other !== from) this.link.send(other, { t: 'joined', i: from, name });
    this.hooks.onPeerJoin?.(from, name);
  }

  _onEdit(from, msg) {
    const p = this._peers.get(from);
    if (!p?.joined) return;
    if (!p.editBucket.take(this.now())) return;   // silent drop; the digest heartbeat repairs it
    if (!validEdit(msg)) return;
    this.hooks.applyEdit?.(msg.x, msg.y, msg.z, msg.b, from, msg.tool);
    this._outbox.push([msg.x, msg.y, msg.z, msg.b, from]);
  }

  _onMove(from, msg) {
    const p = this._peers.get(from);
    if (!p?.joined) return;
    const entry = { x: round2(msg.x), y: round2(msg.y), z: round2(msg.z), yaw: round3(msg.yaw), pitch: round3(msg.pitch), f: msg.f };
    if (!validMove(entry)) return;
    p.lastPos = { x: entry.x, y: entry.y, z: entry.z };
    const rec = this.players.get(from);
    if (!rec) return;
    rec.lastSeen = this.now();
    this._pushSample(rec, entry);
  }

  _onGrab(from, msg) {
    const p = this._peers.get(from);
    if (!p?.joined || !p.lastPos || !Number.isInteger(msg.id)) return;
    const drops = this.hooks.drops?.();
    const list = drops?.list ?? [];
    const drop = list.find((d) => d.id === msg.id);
    if (!drop) return;   // already granted to someone else, or expired - loser gets nothing
    const dx = drop.x - p.lastPos.x, dy = drop.y - (p.lastPos.y + PLAYER_MID), dz = drop.z - p.lastPos.z;
    if (dx * dx + dy * dy + dz * dz > GRAB_RANGE * GRAB_RANGE) return;
    this.hooks.onGrant?.({ id: drop.id, item: drop.item, count: drop.count, dur: drop.dur ?? null, by: from });
    this.link.send(from, { t: 'granted', id: drop.id, item: drop.item, count: drop.count, dur: drop.dur ?? null });
  }

  _onSpill(from, msg) {
    const p = this._peers.get(from);
    if (!p?.joined) return;
    const stack = cloneStackOrNull({ item: msg.item, count: msg.count, dur: msg.dur });
    if (!stack) return;
    if (![msg.x, msg.y, msg.z].every(Number.isFinite)) return;
    this.hooks.onSpillRequest?.({ item: stack.item, count: stack.count, dur: stack.dur, x: msg.x, y: msg.y, z: msg.z });
  }

  _onMobHit(from, msg) {
    const p = this._peers.get(from);
    if (!p?.joined || !p.lastPos || !p.attackBucket.take(this.now())) return;
    if (!Number.isInteger(msg.id) || !Number.isInteger(msg.tool) || ![msg.dx, msg.dz].every(Number.isFinite)) return;
    this.hooks.onMobHit?.(msg.id, msg.tool, p.lastPos, msg.dx, msg.dz);
  }

  _onFurnaceOpen(from, msg) {
    const p = this._peers.get(from);
    if (!p?.joined) return;
    const at = parseAt(msg.at);
    if (!at) return;
    const key = at.x + ',' + at.y + ',' + at.z;
    const lock = this._furnaceLocks.get(key);
    if (lock && lock.peer !== from) return this.link.send(from, { t: 'furnace.busy', at: key });
    this._furnaceLocks.set(key, { peer: from, lastSeq: 0 });
    this._flushFurnaces();
  }

  _onFurnaceClose(from, msg) {
    const at = parseAt(msg.at);
    if (!at) return;
    const key = at.x + ',' + at.y + ',' + at.z;
    if (this._furnaceLocks.get(key)?.peer === from) this._furnaceLocks.delete(key);
  }

  _onFurnaceSet(from, msg) {
    const at = parseAt(msg.at);
    if (!at) return;
    const key = at.x + ',' + at.y + ',' + at.z;
    const lock = this._furnaceLocks.get(key);
    if (!lock || lock.peer !== from) return;
    if (!Number.isInteger(msg.seq) || msg.seq <= lock.lastSeq) return;
    lock.lastSeq = msg.seq;
    const stations = this.hooks.stations?.();
    const rec = stations?.furnaceAt?.(at.x, at.y, at.z, true);
    if (!rec) return;
    // Only fields present and legal are written - a slot the guest left alone
    // (undefined) or emptied (null) must not be rejected as "invalid".
    if (msg.input !== undefined) rec.input = msg.input === null ? null : (validStack(msg.input) ? { ...msg.input } : rec.input);
    if (msg.fuel !== undefined) rec.fuel = msg.fuel === null ? null : (validStack(msg.fuel) ? { ...msg.fuel } : rec.fuel);
    if (msg.output !== undefined) rec.output = msg.output === null ? null : (validStack(msg.output) ? { ...msg.output } : rec.output);
  }

  _onChatFromGuest(from, msg) {
    const p = this._peers.get(from);
    if (!p?.joined) return;
    const text = clampStr(msg.text, CHAT_CAP);
    if (!text) return;
    this.hooks.onChat?.(from, text);
    for (const id of this.players.keys()) this.link.send(id, { t: 'chat', i: from, text });
  }

  _onResync(from) {
    const p = this._peers.get(from);
    if (!p?.joined) return;
    const snap = this.hooks.snapshot?.() ?? {};
    this.link.send(from, {
      t: 'snapshot', seed: snap.seed, mode: snap.mode, time: snap.time,
      edits: snap.edits, stations: snap.stations, drops: snap.drops, digest: this.hooks.digest?.() ?? null,
    });
  }

  _onPong(from, msg) {
    const p = this._peers.get(from);
    if (p) p.lastPongAt = this.now();
  }

  // ================================================================= CLIENT

  _onWelcome(from, msg) {
    this.selfId = msg.i;
    this.players.clear();
    for (const e of msg.players ?? []) {
      if (e.i === this.selfId || !validMove(e)) continue;
      const rec = { name: clampStr(e.name, NAME_CAP), buf: [], lastSeen: this.now() };
      this._pushSample(rec, { x: e.x, y: e.y, z: e.z, yaw: e.yaw, pitch: e.pitch, f: e.f });
      this.players.set(e.i, rec);
    }
    this._digestMismatches = 0;
    this._loadWorld(() => this.hooks.onWelcome?.(msg));
  }

  _loadWorld(load) {
    this._ready = false;
    const complete = () => {
      if (this._closed) return;
      // TCP preserves the order of updates received during world loading.
      this._ready = true;
      const pending = this._pendingEdits;
      this._pendingEdits = [];
      for (const [x, y, z, b, by] of pending) this.hooks.applyEdit?.(x, y, z, b, by, 0);
      const messages = this._pendingMessages;
      this._pendingMessages = [];
      for (const [from, msg] of messages) this.handle(from, msg);
    };
    try {
      const result = load();
      if (result?.then) result.then(complete, () => this.close('world-load-failed'));
      else complete();
    } catch { this.close('world-load-failed'); }
  }

  _onEdits(from, msg) {
    for (const e of msg.list ?? []) {
      const [x, y, z, b, by] = e;
      if (![x, y, z, b].every(Number.isInteger)) continue;
      if (this._ready) this.hooks.applyEdit?.(x, y, z, b, by, 0);
      else this._pendingEdits.push([x, y, z, b, by]);
    }
  }

  _onPlayers(from, msg) {
    const t = this.now();
    const list = [];
    for (const e of msg.list ?? []) {
      if (e.i === this.selfId || !validMove(e)) continue;
      let rec = this.players.get(e.i);
      if (!rec) { rec = { name: '', buf: [], lastSeen: t }; this.players.set(e.i, rec); }
      rec.lastSeen = t;
      this._pushSample(rec, e);
      list.push(e);
    }
    this.hooks.onPlayers?.(list, t);
  }

  _onJoined(from, msg) {
    if (!this.players.has(msg.i)) this.players.set(msg.i, { name: clampStr(msg.name, 16), buf: [], lastSeen: this.now() });
    else this.players.get(msg.i).name = clampStr(msg.name, 16);
    this.hooks.onPeerJoin?.(msg.i, msg.name);
  }

  _onLeft(from, msg) {
    this.players.delete(msg.i);
    this.hooks.onPeerLeave?.(msg.i, msg.reason);
  }

  _onDrops(from, msg) {
    this.hooks.onDrops?.({ a: msg.a ?? [], r: msg.r ?? [], m: msg.m ?? [], all: msg.all });
  }

  _onGranted(from, msg) {
    this.hooks.onGrant?.({ id: msg.id, item: msg.item, count: msg.count, dur: msg.dur ?? null, by: this.selfId });
  }

  _onFurnaceBusy(from, msg) {
    if (msg.at === this._openFurnaceAt) this._openFurnaceAt = null;
    this.hooks.onFurnaceBusy?.(msg.at);
  }

  _onFurnaceState(from, msg) {
    // The seq race: a host state frame in flight when the guest just clicked
    // must not clobber that click. Timers are host-owned every tick, so they
    // are always applied; the three stacks only apply once the host has
    // caught up to the guest's most recent `furnace.set`.
    const seqMatches = msg.seq === this._furnaceSetSeq;
    this.hooks.onFurnaceState?.({
      at: msg.at, burn: msg.burn, burnMax: msg.burnMax, progress: msg.progress, lit: msg.lit,
      stacks: seqMatches ? { input: msg.input ?? null, fuel: msg.fuel ?? null, output: msg.output ?? null } : null,
    });
  }

  _onTime(from, msg) { this.hooks.onTime?.(msg.v); }

  _onChatFromHost(from, msg) { this.hooks.onChat?.(msg.i, msg.text); }

  _onDigest(from, msg) {
    const mine = this.hooks.digest?.();
    const quiet = this.now() - this._lastLocalEditAt > RESYNC_QUIET_MS;
    if (mine != null && msg.d !== mine && quiet) {
      this._digestMismatches++;
      // An optimistic local apply legitimately makes the digest differ for a
      // moment while its echo is in flight - two misses in a row is what
      // separates "in flight" from "actually diverged".
      if (this._digestMismatches >= RESYNC_MISMATCHES) {
        this._digestMismatches = 0;
        this.link.send(0, { t: 'resync' });
      }
    } else {
      this._digestMismatches = 0;
    }
  }

  _onSnapshot(from, msg) {
    this._pendingEdits = [];
    this._digestMismatches = 0;
    this._loadWorld(() => this.hooks.onResyncNeeded?.(msg));
  }

  _onPing(from, msg) { this.link.send(0, { t: 'pong', ts: msg.ts }); }

  // ------------------------------------------------------------- samples
  _pushSample(rec, e) {
    rec.buf.push({ t: this.now(), x: e.x, y: e.y, z: e.z, yaw: e.yaw, pitch: e.pitch, f: e.f });
    if (rec.buf.length > RING) rec.buf.shift();
  }

  // ------------------------------------------------------------ outbound API
  sendMove(player, flags) {
    if (this.role !== 'client' || this._closed) return;
    const t = this.now();
    if (this._lastMoveAt != null && t - this._lastMoveAt < 1000 / 20) return;
    const x = round2(player.pos.x), y = round2(player.pos.y), z = round2(player.pos.z);
    const yaw = round3(player.yaw), pitch = round3(player.pitch);
    const last = this._lastMove;
    if (last && Math.abs(x - last.x) < 0.01 && Math.abs(y - last.y) < 0.01 && Math.abs(z - last.z) < 0.01
      && Math.abs(yaw - last.yaw) < 0.01 && Math.abs(pitch - last.pitch) < 0.01 && flags === last.f) {
      return;   // idle: costs nothing
    }
    this._lastMoveAt = t;
    this._lastMove = { x, y, z, yaw, pitch, f: flags };
    this.link.send(0, { t: 'move', x, y, z, yaw, pitch, f: flags });
  }

  /**
   * Sends the intent - it never re-applies the edit. The caller (game.js's
   * `editWorld`, per the spec: `world.setBlock()` runs before `net.sendEdit()`)
   * has already applied the block change to its own world, for both roles;
   * calling `hooks.applyEdit` again here would double-apply on the actor's
   * own machine. A guest's intent goes to the host over the link; the host's
   * own edit "goes through the same funnel" by joining the very outbox a
   * guest's `edit` message feeds (see _onEdit), so the broadcast order is
   * exactly the host's apply order without the host ever socket-sending to
   * itself.
   */
  sendEdit(x, y, z, id, tool) {
    if (this._closed) return;
    const useTool = Number.isInteger(tool) ? tool : (this.hooks.heldTool?.() ?? 0);
    this._lastLocalEditAt = this.now();
    if (this.role === 'host') this._outbox.push([x, y, z, id, this.selfId]);
    else this.link.send(0, { t: 'edit', x, y, z, b: id, tool: useTool });
  }

  sendGrab(dropId) {
    if (this.role !== 'client' || this._closed) return;
    const drops = this.hooks.drops?.();
    const drop = drops?.list?.find?.((d) => d.id === dropId);
    if (drop && this.hooks.inventoryRoomFor && !(this.hooks.inventoryRoomFor({ item: drop.item, count: drop.count }) > 0)) return;
    this.link.send(0, { t: 'grab', id: dropId });
  }

  sendSpill(item, count, dur, x, y, z) {
    if (this.role !== 'client' || this._closed) return;
    this.link.send(0, { t: 'spill', item, count, dur: dur ?? null, x: round2(x), y: round2(y), z: round2(z) });
  }

  openFurnace(at) {
    if (this._closed) return false;
    if (this.role === 'host') {
      if (this._furnaceLocks.has(at)) return false;
      this._furnaceLocks.set(at, { peer: 0, lastSeq: 0 });
      this._openFurnaceAt = at;
      return true;
    }
    this._openFurnaceAt = at;
    this._furnaceSetSeq = 0;
    this.link.send(0, { t: 'furnace.open', at });
    return true;
  }

  closeFurnace() {
    if (this._closed || !this._openFurnaceAt) return;
    if (this.role === 'host') this._furnaceLocks.delete(this._openFurnaceAt);
    else this.link.send(0, { t: 'furnace.close', at: this._openFurnaceAt });
    this._openFurnaceAt = null;
  }

  setFurnace(at, rec) {
    if (this.role !== 'client' || this._closed) return;
    this._furnaceSetSeq++;
    this.link.send(0, {
      t: 'furnace.set', at, seq: this._furnaceSetSeq,
      input: rec.input ?? null, fuel: rec.fuel ?? null, output: rec.output ?? null,
    });
  }

  sendChat(text) {
    if (this._closed) return;
    const clean = clampStr(text, CHAT_CAP);
    if (!clean) return;
    if (this.role === 'host') {
      this.hooks.onChat?.(0, clean);
      for (const id of this.players.keys()) this.link.send(id, { t: 'chat', i: 0, text: clean });
    } else {
      this.link.send(0, { t: 'chat', text: clean });
    }
  }

  sendMobHit(id, tool, dx, dz) {
    if (this.role === 'client' && !this._closed) this.link.send(0, { t: 'mobhit', id, tool, dx, dz });
  }

  // ------------------------------------------------------------------ ticks
  /** 20 Hz, driven by the caller (host: flush edits/players/heartbeat; both: ping housekeeping). */
  tick() {
    if (this._closed) return;
    const t = this.now();
    if (this.role === 'host') {
      this._flushEdits();
      this._flushPlayers();
      if (t - this._lastDropsAt >= 1000 / DROPS_HZ) {
        this._lastDropsAt = t; this._flushDrops();
        const list = this.hooks.mobState?.();
        if (list) for (const id of this.players.keys()) this.link.send(id, { t: 'mobstate', list });
      }
      if (t - this._lastFurnaceAt >= 1000 / FURNACE_HZ) { this._lastFurnaceAt = t; this._flushFurnaces(); }
      if (t - this._lastDigestAt >= HEARTBEAT_S * 1000) { this._lastDigestAt = t; this._flushDigest(); }
      if (t - this._lastTimeAt >= TIME_EVERY_S * 1000) { this._lastTimeAt = t; this._flushTime(); }
      this._pingPeers(t);
    }
  }

  /** Display-rate hook for interpolation bookkeeping. Currently a light no-op:
   * avatars.js reads `session.players` directly at render time, so nothing
   * here needs `dt` yet - kept for the cadence the spec's public surface names. */
  frame(dt) { /* no-op: see comment above */ }

  _flushEdits() {
    if (!this._outbox.length) return;
    const list = this._outbox;
    this._outbox = [];
    for (const id of this.players.keys()) this.link.send(id, { t: 'edits', list });
  }

  _flushPlayers() {
    const self = this.hooks.playerState?.();
    const all = [];
    if (self) {
      all.push({ i: 0, x: round2(self.x), y: round2(self.y), z: round2(self.z), yaw: round3(self.yaw), pitch: round3(self.pitch), f: self.f ?? 0 });
    }
    for (const [id, rec] of this.players) {
      const s = rec.buf[rec.buf.length - 1];
      if (s) all.push({ i: id, x: s.x, y: s.y, z: s.z, yaw: s.yaw, pitch: s.pitch, f: s.f });
    }
    if (!all.length) return;
    for (const id of this.players.keys()) {
      const list = all.filter((e) => e.i !== id);
      if (list.length) this.link.send(id, { t: 'players', list });
    }
  }

  _flushDrops() {
    const drops = this.hooks.drops?.();
    if (!drops?.netFrame) return;
    for (const [id, p] of this._peers) {
      if (!p.joined) continue;
      const centre = p.lastPos ?? { x: 0, y: 0, z: 0 };
      const frame = drops.netFrame(centre, p.knownDrops);
      if (!frame) continue;
      const msg = { t: 'drops' };
      if (frame.all) msg.all = frame.all;
      if (frame.a?.length) msg.a = frame.a;
      if (frame.r?.length) msg.r = frame.r;
      if (frame.m?.length) msg.m = frame.m;
      if (msg.a || msg.r || msg.m || msg.all) this.link.send(id, msg);
    }
  }

  _flushFurnaces() {
    if (!this._furnaceLocks.size) return;
    const stations = this.hooks.stations?.();
    if (!stations) return;
    for (const [key, lock] of this._furnaceLocks) {
      if (lock.peer === 0) continue;
      const at = parseAt(key);
      const rec = at && stations.furnaceAt?.(at.x, at.y, at.z, false);
      if (!rec) continue;
      this.link.send(lock.peer, {
        t: 'furnace.state', at: key, seq: lock.lastSeq,
        input: rec.input ?? null, fuel: rec.fuel ?? null, output: rec.output ?? null,
        burn: rec.burn, burnMax: rec.burnMax, progress: rec.progress, lit: !!rec.lit,
      });
    }
  }

  _flushDigest() {
    const d = this.hooks.digest?.();
    if (d == null) return;
    for (const id of this.players.keys()) this.link.send(id, { t: 'digest', d });
  }

  _flushTime() {
    const v = this.hooks.snapshot?.()?.time;
    if (v == null) return;
    for (const id of this.players.keys()) this.link.send(id, { t: 'time', v });
  }

  _pingPeers(t) {
    for (const [id, p] of this._peers) {
      if (!p.joined) continue;
      if (t - p.lastPongAt > PEER_TIMEOUT_MS) {
        this.link.send(id, { t: 'bye', reason: 'timeout' });
        this._removePeer(id, 'timeout'); continue;
      }
      if (t - p.lastPingAt >= PING_EVERY_MS) { p.lastPingAt = t; this.link.send(id, { t: 'ping', ts: t }); }
    }
  }

  // ----------------------------------------------------------------- close
  close(reason, notify = true) {
    if (this._closed) return;
    this._closed = true;
    this.link?.close?.();
    if (notify && this.role === 'client') this.hooks.onDisconnect?.(reason);
  }
}

// Built once from the prototype rather than as a fresh object literal per
// handle() call - dispatch runs on every inbound frame, not just per render
// frame, but there is no reason to allocate for it.
const HOST_HANDLERS = {
  hello: NetSession.prototype._onHello,
  edit: NetSession.prototype._onEdit,
  move: NetSession.prototype._onMove,
  grab: NetSession.prototype._onGrab,
  spill: NetSession.prototype._onSpill,
  mobhit: NetSession.prototype._onMobHit,
  'furnace.open': NetSession.prototype._onFurnaceOpen,
  'furnace.close': NetSession.prototype._onFurnaceClose,
  'furnace.set': NetSession.prototype._onFurnaceSet,
  chat: NetSession.prototype._onChatFromGuest,
  resync: NetSession.prototype._onResync,
  pong: NetSession.prototype._onPong,
};

const CLIENT_HANDLERS = {
  mobstate(from, msg) { if (Array.isArray(msg.list)) this.hooks.onMobState?.(msg.list); },
  hurt(from, msg) { this.hooks.onHurt?.(msg); },
  bye(from, msg) { this.close(msg.reason ?? 'disconnected'); },
  welcome: NetSession.prototype._onWelcome,
  edits: NetSession.prototype._onEdits,
  players: NetSession.prototype._onPlayers,
  joined: NetSession.prototype._onJoined,
  left: NetSession.prototype._onLeft,
  drops: NetSession.prototype._onDrops,
  granted: NetSession.prototype._onGranted,
  'furnace.busy': NetSession.prototype._onFurnaceBusy,
  'furnace.state': NetSession.prototype._onFurnaceState,
  time: NetSession.prototype._onTime,
  chat: NetSession.prototype._onChatFromHost,
  digest: NetSession.prototype._onDigest,
  snapshot: NetSession.prototype._onSnapshot,
  ping: NetSession.prototype._onPing,
};
