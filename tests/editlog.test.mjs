// Tests for app/js/editlog.js: round-trip serialization, cross-chunk voxel
// indexing, the order-independent digest, and tolerance of a hand-edited save.

import assert from 'node:assert/strict';
import { EditLog, chunkKey } from '../app/js/editlog.js';
import { CHUNK_SX, CHUNK_SZ, WORLD_H, vIndex } from '../app/js/worldgen.js';

// -------------------------------------------------------------------- runner
let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok    ${name}`); }
  catch (e) { fail++; failures.push([name, e]); console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

console.log('\neditlog.test.mjs\n');

// ------------------------------------------------------------ round-trip

t('get() is null before anything is set, and returns what was set', () => {
  const log = new EditLog();
  assert.equal(log.get(3, 4, 5), null);
  log.set(3, 4, 5, 7);
  assert.equal(log.get(3, 4, 5), 7);
  assert.equal(log.size, 1);
});

t('overwriting a cell updates get() and keeps size at 1', () => {
  const log = new EditLog();
  log.set(1, 2, 3, 5);
  log.set(1, 2, 3, 9);
  assert.equal(log.get(1, 2, 3), 9);
  assert.equal(log.size, 1);
});

t('serialize()/load() round-trips across multiple chunks, including negative ones', () => {
  const cells = [
    [0, 1, 0, 3], [15, 5, 15, 4], [16, 5, 0, 7], [-1, 5, 0, 2],
    [-17, 60, -33, 9], [200, 100, -200, 1],
  ];
  const log = new EditLog();
  for (const [x, y, z, id] of cells) log.set(x, y, z, id);

  const obj = log.serialize();
  // Exactly today's World.serializeEdits() shape: "cx,cz" -> flat [idx,id,...].
  for (const key of Object.keys(obj)) {
    assert.ok(/^-?\d+,-?\d+$/.test(key), `key "${key}" must be "cx,cz"`);
    assert.equal(obj[key].length % 2, 0, 'flat array must be idx/id pairs');
  }

  const loaded = new EditLog();
  loaded.load(obj);
  for (const [x, y, z, id] of cells) assert.equal(loaded.get(x, y, z), id, `(${x},${y},${z})`);
  assert.equal(loaded.size, cells.length);
  assert.equal(loaded.digest, log.digest, 'a round trip must not change the digest');
});

t('load() clears whatever was there before', () => {
  const log = new EditLog();
  log.set(0, 1, 0, 5);
  log.load({});
  assert.equal(log.get(0, 1, 0), null);
  assert.equal(log.size, 0);
  assert.equal(log.digest, new EditLog().digest, 'an empty log always digests the same');
});

// ------------------------------------------------------- cross-chunk indexing

t('forChunk() and get() agree on which chunk a boundary voxel belongs to', () => {
  const log = new EditLog();
  log.set(15, 8, 15, 11);   // last voxel of chunk (0,0)
  log.set(16, 8, 0, 12);    // first voxel of chunk (1,0)
  log.set(0, 8, 16, 13);    // first voxel of chunk (0,1)
  log.set(-1, 8, 0, 14);    // last voxel of chunk (-1,0)

  assert.equal(log.forChunk(0, 0).get(vIndex(15, 8, 15)), 11);
  assert.equal(log.forChunk(1, 0).get(vIndex(0, 8, 0)), 12);
  assert.equal(log.forChunk(0, 1).get(vIndex(0, 8, 0)), 13);
  assert.equal(log.forChunk(-1, 0).get(vIndex(15, 8, 0)), 14);
  assert.equal(log.forChunk(5, 5), undefined, 'an untouched chunk has no entry at all');

  assert.equal(log.get(15, 8, 15), 11);
  assert.equal(log.get(16, 8, 0), 12);
  assert.equal(log.get(0, 8, 16), 13);
  assert.equal(log.get(-1, 8, 0), 14);
});

t('the map getter is keyed exactly like chunkKey() and shaped for restoreLights()', () => {
  const log = new EditLog();
  log.set(20, 3, 20, 6);   // chunk (1,1)
  const m = log.map;
  assert.ok(m instanceof Map);
  assert.ok(m.get(chunkKey(1, 1)) instanceof Map);
  assert.equal(m.get(chunkKey(1, 1)).get(vIndex(4, 3, 4)), 6);
});

t('a full-height, full-width voxel index round-trips through set/get', () => {
  const log = new EditLog();
  const x = 7, y = WORLD_H - 2, z = CHUNK_SZ - 1;
  log.set(x, y, z, 42);
  assert.equal(log.get(x, y, z), 42);
});

// ------------------------------------------------------------------- digest

/** A little seeded PRNG so "apply in N different orders" is reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

t('digest is order-independent: the same final cells, applied in 5 different orders, digest the same', () => {
  const rng = mulberry32(1234);
  // A set of *unique* cells standing in for a final world state - the claim
  // under test is that Map iteration order (insertion order) never affects
  // the digest, not what happens mid-way through an overwrite chain (that is
  // the separate test below).
  const seen = new Map();
  while (seen.size < 60) {
    const x = Math.floor(rng() * 10) - 5, y = 1 + Math.floor(rng() * 20), z = Math.floor(rng() * 10) - 5;
    seen.set(`${x},${y},${z}`, [x, y, z, Math.floor(rng() * 250)]);
  }
  const edits = [...seen.values()];

  const digests = [];
  for (let order = 0; order < 5; order++) {
    const log = new EditLog();
    for (const [x, y, z, id] of shuffled(edits, mulberry32(900 + order))) log.set(x, y, z, id);
    digests.push(log.digest);
  }
  for (const d of digests) assert.equal(d, digests[0], `order produced ${d}, expected ${digests[0]}`);
});

t('digest is order-independent regardless of how many times a cell was overwritten first', () => {
  const a = new EditLog();
  a.set(1, 1, 1, 5);

  const b = new EditLog();
  b.set(1, 1, 1, 9);
  b.set(1, 1, 1, 2);
  b.set(1, 1, 1, 5);   // same final value as `a`, three overwrites deep

  assert.equal(a.digest, b.digest);
});

t('a single dropped edit changes the digest', () => {
  const full = new EditLog();
  full.set(0, 1, 0, 3);
  full.set(1, 1, 0, 4);
  full.set(2, 1, 0, 5);

  const dropped = new EditLog();
  dropped.set(0, 1, 0, 3);
  dropped.set(2, 1, 0, 5);   // the middle edit never arrived

  assert.notEqual(full.digest, dropped.digest);
});

t('a single differing value changes the digest even with the same cells touched', () => {
  const a = new EditLog();
  a.set(4, 2, 4, 10);
  const b = new EditLog();
  b.set(4, 2, 4, 11);
  assert.notEqual(a.digest, b.digest);
});

t('digest is always 8 lowercase hex characters', () => {
  const log = new EditLog();
  assert.match(log.digest, /^[0-9a-f]{8}$/);
  for (let i = 0; i < 30; i++) log.set(i, 1, 0, i % 250);
  assert.match(log.digest, /^[0-9a-f]{8}$/);
});

// -------------------------------------------------------- hand-edited saves

t('load() tolerates a hand-edited save: garbage entries are skipped, not thrown', () => {
  const log = new EditLog();
  assert.doesNotThrow(() => log.load({
    'not-a-key': [0, 1],
    '1,1': 'not an array',
    '2,2': [0],                 // odd length
    '3,3': [0, 300],            // id out of Uint8 range
    '4,4': [-1, 5],             // negative index
    '5,5': [999999, 5],         // index past the volume
    '6,6': [0, 1.5],            // non-integer id
    '7,7': [0, 5, 10, 6],       // two genuinely good pairs, alongside all the garbage above
  }));
  // Chunk (7,7): idx 0 -> local (0,0,0), idx 10 -> local (10,0,0).
  assert.equal(log.get(7 * CHUNK_SX + 0, 0, 7 * CHUNK_SZ + 0), 5);
  assert.equal(log.get(7 * CHUNK_SX + 10, 0, 7 * CHUNK_SZ + 0), 6);
  assert.equal(log.size, 2, 'only the two well-formed pairs were adopted');
});

t('load() on a completely non-object input clears rather than throws', () => {
  const log = new EditLog();
  log.set(0, 1, 0, 5);
  assert.doesNotThrow(() => log.load(null));
  assert.equal(log.size, 0);
  assert.doesNotThrow(() => log.load(undefined));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nfailures:');
  for (const [name, e] of failures) console.log(`  ${name}: ${e.stack}`);
}
process.exit(fail ? 1 : 0);
