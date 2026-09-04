// Unit tests for the crafting/smelting engine. Plain node, no framework:
//   node tests/recipes.test.mjs
//
// The interesting cases are all about placement (a pattern may float anywhere in
// the grid) and about tags (the same recipe has to work with martian rock).

import assert from 'node:assert/strict';
import { ITEMS, itemIdOf, ingredientItems } from '../app/js/items.js';
import {
  RECIPES, RECIPE_BY_ID, SMELTING, matchRecipe, craftingResult, consumeGrid,
  smeltingResult, fuelSeconds, recipesForSize, canCraft, layoutFor, ingredientsOf,
} from '../app/js/recipes.js';

let checks = 0;
function test(name, fn) {
  try {
    fn();
    checks++;
  } catch (err) {
    console.error(`FAIL: ${name}\n  ${err.message}`);
    process.exit(1);
  }
}

/** Build a flat grid from an array of item keys ('' / null = empty slot). */
function grid(size, keys, counts = 1) {
  const cells = new Array(size * size).fill(null);
  keys.forEach((key, i) => {
    if (!key) return;
    cells[i] = { item: itemIdOf(key), count: Array.isArray(counts) ? counts[i] : counts };
  });
  return cells;
}

/** Stamp a pattern into a grid at (ox, oy); `key` maps pattern chars to item keys. */
function stamp(size, pattern, key, ox = 0, oy = 0, count = 1) {
  const cells = new Array(size * size).fill(null);
  pattern.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch === ' ') return;
      cells[(y + oy) * size + (x + ox)] = { item: itemIdOf(key[ch]), count };
    });
  });
  return cells;
}

const PICK = ['MMM', ' R ', ' R '];
const AXE = ['MM', 'MR', ' R'];      // already trimmed
const SHOVEL = ['M', 'R', 'R'];      // already trimmed

// ---------------------------------------------------------------- placement

test('shaped recipe matches at three different offsets in a 3x3', () => {
  const key = { M: 'cobble', R: 'stick' };
  for (const ox of [0, 1, 2]) {
    const g = stamp(3, SHOVEL, key, ox, 0);
    const r = matchRecipe(g, 3);
    assert.ok(r, `no match at ox=${ox}`);
    assert.equal(r.id, 'stone_shovel', `wrong recipe at ox=${ox}`);
  }
});

test('a 3x3 pickaxe pattern floats to every offset of a 4x4 grid', () => {
  const key = { M: 'iron_ingot', R: 'stick' };
  let hits = 0;
  for (const oy of [0, 1]) {
    for (const ox of [0, 1]) {
      const r = matchRecipe(stamp(4, PICK, key, ox, oy), 4);
      assert.ok(r, `no match at ${ox},${oy}`);
      assert.equal(r.id, 'iron_pickaxe');
      hits++;
    }
  }
  assert.equal(hits, 4);
});

test('the pickaxe fills its only 3x3 placement', () => {
  const r = matchRecipe(stamp(3, PICK, { M: 'cobble', R: 'stick' }), 3);
  assert.equal(r.id, 'stone_pickaxe');
  assert.deepEqual(craftingResult(stamp(3, PICK, { M: 'cobble', R: 'stick' }), 3),
    { item: itemIdOf('stone_pickaxe'), count: 1 });
});

test('a mirrored pattern still crafts (left-handed axe)', () => {
  const key = { M: 'planks', R: 'stick' };
  const normal = matchRecipe(stamp(3, AXE, key, 0, 0), 3);
  const mirrored = matchRecipe(grid(3, [
    null, 'planks', 'planks',
    null, 'stick', 'planks',
    null, 'stick', null,
  ]), 3);
  assert.equal(normal.id, 'wood_axe');
  assert.ok(mirrored, 'mirrored axe did not match');
  assert.equal(mirrored.id, 'wood_axe');
});

test('a 2x2 recipe matches inside a 3x3, but not with a stray item present', () => {
  const ok = grid(3, [
    null, null, null,
    null, 'planks', 'planks',
    null, 'planks', 'planks',
  ]);
  assert.equal(matchRecipe(ok, 3).id, 'fabricator');

  const strayed = grid(3, [
    'stick', null, null,
    null, 'planks', 'planks',
    null, 'planks', 'planks',
  ]);
  assert.equal(matchRecipe(strayed, 3), null, 'stray item should block the match');
  assert.equal(craftingResult(strayed, 3), null);
});

