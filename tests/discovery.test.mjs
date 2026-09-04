// discovery.test.mjs - electron/net/discovery.js: the pure interface-to-
// broadcast-address math, and a real beacon talking to a real browser over
// loopback in this one process (no second machine, no Electron).
//
// UDP discovery needs a real bound socket to prove anything, and some CI
// sandboxes forbid that outright (or leave a stale listener from a previous
// run holding the port). That is an environment fact, not a bug in this
// module, so a real bind is attempted first and the whole file degrades to a
// SKIP - never a FAIL - on exactly the errors that mean "cannot run here."

import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { DISCOVERY_PORT, subnetBroadcasts, startBeacon, startBrowser } from '../electron/net/discovery.js';

async function canBindDiscoveryPort() {
  return new Promise((resolve) => {
    const probe = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    probe.once('error', (err) => {
      const sandboxed = err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EADDRINUSE';
      resolve(!sandboxed); // any other error is a real bug - let the real test surface it
    });
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.bind(DISCOVERY_PORT);
  });
}

if (!(await canBindDiscoveryPort())) {
  console.log(`SKIP  discovery.test.mjs: cannot bind UDP ${DISCOVERY_PORT} in this sandbox`);
  process.exit(0);
}

let pass = 0;
const check = async (name, fn) => { await fn(); pass++; console.log('  ok  ' + name); };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { timeout = 2000, interval = 20 } = {}) {
  const start = Date.now();
  for (;;) {
    const v = predicate();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`waitFor: timed out after ${timeout}ms`);
    await sleep(interval);
  }
}

// --------------------------------------------------------- pure interface math

