// electron/net/lan.js — the TCP transport for LAN co-op, plus the IPC surface
// the renderer's session logic talks to. This file owns sockets and nothing
// else: it frames and relays opaque messages, enforces connection-level
// guards (address filtering, connection caps, rate limits, backpressure), and
// drives ./discovery.js for lobby advertising/browsing. It has no idea what a
// `move` or an `edit` means - that interpretation lives entirely in the
// renderer's app/js/net/session.js, reached only through the net:* channels
// documented in the multiplayer spec, §5.
//
// State is per renderer window, `Map<webContents.id, Session>`, so two
// windows in one Electron process can host and join each other - exactly the
// shape `probe-lan.js` needs, and why every socket guard here keys off the
// window that owns it rather than any process-wide singleton.

import net from 'node:net';
import os from 'node:os';
import crypto from 'node:crypto';
import { ipcMain } from 'electron';
import { encodeFrame, FrameReader, MAX_FRAME } from './framing.js';
import { startBeacon, startBrowser } from './discovery.js';
import { assertTrustedSender, isTrustedSender } from '../security.js';

const TCP_PORT_BASE = 25710;
const TCP_PORT_SPAN = 8; // 25710..25717
const MAX_GUESTS = 7; // + the host itself = 8 peers total
const MAX_PENDING = 4; // unauthenticated sockets awaiting a first frame
const HELLO_DEADLINE_MS = 5000;
const NET_SEND_MAX_BYTES = 256 * 1024;
const WRITE_QUEUE_LIMIT = 2 * 1024 * 1024; // 2 MB of unflushed writes = disconnect
const STALL_FRAME_LIMIT = 3; // consecutive false returns from socket.write() before throttling
const LOW_PRIORITY_TYPES = new Set(['players', 'drops', 'furnace.state', 'mobstate']);
const MSG_RATE = 250, MSG_BURST = 400; // per-peer inbound token bucket
const BYTE_RATE = 256 * 1024; // per-peer inbound bytes/s
const BEACON_PROTO = 1; // the discovery packet's own version, independent of app/js/net/protocol.js's wire PROTOCOL

// --------------------------------------------------------------- addressing

/** Node reports an IPv4 peer on a dual-stack socket as `::ffff:x.x.x.x`. */
function normalizeAddress(addr) {
  return typeof addr === 'string' && addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}

/**
 * True for anything in 10/8, 172.16/12, 192.168/16, 169.254/16, 127/8,
 * ::1, fc00::/7, fe80::/10. "LAN multiplayer" must mean LAN even on a
 * machine that also has a public IP, so this gates both inbound accepts
 * (host) and outbound join targets (client, via the `blocked` net:join
 * error) - the same rule, checked from both ends of the wire.
 */
export function isPrivateAddress(rawAddr) {
  const addr = normalizeAddress(rawAddr);
  if (typeof addr !== 'string' || !addr) return false;
  if (addr === '127.0.0.1' || addr === '::1') return true;
  const v4 = addr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const o = v4.slice(1).map(Number);
    if (o.some((n) => n > 255)) return false;
    if (o[0] === 10) return true;
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
    if (o[0] === 192 && o[1] === 168) return true;
    if (o[0] === 169 && o[1] === 254) return true;
    if (o[0] === 127) return true;
    return false;
  }
  const first = parseInt(addr.split(':')[0] || '', 16);
  if (Number.isNaN(first)) return false;
  if (first >= 0xfe80 && first <= 0xfebf) return true; // fe80::/10, link-local
  if (first >= 0xfc00 && first <= 0xfdff) return true; // fc00::/7, unique local
  return false;
}

function localAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    if (!list) continue;
    for (const info of list) {
      if (info && !info.internal && info.family === 'IPv4') out.push(info.address);
    }
  }
  return out;
}

// ----------------------------------------------------------------- helpers

function isPlainObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

/** A well-formed message a peer could plausibly send: shape only, never semantics. */
function isWellFormedMessage(msg) {
  return isPlainObject(msg) && typeof msg.t === 'string' && msg.t.length > 0 && msg.t.length <= 32;
}