test('a 2x2 recipe also matches in a bare 2x2 grid', () => {
  assert.equal(matchRecipe(grid(2, ['iron_ingot', 'iron_ingot', 'iron_ingot', 'iron_ingot']), 2).id, 'hull');
});

test('an empty grid produces nothing', () => {
  assert.equal(matchRecipe(grid(3, []), 3), null);
  assert.equal(craftingResult(grid(2, []), 2), null);
});

// ---------------------------------------------------------------- shapeless

test('shapeless matching ignores order and position', () => {
  const orders = [
    ['nutrient_paste', 'volatiles', 'iron_ingot'],
    ['iron_ingot', 'nutrient_paste', 'volatiles'],
    ['volatiles', 'iron_ingot', 'nutrient_paste'],
  ];
  for (const order of orders) {
    assert.equal(matchRecipe(grid(2, order), 2).id, 'medkit', `order ${order}`);
  }
  // scattered across a 3x3 with gaps
  const scattered = grid(3, [
    'volatiles', null, 'nutrient_paste',
    null, null, null,
    null, 'iron_ingot', null,
  ]);
  assert.equal(matchRecipe(scattered, 3).id, 'medkit');
});

test('shapeless does not match with an extra item in the grid', () => {
  const g = grid(3, ['algae', 'volatiles', 'iron_ingot', 'coal']);
  assert.equal(matchRecipe(g, 3), null);
});

test('similar shapeless recipes stay distinguishable', () => {
  assert.equal(matchRecipe(grid(2, ['iron_ingot', 'volatiles', 'volatiles']), 2).id, 'oxygen_canister');
  assert.equal(matchRecipe(grid(2, ['nutrient_paste', 'nutrient_paste', 'volatiles']), 2).id, 'ration');
  assert.equal(matchRecipe(grid(2, ['iron_ingot', 'iron_ingot', 'cobble', 'cobble']), 2).id, 'fabricator_from_metal');
});

// --------------------------------------------------------------------- tags

test('tag ingredients let every planet build the same pickaxe', () => {
  for (const rock of ['cobble', 'mars_rock', 'moon_rock', 'titan_rock', 'storm_stone', 'sulfur_crust']) {
    const r = matchRecipe(stamp(3, PICK, { M: rock, R: 'stick' }), 3);
    assert.ok(r, `${rock} pickaxe did not match`);
    assert.equal(r.id, 'stone_pickaxe', `${rock} produced ${r.id}`);
  }
});

test('rods can come from metal on a treeless world', () => {
  assert.equal(matchRecipe(grid(2, ['iron_ingot']), 2).id, 'stick_from_metal');
  assert.equal(matchRecipe(grid(2, ['log']), 2).id, 'planks');
  assert.equal(matchRecipe(grid(2, ['alien_log']), 2).id, 'planks');
});

// ---------------------------------------------------------------- consuming

test('consumeGrid decrements exactly the slots the match used', () => {
  const g = stamp(3, SHOVEL, { M: 'cobble', R: 'stick' }, 2, 0);
  g[2].count = 3;                       // the cobble head
  const recipe = matchRecipe(g, 3);
  consumeGrid(g, 3, recipe);

  assert.equal(g[2].count, 2, 'head stack should lose exactly one');
  assert.equal(g[5], null, 'spent rod slot should empty to null');
  assert.equal(g[8], null, 'spent rod slot should empty to null');
  for (const i of [0, 1, 3, 4, 6, 7]) assert.equal(g[i], null, `slot ${i} must stay untouched`);
});

test('consumeGrid leaves the rest of a shapeless stack behind', () => {
  const g = grid(2, ['nutrient_paste', 'volatiles', 'iron_ingot'], 3);
  consumeGrid(g, 2, matchRecipe(g, 2));
  assert.deepEqual(g.map((s) => (s ? s.count : null)), [2, 2, 2, null]);
});

test('consumeGrid is a no-op without a recipe', () => {
  const g = grid(2, ['algae']);
  consumeGrid(g, 2, null);
  assert.equal(g[0].count, 1);
});

// ---------------------------------------------------------------- smelting

