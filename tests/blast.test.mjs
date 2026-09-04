// blast.js tests. Run: node tests/blast.test.mjs
//
// Math.random is stubbed to throw for the whole file - computeBlast must
// never touch it, only the injected rng. That is the multiplayer precondition
// this test exists to guard.

import assert from 'node:assert/strict';
import {
  BLAST_R, BLAST_POWER, BLAST_MAX_R, BLAST_DROP_CAP, BLAST_DAMAGE,
  sphereOffsets, computeBlast, createBlastScratch, blastDamageAt,
} from '../app/js/blast.js';
import { BY_KEY, AIR } from '../app/js/blocks.js';
import { mulberry32 } from '../app/js/mobs.js';

const originalRandom = Math.random;
Math.random = () => { throw new Error('Math.random must never be called by the blast path'); };

// --- harness ----------------------------------------------------------------
let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; }
  catch (err) { failures.push({ name, err }); }
}
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b} (+-${eps})`);

const fillWorld = (id) => ({ getBlock: () => id });
const noDropRng = () => 1;   // >= BLAST_DROP_CHANCE always, so no rng() calls land inside dropFor

function countDestroyed(blockKey, rng = noDropRng) {
  const id = BY_KEY.get(blockKey).id;
  const world = fillWorld(id);
  const out = createBlastScratch();
  computeBlast(world, 0, 0, 0, BLAST_R, BLAST_POWER, rng, out);
  return out;
}

// ---------------------------------------------------------------- geometry
test('sphereOffsets(3.4) has exactly 171 candidates, cached and near-to-far', () => {
  const off = sphereOffsets(BLAST_R);
  assert.equal(off.length / 3, 171);
  const again = sphereOffsets(BLAST_R);
  assert.equal(off, again, 'must be cached, not rebuilt');

  let lastD2 = -1;
  for (let i = 0; i < off.length; i += 3) {
    const d2 = off[i] * off[i] + off[i + 1] * off[i + 1] + off[i + 2] * off[i + 2];
    assert.ok(d2 >= lastD2 - 1e-9, `not sorted near-to-far at index ${i / 3}`);
    lastD2 = d2;
  }
});

test('sphereOffsets(BLAST_MAX_R) fits inside MAX_BLAST_BLOCKS', () => {
  const off = sphereOffsets(BLAST_MAX_R);
  assert.ok(off.length / 3 <= 560, `${off.length / 3} candidates exceeds the scratch capacity`);
});

// ----------------------------------------------------------- destroy profile
test('the exact destruction profile from spec §3, one block type at a time', () => {
  const cases = [
    ['cloud', 147], ['ice', 93], ['dirt', 81], ['sulfur_crust', 81],
    ['stone', 33], ['storm_stone', 27], ['helium_ice', 19], ['furnace', 7],
    ['hull', 1], ['crystal_ore', 1], ['obsidian', 0], ['bedrock', 0],
  ];
  for (const [key, want] of cases) {
    const out = countDestroyed(key);
    assert.equal(out.n, want, `${key}: expected ${want} destroyed, got ${out.n}`);
  }
});

test('hull is destroyed only at the exact origin voxel', () => {
  const out = countDestroyed('hull');
  assert.equal(out.n, 1);
  assert.equal(out.edits[0], 0); assert.equal(out.edits[1], 0); assert.equal(out.edits[2], 0);
  assert.equal(out.edits[3], AIR);
  assert.equal(out.old[0], BY_KEY.get('hull').id);
});

test('liquids are never removed', () => {
  for (const key of ['water', 'lava', 'methane']) {
    const out = countDestroyed(key);
    assert.equal(out.n, 0, `${key} should never be destroyed`);
  }
});

test('drop list is capped at 24 even when 81 blocks break', () => {
  const rng = mulberry32(777);
  const out = countDestroyed('dirt', rng);
  assert.equal(out.n, 81);
  assert.ok(out.dn <= BLAST_DROP_CAP, `dn=${out.dn} exceeds the cap`);
});

test('out.old carries the right destroyed ids, parallel to out.edits', () => {
  const stoneId = BY_KEY.get('stone').id;
  const world = fillWorld(stoneId);
  const out = createBlastScratch();
  computeBlast(world, 5, 20, -3, BLAST_R, BLAST_POWER, noDropRng, out);
  assert.equal(out.n, 33);
  for (let i = 0; i < out.n; i++) {
    assert.equal(out.old[i], stoneId);
    assert.equal(out.edits[i * 4 + 3], AIR);
  }
});

// ------------------------------------------------------------- determinism
test('determinism: 100 runs, same seed and centre, byte-identical edits', () => {
  const world = fillWorld(BY_KEY.get('stone').id);
  const first = createBlastScratch();
  computeBlast(world, 1, 15, 1, BLAST_R, BLAST_POWER, mulberry32(42), first);
  const firstEdits = first.edits.slice(0, first.n * 4);
  const firstN = first.n, firstDn = first.dn;
  const firstDrops = first.drops.slice(0, first.dn * 5);

  for (let run = 0; run < 100; run++) {
    const out = createBlastScratch();
    computeBlast(world, 1, 15, 1, BLAST_R, BLAST_POWER, mulberry32(42), out);
    assert.equal(out.n, firstN, `run ${run}: n differs`);
    assert.equal(out.dn, firstDn, `run ${run}: dn differs`);
    for (let i = 0; i < firstN * 4; i++) assert.equal(out.edits[i], firstEdits[i], `run ${run}: edits[${i}] differs`);
    for (let i = 0; i < firstDn * 5; i++) assert.equal(out.drops[i], firstDrops[i], `run ${run}: drops[${i}] differs`);
  }
});

test('calling computeBlast twice into the same scratch is idempotent and allocates no new arrays', () => {
  const world = fillWorld(BY_KEY.get('dirt').id);
  const out = createBlastScratch();
  const editsRef = out.edits, oldRef = out.old, dropsRef = out.drops;
  computeBlast(world, 0, 20, 0, BLAST_R, BLAST_POWER, mulberry32(9), out);
  const n1 = out.n, dn1 = out.dn;
  const edits1 = out.edits.slice(0, n1 * 4);
  computeBlast(world, 0, 20, 0, BLAST_R, BLAST_POWER, mulberry32(9), out);
  assert.equal(out.n, n1);
  assert.equal(out.dn, dn1);
  assert.equal(out.edits, editsRef, 'edits array was reallocated');
  assert.equal(out.old, oldRef, 'old array was reallocated');
  assert.equal(out.drops, dropsRef, 'drops array was reallocated');
  for (let i = 0; i < n1 * 4; i++) assert.equal(out.edits[i], edits1[i]);
});

// -------------------------------------------------------------- blastDamageAt
test('blastDamageAt: 22 at centre, ~5.5 at r, 0 at 2r, monotonic', () => {
  const world = { getBlock: () => AIR };
  near(blastDamageAt(world, 0, 0, 0, BLAST_R, 0, 0, 0), BLAST_DAMAGE, 1e-9);
  near(blastDamageAt(world, 0, 0, 0, BLAST_R, BLAST_R, 0, 0), 5.5, 1e-6);
  near(blastDamageAt(world, 0, 0, 0, BLAST_R, 2 * BLAST_R, 0, 0), 0, 1e-9);
  near(blastDamageAt(world, 0, 0, 0, BLAST_R, 3 * BLAST_R, 0, 0), 0, 1e-9);

  let prev = Infinity;
  for (let d = 0; d <= 2 * BLAST_R; d += 0.2) {
    const dmg = blastDamageAt(world, 0, 0, 0, BLAST_R, d, 0, 0);
    assert.ok(dmg <= prev + 1e-9, `damage rose from ${prev} to ${dmg} at d=${d}`);
    prev = dmg;
  }
});

test('blastDamageAt cover check needs a unit direction: a wall past the target must not count', () => {
  // Regression: raycastVoxel marches P(t) = O + t*D and compares t directly
  // against maxDist in world units, so D must be a unit vector (see its other
  // caller, game.js's block-targeting raycast, which always normalizes). The
  // raw (tx-ox, ...) delta has magnitude d, not 1, so passed straight through
  // the march travelled up to d times too far past the real target and could
  // find "cover" nowhere near the actual line between blast and target.
  const stoneId = BY_KEY.get('stone').id;
  const wallBeyondTarget = { getBlock: (x, y, z) => (x === 3 && y === 0 && z === 0 ? stoneId : AIR) };
  const open = blastDamageAt({ getBlock: () => AIR }, 0, 0, 0, BLAST_R, 2, 0, 0);
  const withWallBehindTarget = blastDamageAt(wallBeyondTarget, 0, 0, 0, BLAST_R, 2, 0, 0);
  near(withWallBehindTarget, open, 1e-9);
});

test('blastDamageAt is halved when a solid block stands in the way', () => {
  const stoneId = BY_KEY.get('stone').id;
  const clear = { getBlock: () => AIR };
  const blocked = { getBlock: (x, y, z) => (x === 1 && y === 0 && z === 0 ? stoneId : AIR) };
  const open = blastDamageAt(clear, 0, 0, 0, BLAST_R, 2, 0, 0);
  const covered = blastDamageAt(blocked, 0, 0, 0, BLAST_R, 2, 0, 0);
  near(covered, open / 2, 1e-9);
});

// --- summary ----------------------------------------------------------------
Math.random = originalRandom;
for (const f of failures) {
  console.error(`FAIL  ${f.name}\n      ${f.err.stack ?? f.err.message}`);
}
const total = passed + failures.length;
console.log(`\nblast: ${passed}/${total} passed${failures.length ? `, ${failures.length} FAILED` : ''}`);
process.exit(failures.length ? 1 : 0);
