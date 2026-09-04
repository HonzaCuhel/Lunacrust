// Can you actually bootstrap on every world?
//
// This is a closure analysis, not a play-through: start from what bare hands can
// harvest out of a planet's real terrain, then repeatedly apply every recipe and
// smelt whose inputs are already available - and every time a better pickaxe
// appears, unlock the ore tiers it can reach and feed their drops back in. If the
// fixpoint is missing a tool tier or life support, that planet is unwinnable and
// this test says so by name.

import assert from 'node:assert/strict';
import { PLANETS } from '../app/js/planets.js';
import { WorldGen } from '../app/js/worldgen.js';
import { BLOCKS, AIR } from '../app/js/blocks.js';
import { ITEMS, ITEM_BY_KEY, itemIdOf, dropFor, canHarvest, LANDING_KIT, matchesIngredient } from '../app/js/items.js';
import { RECIPES, SMELTING, smeltingResult, fuelSeconds, ingredientsOf } from '../app/js/recipes.js';

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

/** Every block id that actually occurs in a few chunks of this planet. */
function blocksOn(planet, chunks = 6) {
  const gen = new WorldGen(planet, 20240);
  const seen = new Set();
  for (let i = 0; i < chunks; i++) {
    const v = gen.generate(i - 3, (i * 5) % 7);
    for (const id of v) if (id !== AIR) seen.add(id);
  }
  return seen;
}

/** Best pickaxe tier among the items we hold. */
function bestTier(have) {
  let tier = 0;
  for (const id of have) {
    const t = ITEMS[id]?.tool;
    if (t && t.type === 'pickaxe') tier = Math.max(tier, t.tier);
  }
  return tier;
}

function closure(planet, { withKit }) {
  const present = blocksOn(planet);
  const have = new Set();
  if (withKit) for (const k of LANDING_KIT) have.add(itemIdOf(k.key));

  const satisfied = (spec) => {
    for (const id of have) if (matchesIngredient(id, spec)) return true;
    return false;
  };

  for (let pass = 0; pass < 24; pass++) {
    const before = have.size;

    // 1. harvest whatever the current best tool can break
    const tier = bestTier(have);
    const probe = [...have].find((id) => ITEMS[id]?.tool?.type === 'pickaxe' && ITEMS[id].tool.tier === tier) ?? 0;
    for (const blockId of present) {
      if (!canHarvest(blockId, probe)) continue;
      const d = dropFor(blockId, probe, 0.99);
      if (d) have.add(d.item);
      // a mined block you can place is also an item you hold
      if (BLOCKS[blockId].drop === BLOCKS[blockId].key) have.add(blockId);
    }

    // 2. craft everything craftable
    for (const r of RECIPES) {
      if (ingredientsOf(r).every(satisfied)) have.add(r.out.item);
    }

    // 3. smelt everything smeltable, provided some fuel exists
    const hasFuel = [...have].some((id) => fuelSeconds(id) > 0);
    if (hasFuel) {
      for (const id of [...have]) {
        const s = smeltingResult(id);
        if (s) have.add(s.item);
      }
    }

    if (have.size === before) break;
  }
  return have;
}

const REQUIRED = [
  'fabricator', 'furnace', 'stick', 'iron_ingot',
  'stone_pickaxe', 'iron_pickaxe', 'crystal_pickaxe',
  'oxygen_canister', 'medkit', 'nutrient_paste', 'ration',
  'life_support', 'lamp', 'glass', 'hull',
];

console.log('planet    hand-start  reachable  missing');
for (const planet of PLANETS) {
  const kitted = closure(planet, { withKit: true });
  const bare = closure(planet, { withKit: false });

  const missing = REQUIRED.filter((k) => !kitted.has(itemIdOf(k)));
  const missingBare = REQUIRED.filter((k) => !bare.has(itemIdOf(k)));

  console.log(
    planet.id.padEnd(9),
    String(bare.size).padStart(6),
    String(kitted.size).padStart(10),
    '  ' + (missing.length ? missing.join(',') : '-'),
  );

  ok(missing.length === 0, `${planet.id}: unreachable with the landing kit -> ${missing.join(', ')}`);
  // The harder promise: a player who lost everything can still climb back.
  ok(missingBare.length === 0, `${planet.id}: unreachable from bare hands -> ${missingBare.join(', ')}`);
}

// The bootstrap itself: rock is hand-breakable everywhere, and rock makes rods.
for (const planet of PLANETS) {
  const present = blocksOn(planet, 3);
  const handRock = [...present].some((id) => canHarvest(id, 0) && BLOCKS[id].material === 'rock');
  ok(handRock, `${planet.id}: no rock that bare hands can harvest`);
}

// Food and oxygen must be renewable, not just present in the landing kit.
for (const planet of PLANETS) {
  const have = closure(planet, { withKit: false });
  ok(have.has(itemIdOf('nutrient_paste')), `${planet.id}: no renewable food`);
  ok(have.has(itemIdOf('oxygen_canister')) || planet.atmosphere.breathable,
    `${planet.id}: no renewable oxygen`);
}

console.log(`\nprogression: ${checks} checks passed - every world is winnable from bare hands`);