test('smelting resolves ores, sand and every ice', () => {
  assert.deepEqual(smeltingResult(itemIdOf('raw_iron')), { item: itemIdOf('iron_ingot'), count: 1, time: 10 });
  assert.deepEqual(smeltingResult(itemIdOf('raw_gold')), { item: itemIdOf('gold_ingot'), count: 1, time: 10 });
  assert.deepEqual(smeltingResult(itemIdOf('europa_ice')), { item: itemIdOf('volatiles'), count: 1, time: 5 });

  for (const ice of ingredientItems('#ice')) {
    const out = smeltingResult(ice);
    assert.ok(out, `${ITEMS[ice].key} does not smelt`);
    assert.equal(out.item, itemIdOf('volatiles'), `${ITEMS[ice].key} smelts to the wrong thing`);
  }
  // pack_ice is in both #rock and #ice; ice wins.
  assert.equal(smeltingResult(itemIdOf('pack_ice')).item, itemIdOf('volatiles'));
});

test('smelting turns regolith into glass and rock into brick', () => {
  // Volcanic glass counts as a silicate feedstock: it is what gives Venus, Io,
  // Europa and Jupiter a route to glass at all (see tests/progression.test.mjs).
  for (const key of ['sand', 'mars_sand', 'moon_dust', 'titan_sand', 'gravel',
    'obsidian', 'basalt', 'storm_stone']) {
    assert.deepEqual(smeltingResult(itemIdOf(key)), { item: itemIdOf('glass'), count: 1, time: 8 }, key);
  }
  for (const key of ['cobble', 'mars_rock', 'moon_rock', 'venus_crust', 'titan_rock', 'sulfur_crust', 'dirt', 'mars_clay']) {
    assert.deepEqual(smeltingResult(itemIdOf(key)), { item: itemIdOf('brick'), count: 1, time: 8 }, key);
  }
  for (const key of ['volatiles', 'algae', 'spore_pod']) {
    assert.deepEqual(smeltingResult(itemIdOf(key)), { item: itemIdOf('nutrient_paste'), count: 1, time: 6 }, key);
  }
});

test('unsmeltable items return null', () => {
  for (const key of ['iron_ingot', 'stick', 'coal', 'hull', 'medkit']) {
    assert.equal(smeltingResult(itemIdOf(key)), null, key);
  }
  assert.equal(smeltingResult(0), null);
});

test('smeltingResult hands back a fresh object each call', () => {
  const a = smeltingResult(itemIdOf('raw_iron'));
  a.count = 99;
  assert.equal(smeltingResult(itemIdOf('raw_iron')).count, 1);
});

// -------------------------------------------------------------------- fuel

test('fuelSeconds reads the registry and returns 0 for non-fuels', () => {
  assert.equal(fuelSeconds(itemIdOf('coal')), 40);
  assert.equal(fuelSeconds(itemIdOf('log')), 12);
  assert.equal(fuelSeconds(itemIdOf('alien_log')), 12);
  assert.equal(fuelSeconds(itemIdOf('planks')), 8);
  assert.equal(fuelSeconds(itemIdOf('stick')), 3);
  assert.equal(fuelSeconds(itemIdOf('sulfur')), 6);
  assert.equal(fuelSeconds(itemIdOf('fabricator')), 10);
  assert.equal(fuelSeconds(itemIdOf('cobble')), 0);
  assert.equal(fuelSeconds(0), 0);
  assert.equal(fuelSeconds(9999), 0);
});

// ------------------------------------------------------------- the book

test('every recipe output is a real item', () => {
  for (const r of RECIPES) {
    assert.ok(ITEMS[r.out.item], `${r.id} outputs unknown item id ${r.out.item}`);
    assert.ok(r.out.count > 0, `${r.id} outputs ${r.out.count}`);
    assert.ok(['basic', 'tools', 'armour', 'stations', 'food', 'building'].includes(r.category), `${r.id} category`);
    assert.ok(r.size === 2 || r.size === 3, `${r.id} size ${r.size}`);
  }
});

// The spec that drove this loop claimed boots trim to a 2x2 shape ("M M"/"M M"
// read as a 2-wide footprint). trim() actually takes its bounding box from the
// left/right-most non-space *character*, so a row with a middle gap still
// spans all three columns - boots need the fabricator exactly like the other
// three pieces. Asserting that here, against the real code, rather than the
// size the design doc predicted.
test('all twelve armour recipes resolve to the right item and all four pieces need a 3x3 grid', () => {
  for (const tier of ['patch', 'alloy', 'void']) {
    for (const shape of ['helmet', 'chest', 'legs', 'boots']) {
      const key = `${tier}_${shape}`;
      const recipe = RECIPE_BY_ID.get(key);
      assert.ok(recipe, `${key} has no recipe`);
      assert.equal(recipe.out.item, itemIdOf(key), `${key} recipe outputs the wrong item`);
      assert.equal(recipe.size, 3, `${key} should need the 3x3 fabricator`);
      assert.equal(layoutFor(recipe, 2), null, `${key} must not fit a bare 2x2 grid`);
      assert.ok(layoutFor(recipe, 3), `${key} should fit the 3x3 fabricator`);
    }
  }
});

