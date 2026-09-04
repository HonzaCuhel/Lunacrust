// Tests for app/js/stations.js - furnace burn/smelt timing and life-support range.
//
// stations.js imports ./recipes.js, which is authored separately. When that file
// is not on disk yet the whole module graph fails to load, so this test falls
// back to a scratch copy of stations.js next to a stub recipes module. Only the
// "these are the real game's recipe numbers" claim is lost that way; every piece
// of furnace mechanics below still runs, and the banner says which mode it used.

import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { itemIdOf, maxStack } from '../app/js/items.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '../app/js');
const appUrl = (name) => pathToFileURL(path.join(APP, name)).href;

const STUB_RECIPES = [
  "import { ITEMS, ITEM_BY_KEY } from './items.js';",
  'const id = (k) => ITEM_BY_KEY.get(k).id;',
  'const SMELT = new Map([',
  "  [id('raw_iron'), { item: id('iron_ingot'), count: 1, time: 9 }],",
  "  [id('raw_gold'), { item: id('gold_ingot'), count: 1, time: 9 }],",
  ']);',
  'export const smeltingResult = (itemId) => SMELT.get(itemId) ?? null;',
  'export const fuelSeconds = (itemId) => ITEMS[itemId]?.fuel ?? 0;',
].join('\n');

let recipes, Stations, REAL = true, note = '';
try {
  recipes = await import(appUrl('recipes.js'));
  ({ Stations } = await import(appUrl('stations.js')));
} catch (err) {
  REAL = false;
  note = err.message;
  const dir = path.join(os.tmpdir(), 'spacemc-stations-harness');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
  writeFileSync(path.join(dir, 'items.js'), `export * from ${JSON.stringify(appUrl('items.js'))};\n`);
  writeFileSync(path.join(dir, 'recipes.js'), STUB_RECIPES);
  writeFileSync(path.join(dir, 'stations.js'), readFileSync(path.join(APP, 'stations.js'), 'utf8'));
  const url = (n) => pathToFileURL(path.join(dir, n)).href;
  recipes = await import(url('recipes.js'));
  ({ Stations } = await import(url('stations.js')));
}

const { smeltingResult, fuelSeconds } = recipes;

// ------------------------------------------------------------------ fixtures

const RAW_IRON = itemIdOf('raw_iron');
const IRON_INGOT = itemIdOf('iron_ingot');
const COAL = itemIdOf('coal');

const IRON_RECIPE = smeltingResult(RAW_IRON);
const SMELT_TIME = IRON_RECIPE ? IRON_RECIPE.time : 0;
const COAL_SECONDS = fuelSeconds(COAL);
const CAP = maxStack(IRON_INGOT);

/** Drives the sim the way game.js does: many small fixed steps. */
function run(st, seconds, dt = 0.05) {
  const out = [];
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) out.push(...st.update(dt));
  return out;
}

function loaded(st, x, y, z, input = 4, fuel = 3) {
  const f = st.furnaceAt(x, y, z, true);
  f.input = { item: RAW_IRON, count: input };
  f.fuel = { item: COAL, count: fuel };
  return f;
}

// -------------------------------------------------------------------- runner

let pass = 0, fail = 0, skip = 0;
const failures = [];

function t(name, fn) {
  try { fn(); pass++; console.log(`  ok    ${name}`); }
  catch (e) { fail++; failures.push([name, e]); console.log(`  FAIL  ${name}\n        ${e.message}`); }
}
function skipped(name, why) { skip++; console.log(`  skip  ${name}  (${why})`); }

console.log(`\nstations.test.mjs  [recipes: ${REAL ? 'real app/js/recipes.js' : 'STUB - ' + note}]\n`);

// ------------------------------------------------------------------- recipes

