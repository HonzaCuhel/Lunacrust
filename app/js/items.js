// Item registry: everything that can sit in an inventory slot.
//
// Block items keep the block's own id (item id === block id), so converting
// between "the thing in your hand" and "the thing in the world" never needs a
// lookup table. Non-block items - tools, food, materials - are appended after
// them, which is why BLOCKS must be fully defined before this module loads.
//
// Recipes refer to items either by key ('iron_ingot') or by tag ('#rock'). Tags
// are what make crafting work on eight different planets: there is no cobble on
// Mars, but there is martian rock, and both answer to '#rock'.

import { BLOCKS, BY_KEY, AIR, TIER } from './blocks.js';

export const NONE = 0;

/** @type {Array<any>} */
export const ITEMS = [];
export const ITEM_BY_KEY = new Map();
export const TAG_MEMBERS = new Map();   // '#rock' -> Set<itemId>
export const ITEM_TAGS = new Map();     // itemId -> string[]

function push(item) {
  ITEMS[item.id] = item;
  ITEM_BY_KEY.set(item.key, item);
  return item.id;
}

// ---------------------------------------------------------------- block items
// id 0 is "empty slot", which lines up with air being block id 0.
push({ id: 0, key: 'none', name: '', kind: 'none', stack: 0, blockId: AIR, tool: null, food: null, fuel: 0, use: null, armour: null });

for (const b of BLOCKS) {
  if (b.id === AIR) continue;
  push({
    id: b.id,
    key: b.key,
    name: b.name,
    kind: 'block',
    stack: 64,
    blockId: b.id,
    tool: null,
    food: null,
    fuel: b.fuel ?? 0,
    use: null,
    armour: null,
  });
}

let nextId = BLOCKS.length;
const def = (key, name, opts = {}) => push({
  id: nextId++,
  key,
  name,
  kind: opts.kind ?? 'material',
  stack: opts.stack ?? 64,
  blockId: null,
  tool: opts.tool ?? null,
  food: opts.food ?? null,
  fuel: opts.fuel ?? 0,
  use: opts.use ?? null,
  armour: opts.armour ?? null,
});

// -------------------------------------------------------------------- tools
// speed multiplies mining rate; tier gates whether a block drops anything.
function tool(key, name, type, tier, speed, durability) {
  return def(key, name, { kind: 'tool', stack: 1, tool: { type, tier, speed, durability } });
}

// Standard issue, and deliberately iron-capable: it is the whole reason a
// landing on an airless world can bootstrap a tech tree at all.
export const HAND_DRILL = tool('hand_drill', 'Standard Hand Drill', 'pickaxe', TIER.STONE, 3.2, 160);

export const WOOD_PICKAXE = tool('wood_pickaxe', 'Wooden Pickaxe', 'pickaxe', TIER.BASIC, 2.6, 60);
export const WOOD_AXE = tool('wood_axe', 'Wooden Axe', 'axe', TIER.BASIC, 2.6, 60);
export const WOOD_SHOVEL = tool('wood_shovel', 'Wooden Shovel', 'shovel', TIER.BASIC, 2.6, 60);

export const STONE_PICKAXE = tool('stone_pickaxe', 'Stone Pickaxe', 'pickaxe', TIER.STONE, 4.6, 132);
export const STONE_AXE = tool('stone_axe', 'Stone Axe', 'axe', TIER.STONE, 4.6, 132);
export const STONE_SHOVEL = tool('stone_shovel', 'Stone Shovel', 'shovel', TIER.STONE, 4.6, 132);

export const IRON_PICKAXE = tool('iron_pickaxe', 'Iron Pickaxe', 'pickaxe', TIER.IRON, 7.2, 251);
export const IRON_AXE = tool('iron_axe', 'Iron Axe', 'axe', TIER.IRON, 7.2, 251);
export const IRON_SHOVEL = tool('iron_shovel', 'Iron Shovel', 'shovel', TIER.IRON, 7.2, 251);

export const CRYSTAL_PICKAXE = tool('crystal_pickaxe', 'Crystal Pickaxe', 'pickaxe', TIER.CRYSTAL, 12, 820);
export const CRYSTAL_AXE = tool('crystal_axe', 'Crystal Axe', 'axe', TIER.CRYSTAL, 12, 820);
export const CRYSTAL_SHOVEL = tool('crystal_shovel', 'Crystal Shovel', 'shovel', TIER.CRYSTAL, 12, 820);

// ---------------------------------------------------------------- materials
export const STICK = def('stick', 'Rod', { fuel: 3 });
export const COAL = def('coal', 'Coal', { fuel: 40 });
export const RAW_IRON = def('raw_iron', 'Raw Iron');
export const IRON_INGOT = def('iron_ingot', 'Iron Ingot');
export const RAW_GOLD = def('raw_gold', 'Raw Gold');
export const GOLD_INGOT = def('gold_ingot', 'Gold Ingot');
export const CRYSTAL_SHARD = def('crystal_shard', 'Void Crystal Shard');
export const VOLATILES = def('volatiles', 'Volatiles', { fuel: 0 });