await check('subnetBroadcasts derives each /24 broadcast and dedupes two NICs on the same subnet', () => {
  // The facts this project measured on its own dev machine: two active
  // adapters, both on 192.168.0.0/24, must fold down to one target address.
  const fake = {
    en0: [{ address: '192.168.0.94', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
    en10: [{ address: '192.168.0.188', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
    lo0: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true }],
    en0v6: [{ address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', internal: false }],
  };
  assert.deepEqual(subnetBroadcasts(fake), ['192.168.0.255']);
});

await check('subnetBroadcasts keeps distinct subnets separate and tolerates a missing netmask', () => {
  const fake = {
    a: [{ address: '10.0.5.20', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
    b: [{ address: '172.16.9.9', netmask: '255.255.0.0', family: 'IPv4', internal: false }],
    c: [{ address: '10.0.9.9', netmask: null, family: 'IPv4', internal: false }], // defensive: never throws
  };
  assert.deepEqual(subnetBroadcasts(fake).sort(), ['10.0.5.255', '172.16.255.255']);
});

await check('an interface list with nothing usable yields no targets, not a throw', () => {
  assert.deepEqual(subnetBroadcasts({ lo0: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true }] }), []);
});

// -------------------------------------------------- real beacon, real browser, loopback

await check('a real beacon is heard by a real browser: fields parse, and the address is rinfo, never the payload', async () => {
  const sid = crypto.randomBytes(4).toString('hex');
  const record = {
    magic: 'SPACEMC', v: 1, sid, proto: 1, hash: 'aabbccdd',
    name: "Jan's Luna", planetId: 'luna', mode: 'survival', seed: 1234567,
    players: 1, max: 8, locked: false, port: 40710, // deliberately outside the real 25710-25717 TCP range - fixture noise must never look like a real game port
    address: '6.6.6.6', // a lie the payload has no business carrying - the browser must ignore it
  };
  let lobbies = [];
  const browser = startBrowser((list) => { lobbies = list; }, { ttl: 4000 });
  const beacon = startBeacon(record, { interval: 30 });
  try {
    const found = await waitFor(() => lobbies.find((l) => l.sid === sid));
    assert.notEqual(found.address, '6.6.6.6', 'the payload cannot assert its own address');
    assert.ok(typeof found.address === 'string' && found.address.length > 0, 'rinfo always supplies a real address');
    assert.equal(found.port, 40710, 'the game port is a legitimate payload field, unlike the address');
    assert.equal(found.name, "Jan's Luna");
    assert.equal(found.planetId, 'luna');
    assert.equal(found.mode, 'survival');
    assert.equal(found.seed, 1234567);
    assert.equal(found.locked, false);
    assert.equal(found.hash, 'aabbccdd');
  } finally {
    beacon.stop();
    await sleep(80); // let any already-sent straggler land here, not in the next check's browser
    browser.stop();
  }
});

await check('duplicate delivery of the same beacon coalesces into exactly one lobby, keyed by sid', async () => {
  // A beacon fans one advertisement out to several targets (global broadcast,
  // loopback, every interface's subnet broadcast); on a real multi-homed LAN
  // that lands as more than one datagram for the same logical lobby. This
  // reproduces that shape directly - many independent sends of the identical
  // sid - rather than depending on this sandbox actually owning two NICs.
  const sid = crypto.randomBytes(4).toString('hex');
  const record = { magic: 'SPACEMC', v: 1, sid, proto: 1, hash: '11223344', name: 'Dup Test', planetId: 'mars', mode: 'creative', seed: 7, players: 1, max: 8, locked: false, port: 40711 };
  let lobbies = [];
  const browser = startBrowser((list) => { lobbies = list; }, { ttl: 4000 });
  const beacon = startBeacon(record, { interval: 25 });
  try {
    await waitFor(() => lobbies.find((l) => l.sid === sid));
    await sleep(200); // several more ticks; each tick sends to multiple targets
    const matches = lobbies.filter((l) => l.sid === sid);
    assert.equal(matches.length, 1, `repeated/duplicate arrivals of one sid must not multiply lobbies (saw ${matches.length})`);
  } finally {
    beacon.stop();
    await sleep(80);
    browser.stop();
  }
});

await check('garbage datagrams are ignored: no crash, no lobby, real beacons keep working', async () => {
  let lobbies = [];
  const browser = startBrowser((list) => { lobbies = list; }, { ttl: 4000 });
  const junk = dgram.createSocket('udp4');
  try {
    const send = (buf) => new Promise((resolve) => junk.send(buf, DISCOVERY_PORT, '127.0.0.1', () => resolve()));
    await send(Buffer.from('not json at all'));
    await send(Buffer.from(JSON.stringify({ magic: 'WRONG', v: 1, sid: 'aaaaaaaa' })));
    await send(Buffer.from(JSON.stringify({ magic: 'SPACEMC', v: 2, sid: 'bbbbbbbb' })));
    await send(Buffer.from(JSON.stringify({ magic: 'SPACEMC', v: 1 }))); // no sid
    await sleep(150);
    // Checked by sid, not by list length: a straggler UDP packet from a
    // previous check's just-stopped beacon can still be in flight when this
    // browser binds, since stopping a beacon cannot recall a packet already
    // handed to the OS. None of *these* crafted sids can ever become valid.
    assert.ok(!lobbies.some((l) => l.sid === 'aaaaaaaa'), 'wrong magic must not become a lobby');
    assert.ok(!lobbies.some((l) => l.sid === 'bbbbbbbb'), 'wrong version must not become a lobby');

    // The listener must still be alive and correct after absorbing garbage.
    const sid = crypto.randomBytes(4).toString('hex');
    const beacon = startBeacon({ magic: 'SPACEMC', v: 1, sid, proto: 1, hash: 'ffffffff', name: 'After Junk', planetId: 'luna', mode: 'survival', seed: 1, players: 1, max: 8, locked: false, port: 40710 }, { interval: 30 });
    try {
      const found = await waitFor(() => lobbies.find((l) => l.sid === sid));
      assert.equal(found.name, 'After Junk');
    } finally {
      beacon.stop();
    }
  } finally {
    junk.close();
    browser.stop();
  }
});

await check('a lobby expires after ttl of silence and disappears from the published list', async () => {
  const sid = crypto.randomBytes(4).toString('hex');
  const record = { magic: 'SPACEMC', v: 1, sid, proto: 1, hash: '55667788', name: 'Expiring', planetId: 'venus', mode: 'survival', seed: 9, players: 1, max: 8, locked: false, port: 40712 };
  let lobbies = [];
  const browser = startBrowser((list) => { lobbies = list; }, { ttl: 250 });
  const beacon = startBeacon(record, { interval: 30 });
  try {
    await waitFor(() => lobbies.find((l) => l.sid === sid));
    beacon.stop(); // stop advertising; silence should age the entry out
    await waitFor(() => !lobbies.find((l) => l.sid === sid), { timeout: 3000 });
  } finally {
    beacon.stop();
    await sleep(80);
    browser.stop();
  }
});

await check('update() changes what the next beacon tick advertises', async () => {
  const sid = crypto.randomBytes(4).toString('hex');
  const record = { magic: 'SPACEMC', v: 1, sid, proto: 1, hash: '99aabbcc', name: 'Before', planetId: 'luna', mode: 'survival', seed: 3, players: 1, max: 8, locked: false, port: 40710 };
  let lobbies = [];
  const browser = startBrowser((list) => { lobbies = list; }, { ttl: 4000 });
  const beacon = startBeacon(record, { interval: 30 });
  try {
    await waitFor(() => lobbies.find((l) => l.sid === sid));
    beacon.update({ players: 4, locked: true });
    const updated = await waitFor(() => {
      const l = lobbies.find((x) => x.sid === sid);
      return l && l.players === 4 ? l : null;
    });
    assert.equal(updated.locked, true);
    assert.equal(updated.name, 'Before', 'update() merges - fields not passed are untouched');
  } finally {
    beacon.stop();
    await sleep(80);
    browser.stop();
  }
});

console.log(`\n${pass} checks passed`);
process.exit(0);