class TokenBucket {
  constructor(ratePerSec, burst) {
    this.rate = ratePerSec;
    this.capacity = burst;
    this.tokens = burst;
    this.last = Date.now();
  }
  take(n) {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

function sendByeAndClose(socket, reason) {
  try { socket.end(encodeFrame({ t: 'bye', reason })); }
  catch { try { socket.destroy(); } catch { /* already gone */ } }
}

/**
 * Strips a socket's listeners ahead of a bulk teardown so the per-connection
 * `close` handler doesn't also fire and double-report state the caller
 * already knows about - but `removeAllListeners()` strips the no-op `error`
 * handler along with everything else, and a socket mid-destroy with data
 * still in flight can raise a real `ECONNRESET` afterward. With nothing
 * listening for `error`, Node treats that as fatal and crashes the whole
 * main process, so the safety net goes back on immediately after stripping.
 */
function silence(socket) {
  socket.removeAllListeners();
  socket.on('error', () => {});
}

/**
 * The one place a frame actually goes onto a peer's socket. `players`/
 * `drops`/`furnace.state` are dropped rather than queued while a peer is
 * `stalled` - everything else (`edits`, `welcome`, `granted`, `chat`, `bye`,
 * and anything not in the low-priority set) always goes through, per §4.
 * A `bye` frame always ends the socket right after - "then FIN" is a
 * property of the message type, not of who sent it.
 */
function writeFrame(peer, msg, frame = encodeFrame(msg)) {
  if (peer.stalled && LOW_PRIORITY_TYPES.has(msg.t)) return;
  const ok = peer.socket.write(frame);
  if (peer.socket.writableLength > WRITE_QUEUE_LIMIT) {
    peer.pendingReason = 'too-slow';
    try { peer.socket.destroy(); } catch { /* 'close' still fires */ }
    return;
  }
  if (ok) { peer.stallCount = 0; }
  else if (++peer.stallCount >= STALL_FRAME_LIMIT) { peer.stalled = true; }
  if (msg && msg.t === 'bye') peer.socket.end();
}

// ------------------------------------------------------------------ session

function createSession(sender) {
  return {
    sender,
    role: 'none', // 'none' | 'host' | 'client'
    server: null,
    port: null,
    sid: null,
    hostAddresses: [],
    beacon: null,
    browser: null,
    pending: new Set(),
    peers: new Map(), // id -> peer; host: guest sockets keyed by their assigned id; client: just {0: host}
    nextId: 1,
  };
}

function resolveTargets(session, to) {
  // 'all' and 'others' resolve identically here: `peers` never contains an
  // entry for the local, sending side (the host has no socket to itself; a
  // client's own id is never in its one-entry peers map), so "everyone this
  // transport can reach" already excludes the sender by construction. The
  // distinction, if session.js ever needs one, is about payload content
  // (e.g. omitting each recipient's own entry from a `players` list), which
  // is exactly why that per-recipient shaping happens above this layer.
  if (to === 'all' || to === 'others') return [...session.peers.values()];
  const p = session.peers.get(to);
  return p ? [p] : [];
}

// ---------------------------------------------------------- host: accepting

function onGuestClose(session, conn) {
  if (conn.isPending) { session.pending.delete(conn); clearTimeout(conn.helloTimer); return; }
  const peer = session.peers.get(conn.peerId);
  if (!peer) return; // already removed by a bulk teardown
  session.peers.delete(conn.peerId);
  // Two objects can carry a reason for the same close: `conn` (set by this
  // module's own read-side guards - bad-frame, flood - which only ever see
  // `conn`) and `peer` (set by write-side paths - kickPeer, the too-slow
  // backpressure disconnect - which only ever see `peer`, not the `conn` that
  // predates promotion). Exactly one is ever set for a given close, so either
  // order is correct; `peer` first because a kick or too-slow disconnect is
  // the more specific, deliberate reason when both happen to be present.
  session.sender.send('net:peer', { kind: 'gone', id: conn.peerId, address: conn.address, reason: peer.pendingReason ?? conn.pendingReason ?? 'closed' });
}

function promote(session, conn, firstMsg) {
  clearTimeout(conn.helloTimer);
  session.pending.delete(conn);
  if (session.peers.size >= MAX_GUESTS) {
    // Never announced to the renderer - this connection never became a peer.
    conn.pendingReason = 'full';
    sendByeAndClose(conn.socket, 'full');
    return;
  }
  const id = session.nextId++;
  conn.peerId = id;
  conn.isPending = false;
  const name = typeof firstMsg.name === 'string' && firstMsg.name ? firstMsg.name.slice(0, 16) : 'guest';
  const peer = {
    session, id, name, address: conn.address, socket: conn.socket, reader: conn.reader,
    lastSeen: Date.now(), stalled: false, stallCount: 0, pendingReason: null,
  };
  session.peers.set(id, peer);
  conn.socket.on('drain', () => { peer.stalled = false; peer.stallCount = 0; });
  session.sender.send('net:peer', { kind: 'connected', id, address: conn.address });
}

function onGuestData(session, conn, chunk) {
  if (!conn.byteBucket.take(chunk.length)) { floodOut(session, conn); return; }
  let frames;
  try { frames = conn.reader.push(chunk); }
  catch {
    // "A FrameReader throw destroys that socket" - the parser is desynced, not just this message.
    if (conn.isPending) { session.pending.delete(conn); clearTimeout(conn.helloTimer); }
    else conn.pendingReason = 'bad-frame';
    try { conn.socket.destroy(); } catch { /* 'close' still fires */ }
    return;
  }
  for (const msg of frames) {
    if (!conn.msgBucket.take(1)) { floodOut(session, conn); return; }
    if (!isWellFormedMessage(msg)) continue; // malformed - dropped, never forwarded, never crashes the host
    if (conn.isPending) {
      if (msg.t !== 'hello') { sendByeAndClose(conn.socket, 'hello-required'); return; }
      promote(session, conn, msg);
      if (conn.isPending) return; // rejected as full; conn.socket is already closing
    }
    msg.i = conn.peerId; // id stamping: spoofing another player is not expressible
    const peer = session.peers.get(conn.peerId);
    if (!peer) return; // removed between promote() and here
    peer.lastSeen = Date.now();
    session.sender.send('net:message', conn.peerId, msg);
  }
}

function floodOut(session, conn) {
  if (conn.isPending) { session.pending.delete(conn); clearTimeout(conn.helloTimer); }
  else conn.pendingReason = 'flood';
  sendByeAndClose(conn.socket, 'flood');
}

function onConnection(session, socket) {
  // Registered before any rejection path below: an abrupt destroy() on a
  // freshly accepted socket can still raise an ECONNRESET, and a socket that
  // has never had an `error` listener attached crashes the whole main
  // process on one - including for a connection rejected in its first tick.
  socket.on('error', () => {});
  const address = normalizeAddress(socket.remoteAddress);
  if (!isPrivateAddress(address)) { socket.destroy(); return; } // never even counted as pending
  if (session.pending.size >= MAX_PENDING) { socket.destroy(); return; } // no room to vet another
  if (session.peers.size >= MAX_GUESTS) { sendByeAndClose(socket, 'full'); return; }

  socket.setNoDelay(true);
  socket.setKeepAlive(true, 10000);
  const conn = {
    socket, address, reader: new FrameReader(), isPending: true, peerId: null, pendingReason: null,
    msgBucket: new TokenBucket(MSG_RATE, MSG_BURST), byteBucket: new TokenBucket(BYTE_RATE, BYTE_RATE),
    helloTimer: null,
  };
  conn.helloTimer = setTimeout(() => {
    session.pending.delete(conn);
    try { conn.socket.destroy(); } catch { /* already gone */ }
  }, HELLO_DEADLINE_MS);
  session.pending.add(conn);

  socket.on('data', (chunk) => onGuestData(session, conn, chunk));
  socket.on('close', () => onGuestClose(session, conn));
}

// ------------------------------------------------------------------- hosts

async function listenWithFallback(server) {
  for (let i = 0; i < TCP_PORT_SPAN; i++) {
    const port = TCP_PORT_BASE + i;
    try {
      await new Promise((resolve, reject) => {
        const onErr = (err) => { server.removeListener('listening', onOk); reject(err); };
        const onOk = () => { server.removeListener('error', onErr); resolve(); };
        server.once('error', onErr);
        server.once('listening', onOk);
        server.listen({ port, host: '0.0.0.0' });
      });
      return port;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
      // else try the next candidate port
    }
  }
  throw new Error('no free port in range');
}

async function hostSession(session, opts) {
  if (session.role === 'host') return { ok: true, port: session.port, addresses: session.hostAddresses };
  if (session.role !== 'none') return { ok: false, error: 'busy' };

  const { name, beacon: beaconOpts, code } = opts ?? {};
  const server = net.createServer();
  let port;
  try { port = await listenWithFallback(server); }
  catch { try { server.close(); } catch { /* never opened */ } return { ok: false, error: 'no-port' }; }

  session.role = 'host';
  session.server = server;
  session.port = port;
  session.sid = crypto.randomBytes(4).toString('hex');
  session.hostAddresses = localAddresses();
  server.on('connection', (socket) => onConnection(session, socket));
  server.on('error', () => {}); // rare post-listen errors must not crash the process

  const record = {
    magic: 'SPACEMC', v: 1, sid: session.sid, proto: BEACON_PROTO,
    hash: beaconOpts?.hash, name: beaconOpts?.name ?? name ?? 'Lunacrust',
    planetId: beaconOpts?.planetId, mode: beaconOpts?.mode, seed: beaconOpts?.seed,
    players: 1, max: MAX_GUESTS + 1, locked: !!code, port,
  };
  session.beacon = startBeacon(record, { interval: 1500 });

  return { ok: true, port, addresses: session.hostAddresses };
}

/** Bulk teardown: listeners are stripped before destroying so the per-socket
 * `close` handler (which expects to run one peer at a time) does not also
 * fire mid-teardown and double-report state the caller already knows about. */
function unhostSession(session, opts) {
  if (session.role !== 'host') return { ok: true };
  const reason = opts?.reason ?? 'not-hosting';
  for (const peer of session.peers.values()) {
    silence(peer.socket);
    writeFrame(peer, { t: 'bye', reason });
  }
  session.peers.clear();
  for (const conn of session.pending) {
    clearTimeout(conn.helloTimer);
    silence(conn.socket);
    try { conn.socket.destroy(); } catch { /* already gone */ }
  }
  session.pending.clear();
  if (session.beacon) { session.beacon.stop(); session.beacon = null; }
  if (session.server) { try { session.server.close(); } catch { /* already closed */ } session.server = null; }
  session.role = 'none';
  session.port = null;
  session.sid = null;
  session.hostAddresses = [];
  return { ok: true };
}

// ------------------------------------------------------------------ client

function joinSession(session, opts) {
  const { address, port, hello } = opts ?? {};
  if (session.role !== 'none') return Promise.resolve({ ok: false, error: 'refused' });
  if (!isPrivateAddress(address)) return Promise.resolve({ ok: false, error: 'blocked' });
  if (!isPlainObject(hello) || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return Promise.resolve({ ok: false, error: 'refused' });
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
    const socket = new net.Socket();
    const timer = setTimeout(() => { finish({ ok: false, error: 'timeout' }); try { socket.destroy(); } catch { /* already gone */ } }, HELLO_DEADLINE_MS);

    socket.once('error', () => { clearTimeout(timer); finish({ ok: false, error: 'refused' }); });

    socket.connect({ host: address, port }, () => {
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 10000);
      const reader = new FrameReader();
      const peer = {
        session, id: 0, name: null, address, socket, reader,
        lastSeen: Date.now(), stalled: false, stallCount: 0, pendingReason: null,
      };
      session.role = 'client';
      session.peers.set(0, peer);

      let announced = false;
      socket.on('data', (chunk) => {
        let frames;
        try { frames = reader.push(chunk); }
        catch { peer.pendingReason = 'bad-frame'; try { socket.destroy(); } catch { /* 'close' still fires */ } return; }
        for (const msg of frames) {
          if (!isWellFormedMessage(msg)) continue;
          if (!announced) {
            announced = true;
            clearTimeout(timer);
            finish(msg.t === 'bye' ? { ok: false, error: 'refused' } : { ok: true });
          }
          peer.lastSeen = Date.now();
          session.sender.send('net:message', 0, msg);
        }
      });
      socket.on('drain', () => { peer.stalled = false; peer.stallCount = 0; });
      socket.on('close', () => {
        clearTimeout(timer);
        if (!session.peers.has(0)) return; // net:leave already tore this down
        session.peers.delete(0);
        session.role = 'none';
        session.sender.send('net:peer', { kind: 'disconnected', id: 0, address, reason: peer.pendingReason ?? 'closed' });
        finish({ ok: false, error: 'refused' });
      });
      socket.on('error', () => {});

      // Every other encodeFrame call site in this file (sendByeAndClose,
      // sendFromRenderer) guards against a RangeError from an oversize
      // payload; this one didn't, and the throw happens inside a socket
      // 'connect' callback, not inside the surrounding Promise executor - so
      // it isn't caught by the Promise machinery, it's an uncaught exception
      // that takes down the whole main process. `hello` is renderer-supplied,
      // not remote-attacker-supplied, but a future bug that inflates it is
      // exactly the kind of failure this transport must contain instead of
      // amplify.
      let helloFrame;
      try { helloFrame = encodeFrame(hello); }
      catch { clearTimeout(timer); session.peers.delete(0); session.role = 'none'; try { socket.destroy(); } catch { /* already gone */ } finish({ ok: false, error: 'refused' }); return; }
      socket.write(helloFrame);
    });
  });
}

