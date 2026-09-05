// Crafting and smelting rules.
//
// Recipes are plain data so the fabricator screen, the recipe book and the tests
// all read one list instead of three. Ingredients are specs - an item key
// ('iron_ingot') or a tag ('#rock') - resolved through items.js. Tags are the
// whole reason a single pickaxe recipe works on eight planets that share no
// common stone: Mars has no cobble, but martian rock answers to '#rock'.
//
// Nothing here touches the world or the DOM, so it stays unit-testable under
// plain node.

import { ITEMS, ITEM_BY_KEY, matchesIngredient, ingredientItems } from './items.js';

/** Item id for a key, throwing at load time so a typo can never ship silently. */
function id(key) {
  const it = ITEM_BY_KEY.get(key);
  if (!it) throw new Error(`recipe references unknown item '${key}'`);
  return it.id;
}

/** Every spec must resolve to at least one item, or the recipe is unreachable. */
function checkSpec(spec, where) {
  if (ingredientItems(spec).length === 0) {
    throw new Error(`recipe ${where}: ingredient '${spec}' matches no item`);
  }
}

// ------------------------------------------------------------------ patterns

/** Strip the empty border off a pattern, leaving its bounding box. */
function trim(pattern) {
  let top = 0;
  let bottom = pattern.length - 1;
  while (top <= bottom && pattern[top].trim() === '') top++;
  while (bottom >= top && pattern[bottom].trim() === '') bottom--;
  if (top > bottom) return { rows: [], w: 0, h: 0 };

  let left = Infinity;
  let right = -1;
  for (let r = top; r <= bottom; r++) {
    const row = pattern[r];
    for (let c = 0; c < row.length; c++) {
      if (row[c] === ' ') continue;
      if (c < left) left = c;
      if (c > right) right = c;
    }
  }
  const rows = [];
  // padEnd lets a recipe write 'MM' instead of 'MM ' for a short trailing row.
  for (let r = top; r <= bottom; r++) rows.push(pattern[r].padEnd(right + 1, ' ').slice(left, right + 1));
  return { rows, w: right - left + 1, h: rows.length };
}

const mirror = (pattern) => pattern.map((row) => [...row].reverse().join(''));

// A shaped recipe matches in both handednesses (Minecraft does this too - a
// left-handed pickaxe is still a pickaxe). Symmetric patterns collapse to one
// form so we do not scan the grid twice for nothing.
const formCache = new Map();
function formsOf(recipe) {
  let forms = formCache.get(recipe);
  if (!forms) {
    const a = trim(recipe.pattern);
    const b = trim(mirror(recipe.pattern));
    forms = a.rows.join('|') === b.rows.join('|') ? [a] : [a, b];
    formCache.set(recipe, forms);
  }
  return forms;
}

// ------------------------------------------------------------- recipe tables

/** @type {Array<any>} */
export const RECIPES = [];
export const RECIPE_BY_ID = new Map();

function add(recipe) {
  if (RECIPE_BY_ID.has(recipe.id)) throw new Error(`duplicate recipe id '${recipe.id}'`);
  RECIPES.push(recipe);
  RECIPE_BY_ID.set(recipe.id, recipe);
  return recipe;
}

/**
 * `size` is derived from the trimmed pattern rather than declared, so a recipe
 * can never claim to fit in a grid it does not fit in.
 */
function shaped(rid, pattern, key, outKey, count, category) {
  const form = trim(pattern);
  for (const row of pattern) {
    for (const ch of row) {
      if (ch === ' ') continue;
      if (!key[ch]) throw new Error(`recipe ${rid}: pattern char '${ch}' has no key entry`);
      checkSpec(key[ch], rid);
    }
  }
  return add({
    id: rid,
    kind: 'shaped',
    size: Math.max(2, form.w, form.h),
    out: { item: id(outKey), count },
    pattern,
    key,
    category,
  });
}

function shapeless(rid, ingredients, outKey, count, category) {
  if (ingredients.length < 1 || ingredients.length > 9) {
    throw new Error(`recipe ${rid}: ${ingredients.length} ingredients does not fit any grid`);
  }
  for (const spec of ingredients) checkSpec(spec, rid);
  return add({
    id: rid,
    kind: 'shapeless',
    size: ingredients.length > 4 ? 3 : 2,
    out: { item: id(outKey), count },
    ingredients,
    category,
  });
}

// -- basic -------------------------------------------------------------------
shapeless('planks', ['#wood'], 'planks', 4, 'basic');
shaped('stick', ['P', 'P'], { P: '#planks' }, 'stick', 4, 'basic');
// Airless worlds grow no trees, so rods can also be drawn from metal - without
// this every tool tier would be gated behind Earth.
shapeless('stick_from_metal', ['#metal'], 'stick', 4, 'basic');
// ...and knapped from plain rock, which is the one material every planet has and
// bare hands can always break. This is the recipe that guarantees a player who
// snapped their drill with an empty inventory can still climb back to tools.
shapeless('stick_from_rock', ['#rock', '#rock'], 'stick', 2, 'basic');