t('recipe fixtures are usable', () => {
  assert.ok(RAW_IRON && IRON_INGOT && COAL, 'items.js must define raw_iron, iron_ingot, coal');
  assert.ok(IRON_RECIPE, 'recipes.js must smelt raw_iron');
  assert.equal(IRON_RECIPE.item, IRON_INGOT, 'raw_iron smelts to iron_ingot');
  assert.ok(SMELT_TIME > 0.3, `smelt time must be positive, got ${SMELT_TIME}`);
  assert.ok(COAL_SECONDS > SMELT_TIME + 0.3,
    `these tests assume one coal outlasts one smelt (coal ${COAL_SECONDS}s vs ${SMELT_TIME}s)`);
});

if (REAL) {
  t('real recipe book smelts raw iron with coal', () => {
    assert.equal(smeltingResult(RAW_IRON).item, IRON_INGOT);
    assert.ok(fuelSeconds(COAL) > 0);
  });
} else {
  skipped('real recipe book smelts raw iron with coal', 'app/js/recipes.js not written yet');
}

// ------------------------------------------------------------------ smelting

t('raw_iron + coal yields an ingot at the recipe time and no sooner', () => {
  const st = new Stations();
  const f = loaded(st, 0, 64, 0, 3, 2);

  run(st, SMELT_TIME - 0.2);
  assert.equal(f.output, null, 'output must still be empty just before the recipe time');
  assert.equal(f.input.count, 3, 'input is only spent on completion');
  assert.equal(f.fuel.count, 1, 'exactly one fuel item lit the furnace');
  assert.equal(f.lit, true);
  assert.equal(f.burnMax, COAL_SECONDS);

  run(st, 0.3);
  assert.deepEqual(f.output, { item: IRON_INGOT, count: 1 });
  assert.equal(f.input.count, 2);
  assert.ok(f.progress < SMELT_TIME, 'progress rolls over, it does not reset to the top');
});

t('a second and third ingot arrive one recipe time apart', () => {
  const st = new Stations();
  const f = loaded(st, 0, 64, 0, 3, 2);
  run(st, SMELT_TIME * 1 + 0.1);
  assert.equal(f.output.count, 1);
  run(st, SMELT_TIME);
  assert.equal(f.output.count, 2);
  run(st, SMELT_TIME);
  assert.equal(f.output.count, 3);
  assert.equal(f.input, null, 'an emptied input slot collapses to null');
});

t('input runs out mid-burn without producing a phantom ingot', () => {
  const st = new Stations();
  const f = loaded(st, 1, 1, 1, 1, 1);
  run(st, SMELT_TIME * 3);
  assert.equal(f.output.count, 1);
  assert.equal(f.input, null);
  assert.equal(f.lit, true, 'the flame keeps burning out the fuel it already lit');
});

// ---------------------------------------------------------------------- fuel

t('fuel is not consumed while the input slot is empty', () => {
  const st = new Stations();
  const f = st.furnaceAt(1, 2, 3, true);
  f.fuel = { item: COAL, count: 1 };
  const changes = run(st, 5);
  assert.deepEqual(changes, [], 'an idle furnace reports no lit changes');
  assert.deepEqual(f.fuel, { item: COAL, count: 1 });
  assert.equal(f.burn, 0);
  assert.equal(f.lit, false);
});

t('fuel is not consumed while the input is unsmeltable', () => {
  const st = new Stations();
  const f = st.furnaceAt(4, 4, 4, true);
  f.input = { item: IRON_INGOT, count: 8 };   // already smelted, nothing to do
  f.fuel = { item: COAL, count: 2 };
  run(st, 5);
  assert.equal(f.fuel.count, 2);
  assert.equal(f.lit, false);
  assert.equal(f.progress, 0);
});

// ------------------------------------------------------------------ stacking

