// mobs.js tests. Run: node tests/mobs.test.mjs
//
// A fake world ({getBlock, isLoaded}) and a fake ctx, stepped at fixed 0.05
// like the survival tests. Every AI assertion uses an injected rng, so it is
// deterministic rather than flaky.

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  Mobs, mulberry32, MAX_MOBS, SIM_DT, STATE, probeStep, chooseHeading, knockbackImpulse,
} from '../app/js/mobs.js';
import { MOB, MOB_TYPES, mobJumpImpulse, mobSafeImpact, maxDropFor } from '../app/js/mobtypes.js';
import { BY_KEY, AIR } from '../app/js/blocks.js';
import { G_SCALE, boxOverlapsSolid } from '../app/js/body.js';
import { itemIdOf } from '../app/js/items.js';

// --- harness ----------------------------------------------------------------
let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; }
  catch (err) { failures.push({ name, err }); }
}
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b} (+-${eps})`);

const STONE = BY_KEY.get('stone').id;
const LAVA = BY_KEY.get('lava').id;

// --- fixtures ----------------------------------------------------------------
const EARTH = { id: 'earth', gravity: 9.81, terrain: { layers: { deep: 'stone' } }, mobs: { crawler: 1, warden: 1 } };
const JUPITER = { id: 'jupiter', gravity: 24.79, terrain: { layers: { deep: 'storm_stone' } }, mobs: { crawler: 1, warden: 1 } };
const PLANET_GRAVITIES = [9.81, 1.62, 3.72, 8.87, 24.79, 1.31, 1.80, 1.35];   // the eight worlds, spec §0

/** Solid floor at y<=10, open sky above, everything loaded. */
function flatWorld(extra) {
  return {
    getBlock(x, y, z) {
      if (extra) { const v = extra(x, y, z); if (v !== undefined) return v; }
      return y <= 10 ? STONE : AIR;
    },
    isLoaded: () => true,
  };
}
/** A solid wall at x===wallX from y=11..14, blocking line of sight. */
function wallWorld(wallX) {
  return flatWorld((x, y, z) => (x === wallX && y >= 11 && y <= 14 ? STONE : undefined));
}
/**
 * A one-room shelter: floor at y<=10 (as flatWorld), open air y=11..14, then
 * solid ceiling extending upward without end from y=15 - so the only valid
 * landing surface within the spawn scan is the floor, roofed by real opaque
 * mass rather than a landing-pad-shaped roof the scan would stand on top of.
 */
function roofedWorld() {
  return flatWorld((x, y, z) => (y >= 15 ? STONE : undefined));
}

function baseCtx(over = {}) {
  const rec = { hurt: [], push: [], drops: [], setBlocksCalls: [], burst: 0, blast: 0, onHit: [] };
  const ctx = {
    world: flatWorld(),
    planet: EARTH, mode: 'survival', paused: false, dead: false,
    gravity: EARTH.gravity * G_SCALE,
    playerPos: { x: 0.5, y: 11, z: 0.5 }, playerEyeY: 12.62, playerW: 0.62, playerH: 1.8,
    daylight: 0, enabled: true,
    blocked: () => false,
    hurtPlayer: (amount, cause) => rec.hurt.push({ amount, cause }),
    pushPlayer: (vx, vy, vz) => rec.push.push({ vx, vy, vz }),
    spawnDrop: (x, y, z, itemId, count) => rec.drops.push({ x, y, z, itemId, count }),
    burst: () => { rec.burst++; },
    onBlast: () => { rec.blast++; },
    setBlocks: (flat, n) => { rec.setBlocksCalls.push(n); },
    onHit: (id, killed) => rec.onHit.push({ id, killed }),
    ...over,
  };
  ctx._rec = rec;
  return ctx;
}

function tick(mobs, ctx, n = 1) { for (let i = 0; i < n; i++) mobs.update(SIM_DT, ctx); }
function findByKind(mobs, kind) { let out = null; mobs.forEachLive((m) => { if (m.kind === kind) out = m; }); return out; }

// =========================================================== pool / stagger
test('pool: global and per-type caps are never exceeded', () => {
  const mobs = new Mobs(EARTH, { rng: mulberry32(1) });
  for (let i = 0; i < 40; i++) mobs.spawnAt('crawler', 10 + i, 11, 0.5);
  assert.equal(mobs.count, MOB_TYPES[MOB.CRAWLER].cap);
  for (let i = 0; i < 40; i++) mobs.spawnAt('warden', 200 + i, 11, 0.5);
  assert.equal(mobs.count, MOB_TYPES[MOB.CRAWLER].cap + MOB_TYPES[MOB.WARDEN].cap);
  assert.equal(mobs.count, MAX_MOBS);
});

test('pool: slots recycle but ids never collide across 10 000 spawn/despawn cycles', () => {
  const mobs = new Mobs(EARTH, { rng: mulberry32(2) });
  const seen = new Set();
  for (let i = 0; i < 10000; i++) {
    const id = mobs.spawnAt('crawler', 10, 11, 0.5);
    assert.ok(id > 0, `spawn ${i} refused`);
    assert.ok(!seen.has(id), `id ${id} reused`);
    seen.add(id);
    let idx = -1;
    for (let k = 0; k < mobs.liveN; k++) if (mobs.live[k].id === id) idx = k;
    mobs._despawn(idx);
  }
  assert.equal(seen.size, 10000);
  assert.equal(mobs.count, 0);
});

test('stagger: never more than 6 thinks in a single sim tick, over 1000 ticks', () => {
  const mobs = new Mobs(EARTH, { rng: mulberry32(3) });
  // Kept within reach of even the farthest wander excursion (anchor +14)
  // staying under the 44-block soft despawn radius, and creative mode below
  // keeps every mob in WANDER for the whole run - this test is about the
  // stagger mechanism in isolation, not the full AI, so nothing here should
  // be free to despawn or change the population mid-run.
  for (let i = 0; i < MOB_TYPES[MOB.WARDEN].cap; i++) mobs.spawnAt('warden', 3 + i * 2, 11, 0.5);
  for (let i = 0; i < MOB_TYPES[MOB.CRAWLER].cap; i++) mobs.spawnAt('crawler', 10 + i, 11, 0.5);
  assert.equal(mobs.count, MAX_MOBS);
  let perTick = 0;
  let maxSeen = 0;
  const thoughtIds = new Set();
  const origThink = mobs._think.bind(mobs);
  mobs._think = (m, c) => { perTick++; thoughtIds.add(m.id); origThink(m, c); };
  const ctx = baseCtx({ mode: 'creative' });
  for (let i = 0; i < 1000; i++) {
    perTick = 0;
    mobs.update(SIM_DT, ctx);
    if (perTick > maxSeen) maxSeen = perTick;
  }
  assert.ok(maxSeen <= 6, `saw ${maxSeen} thinks in one tick`);
  // The upper bound alone would also pass a broken stagger that starves most
  // mobs of thinking at all (e.g. gating on tick%4===0 AND slot%4===tick%4,
  // which only ever fires for slot%4===0) - so also require every mob to
  // actually have thought at least once across the 1000 ticks (50s at 5Hz).
  assert.equal(thoughtIds.size, MAX_MOBS, 'not every mob got a think');
});

// ============================================================ state machine
test('WANDER acquires CHASE on clear LOS within sight', () => {
  const mobs = new Mobs(EARTH, { rng: mulberry32(4) });
  mobs.spawnAt('crawler', 10.5, 11, 0.5);
  const ctx = baseCtx({ playerPos: { x: 12.5, y: 11, z: 0.5 } });
  tick(mobs, ctx, 6);
  const m = findByKind(mobs, MOB.CRAWLER);
  assert.equal(m.state, STATE.CHASE);
});

test('LOS is not fooled by terrain beyond the player - raycastVoxel needs a unit direction', () => {
  // Regression: _hasLOS passed the raw (unnormalized) eye-to-player delta to
  // raycastVoxel, whose march compares its parameter t directly against
  // maxDist in world units and therefore requires a UNIT direction (exactly
  // how game.js's own block-targeting raycast always calls it). With the raw
  // vector, the march travelled up to `dist` times too far past the real
  // target and reported "blocked" on whatever it hit way out there. A wall
  // far beyond the player (never on the real 10-block segment) must not
  // affect LOS at all.
  const mobs = new Mobs(EARTH, { rng: mulberry32(4) });
  mobs.spawnAt('crawler', 0.5, 11, 0.5);
  const world = flatWorld((x, y, z) => (x === 50 && y === 11 ? STONE : undefined));
  const ctx = baseCtx({ world, playerPos: { x: 10.5, y: 11, z: 0.5 } });
  tick(mobs, ctx, 6);
  const m = findByKind(mobs, MOB.CRAWLER);
  assert.equal(m.state, STATE.CHASE, 'a wall 40 blocks past the player must not block LOS to the player');
});

test('WANDER does NOT acquire through a wall', () => {
  const mobs = new Mobs(EARTH, { rng: mulberry32(5) });
  mobs.spawnAt('crawler', 10.5, 11, 0.5);
  const ctx = baseCtx({ world: wallWorld(11), playerPos: { x: 12.5, y: 11, z: 0.5 } });
  tick(mobs, ctx, 40);
  const m = findByKind(mobs, MOB.CRAWLER);
  assert.equal(m.state, STATE.WANDER);
});

test('CHASE is held while lostFor < lose, even two blocks behind a pillar', () => {
  const mobs = new Mobs(EARTH, { rng: mulberry32(6) });
  const id = mobs.spawnAt('crawler', 10.5, 11, 0.5);
  const ctx = baseCtx({ world: wallWorld(11), playerPos: { x: 12.5, y: 11, z: 0.5 } });
  const m = mobs.byId(id);
  m.state = STATE.CHASE; m.stateT = 0; m.lostFor = 0; m.engaged = true;
  m.anchor.x = 12.5; m.anchor.z = 0.5;
  tick(mobs, ctx, Math.round((MOB_TYPES[MOB.CRAWLER].lose - 1) / SIM_DT));
  assert.equal(m.state, STATE.CHASE);
});

test('CHASE give-up requires both the lose timeout AND distance > 12', () => {
  const type = MOB_TYPES[MOB.CRAWLER];
  // lostFor timed out, but still close (<=12): stays CHASE.
  {
    const mobs = new Mobs(EARTH, { rng: mulberry32(7) });
    const id = mobs.spawnAt('crawler', 8.5, 11, 0.5);
    const m = mobs.byId(id);
    m.state = STATE.CHASE; m.engaged = true; m.anchor.x = 8.5; m.anchor.z = 0.5;
    const ctx = baseCtx({ world: wallWorld(9), playerPos: { x: 10.5, y: 11, z: 0.5 } });
    tick(mobs, ctx, Math.round((type.lose + 1) / SIM_DT));
    assert.equal(m.state, STATE.CHASE, 'gave up while still close');
  }
  // far away (>12), but LOS never lost (lostFor stays 0): stays CHASE.
  {
    const mobs = new Mobs(EARTH, { rng: mulberry32(8) });
    const id = mobs.spawnAt('crawler', 0.5, 11, 0.5);
    const m = mobs.byId(id);
    m.state = STATE.CHASE; m.engaged = true; m.anchor.x = 0.5; m.anchor.z = 0.5;
    const ctx = baseCtx({ playerPos: { x: 20.5, y: 11, z: 0.5 } });   // open LOS, far
    tick(mobs, ctx, 40);
    assert.equal(m.state, STATE.CHASE, 'gave up with LOS still clear');
  }
  // both: lostFor timed out AND far away: gives up.
  {
    const mobs = new Mobs(EARTH, { rng: mulberry32(9) });
    const id = mobs.spawnAt('crawler', 0.5, 11, 0.5);
    const m = mobs.byId(id);
    m.state = STATE.CHASE; m.engaged = true; m.anchor.x = 0.5; m.anchor.z = 0.5;
    const ctx = baseCtx({ world: wallWorld(3), playerPos: { x: 20.5, y: 11, z: 0.5 } });
    tick(mobs, ctx, Math.round((type.lose + 1) / SIM_DT));
    assert.equal(m.state, STATE.WANDER, 'never gave up');
  }
});

test('CHASE give-up beyond leash distance, regardless of LOS', () => {
  const type = MOB_TYPES[MOB.CRAWLER];
  const mobs = new Mobs(EARTH, { rng: mulberry32(10) });
  // The mob has wandered well past its own acquisition point (anchor), even
  // though the player is right next to it with clear LOS the whole time.
  const id = mobs.spawnAt('crawler', type.leash + 5.5, 11, 0.5);
  const m = mobs.byId(id);
  m.state = STATE.CHASE; m.engaged = true; m.anchor.x = 0.5; m.anchor.z = 0.5;
  const ctx = baseCtx({ playerPos: { x: type.leash + 5.5, y: 11, z: 0.5 } });
  tick(mobs, ctx, 6);
  assert.equal(m.state, STATE.WANDER);
});

test('FUSE reaches blast at exactly 1.5s', () => {
  const mobs = new Mobs(EARTH, { rng: mulberry32(11) });
  const id = mobs.spawnAt('crawler', 2.5, 11, 0.5);
  const m = mobs.byId(id);
  m.state = STATE.FUSE; m.fuse = 0;
  const ctx = baseCtx({ playerPos: { x: 0.5, y: 11, z: 0.5 } });   // 2 blocks away, well inside arm/abort
  const type = MOB_TYPES[MOB.CRAWLER];
  const ticksToBlast = Math.round(type.fuse.time / SIM_DT);
  tick(mobs, ctx, ticksToBlast - 1);
  assert.equal(ctx._rec.blast, 0, 'blew up early');
  tick(mobs, ctx, 1);
  assert.equal(ctx._rec.blast, 1, 'did not blow up on time');
  assert.equal(m.state, STATE.DEAD, 'the crawler does not survive its own blast');
});

test('FUSE aborts and decays at 2x when the player steps back to 6.1 blocks', () => {
  const mobs = new Mobs(EARTH, { rng: mulberry32(12) });
  const id = mobs.spawnAt('crawler', 6.6, 11, 0.5);
  const m = mobs.byId(id);
  m.state = STATE.FUSE; m.fuse = 0.5; m.lostFor = 0;
  const type = MOB_TYPES[MOB.CRAWLER];
  const ctx = baseCtx({ playerPos: { x: 0.5, y: 11, z: 0.5 } });   // 6.1 blocks away, beyond abort(6.0)
  mobs.update(SIM_DT, ctx);
  near(m.fuse, 0.5 - type.fuse.decay * SIM_DT);
});

test('FUSE never despawns from distance/engagement rules', () => {
  // A fusing mob only ever exists within its own abort radius of the player
  // in practice, so this exercises the despawn pass directly rather than
  // through the full state machine (which would otherwise abort the fuse
  // itself well before 72 blocks of distance could ever be observed).
  const mobs = new Mobs(EARTH, { rng: mulberry32(13) });
  const id = mobs.spawnAt('crawler', 90.5, 11, 0.5);   // beyond the hard despawn radius
  const m = mobs.byId(id);
  m.state = STATE.FUSE; m.engaged = false;
  const ctx = baseCtx({ playerPos: { x: 0.5, y: 11, z: 0.5 } });
  mobs._despawnPass(ctx);
  assert.ok(mobs.byId(id), 'a fusing mob must never be despawned');
  assert.equal(m.state, STATE.FUSE);
});

test('WARDEN windup->slam hits inside the arc and misses outside it', () => {
  const type = MOB_TYPES[MOB.WARDEN];
  // +1 tick of slack: 9 additions of 0.05 lands at 0.44999999999999996 in
  // float64, one hair under the threshold - the hit test still fires exactly
  // on schedule, just on the tick after the naive ceil().
  const ticksToSlam = Math.ceil(type.attack.windup / SIM_DT) + 1;
  // Player is at -X from the mob (dx=-2,dz=0), so yaw=+pi/2 faces it exactly
  // (yaw 0 looks down -Z, per player.js's convention - see dirToYaw).
  {
    const mobs = new Mobs(EARTH, { rng: mulberry32(14) });
    const id = mobs.spawnAt('warden', 2.5, 11, 0.5);
    const m = mobs.byId(id);
    m.state = STATE.WINDUP; m.windup = 0; m.yaw = Math.PI / 2; m.wantYaw = Math.PI / 2;
    const ctx = baseCtx({ playerPos: { x: 0.5, y: 11, z: 0.5 } });
    tick(mobs, ctx, ticksToSlam);
    assert.equal(ctx._rec.hurt.length, 1, 'should have hit');
    assert.equal(ctx._rec.hurt[0].cause, 'warden');
  }
  // Facing directly away from the player (180 degrees off): same range, misses.
  {
    const mobs = new Mobs(EARTH, { rng: mulberry32(15) });
    const id = mobs.spawnAt('warden', 2.5, 11, 0.5);
    const m = mobs.byId(id);
    m.state = STATE.WINDUP; m.windup = 0; m.yaw = -Math.PI / 2; m.wantYaw = -Math.PI / 2;
    const ctx = baseCtx({ playerPos: { x: 0.5, y: 11, z: 0.5 } });
    tick(mobs, ctx, ticksToSlam);
    assert.equal(ctx._rec.hurt.length, 0, 'should have missed outside the arc');
  }
});

test('WARDEN attack cooldown and recovery return it to CHASE', () => {
  const type = MOB_TYPES[MOB.WARDEN];
  const mobs = new Mobs(EARTH, { rng: mulberry32(16) });
  const id = mobs.spawnAt('warden', 2.5, 11, 0.5);
  const m = mobs.byId(id);
  m.state = STATE.WINDUP; m.windup = 0; m.yaw = Math.PI;
  const ctx = baseCtx({ playerPos: { x: 0.5, y: 11, z: 0.5 } });
  const totalTicks = Math.ceil((type.attack.windup + type.attack.swing) / SIM_DT) + 1;
  tick(mobs, ctx, totalTicks);
  assert.equal(m.state, STATE.RECOVER);
  near(m.attackCd, type.attack.cooldown, 0.06);
  tick(mobs, ctx, Math.ceil(type.attack.cooldown / SIM_DT) + 1);
  assert.equal(m.state, STATE.CHASE);
});

// ================================================================= pathing
test('pathing: +1 -> STEP, +2 -> JUMP for the crawler, +2 -> NO for the warden', () => {
  const crawler = MOB_TYPES[MOB.CRAWLER], warden = MOB_TYPES[MOB.WARDEN];
  const stepWorld = (rise) => ({ getBlock: (x, y, z) => (x >= 5 ? (y <= 10 + rise ? 1 : 0) : (y <= 10 ? 1 : 0)) });
  const mC = { pos: { x: 4.5, y: 11, z: 0.5 }, w: crawler.w, h: crawler.h };
  const mW = { pos: { x: 4.5, y: 11, z: 0.5 }, w: warden.w, h: warden.h };
  assert.equal(probeStep(stepWorld(1), mC, 1, 0, 6, crawler), 2);   // STEP
  assert.equal(probeStep(stepWorld(2), mC, 1, 0, 6, crawler), 3);   // JUMP
  assert.equal(probeStep(stepWorld(2), mW, 1, 0, 4, warden), 0);    // NO - the warden cannot jump
  assert.equal(probeStep(stepWorld(1), mW, 1, 0, 4, warden), 2);    // STEP still works for the warden
});

test('pathing: a 4-block drop is NO on Earth and WALK on Europa', () => {
  const crawler = MOB_TYPES[MOB.CRAWLER];
  const dropWorld = (drop) => ({ getBlock: (x, y, z) => (x >= 5 ? (y <= 10 - drop ? 1 : 0) : (y <= 10 ? 1 : 0)) });
  const m = { pos: { x: 4.5, y: 11, z: 0.5 }, w: crawler.w, h: crawler.h };
  const earthDrop = maxDropFor(crawler, EARTH.gravity * G_SCALE);
  const europaDrop = maxDropFor(crawler, 1.31 * G_SCALE);
  assert.equal(probeStep(dropWorld(4), m, 1, 0, earthDrop, crawler), 0);   // NO
  assert.equal(probeStep(dropWorld(4), m, 1, 0, europaDrop, crawler), 1);  // WALK
});

test('a warden on a Jupiter deck lip refuses every heading that leaves the deck', () => {
  const warden = MOB_TYPES[MOB.WARDEN];
  const jupiterGravity = JUPITER.gravity * G_SCALE;
  assert.equal(maxDropFor(warden, jupiterGravity), 1);
  // A one-block drop just past maxDrop(1) on every side of a 1x1 deck.
  const world = { getBlock: (x, y, z) => (Math.abs(x) <= 0 && Math.abs(z) <= 0 ? (y <= 10 ? 1 : 0) : (y <= 8 ? 1 : 0)) };
  const m = { pos: { x: 0.5, y: 11, z: 0.5 }, w: warden.w, h: warden.h };
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    assert.equal(probeStep(world, m, dx, dz, maxDropFor(warden, jupiterGravity), warden), 0);
  }
});

test('chooseHeading skips a blacklisted direction', () => {
  const crawler = MOB_TYPES[MOB.CRAWLER];
  const world = { getBlock: () => 0 };   // void everywhere: nothing is walkable except... use a floor
  const floor = { getBlock: (x, y, z) => (y <= 10 ? 1 : 0) };
  const m = { pos: { x: 0.5, y: 11, z: 0.5 }, w: crawler.w, h: crawler.h };
  const direct = chooseHeading(floor, m, crawler, 31, 0, -1);
  assert.ok(direct);
  assert.deepEqual([direct.x, direct.z], [0, -1]);
  const blacklisted = chooseHeading(floor, m, crawler, 31, 0, -1, 0, -1, 2);
  assert.ok(blacklisted);
  assert.notDeepEqual([blacklisted.x, blacklisted.z], [0, -1]);
});

// ============================================================ stuck ladders
test('geometry stuck: a permanently buried mob despawns at 3s, not stuck at the 1.5s teleport mark forever', () => {
  // Solid everywhere, so the 26-cell teleport scan can never find a free
  // cell - the despawn rung is the only way out. Regression for a bug where
  // the teleport attempt unconditionally zeroed the same clock the despawn
  // check reads, so unstickT could never climb past GEOM_TELEPORT_T(1.5) and
  // the mob rose forever instead of despawning at GEOM_DESPAWN_T(3).
  const world = { getBlock: () => STONE, isLoaded: () => true };
  const mobs = new Mobs(EARTH, { rng: mulberry32(30) });
  const id = mobs.spawnAt('crawler', 5.5, 5, 0.5);
  const ctx = baseCtx({ world, playerPos: { x: 5.5, y: 5, z: 0.5 } });
  let despawnedAtTick = -1;
  for (let i = 0; i < 200 && despawnedAtTick < 0; i++) {
    mobs.update(SIM_DT, ctx);
    if (!mobs.byId(id)) despawnedAtTick = i;
  }
  assert.ok(despawnedAtTick >= 0, 'a permanently buried mob must eventually despawn');
  near(despawnedAtTick * SIM_DT, 3, 1e-9);
});

test('geometry stuck: a mob that frees itself on the first teleport never reaches despawn', () => {
  // An entire open column one block over (x===6) among the 26 neighbours the
  // teleport scan checks, everything else solid - the scan finds it well
  // before 3s and the mob must survive for as long as we care to run it.
  const world = { getBlock: (x, y, z) => (x === 6 ? AIR : STONE), isLoaded: () => true };
  const mobs = new Mobs(EARTH, { rng: mulberry32(31) });
  const id = mobs.spawnAt('crawler', 5.5, 11, 0.5);
  const ctx = baseCtx({ world, playerPos: { x: 5.5, y: 11, z: 0.5 } });
  for (let i = 0; i < 200; i++) mobs.update(SIM_DT, ctx);   // 10s, well past both 1.5s and 3s
  assert.ok(mobs.byId(id), 'the mob should have freed itself and survived');
});

// ================================================================= combat
test('knockback: vy^2 / (2g) === 0.35 on all eight planets', () => {
  for (const g of PLANET_GRAVITIES) {
    const gravity = g * G_SCALE;
    const kb = knockbackImpulse(gravity, 0.35, 0);
    near((kb.vy * kb.vy) / (2 * gravity), 0.35, 1e-9);
    // resist changes only the horizontal reach, never the height
    const resisted = knockbackImpulse(gravity, 0.35, 0.78);
    near((resisted.vy * resisted.vy) / (2 * gravity), 0.35, 1e-9);
    assert.ok(resisted.speed < kb.speed);
  }
});

test("fall damage: a mob's own jump never hurts it, on every planet", () => {
  for (const g of PLANET_GRAVITIES) {
    const gravity = g * G_SCALE;
    assert.ok(mobJumpImpulse(gravity) <= mobSafeImpact(gravity),
      `jump ${mobJumpImpulse(gravity)} exceeds safe impact ${mobSafeImpact(gravity)} at g=${g}`);
  }
});

test('hit(): applies armor-adjusted damage, i-frames, knockback and kills at 0 hp', () => {
  const mobs = new Mobs(EARTH, { rng: mulberry32(17) });
  const id = mobs.spawnAt('crawler', 5.5, 11, 0.5);
  const m = mobs.byId(id);
  const ctx = baseCtx();
  const r1 = mobs.hit(id, 5, 1, 0, ctx);
  assert.equal(r1.hit, true);
  assert.equal(m.health, MOB_TYPES[MOB.CRAWLER].health - 5);
  assert.ok(m.vel.x > 0, 'knockback should push away from the hit direction');
  // i-frames: an immediate second hit does nothing.
  const before = m.health;
  const r2 = mobs.hit(id, 5, 1, 0, ctx);
  assert.equal(r2.hit, false);
  assert.equal(m.health, before);
  // wait out the i-frames, then finish it off.
  tick(mobs, ctx, 8);
  const r3 = mobs.hit(id, 999, 1, 0, ctx);
  assert.equal(r3.killed, true);
  assert.equal(ctx._rec.drops.length > 0, true, 'a melee kill in survival should drop loot');
});

test('creative hit: one hit kills, and blast() never touches the world', () => {
  const mobs = new Mobs(EARTH, { rng: mulberry32(18) });
  const id = mobs.spawnAt('crawler', 5.5, 11, 0.5);
  const ctx = baseCtx({ mode: 'creative' });
  const r = mobs.hit(id, 1, 1, 0, ctx);
  assert.equal(r.killed, true);
  assert.equal(ctx._rec.drops.length, 0, 'creative kills drop nothing');

  const mobs2 = new Mobs(EARTH, { rng: mulberry32(19) });
  const id2 = mobs2.spawnAt('crawler', 2.5, 11, 0.5);
  const m2 = mobs2.byId(id2);
  m2.state = STATE.FUSE; m2.fuse = 0;
  const ctx2 = baseCtx({ mode: 'creative', playerPos: { x: 0.5, y: 11, z: 0.5 } });
  mobs2.blast(m2, ctx2);
  assert.equal(ctx2._rec.setBlocksCalls.length, 0, 'creative blast must not touch the world');
});

test('a mob killed by an explosion drops nothing, even in survival', () => {
  const volatilesId = itemIdOf('volatiles');
  const mobs = new Mobs(EARTH, { rng: mulberry32(20) });
  const id = mobs.spawnAt('crawler', 2.5, 11, 0.5);
  const m = mobs.byId(id);
  const ctx = baseCtx({ playerPos: { x: 20.5, y: 11, z: 0.5 } });   // far away, so no player-damage noise
  mobs.blast(m, ctx);
  // Any drop present came from destroyed blocks (blast.js's own loot roll),
  // never from the crawler's own death - it burned.
  assert.equal(ctx._rec.drops.filter((d) => d.itemId === volatilesId).length, 0);
  assert.equal(m.state, STATE.DEAD);
});

test('pick(): nearest hit within reach, sphere-prefiltered slab test', () => {
  const mobs = new Mobs(EARTH, { rng: mulberry32(21) });
  mobs.spawnAt('crawler', 5.5, 11, 0.5);
  mobs.spawnAt('crawler', 8.5, 11, 0.5);
  const hit = mobs.pick(0.5, 11.8, 0.5, 1, 0, 0, 10);
  assert.ok(hit);
  near(hit.mob.pos.x, 5.5, 0.01);
  const miss = mobs.pick(0.5, 11.8, 0.5, 0, 1, 0, 10);   // straight up, nothing there
  assert.equal(miss, null);
});

// ============================================================ mode/pause
test('creative: update() spawns nothing over 60 director ticks', () => {
  const mobs = new Mobs(EARTH, { rng: mulberry32(22) });
  const ctx = baseCtx({ mode: 'creative', world: roofedWorld() });
  for (let i = 0; i < 60; i++) mobs.update(3, ctx);   // 3s > the 2s director interval, one attempt per call
  assert.equal(mobs.count, 0);
});

test('paused: update() advances no timer and moves no mob', () => {
  const mobs = new Mobs(EARTH, { rng: mulberry32(23) });
  const id = mobs.spawnAt('crawler', 5.5, 11, 0.5);
  const m = mobs.byId(id);
  m.state = STATE.CHASE; m.vel.x = 3;
  const before = JSON.stringify({ pos: m.pos, vel: m.vel, tick: mobs.tick, acc: mobs.acc });
  const ctx = baseCtx({ paused: true, playerPos: { x: 20.5, y: 11, z: 0.5 } });
  for (let i = 0; i < 50; i++) mobs.update(SIM_DT, ctx);
  const after = JSON.stringify({ pos: m.pos, vel: m.vel, tick: mobs.tick, acc: mobs.acc });
  assert.equal(after, before);
});

// ================================================================ spawning
test('spawn: refused inside geometry (headroom fails for the warden across its own width)', () => {
  const mobs = new Mobs(EARTH, { rng: mulberry32(24) });
  // Floor at y<=10 everywhere; a one-block-thick ceiling at y=13 only at x=1
  // (just inside the warden's 1.2-wide body centred at x=0.5..) so the single
  // -column headroom scan at the centre clears, but the full-width overlap
  // check does not.
  const world = { getBlock: (x, y, z) => (y <= 10 ? 1 : (x === 1 && y === 13 ? 1 : 0)) };
  assert.equal(mobs._findGroundY(world, 0, 0, 11, MOB_TYPES[MOB.WARDEN]), 11);
  const probe = { pos: { x: 0.5, y: 11, z: 0.5 }, vel: { x: 0, y: 0, z: 0 }, w: MOB_TYPES[MOB.WARDEN].w, h: MOB_TYPES[MOB.WARDEN].h };
  assert.equal(boxOverlapsSolid(world, probe), true,
    'the full-width AABB check should catch what the single-column headroom scan misses');
});

test('spawn: refused in liquid', () => {
  // A world entirely paved in a solid floor topped with one layer of water:
  // _findGroundY still finds the rock under it (water isn't SOLID), so the
  // rejection has to come from the later liquidAt() check on the actual
  // landing cell - tested end to end through the director.
  const rates = { crawler: 1, warden: 0 };
  const planet = { ...EARTH, mobs: rates };
  const waterId = BY_KEY.get('water').id;
  const world = { getBlock: (x, y, z) => (y === 10 ? waterId : (y < 10 ? STONE : 0)) };
  const mobs = new Mobs(planet, { rng: mulberry32(25) });
  const ctx = baseCtx({ world, planet });
  for (let i = 0; i < 60; i++) mobs.update(3, ctx);
  assert.equal(mobs.count, 0);
});

test('spawn: refused when blocked() reports true, allowed otherwise', () => {
  const rates = { crawler: 1, warden: 0 };
  const planet = { ...EARTH, mobs: rates };
  const world = roofedWorld();   // sheltered, so darkness is never the reason
  {
    const mobs = new Mobs(planet, { rng: mulberry32(26) });
    const ctx = baseCtx({ world, planet, blocked: () => true });
    for (let i = 0; i < 40; i++) mobs.update(3, ctx);
    assert.equal(mobs.count, 0);
  }
  {
    const mobs = new Mobs(planet, { rng: mulberry32(26) });
    const ctx = baseCtx({ world, planet, blocked: () => false });
    for (let i = 0; i < 40; i++) mobs.update(3, ctx);
    assert.ok(mobs.count > 0, 'never spawned even with everything else permissive');
  }
});

test('spawn: refused in daylight on an open column, allowed under a roof', () => {
  const rates = { crawler: 1, warden: 0 };
  const planet = { ...EARTH, mobs: rates };
  {
    const mobs = new Mobs(planet, { rng: mulberry32(27) });
    const ctx = baseCtx({ world: flatWorld(), planet, daylight: 1 });   // open sky, full daylight
    for (let i = 0; i < 40; i++) mobs.update(3, ctx);
    assert.equal(mobs.count, 0);
  }
  {
    const mobs = new Mobs(planet, { rng: mulberry32(27) });
    const ctx = baseCtx({ world: roofedWorld(), planet, daylight: 1 });   // sheltered, same seed
    for (let i = 0; i < 40; i++) mobs.update(3, ctx);
    assert.ok(mobs.count > 0, 'never spawned under a roof');
  }
});

test('spawn director: every spawn lands 24-56 blocks from the player', () => {
  const rates = { crawler: 1, warden: 1 };
  const planet = { ...EARTH, mobs: rates };
  const mobs = new Mobs(planet, { rng: mulberry32(28) });
  const ctx = baseCtx({ world: roofedWorld(), planet });
  for (let i = 0; i < 400 && mobs.count < MAX_MOBS; i++) mobs.update(3, ctx);
  assert.ok(mobs.count > 0);
  mobs.forEachLive((m) => {
    const d = Math.hypot(m.pos.x - ctx.playerPos.x, m.pos.z - ctx.playerPos.z);
    assert.ok(d >= 24 && d < 56, `spawn at distance ${d}`);
  });
});

// -------------------------------------------------------- zero allocation
// Requires --expose-gc; if this process was not started with it, re-exec
// itself with the flag so `node tests/mobs.test.mjs` (and npm test, which
// spawns exactly that) still runs the real check.
if (typeof global.gc !== 'function' && !process.env._MOBS_GC_CHILD) {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, _MOBS_GC_CHILD: '1' } });
  process.exit(r.status ?? 1);
}

test('zero allocation: 20 000 steady-state update frames grow the heap negligibly', () => {
  const mobs = new Mobs(EARTH, { rng: mulberry32(29) });
  for (let i = 0; i < 12; i++) mobs.spawnAt(i % 4 === 0 ? 'warden' : 'crawler', 20 + i * 3, 11, 0.5);
  const ctx = baseCtx({ playerPos: { x: 0.5, y: 11, z: 0.5 } });
  // warm up (JIT, first-touch allocations of anything lazily built)
  for (let i = 0; i < 2000; i++) mobs.update(SIM_DT, ctx);

  if (typeof global.gc === 'function') global.gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 20000; i++) mobs.update(SIM_DT, ctx);
  if (typeof global.gc === 'function') global.gc();
  const after = process.memoryUsage().heapUsed;

  const growth = after - before;
  // A generous ceiling, not a tight one: this is a regression tripwire for a
  // stray per-frame allocation (a closure, an array literal in a hot path),
  // not a proof of literally zero bytes - GC accounting is not that precise.
  assert.ok(growth < 3_000_000, `heap grew ${growth} bytes over 20000 frames`);
});

// --- summary ----------------------------------------------------------------
for (const f of failures) {
  console.error(`FAIL  ${f.name}\n      ${f.err.stack ?? f.err.message}`);
}
const total = passed + failures.length;
console.log(`\nmobs: ${passed}/${total} passed${failures.length ? `, ${failures.length} FAILED` : ''}`);
process.exit(failures.length ? 1 : 0);
