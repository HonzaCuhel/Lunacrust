// Simulation registry. Numeric IDs remain stable for saved and network data;
// display names and original creature art can evolve independently.
import { TIER } from './blocks.js';
import { G_SCALE } from './body.js';
import * as Survival from './survival.js';
const FALL_SAFE_SPEED = Survival.FALL_SAFE_SPEED ?? 13;

export const MOB = { CRAWLER: 0, WARDEN: 1 };

/** @type {Array<any>} */
export const MOB_TYPES = [];

MOB_TYPES[MOB.CRAWLER] = {
  key: 'crawler', name: 'Flux Skitter',
  w: 0.98, h: 1.30, eye: 0.90,
  health: 16, speed: 4.0, cap: 18,
  sight: 16, lose: 24, leash: 32,
  canJump: true, maxDropCap: 6, kbResist: 0, armorTier: TIER.HAND,
  attack: null,                                   // the fuse IS the attack
  fuse: { arm: 3.0, abort: 6.0, time: 1.5, decay: 2, losGrace: 0.3 },
  loot: [{ item: 'volatiles', min: 1, max: 2 }],
  spawn: { footing: 1, headroom: 2 },
};

MOB_TYPES[MOB.WARDEN] = {
  key: 'warden', name: 'Basalt Resonator',
  w: 1.20, h: 2.50, eye: 2.15,
  health: 40, speed: 2.6, cap: 6,
  sight: 18, lose: 28, leash: 40,
  canJump: false, maxDropCap: 4, kbResist: 0.78, armorTier: TIER.STONE,
  attack: {
    reach: 2.6, arc: 1.047, windup: 0.45, swing: 0.12,
    damage: 6, cooldown: 1.6, kbHeight: 0.42,
  },
  fuse: null,
  loot: [{ item: '@deep', min: 2, max: 4 }, { item: 'raw_iron', min: 0, max: 1 }],
  spawn: { footing: 3, headroom: 3 },
};

export const mobGravity = (planet) => planet.gravity * G_SCALE;

// A suit servo is the player's excuse for clearing a block on Jupiter; a mob
// gets no such favour; 1.25 blocks is simply what its legs can do.
export const mobJumpImpulse = (gravity) => Math.sqrt(2 * gravity * 1.25);

// Mirrors the player's `survival.safeImpact = jumpImpulse + 1.2` rule, so a
// mob never hurts itself with its own jump on Jupiter, where the impulse is
// above the flat FALL_SAFE_SPEED floor.
export const mobSafeImpact = (gravity) => Math.max(FALL_SAFE_SPEED, mobJumpImpulse(gravity) + 1.2);

/**
 * The highest ledge this mob will step off unhurt, on THIS world. FALL_SAFE_SPEED
 * is survival.js's number: one constant, one place, so the two can never drift.
 */
export function maxDropFor(type, gravity) {
  const raw = Math.floor((FALL_SAFE_SPEED * FALL_SAFE_SPEED) / (2 * gravity));
  return Math.min(Math.max(raw, 1), type.maxDropCap);
}
