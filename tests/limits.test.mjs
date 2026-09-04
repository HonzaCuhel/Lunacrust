// World-bound tests. Run: node tests/limits.test.mjs
//
// canBuildAt and voidPhase are pure and get exercised directly. The flight
// clamp itself is not this module's code (it lives in player.js), but the
// void depth here only matters in relation to it, so the second half drives
// the real Player - against a stub all-air world, exactly the way game.js
// does - to prove flying stops at the two bounds and falling does not.

import assert from 'node:assert/strict';
import {
  BUILD_MIN, BUILD_MAX, VOID_TOP, VOID_FATAL, VOID_DPS, canBuildAt, voidPhase,
} from '../app/js/limits.js';
import { Player, FLIGHT_FLOOR, FLIGHT_CEIL } from '../app/js/player.js';
import { WORLD_H } from '../app/js/worldgen.js';

// --- harness ----------------------------------------------------------------
let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; }
  catch (err) { failures.push({ name, err }); }
}

// --- canBuildAt ---------------------------------------------------------
test('BUILD_MIN/BUILD_MAX bracket the real world height', () => {
  assert.equal(BUILD_MIN, 1);
  assert.equal(BUILD_MAX, WORLD_H - 1);
});

test('canBuildAt is inclusive at both ends and refuses outside them', () => {
  assert.equal(canBuildAt(BUILD_MIN), true);
  assert.equal(canBuildAt(BUILD_MAX), true);
  assert.equal(canBuildAt(BUILD_MIN - 1), false);
  assert.equal(canBuildAt(0), false);
  assert.equal(canBuildAt(BUILD_MAX + 1), false);
  assert.equal(canBuildAt(64), true);
});

// --- voidPhase ------------------------------------------------------------
test('voidPhase is inert at and above VOID_TOP', () => {
  assert.deepEqual(voidPhase(VOID_TOP), { dps: 0, fatal: false, haze: 0 });
  assert.deepEqual(voidPhase(VOID_TOP + 40), { dps: 0, fatal: false, haze: 0 });
});

test('voidPhase bites just below VOID_TOP but is not yet fatal', () => {
  const p = voidPhase(VOID_TOP - 1);
  assert.equal(p.dps, VOID_DPS);
  assert.equal(p.fatal, false);
  assert.ok(p.haze > 0 && p.haze < 1, `haze ${p.haze} should be in (0,1)`);
});

test('voidPhase haze ramps linearly from 0 at VOID_TOP to 1 at VOID_FATAL', () => {
  const span = VOID_TOP - VOID_FATAL;
  for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
    const y = VOID_TOP - span * frac;
    assert.ok(Math.abs(voidPhase(y).haze - frac) < 1e-9, `frac ${frac} at y=${y}`);
  }
});

test('voidPhase is fatal at and below VOID_FATAL, haze clamped at 1 beyond it', () => {
  assert.equal(voidPhase(VOID_FATAL).fatal, true);
  assert.equal(voidPhase(VOID_FATAL).haze, 1);
  const deep = voidPhase(VOID_FATAL - 500);
  assert.equal(deep.fatal, true);
  assert.equal(deep.haze, 1);
  assert.equal(deep.dps, VOID_DPS);
});

// --- the real Player against a stub all-air world ------------------------
// getBlock always returns AIR (0), which is not solid, so the player never
// collides with anything and only the flight clamp in player.js can stop it.
const AIR_WORLD = { getBlock: () => 0 };
const EARTH = { gravity: 9.81 };
const NO_INPUT = {
  forward: false, back: false, left: false, right: false,
  jump: false, sneak: false, sprint: false,
};

function step(p, input, seconds, dt = 0.05) {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) p.update(dt, input, AIR_WORLD);
}

test('flying up clamps exactly at FLIGHT_CEIL and sets hitLimit', () => {
  const p = new Player(EARTH);
  p.flying = true;
  p.setPosition({ x: 0.5, y: FLIGHT_CEIL - 5, z: 0.5 });
  step(p, { ...NO_INPUT, jump: true }, 6);
  assert.equal(p.pos.y, FLIGHT_CEIL);
  assert.equal(p.hitLimit, 'ceiling');
});

test('flying down clamps exactly at FLIGHT_FLOOR and sets hitLimit', () => {
  const p = new Player(EARTH);
  p.flying = true;
  p.setPosition({ x: 0.5, y: FLIGHT_FLOOR + 5, z: 0.5 });
  step(p, { ...NO_INPUT, sneak: true }, 6);
  assert.equal(p.pos.y, FLIGHT_FLOOR);
  assert.equal(p.hitLimit, 'floor');
});

test('falling (not flying) is never clamped and passes well below VOID_FATAL', () => {
  const p = new Player(EARTH);
  p.flying = false;
  p.setPosition({ x: 0.5, y: 5, z: 0.5 });
  step(p, NO_INPUT, 3);
  assert.ok(p.pos.y < VOID_FATAL, `expected below ${VOID_FATAL}, got ${p.pos.y}`);
  assert.equal(p.hitLimit, null);
});

test('flight clamps hold even at terminal-fall speeds arriving from above the ceiling', () => {
  // A player who was flying and released the stick right at the ceiling
  // should not punch through it on the very next frame.
  const p = new Player(EARTH);
  p.flying = true;
  p.setPosition({ x: 0.5, y: FLIGHT_CEIL, z: 0.5 });
  p.vel.y = 40;
  step(p, NO_INPUT, 1);
  assert.ok(p.pos.y <= FLIGHT_CEIL + 1e-6, `expected <= ${FLIGHT_CEIL}, got ${p.pos.y}`);
});

// --- summary ----------------------------------------------------------------
for (const f of failures) {
  console.error(`FAIL  ${f.name}\n      ${f.err.message.split('\n')[0]}`);
}
const total = passed + failures.length;
console.log(`\nlimits: ${passed}/${total} passed${failures.length ? `, ${failures.length} FAILED` : ''}`);
process.exit(failures.length ? 1 : 0);
