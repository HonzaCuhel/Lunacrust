// World-bound maths: where you may place a block, and what falling below the
// bottom of the world costs. This is deliberately narrower than it sounds -
// the flight clamp itself (FLIGHT_FLOOR / FLIGHT_CEIL) already lives in
// player.js and is left alone here. What is missing there is the falling
// side: walking (or being pushed) off the edge is not clamped, on purpose -
// Jupiter's void below its cloud decks is a real hazard, not a wall - so this
// module grades how bad it gets the deeper you fall, instead of the flat
// teleport-and-20-damage the game used to do.
//
// WORLD_H is the one thing this file needs from outside, and worldgen.js is
// itself free of THREE/DOM (it already runs on both the main thread and the
// chunk worker), so importing the real constant here is safer than copying
// the number 128 and hoping nobody ever changes it in one place and not
// the other.
import { WORLD_H } from './worldgen.js';

export const BUILD_MIN = 1;
export const BUILD_MAX = WORLD_H - 1; // 127

// Below VOID_TOP the void starts biting; by VOID_FATAL it is over. The gap
// between them is what makes a fall out of the world an authored death
// (fog, vignette, a few seconds of damage) rather than a surprise.
export const VOID_TOP = -6;
export const VOID_FATAL = -20;
export const VOID_DPS = 6;

export const canBuildAt = (y) => y >= BUILD_MIN && y <= BUILD_MAX;

/**
 * @param {number} y
 * @returns {{dps:number, fatal:boolean, haze:number}} haze is 0..1, for the
 *   void vignette/fog - 0 at VOID_TOP, 1 at and below VOID_FATAL.
 */
export function voidPhase(y) {
  if (y >= VOID_TOP) return { dps: 0, fatal: false, haze: 0 };
  const t = Math.min(1, (VOID_TOP - y) / (VOID_TOP - VOID_FATAL));
  return { dps: VOID_DPS, fatal: y <= VOID_FATAL, haze: t };
}
