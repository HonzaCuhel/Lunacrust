// The mob system: a fixed pool of 24 hostile entities, a fixed 20Hz sim tick,
// a 5Hz staggered think, and steering-plus-a-column-probe pathing. No THREE,
// no DOM, no world.js import - world mutation arrives as an injected callback
// on `ctx`, exactly as drops.update(dt, {pickup}) already does, so this whole
// file runs verbatim in a headless host (see the report's multiplayer note).
//
// Every tuning constant lives in this one block, on purpose - the spec's own
// risk section names pathing as "the part most likely to need two rounds of
// tuning after first playtest", and it should not need a tour of the file to
// find the knob.

import { AIR, BLOCKS, BY_KEY } from './blocks.js';
import { itemIdOf } from './items.js';
import { raycastVoxel } from './raycast.js';
import { TERMINAL, SOLID, stepBody, boxOverlapsSolid, liquidAt } from './body.js';
import { MOB, MOB_TYPES, mobJumpImpulse, mobSafeImpact, maxDropFor } from './mobtypes.js';
import { computeBlast, blastDamageAt, createBlastScratch, BLAST_R, BLAST_POWER } from './blast.js';

export const MAX_MOBS = 24;
export const SIM_DT = 0.05;
export const MAX_CATCHUP = 3;

const THINK_HZ = 5;
const THINK_EVERY = Math.round(1 / SIM_DT / THINK_HZ);   // 4 sim ticks per think
const THINK_DT = THINK_EVERY * SIM_DT;                    // 0.2s

export const STATE = { WANDER: 0, CHASE: 1, FUSE: 2, WINDUP: 3, SLAM: 4, RECOVER: 5, DEAD: 6 };
export const NO = 0, WALK = 1, STEP = 2, JUMP = 3;

// --- combat -------------------------------------------------------------
const HURT_FLASH_TIME = 0.18;
const HIT_IFRAMES = 0.35;
const KB_HEIGHT = 0.35;          // melee pop height - every mob the same, see knockbackImpulse()
const KB_SPEED = 4.2;
const BLAST_KB_HEIGHT = 0.55;
// The warden's own slam knockback height is type.attack.kbHeight (0.42) -
// already carried by mobtypes.js, so it is not duplicated as a constant here.
const DEATH_TIME = 0.25;         // matches mobrender.js's own DEATH_TIME - see the report

// --- AI -------------------------------------------------------------------
const YAW_RATE = 6;              // rad/s, "yaw chases wantYaw"
const WANDER_GOAL_MIN = 6, WANDER_GOAL_MAX = 14;
const WANDER_INTERVAL_MIN = 4, WANDER_INTERVAL_MAX = 9;
const WANDER_SPEED_FACTOR = 0.55;
const WANDER_IDLE_CHANCE = 0.3;
const GIVE_UP_DIST = 12;
const HEADING_HOLD_TIME = 0.4;
const GAIT_RATE = 3.2;           // rad of gait phase per block moved

// steering fan, direct bearing first, then increasingly wide, then retreat -
// kept to 8 probes total per spec's "≤8 probes ≈ 72 reads, at 5Hz" budget.
const FAN_DEG = [0, 30, -30, 60, -60, 90, -90, 180];
const BLACKLIST_DOT = 0.9;       // "same heading" threshold for the nav-stuck blacklist

// two stuck ladders - see §4.7 of the spec and the report
const NAV_STUCK_DIST = 0.4, NAV_STUCK_TIME = 1.5, NAV_BLACKLIST_TIME = 2, NAV_GIVE_UP_TIME = 6;
const GEOM_RISE_RATE = 3;        // blocks/s, the trick drops.js already uses for buried loot
const GEOM_TELEPORT_T = 1.5, GEOM_DESPAWN_T = 3;

const LIQUID_VY = 1.6;
const LAVA_DPS = 4;

const DESPAWN_HARD = 72, DESPAWN_SOFT = 44, DESPAWN_SOFT_TIME = 40, DESPAWN_UNLOADED_TIME = 5;

// --- spawn director ---------------------------------------------------------
const SPAWN_ATTEMPT_INTERVAL = 2;
const SPAWN_CANDIDATES = 8;
const SPAWN_MIN_DIST = 24, SPAWN_MAX_DIST = 56;
const SPAWN_COLUMN_SCAN = 20;    // playerY +-20
const SPAWN_LIGHT_SCAN = 8;
const SPAWN_DAYLIGHT_MAX = 0.25;
const SPAWN_DENSITY_RADIUS = 12, SPAWN_DENSITY_MAX = 4;

const LAVA_ID = BY_KEY.get('lava').id;
const METHANE_ID = BY_KEY.get('methane').id;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const hypot2 = (x, z) => Math.sqrt(x * x + z * z);

// ------------------------------------------------------------------ helpers
/** mulberry32 - small, fast, seeded. Exported so game.js can build the one
 *  rng this system shares with its blast (spec §9: "seeded mulberry32(seed ^ 0x5eed)"). */
