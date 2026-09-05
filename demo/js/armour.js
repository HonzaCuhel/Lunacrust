// Pure armour maths: what a stack of equipped pieces adds up to, and how that
// total turns into a damage discount. No THREE, no DOM - the container that
// holds the four pieces lives in inventory.js (it needs that file's private
// slot-normalisation helpers), and the mitigation itself lives in survival.js
// as a snapshot of plain numbers. This module is the seam between them: it
// knows what a piece IS, not who is wearing it or what hit them.

import { armourOf } from './items.js';

export const ARMOUR_SLOTS = ['head', 'chest', 'legs', 'feet'];
export const ARMOUR_CAP = 20;
export const ARMOUR_PER_POINT = 0.04;   // survival.js duplicates this - see its header note

/** Does item `itemId` belong in armour slot `i`? Also false for anything non-armour. */
export const fitsSlot = (itemId, i) => armourOf(itemId)?.slot === ARMOUR_SLOTS[i];

/**
 * Sum the four slots into what Survival needs. `minWear` is the worst
 * remaining-durability fraction among worn pieces (1 = untouched, 0 = about to
 * break) and defaults to 1 when nothing is worn, so an empty suit never reads
 * as "about to break".
 * @param {Array<{item:number,count:number,dur?:number}|null>} slots
 * @returns {{points:number, o2Save:number, fallReduce:number, worn:number, minWear:number}}
 */
export function armourStats(slots) {
  let points = 0, o2Save = 0, fallReduce = 0, worn = 0, minWear = 1;
  for (let i = 0; i < ARMOUR_SLOTS.length; i++) {
    const s = slots?.[i];
    if (!s) continue;
    const a = armourOf(s.item);
    if (!a) continue;   // a corrupt slot should never crash the HUD
    worn++;
    points += a.defense;
    o2Save += a.o2Save;
    fallReduce += a.fallReduce;
    const max = a.durability;
    const dur = s.dur ?? max;   // no dur field yet = factory-fresh
    const frac = max > 0 ? Math.max(0, Math.min(1, dur / max)) : 1;
    if (frac < minWear) minWear = frac;
  }
  return { points, o2Save, fallReduce, worn, minWear };
}

/**
 * Fraction of incoming damage a full suit of `pts` points absorbs. Minecraft's
 * curve, because it is a good one: every point is worth a flat 4%, so a full
 * tier-3 kit (18 points) absorbs 72% and the wearer still takes 28% of every
 * hit - a suit is protection, not immunity.
 * @returns {number} 0..0.8
 */
export const damageReduction = (pts) => Math.min(ARMOUR_CAP, Math.max(0, pts)) * ARMOUR_PER_POINT;

/** Durability spent per hit, from the raw (pre-armour) damage. Never zero on a real hit. */
export const wearCost = (rawDamage) => Math.max(1, Math.round(rawDamage / 4));

/**
 * Spend `cost` durability off every worn piece, nulling anything that breaks.
 * Mutates `slots` in place - the caller owns the container these came from.
 * @returns {string[]} ARMOUR_SLOTS names of pieces that broke this call
 */
export function wearArmour(slots, cost) {
  const broken = [];
  const c = Math.round(cost);
  if (!(c > 0) || !slots) return broken;
  for (let i = 0; i < ARMOUR_SLOTS.length; i++) {
    const s = slots[i];
    if (!s) continue;
    const a = armourOf(s.item);
    if (!a) continue;
    const max = a.durability;
    const cur = s.dur === undefined || s.dur === null ? max : s.dur;
    const next = cur - c;
    if (next <= 0) {
      slots[i] = null;
      broken.push(ARMOUR_SLOTS[i]);
    } else {
      s.dur = next;
    }
  }
  return broken;
}