// -- stations ----------------------------------------------------------------
shaped('fabricator', ['PP', 'PP'], { P: '#planks' }, 'fabricator', 1, 'stations');
shapeless('fabricator_from_metal', ['#metal', '#metal', '#rock', '#rock'], 'fabricator', 1, 'stations');
// Losing your only fabricator used to be unrecoverable on the six worlds with no
// wood: every other route to one ran back through a furnace, which needs a
// fabricator to... no it does not, but the metal route needs smelted iron and
// the iron needs the furnace you cannot build without a bench. Rock and a rod
// are hand-reachable on every planet, so this is the escape hatch.
shapeless('fabricator_from_rock', ['#rock', '#rock', '#rod'], 'fabricator', 1, 'stations');
shaped('furnace', ['RRR', 'R R', 'RRR'], { R: '#rock' }, 'furnace', 1, 'stations');
shaped('life_support', ['MGM', 'CMC', 'MMM'],
  { M: '#metal', G: 'glass', C: 'oxygen_canister' }, 'life_support', 1, 'stations');

// -- building ----------------------------------------------------------------
shapeless('lamp', ['coal', '#rod'], 'lamp', 4, 'building');
shaped('hull', ['MM', 'MM'], { M: '#metal' }, 'hull', 4, 'building');
shaped('brick', ['RR', 'RR'], { R: '#rock' }, 'brick', 4, 'building');
shaped('solar', ['SSS', 'MMM', '   '], { S: '#crystal', M: '#metal' }, 'solar', 2, 'building');

// -- tools -------------------------------------------------------------------
// Four tiers x three heads, all sharing '#rod' for the handle. The material
// spec is what picks the tier, which is why the same three patterns cover all
// twelve tools.
const TOOL_TIERS = [
  ['#planks', 'wood'],
  ['#rock', 'stone'],
  ['#metal', 'iron'],
  ['#crystal', 'crystal'],
];
const TOOL_SHAPES = [
  ['pickaxe', ['MMM', ' R ', ' R ']],
  ['axe', ['MM ', 'MR ', ' R ']],
  ['shovel', [' M ', ' R ', ' R ']],
];
for (const [material, prefix] of TOOL_TIERS) {
  for (const [shape, pattern] of TOOL_SHAPES) {
    shaped(`${prefix}_${shape}`, pattern, { M: material, R: '#rod' }, `${prefix}_${shape}`, 1, 'tools');
  }
}

// -- armour --------------------------------------------------------------
// A deliberate mirror of the tool loop above: material picks the tier, shape
// picks the piece, and twelve recipes fall out of two arrays instead of twelve
// hand-written blocks. Armour needs no handle, so one key ('M') covers every
// shape - no '#rod' to thread through like the tools above.
//
// All four shapes need the full 3x3 fabricator, boots included: trim() takes
// its bounding box from the left- and right-most non-space *character* in the
// pattern, so the boots' 'M M' rows (a deliberate gap, matching the four-plate
// boot recipe every other tier of this loop implies) still span all three
// columns and never collapse to a 2-wide footprint. A solid 'MM'/'MM' block
// would trim to size 2, but it would also be byte-for-byte the same shape as
// `hull` and `brick` above for the same tags, and the earlier recipe always
// wins a tie - so it would make patch_boots and alloy_boots uncraftable.
const ARMOUR_TIERS = [['#rock', 'patch'], ['#metal', 'alloy'], ['#crystal', 'void']];
const ARMOUR_SHAPES = [
  ['helmet', ['MMM', 'M M']],
  ['chest', ['M M', 'MMM', 'MMM']],
  ['legs', ['MMM', 'M M', 'M M']],
  ['boots', ['M M', 'M M']],
];
for (const [material, prefix] of ARMOUR_TIERS) {
  for (const [shape, pattern] of ARMOUR_SHAPES) {
    shaped(`${prefix}_${shape}`, pattern, { M: material }, `${prefix}_${shape}`, 1, 'armour');
  }
}

// -- survival gear -----------------------------------------------------------
shapeless('oxygen_canister', ['#metal', 'volatiles', 'volatiles'], 'oxygen_canister', 2, 'basic');
// Paste rather than raw algae: nothing grows on the Moon, and a medkit you
// cannot craft on an airless world is a medkit that does not exist.
shapeless('medkit', ['nutrient_paste', 'volatiles', '#metal'], 'medkit', 1, 'basic');
shapeless('ration', ['nutrient_paste', 'nutrient_paste', 'volatiles'], 'ration', 2, 'food');