// --------------------------------------------------------------------- food
export const ALGAE = def('algae', 'Algae Mat', { kind: 'food', food: { hunger: 2, heal: 0 } });
export const SPORE_POD = def('spore_pod', 'Spore Pod', { kind: 'food', food: { hunger: 3, heal: 0 } });
export const NUTRIENT_PASTE = def('nutrient_paste', 'Nutrient Paste', { kind: 'food', food: { hunger: 5, heal: 0 } });
export const RATION = def('ration', 'Field Ration', { kind: 'food', food: { hunger: 9, heal: 2 } });

// ------------------------------------------------------------------ usables
export const OXYGEN_CANISTER = def('oxygen_canister', 'Oxygen Canister', {
  kind: 'use', stack: 16, use: { oxygen: 65 },
});
export const MEDKIT = def('medkit', 'Medkit', {
  kind: 'use', stack: 8, use: { health: 8 },
});

// -------------------------------------------------------------------- armour
// Twelve items in three tiers, keyed to tags that exist on every planet - the
// same constraint that produced stick_from_rock: there is no Earth-only choke
// point on the road to a suit. `slot` is one of ARMOUR_SLOTS (armour.js);
// everything else here is read by armour.js (defense/durability) and
// survival.js (o2Save/fallReduce) through a snapshot, never through this item
// record directly.
function armourPiece(key, name, slot, tier, defense, durability, extra = {}) {
  return def(key, name, {
    kind: 'armour', stack: 1,
    armour: { slot, tier, defense, durability, o2Save: 0, fallReduce: 0, ...extra },
  });
}

// Durability mirrors the tool ladder's shape: fixed per piece at tier 1, x1.5
// at tier 2, x3.3 at tier 3 - the same jump the pickaxe/axe/shovel loop above
// takes from wood to stone to crystal.
const ARMOUR_DUR_BASE = { helmet: 165, chest: 240, legs: 225, boots: 195 };
const ARMOUR_DUR_MULT = [1, 1.5, 3.3];
const armourDur = (shape, tierIndex) => Math.round(ARMOUR_DUR_BASE[shape] * ARMOUR_DUR_MULT[tierIndex]);

const ARMOUR_TIER_DEFS = [
  { prefix: 'patch', name: 'Patch Plating', o2Save: 0.20, fallReduce: 0.15,
    defense: { helmet: 1, chest: 3, legs: 2, boots: 1 } },
  { prefix: 'alloy', name: 'Alloy Suit', o2Save: 0.45, fallReduce: 0.25,
    defense: { helmet: 2, chest: 5, legs: 4, boots: 1 } },
  { prefix: 'void', name: 'Void-Crystal Suit', o2Save: 0.65, fallReduce: 0.4,
    defense: { helmet: 3, chest: 7, legs: 5, boots: 3 } },
];
// [shape key, display label, ARMOUR_SLOTS entry]. Recipe ids in recipes.js are
// built as `${prefix}_${shape}`, which is also each item's key - keep them in
// step, or `id()` throws at load with "recipe references unknown item".
const ARMOUR_PIECES = [
  ['helmet', 'Helmet', 'head'],
  ['chest', 'Chestplate', 'chest'],
  ['legs', 'Leggings', 'legs'],
  ['boots', 'Boots', 'feet'],
];

for (let t = 0; t < ARMOUR_TIER_DEFS.length; t++) {
  const def_ = ARMOUR_TIER_DEFS[t];
  for (const [shape, label, slot] of ARMOUR_PIECES) {
    // Only the helmet saves oxygen and only the boots cushion a fall - every
    // other piece keeps armourPiece's zero defaults.
    const extra = shape === 'helmet' ? { o2Save: def_.o2Save }
      : shape === 'boots' ? { fallReduce: def_.fallReduce } : {};
    armourPiece(`${def_.prefix}_${shape}`, `${def_.name} ${label}`, slot, t + 1,
      def_.defense[shape], armourDur(shape, t), extra);
  }
}

export const ITEM_COUNT = ITEMS.length;

// --------------------------------------------------------------------- tags
function tag(name, keys) {
  const set = new Set();
  for (const k of keys) {
    const it = ITEM_BY_KEY.get(k);
    if (!it) throw new Error(`tag ${name} references unknown item ${k}`);
    set.add(it.id);
    const list = ITEM_TAGS.get(it.id) ?? [];
    list.push(name);
    ITEM_TAGS.set(it.id, list);
  }
  TAG_MEMBERS.set(name, set);
}