function leaveSession(session) {
  if (session.role !== 'client') return { ok: true };
  const peer = session.peers.get(0);
  session.peers.delete(0);
  session.role = 'none';
  if (peer) { silence(peer.socket); try { peer.socket.destroy(); } catch { /* already gone */ } }
  return { ok: true };
}

// --------------------------------------------------------------- discovery

function setDiscover(session, on) {
  if (on) {
    if (!session.browser) {
      session.browser = startBrowser((lobbies) => {
        // A session that is itself hosting must never see its own lobby in the join list.
        const visible = session.sid ? lobbies.filter((l) => l.sid !== session.sid) : lobbies;
        session.sender.send('net:lobbies', visible);
      });
    }
  } else if (session.browser) {
    session.browser.stop();
    session.browser = null;
  }
  return { ok: true };
}

function updateBeacon(session, record) {
  if (session.beacon && isPlainObject(record)) session.beacon.update(record);
}

// -------------------------------------------------------------------- info

function infoFor(session) {
  return {
    role: session.role,
    port: session.role === 'host' ? session.port : null,
    addresses: session.role === 'host' ? session.hostAddresses : [],
    peers: [...session.peers.values()].map((p) => ({ id: p.id, name: p.name, address: p.address })),
  };
}

function kickPeer(session, id, reason) {
  if (session.role !== 'host') return { ok: false };
  const peer = session.peers.get(id);
  if (!peer) return { ok: false };
  peer.pendingReason = reason ?? 'kicked';
  writeFrame(peer, { t: 'bye', reason: peer.pendingReason });
  return { ok: true };
}