t('a full output slot stalls the furnace and spends no fuel', () => {
  const st = new Stations();
  const f = loaded(st, 0, 0, 0, 5, 4);
  f.output = { item: IRON_INGOT, count: CAP };
  run(st, SMELT_TIME * 3);
  assert.equal(f.output.count, CAP, 'never exceeds maxStack');
  assert.equal(f.input.count, 5);
  assert.equal(f.fuel.count, 4, 'a blocked furnace must not burn fuel');
  assert.equal(f.progress, 0);
  assert.equal(f.lit, false);
});

t('the last free slot in a stack is filled, then the furnace stalls', () => {
  const st = new Stations();
  const f = loaded(st, 0, 0, 0, 5, 4);
  f.output = { item: IRON_INGOT, count: CAP - 1 };

  run(st, SMELT_TIME + 0.2);
  assert.equal(f.output.count, CAP);
  assert.equal(f.input.count, 4);
  assert.equal(f.fuel.count, 3, 'one coal lit it for that single smelt');

  run(st, SMELT_TIME * 2);
  assert.equal(f.output.count, CAP, 'stalls once the stack is full');
  assert.equal(f.input.count, 4);
  assert.equal(f.fuel.count, 3, 'no further fuel is consumed while blocked');
});

t('a foreign item in the output slot blocks smelting entirely', () => {
  const st = new Stations();
  const f = loaded(st, 2, 2, 2, 4, 4);
  f.output = { item: COAL, count: 1 };
  run(st, SMELT_TIME * 2);
  assert.deepEqual(f.output, { item: COAL, count: 1 });
  assert.equal(f.input.count, 4);
  assert.equal(f.fuel.count, 4);
});

// ------------------------------------------------------------------ progress

t('progress decays at 2x when the smelt is interrupted', () => {
  const st = new Stations();
  const f = loaded(st, 5, 5, 5, 1, 1);
  run(st, SMELT_TIME * 0.5);
  const mid = f.progress;
  assert.ok(mid > 1, `expected a meaningful half-smelt, got ${mid}`);

  f.input = null;                       // ore yanked out of the slot
  run(st, 0.5);
  assert.ok(Math.abs(f.progress - (mid - 1.0)) < 1e-6,
    `expected ${mid - 1.0}, got ${f.progress}`);
  assert.equal(f.lit, true, 'decay does not put the fire out');

  run(st, SMELT_TIME);
  assert.equal(f.progress, 0, 'decay clamps at exactly zero');
});

t('decay never drives progress negative on a long step', () => {
  const st = new Stations();
  const f = st.furnaceAt(6, 6, 6, true);
  f.progress = 0.01;
  run(st, 1);
  assert.equal(f.progress, 0);
});

// -------------------------------------------------------------- lit reporting

t('lit flips are reported exactly once each, with the block position', () => {
  const st = new Stations();
  const f = loaded(st, -3, 70, 12, 64, 1);
  const changes = run(st, COAL_SECONDS + 2);
  assert.equal(changes.length, 2, `expected one light-up and one burn-out, got ${changes.length}`);
  assert.deepEqual(changes[0], { x: -3, y: 70, z: 12, lit: true });
  assert.deepEqual(changes[1], { x: -3, y: 70, z: 12, lit: false });
  assert.equal(f.lit, false);
  assert.equal(f.fuel, null);
});

t('a refuel mid-burn does not report a spurious flicker', () => {
  const st = new Stations();
  loaded(st, 9, 9, 9, 64, 3);
  const changes = run(st, COAL_SECONDS * 2.5);
  assert.equal(changes.length, 1, 'stays lit straight through the second coal');
  assert.equal(changes[0].lit, true);
});

t('an idle furnace costs nothing and reports nothing', () => {
  const st = new Stations();
  st.furnaceAt(0, 0, 0, true);
  assert.deepEqual(st.update(0.05), []);
  assert.deepEqual(run(st, 60), []);
});

t('update with a non-positive dt is a no-op', () => {
  const st = new Stations();
  const f = loaded(st, 0, 0, 0);
  assert.deepEqual(st.update(0), []);
  assert.equal(f.progress, 0);
  assert.equal(f.fuel.count, 3);
});

