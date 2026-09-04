// Unit tests for app/js/armour.js - the pure maths behind wearing a suit.
//   node tests/armour.test.mjs

import assert from 'node:assert/strict';
import { itemIdOf } from '../app/js/items.js';
import {
  ARMOUR_SLOTS, ARMOUR_CAP, ARMOUR_PER_POINT,
  fitsSlot, armourStats, damageReduction, wearCost, wearArmour,
} from '../app/js/armour.js';

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; }
  catch (err) { failures.push({ name, err }); }
}
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b} (+-${eps})`);

const HELMET = itemIdOf('patch_helmet');   // slot head, defense 1, durability 165, o2Save 0.20
const CHEST = itemIdOf('patch_chest');     // slot chest, defense 3, durability 240
const LEGS = itemIdOf('patch_legs');       // slot legs, defense 2, durability 225
const BOOTS = itemIdOf('patch_boots');     // slot feet, defense 1, durability 195, fallReduce 0.15
const ALLOY_HELMET = itemIdOf('alloy_helmet');
const DIRT = itemIdOf('dirt');

const stack = (item, count, dur) => (dur === undefined ? { item, count } : { item, count, dur });
const emptySlots = () => [null, null, null, null];

// ------------------------------------------------------------- ARMOUR_SLOTS

test('ARMOUR_SLOTS is head/chest/legs/feet, in that order', () => {
  assert.deepEqual(ARMOUR_SLOTS, ['head', 'chest', 'legs', 'feet']);
});

// ------------------------------------------------------------------ fitsSlot

test('fitsSlot matches an item to exactly its own slot index', () => {
  assert.equal(fitsSlot(HELMET, 0), true);
  assert.equal(fitsSlot(HELMET, 1), false);
  assert.equal(fitsSlot(HELMET, 2), false);
  assert.equal(fitsSlot(HELMET, 3), false);
  assert.equal(fitsSlot(BOOTS, 3), true);
  assert.equal(fitsSlot(BOOTS, 0), false);
});

test('fitsSlot is false for a non-armour item and for garbage ids', () => {
  assert.equal(fitsSlot(DIRT, 0), false);
  assert.equal(fitsSlot(DIRT, 1), false);
  assert.equal(fitsSlot(0, 0), false);
  assert.equal(fitsSlot(-1, 0), false);
  assert.equal(fitsSlot(999999, 0), false);
});

// --------------------------------------------------------------- armourStats

test('an empty suit sums to zero points and full (1) minWear', () => {
  const s = armourStats(emptySlots());
  assert.deepEqual(s, { points: 0, o2Save: 0, fallReduce: 0, worn: 0, minWear: 1 });
});

test('armourStats sums defense, o2Save and fallReduce across worn pieces', () => {
  const slots = emptySlots();
  slots[0] = stack(HELMET, 1);
  slots[1] = stack(CHEST, 1);
  slots[2] = stack(LEGS, 1);
  slots[3] = stack(BOOTS, 1);
  const s = armourStats(slots);
  assert.equal(s.points, 1 + 3 + 2 + 1);   // 7, the tier-1 total from the spec table
  near(s.o2Save, 0.20);                    // only the helmet carries this
  near(s.fallReduce, 0.15);                // only the boots carry this
  assert.equal(s.worn, 4);
});

test('armourStats treats a stack with no dur field as factory-fresh (minWear 1)', () => {
  const slots = emptySlots();
  slots[0] = stack(HELMET, 1);   // no dur
  const s = armourStats(slots);
  assert.equal(s.minWear, 1);
});

test('armourStats reports the worst wear fraction among worn pieces', () => {
  const slots = emptySlots();
  slots[0] = stack(HELMET, 1, 165);    // fresh: 1.0
  slots[1] = stack(CHEST, 1, 60);      // 60/240 = 0.25, the worst
  slots[3] = stack(BOOTS, 1, 195);     // fresh: 1.0
  const s = armourStats(slots);
  near(s.minWear, 0.25);
});

test('armourStats ignores a null/undefined slot array without throwing', () => {
  assert.deepEqual(armourStats(null), { points: 0, o2Save: 0, fallReduce: 0, worn: 0, minWear: 1 });
  assert.deepEqual(armourStats(undefined), { points: 0, o2Save: 0, fallReduce: 0, worn: 0, minWear: 1 });
});

test('armourStats skips a slot that holds a non-armour item instead of crashing', () => {
  // Should never happen through ArmourContainer, but a corrupt save or a stray
  // direct write must not take the HUD down with it.
  const slots = [stack(DIRT, 1), null, null, null];
  const s = armourStats(slots);
  assert.deepEqual(s, { points: 0, o2Save: 0, fallReduce: 0, worn: 0, minWear: 1 });
});

// --------------------------------------------------------------- damageReduction

test('damageReduction is a flat 4% per point', () => {
  near(damageReduction(0), 0);
  near(damageReduction(1), 0.04);
  near(damageReduction(7), 0.28);    // full tier-1 suit
  near(damageReduction(12), 0.48);   // full tier-2 suit
  near(damageReduction(18), 0.72);   // full tier-3 suit, the spec's own example
});

test('damageReduction clamps to ARMOUR_CAP and never goes negative', () => {
  assert.equal(ARMOUR_CAP, 20);
  assert.equal(ARMOUR_PER_POINT, 0.04);
  near(damageReduction(ARMOUR_CAP), 0.8);
  near(damageReduction(999), 0.8, 1e-9);   // above cap clamps rather than exceeding 80%
  near(damageReduction(-5), 0);            // never negative
});

// --------------------------------------------------------------------- wearCost

test('wearCost is raw damage / 4, rounded, and never less than 1 on a real hit', () => {
  assert.equal(wearCost(4), 1);
  assert.equal(wearCost(10), 3);       // round(2.5) -> 3 (round-half-up)
  assert.equal(wearCost(1), 1);        // round(0.25) -> 0, floored up to 1
  assert.equal(wearCost(0.1), 1);
  assert.equal(wearCost(40), 10);
});

// -------------------------------------------------------------------- wearArmour

test('wearArmour decrements every worn piece by the same cost', () => {
  const slots = emptySlots();
  slots[0] = stack(HELMET, 1, 165);
  slots[1] = stack(CHEST, 1, 240);
  const broken = wearArmour(slots, 10);
  assert.deepEqual(broken, []);
  assert.equal(slots[0].dur, 155);
  assert.equal(slots[1].dur, 230);
});

test('wearArmour treats an undefined dur as factory-fresh before spending it', () => {
  const slots = emptySlots();
  slots[0] = stack(HELMET, 1);   // no dur yet
  wearArmour(slots, 5);
  assert.equal(slots[0].dur, 160);   // 165 - 5
});

test('wearArmour nulls a piece that reaches zero and reports its slot name', () => {
  const slots = emptySlots();
  slots[3] = stack(BOOTS, 1, 4);
  const broken = wearArmour(slots, 4);
  assert.deepEqual(broken, ['feet']);
  assert.equal(slots[3], null);
});

test('wearArmour can break more than one piece in the same hit and lists both', () => {
  const slots = emptySlots();
  slots[0] = stack(HELMET, 1, 3);
  slots[2] = stack(LEGS, 1, 3);
  slots[1] = stack(CHEST, 1, 200);   // survives
  const broken = wearArmour(slots, 5);
  assert.deepEqual(broken.sort(), ['head', 'legs']);
  assert.equal(slots[0], null);
  assert.equal(slots[2], null);
  assert.equal(slots[1].dur, 195);
});

test('wearArmour skips empty slots and never invents a piece', () => {
  const slots = emptySlots();
  slots[1] = stack(CHEST, 1, 240);
  const broken = wearArmour(slots, 10);
  assert.deepEqual(broken, []);
  assert.equal(slots[0], null);
  assert.equal(slots[2], null);
  assert.equal(slots[3], null);
});

test('wearArmour is a no-op for a zero, negative or non-finite cost', () => {
  const slots = emptySlots();
  slots[0] = stack(HELMET, 1, 165);
  assert.deepEqual(wearArmour(slots, 0), []);
  assert.deepEqual(wearArmour(slots, -3), []);
  assert.deepEqual(wearArmour(slots, NaN), []);
  assert.equal(slots[0].dur, 165, 'nothing spent');
});

test('wearArmour tolerates a missing slots array', () => {
  assert.deepEqual(wearArmour(null, 5), []);
  assert.deepEqual(wearArmour(undefined, 5), []);
});

test('wearArmour rounds a fractional cost before spending it', () => {
  const slots = emptySlots();
  slots[0] = stack(HELMET, 1, 165);
  wearArmour(slots, 2.6);
  assert.equal(slots[0].dur, 162);   // round(2.6) = 3
});

// ------------------------------------------------------------ cross-checks
// The two-tier-3-helmet swap and the alloy tier all reuse the same functions,
// so a quick sanity pass across a different tier catches a hardcoded tier-1
// assumption anywhere above.

test('a full tier-2 (alloy) suit adds up the way the spec table says', () => {
  const slots = [
    stack(ALLOY_HELMET, 1), stack(itemIdOf('alloy_chest'), 1),
    stack(itemIdOf('alloy_legs'), 1), stack(itemIdOf('alloy_boots'), 1),
  ];
  const s = armourStats(slots);
  assert.equal(s.points, 2 + 5 + 4 + 1);   // 12
  near(s.o2Save, 0.45);
  near(s.fallReduce, 0.25);
  near(damageReduction(s.points), 0.48);
});

// --- summary ----------------------------------------------------------------
for (const f of failures) {
  console.error(`FAIL  ${f.name}\n      ${f.err.message.split('\n')[0]}`);
}
const total = passed + failures.length;
console.log(`\narmour: ${passed}/${total} passed${failures.length ? `, ${failures.length} FAILED` : ''}`);
process.exit(failures.length ? 1 : 0);