// ------------------------------------------------------------ net:send path

/**
 * `msg` must be a plain object with a string `t` of <=32 chars; the encoded
 * frame must fit 256 KB - except `welcome`/`snapshot`, the two message types
 * that carry a full world snapshot, which are allowed up to `MAX_FRAME`. A
 * message that fails validation is dropped rather than crashing a peer with
 * an oversize or malformed frame; the digest heartbeat is what notices and
 * repairs the resulting divergence (see spec §10).
 */
function sendFromRenderer(session, to, msg) {
  if (!isWellFormedMessage(msg)) return;
  let frame;
  try { frame = encodeFrame(msg); } catch { return; }
  const limit = (msg.t === 'welcome' || msg.t === 'snapshot') ? MAX_FRAME : NET_SEND_MAX_BYTES;
  if (frame.length > limit) return;
  for (const peer of resolveTargets(session, to)) writeFrame(peer, msg, frame);
}

// ---------------------------------------------------------------- lifecycle

const sessions = new Map(); // webContents.id -> Session
let attached = false;

function sessionFor(sender) {
  let session = sessions.get(sender.id);
  if (!session) {
    session = createSession(sender);
    sessions.set(sender.id, session);
    sender.once('destroyed', () => { teardownSession(session); sessions.delete(sender.id); });
  }
  return session;
}