// -------------------------------------------------------------- life support

t('nearLifeSupport respects the radius', () => {
  const st = new Stations();
  assert.equal(st.nearLifeSupport({ x: 0, y: 0, z: 0 }), false, 'nothing built yet');

  st.addLifeSupport(10, 40, 10);        // block centre is (10.5, 40.5, 10.5)
  assert.equal(st.nearLifeSupport({ x: 10.5, y: 40.5, z: 10.5 }), true);
  assert.equal(st.nearLifeSupport({ x: 10.5, y: 40.5, z: 19.0 }), true, '8.5 away, inside r=9');
  assert.equal(st.nearLifeSupport({ x: 10.5, y: 40.5, z: 20.0 }), false, '9.5 away, outside r=9');
  assert.equal(st.nearLifeSupport({ x: 16.5, y: 46.5, z: 10.5 }), true, 'diagonal 8.49');
  assert.equal(st.nearLifeSupport({ x: 17.5, y: 47.5, z: 10.5 }), false, 'diagonal 9.90');
  assert.equal(st.nearLifeSupport({ x: 10.5, y: 40.5, z: 14.5 }, 4), true, 'exactly on the radius');
  assert.equal(st.nearLifeSupport({ x: 10.5, y: 40.5, z: 14.6 }, 4), false);
  assert.equal(st.nearLifeSupport({ x: 10.5, y: 40.5, z: 40.5 }, 40), true, 'wide radius reaches');
});

t('life support add/remove is idempotent and updates coverage', () => {
  const st = new Stations();
  assert.equal(st.addLifeSupport(0, 0, 0), true);
  assert.equal(st.addLifeSupport(0, 0, 0), false, 'already there');
  assert.equal(st.lifeSupports.size, 1);

  st.addLifeSupport(100, 64, 100);
  assert.equal(st.nearLifeSupport({ x: 100.5, y: 64.5, z: 100.5 }), true, 'later units are checked too');
  assert.equal(st.nearLifeSupport({ x: 50, y: 64, z: 50 }), false);

  assert.equal(st.removeLifeSupport(0, 0, 0), true);
  assert.equal(st.nearLifeSupport({ x: 0.5, y: 0.5, z: 0.5 }), false);
  assert.equal(st.removeLifeSupport(0, 0, 0), false, 'removing twice is harmless');
  assert.equal(st.nearLifeSupport({ x: 100.5, y: 64.5, z: 100.5 }), true, 'the survivor still covers');
});

// ------------------------------------------------------------ furnace handles

t('furnaceAt only creates on demand; removeFurnace hands back the contents', () => {
  const st = new Stations();
  assert.equal(st.furnaceAt(1, 1, 1), null);
  assert.equal(st.removeFurnace(1, 1, 1), null);

  const f = st.furnaceAt(1, 1, 1, true);
  assert.equal(st.furnaceAt(1, 1, 1), f, 'same voxel, same state object');
  assert.equal(st.furnaces.size, 1);
  assert.deepEqual(f, { input: null, fuel: null, output: null, burn: 0, burnMax: 0, progress: 0, lit: false });

  f.output = { item: IRON_INGOT, count: 2 };
  const gone = st.removeFurnace(1, 1, 1);
  assert.equal(gone, f);
  assert.deepEqual(gone.output, { item: IRON_INGOT, count: 2 }, 'contents survive for the drop');
  assert.equal(st.furnaces.size, 0);
  assert.equal(st.furnaceAt(1, 1, 1), null);
});

t('negative and separate voxels do not collide', () => {
  const st = new Stations();
  const a = st.furnaceAt(-1, 5, -1, true);
  const b = st.furnaceAt(1, 5, 1, true);
  assert.notEqual(a, b);
  assert.equal(st.furnaces.size, 2);
  assert.equal(st.furnaceAt(-1, 5, -1), a);
});