test('all twelve tools are reachable', () => {
  const outputs = new Set(RECIPES.map((r) => r.out.item));
  for (const prefix of ['wood', 'stone', 'iron', 'crystal']) {
    for (const shape of ['pickaxe', 'axe', 'shovel']) {
      const key = `${prefix}_${shape}`;
      assert.ok(itemIdOf(key), `${key} is not an item`);
      assert.ok(outputs.has(itemIdOf(key)), `${key} has no recipe`);
    }
  }
});

test('layoutFor round-trips: every recipe crafts from its own layout', () => {
  for (const r of RECIPES) {
    const cells = layoutFor(r, 3);
    assert.ok(cells, `${r.id} has no 3x3 layout`);
    assert.equal(cells.length, 9);
    const g = cells.map((spec) => (spec ? { item: ingredientItems(spec)[0], count: 1 } : null));
    const hit = matchRecipe(g, 3);
    assert.ok(hit, `${r.id} layout matched nothing`);
    assert.equal(hit.id, r.id, `${r.id} layout matched ${hit.id} instead`);
  }
});

test('layoutFor refuses a grid the recipe cannot fit in', () => {
  assert.equal(layoutFor(RECIPE_BY_ID.get('stone_pickaxe'), 2), null);
  assert.equal(layoutFor(RECIPE_BY_ID.get('furnace'), 2), null);
  const small = layoutFor(RECIPE_BY_ID.get('fabricator'), 2);
  assert.deepEqual(small, ['#planks', '#planks', '#planks', '#planks']);
});

test('recipesForSize gates the 3x3-only recipes', () => {
  const two = recipesForSize(2);
  const three = recipesForSize(3);
  assert.equal(three.length, RECIPES.length);
  assert.ok(two.length < three.length);
  assert.ok(two.every((r) => r.size === 2));
  const ids = new Set(two.map((r) => r.id));
  assert.ok(ids.has('planks') && ids.has('stick') && ids.has('fabricator'));
  assert.ok(!ids.has('stone_pickaxe') && !ids.has('furnace') && !ids.has('life_support'));
});

// ---------------------------------------------------------------- canCraft

test('canCraft counts stock, not slots', () => {
  const pick = RECIPE_BY_ID.get('stone_pickaxe');
  assert.equal(canCraft(pick, new Map([[itemIdOf('cobble'), 3], [itemIdOf('stick'), 2]])), true);
  assert.equal(canCraft(pick, new Map([[itemIdOf('cobble'), 2], [itemIdOf('stick'), 2]])), false);
  assert.equal(canCraft(pick, new Map([[itemIdOf('cobble'), 3]])), false);
  // mixed rock from two worlds still satisfies three '#rock' slots
  assert.equal(canCraft(pick, new Map([
    [itemIdOf('cobble'), 1], [itemIdOf('mars_rock'), 1], [itemIdOf('basalt'), 1], [itemIdOf('stick'), 2],
  ])), true);
});

test('canCraft does not let one item fill two competing specs', () => {
  const fab = RECIPE_BY_ID.get('fabricator_from_metal');   // 2x #metal + 2x #rock
  assert.equal(canCraft(fab, new Map([[itemIdOf('iron_ingot'), 4]])), false);
  assert.equal(canCraft(fab, new Map([[itemIdOf('iron_ingot'), 2], [itemIdOf('cobble'), 2]])), true);
  const medkit = RECIPE_BY_ID.get('medkit');
  assert.equal(canCraft(medkit, new Map([[itemIdOf('volatiles'), 3]])), false);
});

test('canCraft accepts a plain object as well as a Map', () => {
  const lamp = RECIPE_BY_ID.get('lamp');
  assert.equal(canCraft(lamp, { [itemIdOf('coal')]: 1, [itemIdOf('stick')]: 1 }), true);
  assert.equal(canCraft(lamp, { [itemIdOf('coal')]: 1 }), false);
  assert.equal(canCraft(lamp, {}), false);
});

test('ingredientsOf lists one spec per consumed slot', () => {
  assert.equal(ingredientsOf(RECIPE_BY_ID.get('stone_pickaxe')).length, 5);
  assert.equal(ingredientsOf(RECIPE_BY_ID.get('furnace')).length, 8);
  assert.deepEqual(ingredientsOf(RECIPE_BY_ID.get('lamp')), ['coal', '#rod']);
});