function teardownSession(session) {
  if (session.role === 'host') unhostSession(session, { reason: 'not-hosting' });
  else if (session.role === 'client') leaveSession(session);
  if (session.browser) { session.browser.stop(); session.browser = null; }
}

/** Registers every net:* ipcMain handler. Call once, from electron/main.js. */
export function attachNet() {
  if (attached) return;
  attached = true;

  const handle = (name, fn) => ipcMain.handle(name, (event, ...args) => {
    assertTrustedSender(event);
    return fn(sessionFor(event.sender), ...args);
  });
  handle('net:host', hostSession);
  handle('net:unhost', unhostSession);
  handle('net:join', joinSession);
  handle('net:leave', leaveSession);
  handle('net:discover', (session, on) => setDiscover(session, !!on));
  handle('net:info', infoFor);
  handle('net:kick', kickPeer);
  ipcMain.on('net:send', (event, to, msg) => { if (isTrustedSender(event)) sendFromRenderer(sessionFor(event.sender), to, msg); });
  ipcMain.on('net:beacon', (event, record) => { if (isTrustedSender(event)) updateBeacon(sessionFor(event.sender), record); });
}

/** Closes every socket and beacon/browser across every window. Call from
 * `win.on('close')` and `app.on('before-quit')` so a quitting host doesn't
 * leave guests hanging or a beacon advertising a lobby that's gone. */
export function stopAll() {
  for (const session of sessions.values()) teardownSession(session);
  sessions.clear();
}