// ------------------------------------------------------------- serialization

t('serialize/restore round-trips a furnace mid-smelt', () => {
  const a = new Stations();
  const f = loaded(a, 7, 64, -9, 4, 3);
  a.addLifeSupport(2, 3, 4);
  run(a, SMELT_TIME * 1.5);
  assert.ok(f.progress > 0 && f.output, 'fixture must actually be mid-smelt');

  const snap = JSON.parse(JSON.stringify(a.serialize()));   // through the real save path
  const b = new Stations();
  b.restore(snap);

  const g = b.furnaceAt(7, 64, -9);
  assert.ok(g, 'restored at the same voxel');
  assert.deepEqual(g.input, f.input);
  assert.deepEqual(g.fuel, f.fuel);
  assert.deepEqual(g.output, f.output);
  assert.equal(g.burn, f.burn);
  assert.equal(g.burnMax, f.burnMax);
  assert.equal(g.progress, f.progress);
  assert.equal(g.lit, f.lit, 'lit is rederived from burn on load');
  assert.equal(b.nearLifeSupport({ x: 2.5, y: 3.5, z: 4.5 }), true, 'life support came back');

  run(a, SMELT_TIME);
  run(b, SMELT_TIME);
  assert.deepEqual(b.serialize(), a.serialize(), 'the restored copy stays in lockstep');
});

t('restore replaces whatever was there and survives junk', () => {
  const st = new Stations();
  loaded(st, 0, 0, 0);
  st.addLifeSupport(9, 9, 9);

  st.restore({ furnaces: [], life: [] });
  assert.equal(st.furnaces.size, 0);
  assert.equal(st.lifeSupports.size, 0);
  assert.equal(st.nearLifeSupport({ x: 9.5, y: 9.5, z: 9.5 }), false);

  st.restore(null);
  st.restore({});
  st.restore({ furnaces: [null, { at: '' }] });
  assert.equal(st.furnaces.size, 0, 'malformed records are dropped, not thrown on');
});

t('serialize drops empty slots and does not alias live stacks', () => {
  const st = new Stations();
  const f = loaded(st, 3, 3, 3, 2, 1);
  f.output = null;
  const snap = st.serialize();
  const rec = snap.furnaces[0];
  assert.equal(rec.at, '3,3,3');
  assert.equal(rec.output, null);
  assert.notEqual(rec.input, f.input, 'stacks are copied, not shared');
  rec.input.count = 99;
  assert.equal(f.input.count, 2);
  assert.equal(rec.lit, undefined, 'lit is derived, not stored');
});

// ------------------------------------------------------- framerate invariance
// game.js clamps dt to 0.05, but it feeds whatever the frame took below that.
// Two players smelting the same ore must get the same ingots at 30 and 144 fps.

/** Ingots produced by burning `coals` worth of fuel through `seconds` at `dt`. */
function yieldAt(dt, coals, seconds) {
  const st = new Stations();
  const f = st.furnaceAt(0, 64, 0, true);
  f.input = { item: RAW_IRON, count: 64 };
  f.fuel = { item: COAL, count: coals };
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) st.update(dt);
  return f.output ? f.output.count : 0;
}

t('the ingot count does not depend on the frame length', () => {
  const span = COAL_SECONDS * 3 + SMELT_TIME * 2;
  const ref = yieldAt(0.05, 3, span);
  assert.ok(ref >= 3, `fixture should smelt a good few ingots, got ${ref}`);
  for (const dt of [1 / 144, 1 / 90, 1 / 60, 1 / 30, 1 / 24, 0.02]) {
    assert.equal(yieldAt(dt, 3, span), ref,
      `dt=${dt} produced a different yield than dt=0.05 (${ref})`);
  }
});

