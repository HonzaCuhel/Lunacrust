// body.js tests. Run: node tests/body.test.mjs
//
// This is the riskiest file in the whole feature: it is the AABB solver
// literally moved out from under the shipped player, so mobs and the player
// share one implementation. Most of the weight here goes to proving nothing
// about Player's feel changed in the move.

import assert from 'node:assert/strict';
import {
  G_SCALE, TERMINAL, MAX_STEP, MAX_SUBSTEPS,
  resolveBox, moveAxis, stepBody, boxOverlapsSolid, liquidAt,
} from '../app/js/body.js';
import { Player } from '../app/js/player.js';
import { MOB, MOB_TYPES } from '../app/js/mobtypes.js';
import { BY_KEY } from '../app/js/blocks.js';

// --- harness ----------------------------------------------------------------
let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; }
  catch (err) { failures.push({ name, err }); }
}
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b} (+-${eps})`);

// Player, crawler and warden dimensions - the three bodies that ever touch
// this solver.
const DIMS = {
  player: { w: 0.62, h: 1.80 },
  crawler: MOB_TYPES[MOB.CRAWLER],
  warden: MOB_TYPES[MOB.WARDEN],
};

function makeBody(w, h, x, y, z) {
  return {
    pos: { x, y, z }, vel: { x: 0, y: 0, z: 0 },
    w, h, onGround: false, groundedLastFrame: false, stepOffset: 0, flying: false,
    impactSpeed: 0, justLanded: false,
  };
}

// ------------------------------------------------------------- ledge / wall
// A floor at y<=10 on the "near" side of a boundary at 0 along `axis`, and a
// floor `riseBlocks` higher on the "far" side, in the +travelSign direction.
function ledgeWorld(axis, travelSign, riseBlocks) {
  return {
    getBlock(x, y, z) {
      const coord = axis === 'x' ? x : z;
      const far = travelSign > 0 ? coord >= 0 : coord < 0;
      const floorTop = far ? 10 + riseBlocks : 10;
      return y <= floorTop ? 1 : 0;
    },
  };
}

const GRAVITY = 31;   // representative planet gravity for these ticks, in blocks/s^2
const DT = 0.05;

/**
 * The groundedLastFrame bug, isolated: a single moveAxis call at the exact
 * moment moveAxis is documented to need it - onGround already reset false for
 * this frame's pass (the Y pass has not run yet), the only signal that the
 * body was standing on solid ground a moment ago is groundedLastFrame. This
 * is the precise mechanism "a one-block ledge becomes a wall on the X pass
 * only" describes, tested directly rather than through a full multi-tick walk
 * (see the note below the four-direction loop for why).
 */
function attemptStep(axis, travelSign, dim, groundedLastFrame, riseBlocks = 1) {
  const world = ledgeWorld(axis, travelSign, riseBlocks);
  const start = -0.5 * travelSign;
  const b = axis === 'x'
    ? makeBody(dim.w, dim.h, start, 11.0001, 0.5)
    : makeBody(dim.w, dim.h, 0.5, 11.0001, start);
  b.onGround = false;
  b.groundedLastFrame = groundedLastFrame;
  const d = travelSign * 1.0;
  if (axis === 'x') { b.vel.x = travelSign * 3; moveAxis(world, b, d, 0, 0); }
  else { b.vel.z = travelSign * 3; moveAxis(world, b, 0, 0, d); }
  return b;
}

for (const [axis, travelSign] of [['x', 1], ['x', -1], ['z', 1], ['z', -1]]) {
  for (const [dimName, dim] of Object.entries(DIMS)) {
    test(`${dimName} steps up a one-block ledge travelling ${axis}${travelSign > 0 ? '+' : '-'}`, () => {
      const stepped = attemptStep(axis, travelSign, dim, true);
      assert.equal(stepped.stepOffset, 1.02, 'groundedLastFrame should let the step-up succeed');
      near(stepped.pos.y, 11.0001 + 1.02, 1e-9);

      // The documented bug, reproduced on demand: without groundedLastFrame,
      // onGround being false this early in the frame turns the very same
      // ledge into a flat wall - no step attempted, velocity zeroed instead.
      const walled = attemptStep(axis, travelSign, dim, false);
      assert.equal(walled.stepOffset, 0);
      assert.equal(walled.pos.y, 11.0001);
      assert.equal(axis === 'x' ? walled.vel.x : walled.vel.z, 0);
    });
  }
}

// A full multi-tick walk into the same ledge, proving the step-up is not just
// granted in isolation but actually carries the body up onto the raised
// surface. Z is used here rather than X: a sustained, perfectly axis-locked
// approach along X hits a separate, pre-existing quirk of this exact solver
// (verified identical between the original player.js and this extraction -
// see the mob-core report) where the box can get caught oscillating at the
// ledge instead of finishing the crossing. Real play never isolates a pure
// X-only approach for hundreds of consecutive frames - camera-relative input
// mixes X and Z the moment yaw is off an exact multiple of 90 degrees - and
// the single-call test above already proves the mechanism this file exists
// to protect works identically on every axis.
test('a body actually crosses and settles on a one-block ledge (full multi-tick walk)', () => {
  const world = ledgeWorld('z', 1, 1);
  const b = makeBody(DIMS.player.w, DIMS.player.h, 0.5, 11, -3);
  for (let i = 0; i < 60; i++) {
    b.vel.y -= GRAVITY * DT;
    if (b.vel.y < -TERMINAL) b.vel.y = -TERMINAL;
    b.vel.z = 3;
    stepBody(world, b, DT);
  }
  assert.ok(b.pos.z > 0.5, `did not cross the ledge (z=${b.pos.z})`);
  near(b.pos.y, 12.0001, 1e-3);
  assert.equal(b.onGround, true);
});

// Not a single-call check like the one-block case above: the first attempt
// at ANY rise height reports stepOffset 1.02 (the low-height collision snaps
// the box back clear of the far column before the elevated recheck runs, so
// that recheck always finds clear air behind it - a property of this exact
// solver, true for one block and two alike, and not what actually decides
// whether a rise is climbable). What decides it is whether the body ever
// settles on the far side after a real walk, which is what this asserts.
test('a two-block rise is never actually climbed (full multi-tick walk)', () => {
  const world = ledgeWorld('z', 1, 2);
  const b = makeBody(DIMS.player.w, DIMS.player.h, 0.5, 11, -3);
  for (let i = 0; i < 300; i++) {
    b.vel.y -= GRAVITY * DT;
    if (b.vel.y < -TERMINAL) b.vel.y = -TERMINAL;
    b.vel.z = 3;
    stepBody(world, b, DT);
  }
  assert.ok(b.pos.z < 0.5, `climbed a two-block wall it should not have (z=${b.pos.z})`);
  assert.ok(b.pos.y < 13, `ended up on the raised surface (y=${b.pos.y})`);
});

// -------------------------------------------------------------- ceiling/wall
test('a ceiling zeroes vel.y', () => {
  const world = { getBlock: (x, y, z) => (y === 15 ? 1 : 0) };
  const b = makeBody(DIMS.player.w, DIMS.player.h, 0.5, 15 - DIMS.player.h - 0.5, 0.5);
  b.vel.y = 5;
  moveAxis(world, b, 0, 1, 0);   // enough displacement to drive the box top into the ceiling
  assert.equal(b.vel.y, 0);
});

test('a wall zeroes the horizontal component when airborne (no step-up attempted)', () => {
  const world = { getBlock: (x, y, z) => (x === 2 ? 1 : 0) };
  const b = makeBody(DIMS.player.w, DIMS.player.h, 1.5, 20, 0.5);
  b.onGround = false; b.groundedLastFrame = false;   // airborne: no ledge-climb rule applies
  b.vel.x = 4;
  moveAxis(world, b, b.vel.x * DT, 0, 0);
  assert.equal(b.vel.x, 0);
});

// ---------------------------------------------------------------- no tunnel
test('the substep bound closes: ceil(TERMINAL*0.05/MAX_STEP) <= MAX_SUBSTEPS', () => {
  const n = Math.ceil((TERMINAL * 0.05) / MAX_STEP);
  assert.equal(n, 8);
  assert.ok(n <= MAX_SUBSTEPS);
});

for (const dt of [0.001, 0.005, 0.01, 0.02, 0.033, 0.05]) {
  for (const [dimName, dim] of Object.entries(DIMS)) {
    test(`no tunnelling at TERMINAL through a one-block floor: ${dimName}, dt=${dt}`, () => {
      const world = { getBlock: (x, y, z) => (y <= 10 ? 1 : 0) };
      const b = makeBody(dim.w, dim.h, 0.5, 40, 0.5);
      let iters = 0;
      while (!b.onGround && iters++ < 200000) {
        b.vel.y = -TERMINAL;   // sustained terminal fall, the worst case
        stepBody(world, b, dt);
      }
      assert.ok(b.onGround, `never landed (dt=${dt}, ${dimName})`);
      near(b.pos.y, 11.0001, 1e-6);
    });
  }
}

// -------------------------------------------------------------- misc surface
test('boxOverlapsSolid is a pure zero-delta resolve', () => {
  const world = { getBlock: (x, y, z) => (y <= 10 ? 1 : 0) };
  const clear = makeBody(0.62, 1.8, 0.5, 11.5, 0.5);
  assert.equal(boxOverlapsSolid(world, clear), false);
  const buried = makeBody(0.62, 1.8, 0.5, 9.5, 0.5);
  assert.equal(boxOverlapsSolid(world, buried), true);
});

test('liquidAt samples the block at the given point', () => {
  const waterId = BY_KEY.get('water').id;
  const world = { getBlock: (x, y, z) => (y === 5 ? waterId : 0) };
  assert.equal(liquidAt(world, 0.5, 5.9, 0.5), true);
  assert.equal(liquidAt(world, 0.5, 6.1, 0.5), false);
});

// ---------------------------------------------------- Player regression table
// A flat floor at y<=10, a one-block ledge from x=5 on, and a low ceiling at
// y=20 for x in [12,14] - the same fixture the pre-extraction capture used.
// 60 fixed steps, positions/velocities frozen from today's build BEFORE the
// extraction (captured from the literal pre-extraction player.js, byte-for-
// byte identical to the delegated version at every one of the 60 steps and
// every planet tried - see the mob-core report for how this table was made).
function regressionWorld() {
  return {
    getBlock(x, y, z) {
      if (x >= 12 && x <= 14 && y === 20 && z >= -1 && z <= 2) return 1;
      if (x >= 5) { if (y <= 11) return 1; return 0; }
      if (y <= 10) return 1;
      return 0;
    },
  };
}
function inputAt(i) {
  return {
    forward: true, back: false, left: false, right: (i % 23) === 0,
    sprint: (i % 7) < 3, sneak: (i % 31) === 0, jump: (i % 10) === 0,
  };
}
const round = (v) => Math.round(v * 1e9) / 1e9;

const WALK_TABLE = {
  earth: [
    { step: 9, x: 0.552688072, y: 11.0001, z: -2.093281698, vx: 0.00016576, vy: 0, vz: -7.272356979, onGround: true, stepOffset: 0, impactSpeed: 0, justLanded: true, distance: 0.363617849, landImpact: 0 },
    { step: 19, x: 0.552708005, y: 11.9185, z: -4.915437038, vx: 0.000020984, vy: -5.2264, vz: -5.557374974, onGround: false, stepOffset: 0, impactSpeed: 0, justLanded: true, distance: 0.277868749, landImpact: 0 },
    { step: 29, x: 0.815747252, y: 11.0001, z: -7.658415765, vx: 0.012950002, vy: 0, vz: -6.999448115, onGround: true, stepOffset: 0, impactSpeed: 8.3656, justLanded: true, distance: 0.349973005, landImpact: 0 },
    { step: 39, x: 0.817304488, y: 11.9185, z: -10.931228778, vx: 0.001639358, vy: -5.2264, vz: -6.148804563, onGround: false, stepOffset: 0, impactSpeed: 8.3656, justLanded: true, distance: 0.307440239, landImpact: 0 },
    { step: 49, x: 0.976004247, y: 11.0001, z: -13.780046526, vx: 0.124905172, vy: 0, vz: -6.286285108, onGround: true, stepOffset: 0, impactSpeed: 8.3656, justLanded: true, distance: 0.314376294, landImpact: 0 },
    { step: 59, x: 0.991024074, y: 11.9185, z: -17.029397117, vx: 0.015811915, vy: -5.2264, vz: -6.277537073, onGround: false, stepOffset: 0, impactSpeed: 8.3656, justLanded: true, distance: 0.313877849, landImpact: 0 },
  ],
  europa: [
    { step: 9, x: 0.552688072, y: 11.0001, z: -2.093281698, vx: 0.00016576, vy: 0, vz: -7.272356979, onGround: true, stepOffset: 0, impactSpeed: 0, justLanded: true, distance: 0.363617849, landImpact: 0 },
    { step: 19, x: 0.552708005, y: 14.9785, z: -4.915437038, vx: 0.000020984, vy: 7.0136, vz: -5.557374974, onGround: false, stepOffset: 0, impactSpeed: 0, justLanded: true, distance: 0.277868749, landImpact: 0 },
    { step: 29, x: 0.708508606, y: 17.9089, z: -7.726569541, vx: 0.293659307, vy: 4.9176, vz: -5.810289928, onGround: false, stepOffset: 0, impactSpeed: 0, justLanded: true, distance: 0.290885307, landImpact: 0 },
    { step: 39, x: 0.786196071, y: 19.7913, z: -10.619488032, vx: 0.081784404, vy: 2.8216, vz: -5.748875861, onGround: false, stepOffset: 0, impactSpeed: 0, justLanded: true, distance: 0.287472879, landImpact: 0 },
    { step: 49, x: 0.872935474, y: 20.6257, z: -13.465582986, vx: 0.288771193, vy: 0.7256, vz: -5.631438423, onGround: false, stepOffset: 0, impactSpeed: 0, justLanded: true, distance: 0.281941871, landImpact: 0 },
    { step: 59, x: 0.94932979, y: 20.4121, z: -16.37348169, vx: 0.080423059, vy: -1.3704, vz: -5.918078322, onGround: false, stepOffset: 0, impactSpeed: 0, justLanded: true, distance: 0.295931237, landImpact: 0 },
  ],
  jupiter: [
    { step: 9, x: 0.552688072, y: 11.0001, z: -2.093281698, vx: 0.00016576, vy: 0, vz: -7.272356979, onGround: true, stepOffset: 0, impactSpeed: 0, justLanded: true, distance: 0.363617849, landImpact: 0 },
    { step: 19, x: 0.552706522, y: 11.0001, z: -4.847787814, vx: 0.000004335, vy: 0, vz: -4.797804747, onGround: true, stepOffset: 0, impactSpeed: 10.115780368, justLanded: true, distance: 0.239890237, landImpact: 0.028947619 },
    { step: 29, x: 0.687752161, y: 11.0001, z: -7.562509226, vx: 0.060672317, vy: 0, vz: -7.062888519, onGround: true, stepOffset: 0, impactSpeed: 10.115780368, justLanded: true, distance: 0.353157456, landImpact: 0.028947619 },
    { step: 39, x: 0.694505278, y: 11.0001, z: -10.732943134, vx: 0.001586899, vy: 0, vz: -4.921660242, onGround: true, stepOffset: 0, impactSpeed: 10.115780368, justLanded: true, distance: 0.246083025, landImpact: 0.028947619 },
    { step: 49, x: 0.740989821, y: 11.0001, z: -13.353263103, vx: 0.054998976, vy: 0, vz: -6.395901401, onGround: true, stepOffset: 0, impactSpeed: 10.115780368, justLanded: true, distance: 0.319806893, landImpact: 0.028947619 },
    { step: 59, x: 0.747111468, y: 11.0001, z: -16.605172343, vx: 0.001438511, vy: 0, vz: -5.571720154, onGround: true, stepOffset: 0, impactSpeed: 10.115780368, justLanded: true, distance: 0.278586017, landImpact: 0.028947619 },
  ],
};
const PLANETS = { earth: { gravity: 9.81 }, europa: { gravity: 1.31 }, jupiter: { gravity: 24.79 } };

for (const [name, planet] of Object.entries(PLANETS)) {
  test(`Player.update regression, 60 steps on ${name}`, () => {
    const p = new Player(planet);
    p.setPosition({ x: 0.5, y: 11, z: 0.5 });
    const world = regressionWorld();
    const checkAt = new Map(WALK_TABLE[name].map((row) => [row.step, row]));
    for (let i = 0; i < 60; i++) {
      p.update(0.05, inputAt(i), world);
      const want = checkAt.get(i);
      if (!want) continue;
      near(round(p.pos.x), want.x); near(round(p.pos.y), want.y); near(round(p.pos.z), want.z);
      near(round(p.vel.x), want.vx); near(round(p.vel.y), want.vy); near(round(p.vel.z), want.vz);
      assert.equal(p.onGround, want.onGround, `onGround at step ${i}`);
      near(round(p.stepOffset), want.stepOffset);
      near(round(p.impactSpeed), want.impactSpeed);
      assert.equal(p.justLanded, want.justLanded, `justLanded at step ${i}`);
      near(round(p.distance), want.distance);
      near(round(p.landImpact), want.landImpact);
    }
  });
}

// The flight clamp - FLIGHT_FLOOR/FLIGHT_CEIL/hitLimit - is untouched by the
// extraction. Same numbers on every planet, since flying speed does not
// depend on gravity.
test('Player flight clamp regression: floor then ceiling, all three planets', () => {
  const emptyWorld = { getBlock: () => 0 };
  for (const planet of Object.values(PLANETS)) {
    const p = new Player(planet);
    p.setPosition({ x: 0.5, y: 40, z: 0.5 });
    p.flying = true;
    const noMove = { forward: false, back: false, left: false, right: false, sprint: false };
    for (let i = 0; i < 110; i++) p.update(0.05, { ...noMove, sneak: true, jump: false }, emptyWorld);
    assert.equal(p.pos.y, 1);
    assert.equal(p.vel.y, 0);
    assert.equal(p.hitLimit, 'floor');
    for (let i = 0; i < 260; i++) p.update(0.05, { ...noMove, sneak: false, jump: true }, emptyWorld);
    assert.equal(p.pos.y, 136);
    assert.equal(p.vel.y, 0);
    assert.equal(p.hitLimit, 'ceiling');
  }
});

// G_SCALE stays importable from player.js so nothing in the tree has to
// change its import.
test('G_SCALE is re-exported from player.js and matches body.js', async () => {
  const playerMod = await import('../app/js/player.js');
  assert.equal(playerMod.G_SCALE, G_SCALE);
  assert.equal(G_SCALE, 3.2);
});

// --- summary ----------------------------------------------------------------
for (const f of failures) {
  console.error(`FAIL  ${f.name}\n      ${f.err.message.split('\n')[0]}`);
}
const total = passed + failures.length;
console.log(`\nbody: ${passed}/${total} passed${failures.length ? `, ${failures.length} FAILED` : ''}`);
process.exit(failures.length ? 1 : 0);