// Every world's common building stone. This is the tag that lets one furnace
// recipe work whether you are standing on Earth basalt or Ionian sulfur crust.
tag('#rock', ['cobble', 'stone', 'sandstone', 'basalt', 'mars_rock', 'moon_rock',
  'venus_crust', 'sulfur_crust', 'titan_rock', 'storm_stone', 'brick', 'pack_ice']);
tag('#soil', ['dirt', 'sand', 'gravel', 'mars_sand', 'mars_clay', 'moon_dust',
  'titan_sand', 'sulfur', 'cloud', 'snow']);
tag('#wood', ['log', 'alien_log']);
tag('#planks', ['planks']);
tag('#rod', ['stick']);
tag('#ice', ['ice', 'pack_ice', 'europa_ice', 'ammonia_ice', 'snow', 'helium_ice']);
tag('#metal', ['iron_ingot']);
tag('#organic', ['algae', 'spore_pod', 'moss', 'leaves', 'alien_leaves']);
tag('#crystal', ['crystal_shard']);

/** Does this item satisfy a recipe entry ('#rock' or 'iron_ingot')? */
export function matchesIngredient(itemId, spec) {
  if (!itemId || !spec) return false;
  if (spec.startsWith('#')) return TAG_MEMBERS.get(spec)?.has(itemId) ?? false;
  return ITEMS[itemId]?.key === spec;
}

/** All item ids that satisfy an ingredient spec (used by the recipe book UI). */
export function ingredientItems(spec) {
  if (spec.startsWith('#')) return [...(TAG_MEMBERS.get(spec) ?? [])];
  const it = ITEM_BY_KEY.get(spec);
  return it ? [it.id] : [];
}

// ------------------------------------------------------------------ helpers
export const itemOf = (key) => ITEM_BY_KEY.get(key);
export const itemIdOf = (key) => ITEM_BY_KEY.get(key)?.id ?? 0;
export const isBlockItem = (itemId) => ITEMS[itemId]?.kind === 'block';
export const blockOfItem = (itemId) => ITEMS[itemId]?.blockId ?? AIR;
export const itemOfBlock = (blockId) => blockId;   // ids are shared by construction
export const maxStack = (itemId) => ITEMS[itemId]?.stack ?? 64;
export const isTool = (itemId) => ITEMS[itemId]?.kind === 'tool';
export const isArmour = (itemId) => ITEMS[itemId]?.kind === 'armour';
export const armourOf = (itemId) => ITEMS[itemId]?.armour ?? null;

/** Fuel value in seconds for a stack of this item, 0 if it does not burn. */
export const fuelValue = (itemId) => ITEMS[itemId]?.fuel ?? 0;

/**
 * Can this tool actually harvest the block, i.e. will breaking it drop anything?
 * Blocks with tier 0 always drop; higher tiers need a matching tool of that tier.
 */
export function canHarvest(blockId, toolItemId) {
  const b = BLOCKS[blockId];
  if (!b || b.drop === null) return false;
  if (b.tier === TIER.HAND) return true;
  const t = ITEMS[toolItemId]?.tool;
  if (!t) return false;
  return t.type === b.tool && t.tier >= b.tier;
}

/** Seconds of held-click needed to break `blockId` with `toolItemId` in hand. */
export function miningTime(blockId, toolItemId) {
  const b = BLOCKS[blockId];
  if (!b || b.hardness >= 999) return Infinity;
  const t = ITEMS[toolItemId]?.tool;
  const right = t && t.type === b.tool;
  const speed = right ? t.speed : 1;
  let time = (b.hardness * 1.5) / speed;
  if (!canHarvest(blockId, toolItemId)) time *= 3.2;   // you can still clear it, slowly
  return Math.max(0.06, time);
}

/**
 * What a block yields. Returns {item, count} or null.
 * `roll` is a 0..1 number so callers can stay deterministic in tests.
 */
export function dropFor(blockId, toolItemId, roll = Math.random()) {
  if (!canHarvest(blockId, toolItemId)) return null;
  const spec = BLOCKS[blockId].drop;
  if (!spec) return null;
  if (typeof spec === 'string') {
    const it = ITEM_BY_KEY.get(spec);
    return it ? { item: it.id, count: 1 } : null;
  }
  const it = ITEM_BY_KEY.get(spec.item);
  if (!it) return null;
  const min = spec.min ?? 1, max = spec.max ?? min;
  const count = min + Math.floor(roll * (max - min + 1));
  return count > 0 ? { item: it.id, count } : null;
}

/** The kit you land with in survival mode. */
export const LANDING_KIT = [
  { key: 'hand_drill', count: 1 },
  { key: 'fabricator', count: 1 },
  { key: 'ration', count: 3 },
  { key: 'oxygen_canister', count: 2 },
  { key: 'lamp', count: 4 },
];