// ------------------------------------------------------- ambiguity guard

// The test keeps its own trim/mirror rather than importing the engine's, so a
// bug in the engine cannot hide by agreeing with the test about what a pattern
// means.
function boundingBox(pattern) {
  const rows = pattern.filter((r) => r.trim() !== '');
  let left = Infinity;
  let right = -1;
  for (const r of rows) {
    for (let c = 0; c < r.length; c++) {
      if (r[c] === ' ') continue;
      left = Math.min(left, c);
      right = Math.max(right, c);
    }
  }
  return rows.map((r) => r.padEnd(right + 1, ' ').slice(left, right + 1));
}
const flip = (rows) => rows.map((r) => [...r].reverse().join(''));

/** Nth combination of tag members for `specs`, mixed-radix over each tag. */
function combo(specs, n) {
  const out = [];
  let k = n;
  for (const spec of specs) {
    const members = ingredientItems(spec);
    out.push(members[k % members.length]);
    k = Math.floor(k / members.length);
  }
  return out;
}
const comboCount = (specs) => specs.reduce((a, sp) => a * ingredientItems(sp).length, 1);

// This is the guard that stops a newly added recipe from silently stealing an
// existing one's grid. matchRecipe returns the FIRST recipe that fits, so every
// recipe has to win in every position it can legally occupy, with every rock,
// wood or ice its tags admit - not merely in the tidy top-left layout.
test('every recipe wins its own grid at every offset and handedness', () => {
  let grids = 0;
  const covered = new Set();
  for (const r of RECIPES) {
    for (const size of [2, 3]) {
      if (r.size > size) continue;
      if (r.kind === 'shaped') {
        const base = boundingBox(r.pattern);
        const chars = [...new Set(r.pattern.join('').split('').filter((c) => c !== ' '))];
        const specs = chars.map((ch) => r.key[ch]);
        const cap = Math.min(comboCount(specs), 120);
        for (const rows of [base, boundingBox(flip(base))]) {
          const h = rows.length;
          const w = rows[0].length;
          for (let n = 0; n < cap; n++) {
            const pick = {};
            combo(specs, n).forEach((it, i) => { pick[chars[i]] = it; });
            for (let oy = 0; oy + h <= size; oy++) {
              for (let ox = 0; ox + w <= size; ox++) {
                const g = new Array(size * size).fill(null);
                for (let y = 0; y < h; y++) {
                  for (let x = 0; x < w; x++) {
                    const ch = rows[y][x];
                    if (ch !== ' ') g[(y + oy) * size + (x + ox)] = { item: pick[ch], count: 1 };
                  }
                }
                grids++;
                covered.add(r.id);
                const hit = matchRecipe(g, size);
                const where = `${r.id} size=${size} at ${ox},${oy}`;
                assert.ok(hit, `${where}: matched nothing`);
                assert.equal(hit.id, r.id, `${where}: shadowed by ${hit.id}`);
              }
            }
          }
        }
      } else {
        const cap = Math.min(comboCount(r.ingredients), 120);
        for (let n = 0; n < cap; n++) {
          const items = combo(r.ingredients, n);
          // packed from the front, and pushed to the back, so position cannot matter
          for (const back of [false, true]) {
            const g = new Array(size * size).fill(null);
            const slots = [...g.keys()];
            if (back) slots.reverse();
            items.forEach((it, i) => { g[slots[i]] = { item: it, count: 1 }; });
            grids++;
            covered.add(r.id);
            const hit = matchRecipe(g, size);
            assert.ok(hit, `${r.id} size=${size} back=${back}: matched nothing`);
            assert.equal(hit.id, r.id, `${r.id} size=${size}: shadowed by ${hit.id}`);
          }
        }
      }
    }
  }
  // Guards the guard: a loop that quietly stopped iterating would otherwise pass.
  assert.equal(covered.size, RECIPES.length, 'some recipe was never exercised');
  assert.ok(grids > 500, `only ${grids} grids exercised`);
});