// ---------------------------------------------------------------- matching

const isEmpty = (s) => !s || !s.item || !(s.count > 0);

// Rounds UP, so a grid whose length is not a perfect square still covers every
// slot: reading past the end yields undefined (empty), whereas rounding down
// would drop the tail and let a stray item there pass unnoticed.
const gridSize = (grid) => Math.max(1, Math.ceil(Math.sqrt(grid?.length ?? 0)));
const sizeOf = (grid, size) => (size > 0 ? Math.floor(size) : gridSize(grid));

/**
 * Perfect matching of ingredient specs onto a pool of item ids (Kuhn's
 * algorithm). Greedy fails here: '#rock' and 'cobble' overlap, so a greedy pass
 * can eat the only cobble with the tag slot and then reject a valid grid.
 */
function pairAll(specs, pool) {
  const owner = new Int16Array(pool.length).fill(-1); // pool index -> spec index
  const augment = (s, seen) => {
    for (let p = 0; p < pool.length; p++) {
      if (seen[p] || !matchesIngredient(pool[p], specs[s])) continue;
      seen[p] = 1;
      if (owner[p] === -1 || augment(owner[p], seen)) {
        owner[p] = s;
        return true;
      }
    }
    return false;
  };
  for (let s = 0; s < specs.length; s++) {
    if (!augment(s, new Uint8Array(pool.length))) return false;
  }
  return true;
}

/** Try one placement of a trimmed pattern; returns the used slot indices. */
function placeAt(recipe, form, grid, size, ox, oy) {
  const used = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inside = x >= ox && x < ox + form.w && y >= oy && y < oy + form.h;
      const ch = inside ? form.rows[y - oy][x - ox] : ' ';
      const slot = y * size + x;
      const stack = grid[slot];
      if (ch === ' ') {
        if (!isEmpty(stack)) return null; // a stray item outside the shape blocks it
      } else {
        if (isEmpty(stack) || !matchesIngredient(stack.item, recipe.key[ch])) return null;
        used.push(slot);
      }
    }
  }
  return used;
}

function shapedSlots(recipe, grid, size) {
  for (const form of formsOf(recipe)) {
    if (form.w > size || form.h > size) continue;
    for (let oy = 0; oy + form.h <= size; oy++) {
      for (let ox = 0; ox + form.w <= size; ox++) {
        const used = placeAt(recipe, form, grid, size, ox, oy);
        if (used) return used;
      }
    }
  }
  return null;
}

function shapelessSlots(recipe, grid, size) {
  const used = [];
  for (let i = 0; i < size * size; i++) if (!isEmpty(grid[i])) used.push(i);
  if (used.length !== recipe.ingredients.length) return null;
  return pairAll(recipe.ingredients, used.map((i) => grid[i].item)) ? used : null;
}

/** The slots a recipe would consume from this grid, or null if it does not fit. */
function slotsFor(recipe, grid, size) {
  if (recipe.size > size) return null;
  return recipe.kind === 'shaped' ? shapedSlots(recipe, grid, size) : shapelessSlots(recipe, grid, size);
}

function findMatch(grid, size) {
  for (const recipe of RECIPES) {
    const used = slotsFor(recipe, grid, size);
    if (used) return { recipe, used };
  }
  return null;
}

// ------------------------------------------------------------------- public

/**
 * First recipe satisfied by `grid` (a flat row-major array of size*size stacks),
 * or null. Recipes needing a bigger grid than `size` are skipped.
 */
export function matchRecipe(grid, size) {
  const hit = findMatch(grid, sizeOf(grid, size));
  return hit ? hit.recipe : null;
}

/** What the grid would produce right now: {item, count} or null. */
export function craftingResult(grid, size) {
  const hit = findMatch(grid, sizeOf(grid, size));
  return hit ? { item: hit.recipe.out.item, count: hit.recipe.out.count } : null;
}

/**
 * Take one item out of every slot the recipe used, emptying spent slots to null.
 * Stacks are decremented in place so a grid aliasing inventory stacks stays
 * consistent. Returns the same grid for convenience.
 */
export function consumeGrid(grid, size, recipe = null) {
  // Tolerate consumeGrid(grid, recipe). Getting this wrong is silent and one-way:
  // the player keeps the result and the ingredients, and nothing downstream
  // notices, so the arg shapes are sniffed rather than trusted.
  if (size !== null && typeof size === 'object') { recipe = size; size = undefined; }
  if (!recipe) return grid;
  const used = slotsFor(recipe, grid, sizeOf(grid, size));
  if (!used) return grid;
  for (const slot of used) {
    const stack = grid[slot];
    if (!stack) continue;
    stack.count -= 1;
    if (stack.count <= 0) grid[slot] = null;
  }
  return grid;
}