t('a single long frame spends the whole burn instead of discarding it', () => {
  const st = new Stations();
  const f = st.furnaceAt(0, 0, 0, true);
  f.input = { item: RAW_IRON, count: 64 };
  f.fuel = { item: COAL, count: 1 };
  st.update(0.1);                       // light it: one coal is now paid for
  st.update(COAL_SECONDS * 8);          // ...and one monstrous catch-up frame

  const expected = Math.floor(COAL_SECONDS / SMELT_TIME);
  assert.equal(f.output?.count, expected,
    `one coal must still buy ${expected} ingots when the frame is longer than the burn`);
  assert.equal(f.burn, 0);
  assert.equal(f.lit, false);
  assert.equal(yieldAt(0.05, 1, COAL_SECONDS * 8), expected, 'and small steps agree');
});

// ------------------------------------------------------------- hostile saves

t('a save key the module did not write is re-keyed, not left as a ghost', () => {
  const st = new Stations();
  st.restore({ furnaces: [{ at: '1, 2, 3', input: { item: RAW_IRON, count: 2 }, fuel: { item: COAL, count: 1 } }] });

  const f = st.furnaceAt(1, 2, 3);
  assert.ok(f, 'a hand-spaced key must still be reachable through furnaceAt');
  assert.deepEqual(f.input, { item: RAW_IRON, count: 2 });
  assert.equal(st.serialize().furnaces[0].at, '1,2,3', 'and it round-trips canonically');

  const [c] = st.update(0.05);
  assert.deepEqual(c, { x: 1, y: 2, z: 3, lit: true }, 'the block swap gets real integers');
});

t('unparseable keys are dropped rather than turned into NaN coordinates', () => {
  const st = new Stations();
  st.restore({
    furnaces: [{ at: 'bogus', fuel: { item: COAL, count: 1 }, input: { item: RAW_IRON, count: 1 } }, { at: '4,5' }],
    life: ['nonsense', '7,7,7'],
  });
  assert.equal(st.furnaces.size, 0, 'no furnace the game could never address');
  assert.deepEqual(st.update(0.05), []);
  assert.deepEqual(st.serialize().life, ['7,7,7'], 'only the usable unit survives');
  assert.equal(st.nearLifeSupport({ x: 7.5, y: 7.5, z: 7.5 }), true);
  assert.equal(st.nearLifeSupport({ x: 900, y: 900, z: 900 }), false);
});

t('restore coerces timers a hand-edited save got wrong', () => {
  const st = new Stations();
  st.restore({
    furnaces: [{ at: '0,0,0', input: { item: RAW_IRON, count: 2 }, burn: 'x', burnMax: -5, progress: null }],
  });
  const f = st.furnaceAt(0, 0, 0);
  assert.equal(f.burn, 0);
  assert.equal(f.burnMax, 0);
  assert.equal(f.progress, 0);
  assert.equal(f.lit, false);
  st.update(0.05);
  assert.equal(Number.isFinite(f.burn) && Number.isFinite(f.progress), true, 'the tick stays numeric');
});

t('a slot emptied to count 0 collapses to null', () => {
  const st = new Stations();
  const f = st.furnaceAt(0, 0, 0, true);
  f.input = { item: RAW_IRON, count: 0 };
  f.fuel = { item: COAL, count: 0 };
  f.output = { item: IRON_INGOT, count: 0 };
  st.update(0.05);
  assert.equal(f.input, null, 'breakBlock() must never spill a stack of nothing');
  assert.equal(f.fuel, null);
  assert.equal(f.output, null);
});

// -------------------------------------------------------------------- summary

console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
if (!REAL) {
  console.log('NOTE: app/js/recipes.js was absent - ran against a scratch copy of');
  console.log('      stations.js with a stub recipe module (raw_iron -> iron_ingot, 9s).');
}
if (fail) {
  console.log('\nfailures:');
  for (const [name, e] of failures) console.log(`  ${name}: ${e.stack}`);
}
process.exit(fail ? 1 : 0);