test('a 2x2 recipe reaches every corner of a 3x3', () => {
  for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const g = new Array(9).fill(null);
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 2; x++) g[(y + oy) * 3 + (x + ox)] = { item: itemIdOf('planks'), count: 1 };
    }
    assert.equal(matchRecipe(g, 3)?.id, 'fabricator', `fabricator at ${ox},${oy}`);
  }
  // a 1x2 recipe has six homes in a 3x3
  let found = 0;
  for (let oy = 0; oy < 2; oy++) {
    for (let ox = 0; ox < 3; ox++) {
      const g = new Array(9).fill(null);
      g[oy * 3 + ox] = { item: itemIdOf('planks'), count: 1 };
      g[(oy + 1) * 3 + ox] = { item: itemIdOf('planks'), count: 1 };
      assert.equal(matchRecipe(g, 3)?.id, 'stick', `stick at ${ox},${oy}`);
      found++;
    }
  }
  assert.equal(found, 6);
});

// ------------------------------------------------------------- accounting

test('consuming takes exactly one per used slot and leaves no ghost stacks', () => {
  for (const r of RECIPES) {
    const cells = layoutFor(r, 3);
    assert.ok(cells, `${r.id} has no 3x3 layout`);
    const g = cells.map((sp) => (sp ? { item: ingredientItems(sp)[0], count: 2 } : null));
    const before = g.reduce((a, s) => a + (s ? s.count : 0), 0);
    consumeGrid(g, 3, r);
    const after = g.reduce((a, s) => a + (s ? s.count : 0), 0);
    assert.equal(before - after, ingredientsOf(r).length, `${r.id} consumed the wrong amount`);
    // and again, so every used slot hits zero and must become null
    consumeGrid(g, 3, r);
    for (let i = 0; i < 9; i++) {
      assert.equal(g[i], null, `${r.id} slot ${i} survived as ${JSON.stringify(g[i])}`);
    }
  }
});

test('matching never mutates the grid it is handed', () => {
  const g = stamp(3, PICK, { M: 'cobble', R: 'stick' }, 0, 0, 4);
  const snapshot = JSON.stringify(g);
  matchRecipe(g, 3);
  craftingResult(g, 3);
  canCraft(RECIPE_BY_ID.get('stone_pickaxe'), new Map([[itemIdOf('cobble'), 3]]));
  assert.equal(JSON.stringify(g), snapshot, 'the grid changed under a read-only call');
});

test('consumeGrid tolerates being handed the recipe as its second argument', () => {
  // Silently consuming nothing would hand the player the result for free, which
  // no downstream check would ever catch - so the mis-ordered call must work.
  const g = grid(2, ['planks', 'planks', 'planks', 'planks']);
  consumeGrid(g, RECIPE_BY_ID.get('fabricator'));
  assert.deepEqual(g, [null, null, null, null]);
});

// ------------------------------------------------------------ bad input

test('degenerate input is refused, never thrown', () => {
  const fab = RECIPE_BY_ID.get('fabricator');
  assert.equal(layoutFor(fab), null, 'no size given');
  assert.equal(layoutFor(undefined, 3), null, 'no recipe given');
  assert.equal(canCraft(undefined, new Map()), false);
  assert.deepEqual(ingredientsOf(undefined), []);
  assert.equal(matchRecipe(new Array(9).fill(undefined), 3), null);
  assert.equal(matchRecipe(grid(2, ['log'], 0), 2), null, 'a count:0 stack is not an ingredient');
  assert.equal(consumeGrid(grid(2, ['algae']), 2, fab)[0].count, 1, 'a recipe that does not fit consumes nothing');
  assert.deepEqual(recipesForSize(0), []);
});

test('a lopsided grid does not hide a stray item off the end', () => {
  // length 5 must be read as 3x3-with-holes, not truncated to 2x2: rounding the
  // side length down would drop slot 4 and craft a fabricator for free.
  const g = grid(3, ['planks', 'planks', 'planks', 'planks']).slice(0, 5);
  g[4] = { item: itemIdOf('coal'), count: 1 };
  assert.equal(matchRecipe(g), null, 'the trailing coal must block the match');
});

test('nothing smelts into itself', () => {
  for (const [inId, out] of SMELTING) {
    assert.notEqual(out.item, inId, `${ITEMS[inId].key} smelts to itself`);
    assert.ok(ITEMS[out.item], `${ITEMS[inId].key} smelts to a non-item`);
    assert.ok(out.time > 0 && out.count > 0, `${ITEMS[inId].key} has a bad time/count`);
  }
});

console.log(`ok - recipes: ${checks} checks, ${RECIPES.length} recipes, ${recipesForSize(2).length} craftable 2x2, ${new Set([...RECIPES.map((r) => r.out.item)]).size} distinct outputs`);