/** Recipes craftable in a size x size grid (a 2x2 recipe still works in a 3x3). */
export function recipesForSize(size) {
  return RECIPES.filter((r) => r.size <= size);
}

/** Flat list of ingredient specs a recipe needs, one entry per consumed slot. */
export function ingredientsOf(recipe) {
  if (!recipe) return [];
  if (recipe.kind === 'shapeless') return (recipe.ingredients ?? []).slice();
  const specs = [];
  for (const row of recipe.pattern) {
    for (const ch of row) if (ch !== ' ') specs.push(recipe.key[ch]);
  }
  return specs;
}

/**
 * Could this recipe be crafted from `counts` (Map or object of itemId -> count)?
 * Overlapping tags make this a matching problem, not a subtraction: three
 * '#rock' slots and one 'cobble' slot must not both claim the same cobble.
 */
export function canCraft(recipe, counts) {
  if (!recipe) return false;
  const specs = ingredientsOf(recipe);
  if (!specs.length) return false;
  const entries = counts instanceof Map ? counts.entries() : Object.entries(counts ?? {});
  const pool = [];
  for (const [key, n] of entries) {
    const itemId = Number(key);
    // Never need more copies of one item than there are slots to fill.
    const take = Math.min(Math.floor(n) || 0, specs.length);
    for (let i = 0; i < take; i++) pool.push(itemId);
  }
  if (pool.length < specs.length) return false;
  return pairAll(specs, pool);
}

/**
 * A size*size array of ingredient specs showing how to lay the recipe out,
 * anchored top-left. Returns null if the recipe needs a bigger grid.
 * Shapeless recipes get a compact block - their arrangement is cosmetic.
 */
export function layoutFor(recipe, size) {
  // One guard covers three refusals: no recipe, a missing/garbage size, and a
  // grid too small. Returning null (not a blank array) is load-bearing - the
  // recipe book filters the book by `if (!layoutFor(r, n)) continue`.
  if (!recipe || !(size >= recipe.size)) return null;
  const cells = new Array(Math.floor(size) * Math.floor(size)).fill(null);
  if (recipe.kind === 'shapeless') {
    const w = recipe.ingredients.length > 4 ? 3 : 2;
    recipe.ingredients.forEach((spec, i) => {
      cells[Math.floor(i / w) * size + (i % w)] = spec;
    });
    return cells;
  }
  const form = formsOf(recipe)[0];
  for (let y = 0; y < form.h; y++) {
    for (let x = 0; x < form.w; x++) {
      const ch = form.rows[y][x];
      if (ch !== ' ') cells[y * size + x] = recipe.key[ch];
    }
  }
  return cells;
}

// ------------------------------------------------------------------ smelting

// Ordered: the first rule that claims an item wins. Packed ice is both '#rock'
// and '#ice', and it should boil to volatiles rather than bake into brick.
const SMELT_RULES = [
  { from: ['raw_iron'], to: 'iron_ingot', time: 10 },
  { from: ['raw_gold'], to: 'gold_ingot', time: 10 },
  // Silicates fuse into glass. Obsidian and basalt are literally volcanic glass,
  // which is what keeps Venus, Io and Europa - none of which have sand - from
  // being unable to build a window or a life support unit.
  { from: ['sand', 'mars_sand', 'moon_dust', 'titan_sand', 'gravel', 'obsidian', 'basalt', 'storm_stone'], to: 'glass', time: 8 },
  { from: ['dirt', 'mars_clay'], to: 'brick', time: 8 },
  { from: ['cobble', 'mars_rock', 'moon_rock', 'venus_crust', 'titan_rock', 'sulfur_crust'], to: 'brick', time: 8 },
  { from: ['#ice'], to: 'volatiles', time: 5 },
  { from: ['volatiles', 'algae', 'spore_pod'], to: 'nutrient_paste', time: 6 },
];

/** itemId -> {item, count, time}. Tags are expanded once, at load. */
export const SMELTING = new Map();

for (const rule of SMELT_RULES) {
  const out = Object.freeze({ item: id(rule.to), count: rule.count ?? 1, time: rule.time });
  for (const spec of rule.from) {
    checkSpec(spec, `smelt->${rule.to}`);
    for (const itemId of ingredientItems(spec)) {
      if (!SMELTING.has(itemId)) SMELTING.set(itemId, out);
    }
  }
}

/** What a furnace turns this item into: {item, count, time} in seconds, or null. */
export function smeltingResult(itemId) {
  const out = SMELTING.get(itemId);
  return out ? { item: out.item, count: out.count, time: out.time } : null;
}

/** Seconds of furnace burn one of this item provides; 0 means it does not burn. */
export function fuelSeconds(itemId) {
  const fuel = ITEMS[itemId]?.fuel ?? 0;
  return typeof fuel === 'number' && fuel > 0 ? fuel : 0;
}
