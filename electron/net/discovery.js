// LAN lobby discovery over UDP. Pure Node - only `node:dgram` and `node:os` -
// so it runs headlessly in tests, independent of Electron and of the TCP
// transport in ./lan.js.
//
// Both roles bind to the *same* fixed port with `reuseAddr: true` rather than
// letting the OS hand out an ephemeral one. That is what lets a beacon and a
// browser - or two beacons, one per hosting window - coexist in a single
// process, which is exactly the shape `probe-lan.js` needs (two BrowserWindows,
// one process, no single-instance lock).
//
// No multicast: `addMembership` throws on some interfaces and needs
// per-platform interface selection, for a case the manual IP:port field
// already covers.

import dgram from 'node:dgram';
import os from 'node:os';

export const DISCOVERY_PORT = 25718;
const MAGIC = 'SPACEMC';
const GLOBAL_BROADCAST = '255.255.255.255';
const LOOPBACK = '127.0.0.1';

function ipToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const b = Number(p);
    if (!Number.isInteger(b) || b < 0 || b > 255) return null;
    n = (n << 8) | b;
  }
  return n >>> 0;
}

function intToIp(n) {
  return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
}

/**
 * Every non-internal IPv4 interface's subnet broadcast address, computed from
 * its own netmask. `interfaces` defaults to `os.networkInterfaces()` but takes
 * an override so the interface math is a pure function under test rather than
 * a hostage to whatever NICs happen to be up on the machine running the suite.
 *
 * `255.255.255.255` alone is not sufficient in practice: measured on a
 * multi-homed Mac with two active adapters on the same /24 (en0 192.168.0.94,
 * en10 192.168.0.188), a send to the global broadcast address can fail with
 * EHOSTUNREACH, while a send to the subnet's own broadcast address
 * (192.168.0.255) is delivered - so `startBeacon` sends to both, and this
 * function is what supplies the addresses that actually work.
 */
export function subnetBroadcasts(interfaces = os.networkInterfaces()) {
  const out = new Set();
  for (const list of Object.values(interfaces)) {
    if (!list) continue;
    for (const info of list) {
      if (!info || info.internal || info.family !== 'IPv4' || !info.netmask) continue;
      const ip = ipToInt(info.address);
      const mask = ipToInt(info.netmask);
      if (ip === null || mask === null) continue;
      out.add(intToIp((ip & mask) | (~mask >>> 0)));
    }
  }
  return [...out];
}

/**
 * Advertise `record` (the beacon payload; `magic`/`v`/`sid` etc. are the
 * caller's concern, this module never inspects the fields it carries) roughly
 * every `interval` ms until `stop()`. Sent to the global broadcast address,
 * every interface's own subnet broadcast address, and `127.0.0.1` - the last
 * one is not in the wire spec's target list, but it is what makes same-machine
 * discovery (two windows, one host, `probe-lan.js`) independent of whether
 * this OS loops a real broadcast back to a local listener, which measurably
 * varies by platform and by how many NICs are up.
 *
 * A send to any one target failing (EHOSTUNREACH on the global address is
 * expected on some hosts) must never take the others down with it, so every
 * `socket.send` gets its own no-op error callback instead of letting dgram's
 * default behaviour turn a per-target failure into an `error` event.
 */
export function startBeacon(record, { interval = 1500 } = {}) {
  let current = { ...record };
  let timer = null;
  let closed = false;
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  socket.on('error', () => {}); // an unbindable port must not crash the host process

  const send = () => {
    if (closed) return;
    const payload = Buffer.from(JSON.stringify(current), 'utf8');
    const targets = new Set([GLOBAL_BROADCAST, LOOPBACK, ...subnetBroadcasts()]);
    for (const addr of targets) socket.send(payload, DISCOVERY_PORT, addr, () => {});
  };

  // A sender does not need the discovery receive port. Reserving it stole
  // loopback advertisements from the browser on operating systems that route
  // unicast to only one of the sockets sharing a port.
  socket.bind(0, () => {
    if (closed) return;
    try { socket.setBroadcast(true); } catch { /* some platforms are already broadcast-capable */ }
    send();
    timer = setInterval(send, interval);
    timer.unref?.();
  });

  return {
    /** Merge new fields (player count, mode, lock state, ...) into the advertised record. */
    update(next) { current = { ...current, ...next }; },
    stop() {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      try { socket.close(); } catch { /* not bound yet, or already closed */ }
    },
  };
}

/**
 * Listen for beacons and call `onChange(lobbies)` with the live set whenever
 * it changes - a new lobby heard, an existing one's fields refreshed, or one
 * expiring after `ttl` ms of silence.
 *
 * Two things a beacon payload must never be trusted for: the lobby's address,
 * because the payload cannot prove who sent it - `rinfo.address` is the only
 * address ever used - and identity by socket address at all, because a
 * multi-homed sender's single logical beacon measurably arrives as more than
 * one datagram (duplicate delivery across its own interfaces, sometimes with
 * different apparent source addresses). Lobbies are therefore keyed by the
 * beacon's own `sid`, with the most recently seen `rinfo.address` winning.
 */
export function startBrowser(onChange, { ttl = 4000 } = {}) {
  const lobbies = new Map(); // sid -> record incl. lastSeen
  let closed = false;
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  socket.on('error', () => {});

  const publish = () => {
    if (closed) return;
    onChange([...lobbies.values()].map(({ lastSeen, ...pub }) => pub));
  };

  socket.on('message', (buf, rinfo) => {
    let msg;
    try { msg = JSON.parse(buf.toString('utf8')); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.magic !== MAGIC || msg.v !== 1) return;
    if (typeof msg.sid !== 'string' || !msg.sid) return;
    lobbies.set(msg.sid, {
      sid: msg.sid,
      address: rinfo.address, // never msg.address - the payload has no such field, by design
      port: msg.port,
      proto: msg.proto,
      hash: msg.hash,
      name: msg.name,
      planetId: msg.planetId,
      mode: msg.mode,
      seed: msg.seed,
      players: msg.players,
      max: msg.max,
      locked: !!msg.locked,
      lastSeen: Date.now(),
    });
    publish();
  });

  const sweep = setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const [sid, rec] of lobbies) {
      if (now - rec.lastSeen > ttl) { lobbies.delete(sid); changed = true; }
    }
    if (changed) publish();
  }, Math.max(200, Math.floor(ttl / 8)));
  sweep.unref?.();

  socket.bind(DISCOVERY_PORT);

  return {
    stop() {
      if (closed) return;
      closed = true;
      clearInterval(sweep);
      try { socket.close(); } catch { /* not bound yet, or already closed */ }
    },
  };
}