export function mulberry32(seed) {
  let s = seed >>> 0;
  return function rng() {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Per-entity PRNG, advanced through the mob's own `seed` field so wander
 *  timing/goal picking is deterministic per-mob without a shared stream. */
function entRand(m) {
  let s = m.seed >>> 0 || 1;
  s ^= s << 13; s >>>= 0;
  s ^= s >>> 17;
  s ^= s << 5; s >>>= 0;
  m.seed = s;
  return s / 4294967296;
}

function angleDiff(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
function turnToward(yaw, want, maxDelta) {
  const d = angleDiff(yaw, want);
  if (d > maxDelta) return yaw + maxDelta;
  if (d < -maxDelta) return yaw - maxDelta;
  return want;
}
/** yaw 0 looks down -Z (player.js's convention) - the inverse of that map. */
const dirToYaw = (dx, dz) => Math.atan2(-dx, -dz);

function normalizeXZ(dx, dz) {
  const len = Math.hypot(dx, dz);
  return len > 1e-6 ? [dx / len, dz / len] : [0, 0];
}
function rotateXZ(x, z, rad) {
  const c = Math.cos(rad), s = Math.sin(rad);
  return [x * c - z * s, x * s + z * c];
}

/**
 * Solve for a knockback HEIGHT, not a speed, so the same 0.35-block pop lands
 * on Europa and on Jupiter alike. Only the horizontal reach is resisted -
 * vy is not, which is what makes "every mob pops exactly 0.35 blocks" and the
 * warden's slam/blast heights literal, not merely typical.
 */
export function knockbackImpulse(gravity, height, resist) {
  return { vy: Math.sqrt(2 * gravity * height), speed: KB_SPEED * (1 - resist) };
}

// ---------------------------------------------------------- column probing
/**
 * Samples the column at pos + dir*(w/2+0.6). @returns {0|1|2|3} NO|WALK|STEP|JUMP
 * Exported (beyond the class's own public API in the spec's §4.2 sense) so
 * pathing decisions are unit-testable directly, the way blast.js's pure
 * helpers are - see the mob-core report.
 */
export function probeStep(world, m, dirX, dirZ, maxDrop, type) {
  const reach = m.w / 2 + 0.6;
  const px = Math.floor(m.pos.x + dirX * reach);
  const pz = Math.floor(m.pos.z + dirZ * reach);
  const mobY = Math.floor(m.pos.y);
  const bodyCells = Math.max(1, Math.ceil(m.h));

  // Lava/methane at foot level ahead is a hard no regardless of footing -
  // checked before the floor scan since a hazard floor would otherwise read
  // as perfectly walkable.
  const footId = world.getBlock(px, mobY, pz);
  if (footId === LAVA_ID || footId === METHANE_ID) return NO;

  // Scan from one above the jump ceiling down through maxDrop below the
  // mob's own feet (maxDrop+3 cells) for the topmost solid cell; standing on
  // it means occupying the cell just above it.
  let floorY = null;
  for (let y = mobY + 1; y >= mobY - 1 - maxDrop; y--) {
    if (SOLID[world.getBlock(px, y, pz)]) { floorY = y; break; }
  }
  // No floor found within reach: the cliff guard, the void guard and the
  // Jupiter cloud-deck guard, all in this one rule.
  if (floorY === null) return NO;

  const standY = floorY + 1;
  if (standY === mobY) return WALK;
  if (standY === mobY + 1 || standY === mobY + 2) {
    if (standY === mobY + 2 && !type.canJump) return NO;   // the warden cannot jump on purpose
    for (let dy = 0; dy < bodyCells; dy++) {
      if (SOLID[world.getBlock(px, standY + dy, pz)]) return NO;   // no headroom to stand in (or a wall taller than it looks)
    }
    return standY === mobY + 1 ? STEP : JUMP;
  }
  if (standY < mobY) return WALK;   // a drop within maxDrop - it will fall, safely
  return NO;                        // a wall taller than a jump can clear
}

/**
 * Try the direct bearing; if blocked, fan +-30/+-60/+-90, then a straight
 * retreat, taking the first walkable heading. Skips a heading the nav-stuck
 * ladder has blacklisted.
 */
export function chooseHeading(world, m, type, gravity, dirX, dirZ, blX = 0, blZ = 0, blT = 0) {
  if (dirX === 0 && dirZ === 0) return null;
  const maxDrop = maxDropFor(type, gravity);
  for (const deg of FAN_DEG) {
    const [hx, hz] = deg === 0 ? [dirX, dirZ] : rotateXZ(dirX, dirZ, deg * Math.PI / 180);
    if (blT > 0 && hx * blX + hz * blZ > BLACKLIST_DOT) continue;
    const r = probeStep(world, m, hx, hz, maxDrop, type);
    if (r !== NO) return { x: hx, z: hz, result: r };
  }
  return null;
}

// -------------------------------------------------------------- loot / rng
function resolveLootKey(spec, planet) {
  return spec.item === '@deep' ? planet.terrain.layers.deep : spec.item;
}

// ------------------------------------------------------------- entity pool
function freshMob(slot) {
  return {
    id: 0, slot, kind: MOB.CRAWLER,
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 },
    prev: { x: 0, y: 0, z: 0 }, prevYaw: 0,
    w: 1, h: 1, onGround: false, groundedLastFrame: false, stepOffset: 0, flying: false,
    impactSpeed: 0, justLanded: false,
    yaw: 0, wantYaw: 0,
    health: 1, hurtT: 0, invuln: 0, knockX: 0, knockZ: 0,
    state: STATE.WANDER, stateT: 0,
    fuse: 0, attackCd: 0, windup: 0,
    lostFor: 0, engaged: false,
    anchor: { x: 0, z: 0 }, goal: { x: 0, z: 0 }, heading: { x: 0, z: 0 }, headingT: 0,
    stuckT: 0, unstickT: 0, lastX: 0, lastZ: 0,
    gait: 0, age: 0, alive: true, deathT: 0, seed: 1,
    // Internal bookkeeping beyond the documented render-facing shape (never
    // read by mobrender.js - see the mob-core report for the full list):
    wanderCd: 0,          // seconds until the next wander goal repick
    blX: 0, blZ: 0, blT: 0,   // nav-stuck heading blacklist: direction + time left
    softT: 0,              // seconds spent beyond the soft despawn radius, unengaged
    unloadedT: 0,           // seconds spent in a column that is not loaded
    teleCd: 0,              // geometry-stuck: cooldown before the next teleport attempt
  };
}

function resetMob(m, kind, id, x, y, z, type, seed) {
  m.id = id; m.kind = kind;
  m.pos.x = x; m.pos.y = y; m.pos.z = z;
  m.vel.x = 0; m.vel.y = 0; m.vel.z = 0;
  m.prev.x = x; m.prev.y = y; m.prev.z = z; m.prevYaw = 0;
  m.w = type.w; m.h = type.h;
  m.onGround = false; m.groundedLastFrame = false; m.stepOffset = 0; m.flying = false;
  m.impactSpeed = 0; m.justLanded = false;
  m.yaw = 0; m.wantYaw = 0;
  m.health = type.health; m.hurtT = 0; m.invuln = 0; m.knockX = 0; m.knockZ = 0;
  m.state = STATE.WANDER; m.stateT = 0;
  m.fuse = 0; m.attackCd = 0; m.windup = 0;
  m.lostFor = 0; m.engaged = false;
  m.anchor.x = x; m.anchor.z = z; m.goal.x = x; m.goal.z = z;
  m.heading.x = 0; m.heading.z = 0; m.headingT = 0;
  m.stuckT = 0; m.unstickT = 0; m.lastX = x; m.lastZ = z;
  m.gait = 0; m.age = 0; m.alive = true; m.deathT = 0; m.seed = seed >>> 0 || 1;
  m.wanderCd = 0; m.blX = 0; m.blZ = 0; m.blT = 0; m.softT = 0; m.unloadedT = 0; m.teleCd = 0;
  return m;
}

export class Mobs {
  /** @param {object} planet @param {{rng?:()=>number}} [opts] */
  constructor(planet, opts = {}) {
    this.planet = planet;
    this.rng = opts.rng ?? mulberry32(0x5eed);

    this.pool = new Array(MAX_MOBS);
    for (let i = 0; i < MAX_MOBS; i++) this.pool[i] = freshMob(i);
    this.live = new Array(MAX_MOBS).fill(null);
    this.liveN = 0;
    this.free = [];
    for (let i = MAX_MOBS - 1; i >= 0; i--) this.free.push(i);
    this.counts = [0, 0];   // live count per MOB.*
    this.nextId = 1;

    this.acc = 0;
    this.tick = 0;
    this.directorT = 0;

    this.scratch = createBlastScratch();
    this._targetCtx = {};
    this._spawnProbe = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, w: 1, h: 1 };
  }

  get count() { return this.liveN; }
  get alpha() { return clamp01(this.acc / SIM_DT); }

  forEachLive(fn) { for (let i = 0; i < this.liveN; i++) fn(this.live[i]); }

  byId(id) {
    for (let i = 0; i < this.liveN; i++) if (this.live[i].id === id) return this.live[i];
    return null;
  }

  clear() {
    while (this.liveN > 0) this._despawn(this.liveN - 1);
  }

  // ------------------------------------------------------------------ tick
  update(dt, ctx) {
    if (ctx.paused) return;
    this.acc = Math.min(this.acc + dt, SIM_DT * MAX_CATCHUP);
    while (this.acc >= SIM_DT) { this.acc -= SIM_DT; this._simTick(ctx); }
    this.directorT += dt;
    if (this.directorT >= SPAWN_ATTEMPT_INTERVAL) {
      this.directorT = 0;
      if (ctx.enabled !== false && ctx.mode === 'survival' && this._hasLivePlayer(ctx)) this._directorAttempt(ctx);
    }
  }

  _hasLivePlayer(ctx) {
    return ctx.players?.length ? ctx.players.some((p) => !p.dead) : !ctx.dead;
  }

  // Host simulation picks a target for each creature. A reusable context keeps
  // callbacks and world ownership intact without mutating Game's context.
  _contextFor(ctx, m) {
    if (!ctx.players?.length) return ctx;
    let nearest = null, best = Infinity;
    for (const player of ctx.players) {
      if (player.dead) continue;
      const d = Math.hypot(player.pos.x - m.pos.x, player.pos.y - m.pos.y, player.pos.z - m.pos.z);
      if (d < best) { best = d; nearest = player; }
    }
    const target = Object.assign(this._targetCtx, ctx);
    target.dead = !nearest;
    if (nearest) {
      target.playerPos = nearest.pos;
      target.playerH = nearest.h ?? 1.8;
      target.playerEyeY = nearest.eyeY ?? nearest.pos.y + 1.62;
      target.hurtPlayer = nearest.hurt;
      target.pushPlayer = nearest.push;
    }
    return target;
  }

  _simTick(baseCtx) {
    this.tick++;
    const gravity = baseCtx.gravity;
    // Staggered, not gated: every sim tick, the ~1/4 of mobs whose slot
    // matches this tick's phase think, so across any 4 consecutive ticks
    // every mob gets exactly one think, and no single tick pays for all 24.
    const thinkPhase = this.tick % THINK_EVERY;

    for (let i = this.liveN - 1; i >= 0; i--) {
      const m = this.live[i];
      const ctx = this._contextFor(baseCtx, m);
      m.prev.x = m.pos.x; m.prev.y = m.pos.y; m.prev.z = m.pos.z; m.prevYaw = m.yaw;

      if (m.state === STATE.DEAD) { this._tickDeath(m, i); continue; }

      const cx = Math.floor(m.pos.x), cz = Math.floor(m.pos.z);
      const loaded = !ctx.world.isLoaded || ctx.world.isLoaded(cx, cz);
      if (!loaded) {
        m.unloadedT += SIM_DT;
        if (m.unloadedT >= DESPAWN_UNLOADED_TIME) this._despawn(i);
        continue;
      }
      m.unloadedT = 0;

      // Mode changes and death invalidate an attack immediately, even between
      // staggered AI decisions. Creative worlds must never retain a live fuse.
      if (!this._canAcquire(ctx) && m.state !== STATE.WANDER) {
        this._enterWander(m);
        m.fuse = 0; m.windup = 0; m.engaged = false;
      }
      if (thinkPhase === m.slot % THINK_EVERY) this._think(m, ctx);
      this._steer(m, ctx, gravity);

      const inLiquid = liquidAt(ctx.world, m.pos.x, m.pos.y + m.h * 0.5, m.pos.z);
      if (inLiquid) m.vel.y = Math.max(m.vel.y, LIQUID_VY);
      else {
        m.vel.y -= gravity * SIM_DT;
        if (m.vel.y < -TERMINAL) m.vel.y = -TERMINAL;
      }
      stepBody(ctx.world, m, SIM_DT);

      if (this._geometryStuck(m, ctx, i)) continue;   // may have despawned

      if (m.justLanded && m.impactSpeed > mobSafeImpact(gravity)) {
        // Mirrors survival.js's fall-damage shape with its own constant,
        // since FALL_DAMAGE_PER_MS is module-private there too - see the report.
        const dmg = Math.round((m.impactSpeed - mobSafeImpact(gravity)) * 0.55);
        if (dmg > 0) { m.health = Math.max(0, m.health - dmg); if (m.health <= 0) { this.kill(m, ctx, true); continue; } }
      }

      if (this._attackPhase(m, ctx)) continue;   // may have blasted/despawned
      this._timers(m);
    }
    this._despawnPass(baseCtx);
  }

  _tickDeath(m, i) {
    m.deathT += SIM_DT;
    if (m.deathT >= DEATH_TIME) this._despawn(i);
  }

  /** @returns {boolean} true if the mob despawned this tick (buried too long) */
  _geometryStuck(m, ctx, i) {
    if (!boxOverlapsSolid(ctx.world, m)) { m.unstickT = 0; m.teleCd = 0; return false; }
    m.unstickT += SIM_DT;
    m.pos.y += GEOM_RISE_RATE * SIM_DT;
    m.vel.y = 0;
    // unstickT is the single continuous "how long has this mob been buried"
    // clock and must NOT be reset by a teleport attempt - only despawn (or
    // actually escaping the geometry, above) may zero it. A separate teleCd
    // rate-limits repeat attempts to once per GEOM_TELEPORT_T without ever
    // masking the GEOM_DESPAWN_T check below: a teleport that fails to free
    // the mob (still solid on all 26 neighbours, e.g. deep underground) must
    // still reach the despawn threshold instead of looping the 1.5s mark
    // forever - which is exactly the "vibrating inside bedrock forever" case
    // this ladder exists to rule out.
    if (m.unstickT >= GEOM_DESPAWN_T) { this._despawn(i); return true; }
    if (m.teleCd > 0) {
      m.teleCd = Math.max(0, m.teleCd - SIM_DT);
    } else if (m.unstickT >= GEOM_TELEPORT_T) {
      this._tryTeleportFree(m, ctx);
      m.teleCd = GEOM_TELEPORT_T;
    }
    return false;
  }

  _tryTeleportFree(m, ctx) {
    const bx = Math.floor(m.pos.x), by = Math.floor(m.pos.y), bz = Math.floor(m.pos.z);
    const savedX = m.pos.x, savedY = m.pos.y, savedZ = m.pos.z;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0 && dz === 0) continue;
          m.pos.x = bx + dx + 0.5; m.pos.y = by + dy; m.pos.z = bz + dz + 0.5;
          if (!boxOverlapsSolid(ctx.world, m)) return true;
        }
      }
    }
    m.pos.x = savedX; m.pos.y = savedY; m.pos.z = savedZ;
    return false;
  }

  /** Lava contact, the crawler's fuse, and the warden's windup/slam/recover. */
  _attackPhase(m, ctx) {
    const type = MOB_TYPES[m.kind];
    const footId = ctx.world.getBlock(Math.floor(m.pos.x), Math.floor(m.pos.y), Math.floor(m.pos.z));
    if (footId === LAVA_ID) {
      m.health = Math.max(0, m.health - LAVA_DPS * SIM_DT);
      if (m.health <= 0) { this.kill(m, ctx, true); return true; }
    }

    if (m.state === STATE.FUSE) {
      const dist = hypot2(ctx.playerPos.x - m.pos.x, ctx.playerPos.z - m.pos.z);
      const arming = dist <= type.fuse.abort && m.lostFor <= type.fuse.losGrace;
      m.fuse = clamp(m.fuse + (arming ? 1 : -type.fuse.decay) * SIM_DT, 0, type.fuse.time);
      if (m.fuse >= type.fuse.time) { this.blast(m, ctx); return true; }
      if (m.fuse <= 0 && !arming) { m.state = STATE.CHASE; m.stateT = 0; }
      return false;
    }

    if (m.state === STATE.WINDUP) {
      m.windup += SIM_DT;
      if (m.windup >= type.attack.windup) {
        const dx = ctx.playerPos.x - m.pos.x, dz = ctx.playerPos.z - m.pos.z;
        const dist = hypot2(dx, dz);
        const s = this._eyeVector(m, ctx, type);
        const inHeight = ctx.playerPos.y < m.pos.y + m.h && ctx.playerPos.y + ctx.playerH > m.pos.y;
        if (this._canAcquire(ctx) && inHeight && dist <= type.attack.reach
          && Math.abs(angleDiff(m.yaw, dirToYaw(dx, dz))) <= type.attack.arc
          && this._hasLOS(ctx, s.ex, s.ey, s.ez, s.dx, s.dy, s.dz, s.dist)) {
          ctx.hurtPlayer(type.attack.damage, 'warden');
          const kb = knockbackImpulse(ctx.gravity, type.attack.kbHeight, 0);
          const [nx, nz] = normalizeXZ(dx, dz);
          ctx.pushPlayer(nx * kb.speed, kb.vy, nz * kb.speed);
        }
        m.state = STATE.SLAM;
      }
      return false;
    }
    if (m.state === STATE.SLAM) {
      m.windup += SIM_DT;
      if (m.windup >= type.attack.windup + type.attack.swing) {
        m.state = STATE.RECOVER; m.windup = 0; m.attackCd = type.attack.cooldown;
      }
      return false;
    }
    if (m.state === STATE.RECOVER) {
      m.attackCd -= SIM_DT;
      if (m.attackCd <= 0) { m.attackCd = 0; m.state = STATE.CHASE; m.stateT = 0; }
      return false;
    }
    return false;
  }

  _timers(m) {
    if (m.hurtT > 0) m.hurtT = Math.max(0, m.hurtT - SIM_DT);
    if (m.invuln > 0) m.invuln = Math.max(0, m.invuln - SIM_DT);
    if (m.blT > 0) m.blT = Math.max(0, m.blT - SIM_DT);
    // Time since LOS was last confirmed - ticks up every sim tick by default
    // and is zeroed by a successful think-time LOS check (_thinkChase,
    // _thinkFuseLOS, _enterChase), so both the CHASE give-up rule and the
    // FUSE losGrace rule read real elapsed seconds, not a think-quantised one.
    m.lostFor += SIM_DT;
    const moved = hypot2(m.pos.x - m.prev.x, m.pos.z - m.prev.z);
    m.gait += moved * GAIT_RATE;
    m.age += SIM_DT;
    m.stateT += SIM_DT;
  }

  _despawnPass(ctx) {
    const px = ctx.playerPos.x, pz = ctx.playerPos.z;
    for (let i = this.liveN - 1; i >= 0; i--) {
      const m = this.live[i];
      if (m.state === STATE.DEAD || m.state === STATE.FUSE) { m.softT = 0; continue; }   // a fusing mob is never despawned
      let dist = hypot2(m.pos.x - px, m.pos.z - pz);
      if (ctx.players?.length) {
        for (const player of ctx.players) {
          if (!player.dead) dist = Math.min(dist, hypot2(m.pos.x - player.pos.x, m.pos.z - player.pos.z));
        }
      }
      if (dist > DESPAWN_HARD) { this._despawn(i); continue; }
      if (dist > DESPAWN_SOFT && !m.engaged) {
        m.softT += SIM_DT;
        if (m.softT >= DESPAWN_SOFT_TIME) this._despawn(i);
      } else {
        m.softT = 0;
      }
    }
  }

  // ---------------------------------------------------------------- steer
  _steer(m, ctx, gravity) {
    m.yaw = turnToward(m.yaw, m.wantYaw, YAW_RATE * SIM_DT);
    const locked = m.state === STATE.WINDUP || m.state === STATE.SLAM || m.state === STATE.RECOVER;
    const type = MOB_TYPES[m.kind];
    const speed = locked ? 0 : m.state === STATE.WANDER ? type.speed * WANDER_SPEED_FACTOR : type.speed;
    // Impulses belong to physics, not steering. Retain them over several ticks
    // so the visible recoil matches hit()'s immediate velocity update.
    m.vel.x = m.heading.x * speed + m.knockX;
    m.vel.z = m.heading.z * speed + m.knockZ;
    const decay = Math.exp(-7 * SIM_DT);
    m.knockX *= decay; m.knockZ *= decay;
  }

  // ----------------------------------------------------------------- think
  _think(m, ctx) {
    const type = MOB_TYPES[m.kind];
    switch (m.state) {
      case STATE.WANDER: this._thinkWander(m, ctx, type); break;
      case STATE.CHASE: this._thinkChase(m, ctx, type); break;
      case STATE.FUSE: this._thinkFuseLOS(m, ctx, type); break;
      default: break;   // WINDUP/SLAM/RECOVER need no steering decisions, just the attack timers
    }
  }

  _canAcquire(ctx) {
    return ctx.mode === 'survival' && !ctx.dead;
  }

  _hasLOS(ctx, ex, ey, ez, dx, dy, dz, dist) {
    if (dist <= 1e-6) return true;
    // raycastVoxel (raycast.js) marches P(t) = O + t*D and compares t directly
    // against maxDist in WORLD units, so D must be a UNIT vector - exactly how
    // its only other caller (game.js's block-targeting raycast) always calls
    // it, with a normalized THREE.Vector3. eye-to-player dx/dy/dz here is a
    // raw, undivided delta of magnitude `dist`; passed straight through, the
    // march would travel up to `dist` times too far past the real target and
    // report "blocked" on whatever terrain it happened to hit way out there -
    // in ordinary terrain, almost always. Normalizing here is the fix.
    return raycastVoxel(ctx.world, ex, ey, ez, dx / dist, dy / dist, dz / dist, dist,
      (id) => id !== AIR && !BLOCKS[id].liquid) === null;
  }

  _eyeVector(m, ctx, type) {
    const ex = m.pos.x, ey = m.pos.y + type.eye, ez = m.pos.z;
    // 1.62 mirrors player.js's EYE_H if the caller has not wired
    // ctx.playerEyeY yet - without a fallback here, a missing field turns
    // into a silent NaN dist that fails every sight/LOS check forever
    // (mobs never acquire, and nothing ever throws to say why). See the
    // integration report.
    const pey = ctx.playerEyeY ?? ctx.playerPos.y + 1.62;
    const dx = ctx.playerPos.x - ex, dy = pey - ey, dz = ctx.playerPos.z - ez;
    return { ex, ey, ez, dx, dy, dz, dist: Math.hypot(dx, dy, dz) };
  }

  _thinkWander(m, ctx, type) {
    if (this._canAcquire(ctx)) {
      const s = this._eyeVector(m, ctx, type);
      if (s.dist <= type.sight && this._hasLOS(ctx, s.ex, s.ey, s.ez, s.dx, s.dy, s.dz, s.dist)) {
        this._enterChase(m, ctx);
        return;
      }
    }
    m.wanderCd -= THINK_DT;
    if (m.wanderCd <= 0) {
      m.wanderCd = WANDER_INTERVAL_MIN + entRand(m) * (WANDER_INTERVAL_MAX - WANDER_INTERVAL_MIN);
      if (entRand(m) < WANDER_IDLE_CHANCE) {
        m.goal.x = m.pos.x; m.goal.z = m.pos.z;
      } else {
        const ang = entRand(m) * Math.PI * 2;
        const r = WANDER_GOAL_MIN + entRand(m) * (WANDER_GOAL_MAX - WANDER_GOAL_MIN);
        m.goal.x = m.anchor.x + Math.cos(ang) * r;
        m.goal.z = m.anchor.z + Math.sin(ang) * r;
      }
      m.headingT = HEADING_HOLD_TIME;   // force an immediate re-pick below
    }
    this._pickHeading(m, ctx, type, m.goal.x, m.goal.z);
  }

  _thinkChase(m, ctx, type) {
    const s = this._eyeVector(m, ctx, type);
    const los = this._canAcquire(ctx) && this._hasLOS(ctx, s.ex, s.ey, s.ez, s.dx, s.dy, s.dz, s.dist);
    if (los) m.lostFor = 0;

    const leashDist = hypot2(m.pos.x - m.anchor.x, m.pos.z - m.anchor.z);
    if ((m.lostFor > type.lose && s.dist > GIVE_UP_DIST) || leashDist > type.leash) {
      this._enterWander(m);
      return;
    }

    this._trackNavProgress(m);
    if (m.state !== STATE.CHASE) return;   // _trackNavProgress may have given up

    if (type.fuse && s.dist <= type.fuse.arm && los) {
      m.state = STATE.FUSE; m.stateT = 0; m.fuse = 0;
      return;
    }
    if (type.attack && los && s.dist <= type.attack.reach && m.attackCd <= 0) {
      m.wantYaw = dirToYaw(s.dx, s.dz);
      m.state = STATE.WINDUP; m.stateT = 0; m.windup = 0;
      return;
    }
    this._pickHeading(m, ctx, type, ctx.playerPos.x, ctx.playerPos.z);
  }

  _thinkFuseLOS(m, ctx, type) {
    // The fuse's own arm/abort counting runs every sim tick in _attackPhase,
    // driven by distance (cheap) and m.lostFor (the LOS staleness clock).
    // Only the expensive DDA itself is throttled to think-rate, here.
    const s = this._eyeVector(m, ctx, type);
    const los = this._canAcquire(ctx) && this._hasLOS(ctx, s.ex, s.ey, s.ez, s.dx, s.dy, s.dz, s.dist);
    if (los) m.lostFor = 0;
  }

  _enterChase(m, ctx) {
    m.state = STATE.CHASE; m.stateT = 0; m.lostFor = 0; m.engaged = true;
    m.anchor.x = ctx.playerPos.x; m.anchor.z = ctx.playerPos.z;   // the leash's acquisition point
    m.stuckT = 0; m.lastX = m.pos.x; m.lastZ = m.pos.z;
    m.headingT = HEADING_HOLD_TIME;
  }
  _enterWander(m) {
    m.anchor.x = m.pos.x; m.anchor.z = m.pos.z;   // wander from wherever the chase ended, not back to spawn
    m.state = STATE.WANDER; m.stateT = 0; m.wanderCd = 0;
    m.heading.x = 0; m.heading.z = 0;
  }

  _trackNavProgress(m) {
    const moved = hypot2(m.pos.x - m.lastX, m.pos.z - m.lastZ);
    if (moved >= NAV_STUCK_DIST) { m.stuckT = 0; m.lastX = m.pos.x; m.lastZ = m.pos.z; return; }
    m.stuckT += THINK_DT;
    if (m.stuckT >= NAV_GIVE_UP_TIME) { this._enterWander(m); return; }
    if (m.stuckT >= NAV_STUCK_TIME && m.blT <= 0) {
      m.blX = m.heading.x; m.blZ = m.heading.z; m.blT = NAV_BLACKLIST_TIME;
      m.headingT = HEADING_HOLD_TIME;   // force a fan re-pick next call
    }
  }

  _pickHeading(m, ctx, type, targetX, targetZ) {
    if (m.headingT < HEADING_HOLD_TIME) { m.headingT += THINK_DT; return; }
    const [dx, dz] = normalizeXZ(targetX - m.pos.x, targetZ - m.pos.z);
    if (dx === 0 && dz === 0) { m.heading.x = 0; m.heading.z = 0; m.headingT = 0; return; }
    const found = chooseHeading(ctx.world, m, type, ctx.gravity, dx, dz, m.blX, m.blZ, m.blT);
    if (!found) { m.heading.x = 0; m.heading.z = 0; m.headingT = 0; return; }
    m.heading.x = found.x; m.heading.z = found.z;
    m.wantYaw = dirToYaw(found.x, found.z);
    m.headingT = 0;
    if (found.result === JUMP && m.onGround) m.vel.y = mobJumpImpulse(ctx.gravity);
  }

  // -------------------------------------------------------------- combat
  /** Ray vs. every live AABB (sphere prefilter + slab test). Nearest hit <= reach. */
  pick(ox, oy, oz, dx, dy, dz, reach) {
    const len = Math.hypot(dx, dy, dz) || 1;
    const ux = dx / len, uy = dy / len, uz = dz / len;
    let best = null, bestDist = Infinity;
    for (let i = 0; i < this.liveN; i++) {
      const m = this.live[i];
      if (m.state === STATE.DEAD) continue;
      const cx = m.pos.x, cy = m.pos.y + m.h * 0.5, cz = m.pos.z;
      const rx = cx - ox, ry = cy - oy, rz = cz - oz;
      const boundR = Math.hypot(m.w, m.h) * 0.5 + 0.1;
      if (Math.hypot(rx, ry, rz) > reach + boundR) continue;   // sphere prefilter

      const hw = m.w / 2;
      const t = raySlab(ox, oy, oz, ux, uy, uz, m.pos.x - hw, m.pos.x + hw, m.pos.y, m.pos.y + m.h, m.pos.z - hw, m.pos.z + hw);
      if (t !== null && t <= reach && t < bestDist) { bestDist = t; best = m; }
    }
    return best ? { mob: best, dist: bestDist } : null;
  }

  /** Player swing. Applies armorTier (already folded into `damage` by the
   *  caller - see the report), i-frames, knockback, loot, death. */
  hit(mobId, damage, dirX, dirZ, ctx) {
    const m = this.byId(mobId);
    if (!m || m.state === STATE.DEAD || m.invuln > 0) return { hit: false, killed: false };
    const type = MOB_TYPES[m.kind];
    const creative = ctx.mode !== 'survival';
    // The golem needs a real pickaxe: halved if the held tool's tier is under
    // the target's armorTier. Reads an OPTIONAL ctx.heldToolTier rather than
    // taking a 5th parameter, so this stays a no-op (no reduction) against
    // any caller that does not set it yet - see the integration report for
    // the one-line mobContext() addition that turns it on.
    const under = ctx.heldToolTier !== undefined && ctx.heldToolTier < type.armorTier;
    const dmg = creative ? m.health : (under ? damage * 0.5 : damage);
    m.health = Math.max(0, m.health - dmg);
    m.hurtT = HURT_FLASH_TIME;
    m.invuln = HIT_IFRAMES;

    const kb = knockbackImpulse(ctx.gravity, KB_HEIGHT, type.kbResist);
    const [nx, nz] = normalizeXZ(dirX, dirZ);
    m.knockX += nx * kb.speed; m.knockZ += nz * kb.speed;
    m.vel.x += nx * kb.speed; m.vel.z += nz * kb.speed;
    m.vel.y = Math.max(m.vel.y, kb.vy);

    const killed = m.health <= 0;
    if (killed) this.kill(m, ctx, !creative);
    ctx.onHit?.(mobId, killed);
    return { hit: true, killed };
  }

  /** A mined or placed block draws every WANDERing mob within `radius`. */
  noise(x, y, z, radius = 24) {
    const r2 = radius * radius;
    for (let i = 0; i < this.liveN; i++) {
      const m = this.live[i];
      if (m.state !== STATE.WANDER) continue;
      const dx = m.pos.x - x, dz = m.pos.z - z;
      if (dx * dx + dz * dz > r2) continue;
      m.goal.x = x; m.goal.z = z;
      m.wanderCd = WANDER_INTERVAL_MIN; m.headingT = HEADING_HOLD_TIME;   // preserve this goal long enough to investigate
    }
  }

  kill(m, ctx, dropLoot) {
    if (m.state === STATE.DEAD) return;
    const type = MOB_TYPES[m.kind];
    if (dropLoot && ctx.mode === 'survival' && ctx.spawnDrop) {
      for (const spec of type.loot) {
        const id = itemIdOf(resolveLootKey(spec, ctx.planet ?? this.planet));
        if (!id) continue;
        const min = spec.min ?? 0, max = spec.max ?? min;
        const count = min + Math.floor(this.rng() * (max - min + 1));
        if (count > 0) ctx.spawnDrop(m.pos.x, m.pos.y + m.h * 0.5, m.pos.z, id, count);
      }
    }
    m.state = STATE.DEAD; m.stateT = 0; m.deathT = 0; m.alive = false;
    m.vel.x = 0; m.vel.y = 0; m.vel.z = 0;
  }

  blast(m, ctx) {
    const x = m.pos.x, y = m.pos.y + m.h * 0.3, z = m.pos.z;

    // Block destruction is NOT covered by Survival's creative no-op, so this
    // is the one explicit, unconditional, testable line that protects a
    // build world.
    if (ctx.mode !== 'survival') {
      ctx.burst?.(x, y, z, 0xff8844, 40, 9);
      ctx.onBlast?.(x, y, z, BLAST_R);
      this.kill(m, ctx, false);
      return;
    }

    // this.scratch is populated BEFORE onBlast fires, on purpose: onBlast is
    // also the signal game.js's own step() should read this.mobs.scratch on
    // (old[i] parallel to edits[i*4..]) to spill furnaces, drop life-support
    // and clear placedLights for what this blast just destroyed - see the
    // integration report. A few microseconds' difference in exactly when the
    // boom sound fires within the same synchronous call is not audible.
    computeBlast(ctx.world, x, y, z, BLAST_R, BLAST_POWER, this.rng, this.scratch);
    if (this.scratch.n > 0) ctx.setBlocks(this.scratch.edits, this.scratch.n);
    ctx.burst?.(x, y, z, 0xff8844, 40, 9);
    ctx.onBlast?.(x, y, z, BLAST_R);
    for (let i = 0; i < this.scratch.dn; i++) {
      const di = i * 5;
      ctx.spawnDrop(this.scratch.drops[di] + 0.5, this.scratch.drops[di + 1] + 0.5,
        this.scratch.drops[di + 2] + 0.5, this.scratch.drops[di + 3], this.scratch.drops[di + 4]);
    }

    // damage: player first, then every other live mob (chain reactions, free and funny)
    if (ctx.players?.length) {
      for (const player of ctx.players) {
        if (!player.dead) this._blastPlayer(ctx, x, y, z, player.pos, player.h ?? 1.8, player.hurt, player.push);
      }
    } else if (!ctx.dead) {
      this._blastPlayer(ctx, x, y, z, ctx.playerPos, ctx.playerH, ctx.hurtPlayer, ctx.pushPlayer);
    }
    for (let i = 0; i < this.liveN; i++) {
      const other = this.live[i];
      if (other === m || other.state === STATE.DEAD) continue;
      const oy = other.pos.y + other.h * 0.5;
      const dmg = blastDamageAt(ctx.world, x, y, z, BLAST_R, other.pos.x, oy, other.pos.z);
      if (dmg <= 0) continue;
      other.health = Math.max(0, other.health - dmg);
      other.hurtT = HURT_FLASH_TIME;
      const okb = knockbackImpulse(ctx.gravity, BLAST_KB_HEIGHT, MOB_TYPES[other.kind].kbResist);
      const [onx, onz] = normalizeXZ(other.pos.x - x, other.pos.z - z);
      other.knockX += onx * okb.speed; other.knockZ += onz * okb.speed;
      other.vel.x += onx * okb.speed; other.vel.z += onz * okb.speed;
      other.vel.y = Math.max(other.vel.y, okb.vy);
      if (other.health <= 0) this.kill(other, ctx, false);   // an explosion death drops nothing
    }

    this.kill(m, ctx, false);
  }

  _blastPlayer(ctx, x, y, z, pos, height, hurt, push) {
    const damage = blastDamageAt(ctx.world, x, y, z, BLAST_R, pos.x, pos.y + height * 0.5, pos.z);
    if (damage <= 0) return;
    hurt(damage, 'blast');
    const kb = knockbackImpulse(ctx.gravity, BLAST_KB_HEIGHT, 0);
    const [nx, nz] = normalizeXZ(pos.x - x, pos.z - z);
    push(nx * kb.speed, kb.vy, nz * kb.speed);
  }

  // ------------------------------------------------------------- spawning
  /** Force-spawn. Returns the mob id, or 0 if the spot is invalid. Probe + tests. */
  spawnAt(kindKey, x, y, z) {
    const kind = MOB[String(kindKey).toUpperCase()];
    if (kind === undefined) return 0;
    const m = this._spawnInternal(kind, x, y, z);
    return m ? m.id : 0;
  }

  _spawnInternal(kind, x, y, z) {
    const type = MOB_TYPES[kind];
    if (!type || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    if (this.liveN >= MAX_MOBS || this.counts[kind] >= type.cap) return null;
    const slot = this.free.pop();
    if (slot === undefined) return null;
    const id = this.nextId++;
    const m = resetMob(this.pool[slot], kind, id, x, y, z, type, (id * 2654435761) >>> 0);
    this.live[this.liveN++] = m;
    this.counts[kind]++;
    return m;
  }

  _despawn(i) {
    const m = this.live[i];
    this.counts[m.kind]--;
    this.free.push(m.slot);
    this.live[i] = this.live[this.liveN - 1];
    this.live[this.liveN - 1] = null;
    this.liveN--;
  }

  _directorAttempt(ctx) {
    const rates = ctx.planet?.mobs ?? this.planet?.mobs;
    if (!rates) return;   // this world opts out of mobs, or the per-planet rates have not landed yet
    const total = (rates.crawler ?? 0) + (rates.warden ?? 0);
    if (total <= 0) return;

    const px = ctx.playerPos.x, pz = ctx.playerPos.z;
    for (let attempt = 0; attempt < SPAWN_CANDIDATES; attempt++) {
      const kind = this.rng() * total < (rates.crawler ?? 0) ? MOB.CRAWLER : MOB.WARDEN;
      const type = MOB_TYPES[kind];

      const angle = this.rng() * Math.PI * 2;
      const dist = SPAWN_MIN_DIST + this.rng() * (SPAWN_MAX_DIST - SPAWN_MIN_DIST);
      const x = Math.floor(px + Math.cos(angle) * dist);
      const z = Math.floor(pz + Math.sin(angle) * dist);
      if (ctx.world.isLoaded && !ctx.world.isLoaded(x, z)) continue;

      const y = this._findGroundY(ctx.world, x, z, ctx.playerPos.y, type);
      if (y === null) continue;
      if (!this._darknessOk(ctx, x, y, z)) continue;
      if (ctx.blocked?.(x, y, z)) continue;
      if (this._tooDense(x, y, z)) continue;

      const probe = this._spawnProbe;
      probe.w = type.w; probe.h = type.h;
      probe.pos.x = x + 0.5; probe.pos.y = y; probe.pos.z = z + 0.5;
      if (boxOverlapsSolid(ctx.world, probe)) continue;
      if (liquidAt(ctx.world, x + 0.5, y + 0.1, z + 0.5)) continue;

      const m = this._spawnInternal(kind, x + 0.5, y, z + 0.5);
      if (m) return;   // <=1 spawn per attempt cycle
    }
  }

  _findGroundY(world, x, z, playerY, type) {
    const top = Math.floor(playerY) + SPAWN_COLUMN_SCAN, bottom = Math.floor(playerY) - SPAWN_COLUMN_SCAN;
    const half = Math.floor(type.spawn.footing / 2);
    for (let y = top; y >= bottom; y--) {
      if (!SOLID[world.getBlock(x, y, z)]) continue;
      let ok = true;
      for (let h = 1; h <= type.spawn.headroom && ok; h++) {
        if (SOLID[world.getBlock(x, y + h, z)]) ok = false;
      }
      for (let fz = -half; fz <= half && ok; fz++) {
        for (let fx = -half; fx <= half && ok; fx++) {
          if (!SOLID[world.getBlock(x + fx, y, z + fz)]) ok = false;
        }
      }
      if (ok) return y + 1;
    }
    return null;
  }

  _darknessOk(ctx, x, y, z) {
    for (let h = 1; h <= SPAWN_LIGHT_SCAN; h++) {
      if (BLOCKS[ctx.world.getBlock(x, y + h, z)]?.opaque) return true;
    }
    return (ctx.daylight ?? 1) < SPAWN_DAYLIGHT_MAX;
  }

  _tooDense(x, y, z) {
    let n = 0;
    const r2 = SPAWN_DENSITY_RADIUS * SPAWN_DENSITY_RADIUS;
    for (let i = 0; i < this.liveN; i++) {
      const m = this.live[i];
      const dx = m.pos.x - x, dy = m.pos.y - y, dz = m.pos.z - z;
      if (dx * dx + dy * dy + dz * dz <= r2 && ++n >= SPAWN_DENSITY_MAX) return true;
    }
    return false;
  }
}

/** Ray vs AABB slab test. Returns the entry distance (>=0), or null. */
function raySlab(ox, oy, oz, dx, dy, dz, minX, maxX, minY, maxY, minZ, maxZ) {
  let tmin = -Infinity, tmax = Infinity;
  if (Math.abs(dx) < 1e-12) { if (ox < minX || ox > maxX) return null; }
  else { let t1 = (minX - ox) / dx, t2 = (maxX - ox) / dx; if (t1 > t2) [t1, t2] = [t2, t1]; tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2); }
  if (Math.abs(dy) < 1e-12) { if (oy < minY || oy > maxY) return null; }
  else { let t1 = (minY - oy) / dy, t2 = (maxY - oy) / dy; if (t1 > t2) [t1, t2] = [t2, t1]; tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2); }
  if (Math.abs(dz) < 1e-12) { if (oz < minZ || oz > maxZ) return null; }
  else { let t1 = (minZ - oz) / dz, t2 = (maxZ - oz) / dz; if (t1 > t2) [t1, t2] = [t2, t1]; tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2); }
  if (tmin > tmax || tmax < 0) return null;
  return Math.max(0, tmin);
}
