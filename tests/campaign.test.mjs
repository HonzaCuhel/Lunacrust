import assert from 'node:assert/strict';
import { Container } from '../app/js/inventory.js';
import { PLANETS, PLANET_BY_ID } from '../app/js/planets.js';
import { WorldGen } from '../app/js/worldgen.js';
import { AIR } from '../app/js/blocks.js';
import { ITEMS, itemIdOf, ingredientItems, matchesIngredient, canHarvest, dropFor } from '../app/js/items.js';
import { RECIPES, ingredientsOf, fuelSeconds, smeltingResult } from '../app/js/recipes.js';

const domain = await import('../app/js/campaign.js').catch((error) => {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.message.includes('/campaign.js')) return null;
  throw error;
});
assert.ok(domain, 'The campaign domain must exist before survival can progress between worlds');
const { CAMPAIGN_STAGES, createCampaign, normalizeCampaign, stageFor, canVisit, arrive,
  requirementsFor, repairRelay, nextDestination } = domain;

let checks = 0;
function test(name, fn) {
  try { fn(); checks++; }
  catch (error) { error.message = `${name}: ${error.message}`; throw error; }
}
const ROUTE = ['earth', 'luna', 'mars', 'venus', 'europa', 'io', 'titan', 'jupiter'];
const copy = (value) => JSON.parse(JSON.stringify(value));
const fillFor = (planetId, extra = 0) => {
  const inventory = new Container(36);
  for (const { spec, count } of stageFor(planetId).cost) {
    assert.equal(inventory.addItem(ingredientItems(spec)[0], count + extra), 0);
  }
  return inventory;
};
const finish = (state) => repairRelay(state, state.activePlanet, fillFor(state.activePlanet));

test('every new survival run starts on Earth with an independent identity', () => {
  const a = createCampaign(), b = createCampaign();
  assert.equal(a.version, 1);
  assert.equal(a.campaignKey, 'the-last-signal');
  assert.equal(typeof a.id, 'string');
  assert.notEqual(a.id, b.id);
  assert.equal(a.activePlanet, 'earth');
  assert.deepEqual(a.visited, ['earth']);
  assert.deepEqual(a.repaired, []);
  assert.equal(a.completed, false);
  a.visited.push('jupiter');
  assert.deepEqual(b.visited, ['earth']);
});

test('the eight original chapters follow the intended route and real world IDs', () => {
  assert.deepEqual(CAMPAIGN_STAGES.map((stage) => stage.planetId), ROUTE);
  assert.equal(new Set(CAMPAIGN_STAGES.map((stage) => stage.title)).size, 8);
  for (const stage of CAMPAIGN_STAGES) {
    assert.ok(PLANET_BY_ID.has(stage.planetId));
    for (const field of ['title', 'story', 'objective', 'completionText']) {
      assert.ok(typeof stage[field] === 'string' && stage[field].trim().length > 10, `${stage.planetId}.${field}`);
    }
    assert.ok(stage.cost.length > 0);
    for (const row of stage.cost) {
      assert.ok(Number.isInteger(row.count) && row.count > 0);
      assert.ok(ingredientItems(row.spec).length > 0);
    }
  }
  assert.equal(stageFor('bogus'), null);
  assert.equal(stageFor('moon'), null, 'the actual Moon world ID is luna');
});

test('direct helpers enforce travel locks and reject remote relay repairs', () => {
  const state = createCampaign(), before = copy(state);
  assert.equal(canVisit(state, 'earth'), true);
  assert.equal(nextDestination(state), null);
  for (const planetId of [...ROUTE.slice(1), 'bogus', null]) {
    assert.equal(canVisit(state, planetId), false, String(planetId));
    assert.throws(() => arrive(state, planetId), /locked|unknown/i);
  }
  const inventory = fillFor('luna'), contents = inventory.serialize();
  assert.throws(() => repairRelay(state, 'luna', inventory), /active|locked|visit/i);
  assert.deepEqual(inventory.serialize(), contents);
  assert.deepEqual(state, before);
});

test('resource requirements include all matching rock stacks and labels', () => {
  const state = createCampaign(), inventory = new Container(36);
  inventory.set(0, { item: itemIdOf('cobble'), count: 5 });
  inventory.set(1, { item: itemIdOf('moon_rock'), count: 9 });
  inventory.set(2, { item: itemIdOf('raw_iron'), count: 1 });
  inventory.set(3, { item: itemIdOf('dirt'), count: 64 });
  const requirements = requirementsFor(state, 'earth', inventory);
  assert.equal(requirements.find((row) => row.spec === '#rock').have, 14);
  assert.equal(requirements.find((row) => row.spec === 'raw_iron').have, 1);
  for (const row of requirements) assert.ok(row.label && row.count > 0);
  assert.deepEqual(requirementsFor(state, 'bogus', inventory), []);
});

test('a failed purchase consumes nothing, including affordable earlier ingredients', () => {
  const state = createCampaign(), original = copy(state), inventory = fillFor('earth');
  inventory.removeItems(itemIdOf('raw_iron'), 1);
  const contents = inventory.serialize();
  assert.throws(() => repairRelay(state, 'earth', inventory), /resources|materials|missing/i);
  assert.deepEqual(inventory.serialize(), contents);
  assert.deepEqual(state, original);
});

test('a successful repair consumes exact quantities across stacks and cannot repeat', () => {
  const state = createCampaign(), original = copy(state), inventory = new Container(36);
  const rockCost = stageFor('earth').cost.find((row) => row.spec === '#rock').count;
  const ironCost = stageFor('earth').cost.find((row) => row.spec === 'raw_iron').count;
  inventory.set(0, { item: itemIdOf('cobble'), count: rockCost - 2 });
  inventory.set(1, { item: itemIdOf('basalt'), count: 5 });
  inventory.set(2, { item: itemIdOf('raw_iron'), count: ironCost + 2 });
  inventory.set(3, { item: itemIdOf('dirt'), count: 27 });
  inventory.set(4, { item: itemIdOf('iron_pickaxe'), count: 1, dur: 17 });
  const updated = repairRelay(state, 'earth', inventory);
  assert.deepEqual(state, original);
  assert.equal(inventory.get(0), null);
  assert.equal(inventory.count(itemIdOf('basalt')), 3);
  assert.equal(inventory.count(itemIdOf('raw_iron')), 2);
  assert.equal(inventory.count(itemIdOf('dirt')), 27);
  assert.equal(inventory.get(4).dur, 17);
  assert.deepEqual(updated.repaired, ['earth']);
  assert.deepEqual(updated.visited, ['earth']);
  assert.equal(updated.id, state.id);
  assert.equal(updated.completed, false);
  assert.deepEqual(requirementsFor(updated, 'earth', inventory), []);
  assert.equal(nextDestination(updated), 'luna');
  const contents = inventory.serialize();
  assert.throws(() => repairRelay(updated, 'earth', inventory), /already|repaired/i);
  assert.deepEqual(inventory.serialize(), contents);
});

let completedRun;
test('a full eight-world expedition unlocks one world per repair and ends only at Jupiter', () => {
  let state = createCampaign();
  for (let index = 0; index < ROUTE.length; index++) {
    const planetId = ROUTE[index];
    assert.equal(state.activePlanet, planetId);
    assert.equal(state.completed, false);
    assert.deepEqual(state.visited, ROUTE.slice(0, index + 1));
    assert.deepEqual(state.repaired, ROUTE.slice(0, index));
    assert.equal(nextDestination(state), null);
    for (const lockedId of ROUTE.slice(index + 1)) {
      assert.equal(canVisit(state, lockedId), false);
      assert.throws(() => arrive(state, lockedId), /locked/i);
    }
    const before = copy(state);
    const inventory = fillFor(planetId);
    state = repairRelay(state, planetId, inventory);
    assert.ok(inventory.isEmpty(), `${planetId}: exact payment remains`);
    assert.deepEqual(before.repaired, ROUTE.slice(0, index));
    assert.equal(state.completed, index === ROUTE.length - 1);
    assert.equal(nextDestination(state), ROUTE[index + 1] ?? null);
    assert.deepEqual(normalizeCampaign(copy(state)), state);
    if (index + 1 < ROUTE.length) {
      const prior = state;
      state = arrive(state, ROUTE[index + 1]);
      assert.equal(prior.activePlanet, planetId);
    }
  }
  completedRun = state;
  for (const planetId of ROUTE) {
    assert.equal(canVisit(state, planetId), true);
    const revisited = arrive(state, planetId);
    assert.equal(revisited.completed, true);
    assert.deepEqual(revisited.repaired, ROUTE);
    assert.equal(revisited.activePlanet, planetId);
  }
});

test('visiting old worlds preserves progress and does not permit repairing another world remotely', () => {
  let state = arrive(finish(createCampaign()), 'luna');
  state = arrive(state, 'earth');
  assert.deepEqual(state.visited, ['earth', 'luna']);
  assert.deepEqual(state.repaired, ['earth']);
  assert.equal(nextDestination(state), null);
  const inventory = fillFor('luna'), contents = inventory.serialize();
  assert.throws(() => repairRelay(state, 'luna', inventory), /active/i);
  assert.deepEqual(inventory.serialize(), contents);
  assert.equal(arrive(state, 'luna').activePlanet, 'luna');
});

test('corrupt saves cannot turn visit lists, repaired flags or completed into skipped unlocks', () => {
  const base = createCampaign();
  for (const patch of [
    { completed: true, activePlanet: 'jupiter' },
    { visited: ROUTE, repaired: ['jupiter'], completed: true },
    { visited: ['earth', 'jupiter', 'luna'], repaired: ROUTE, completed: true },
    { visited: ['earth'], repaired: ROUTE, completed: true },
    { visited: ['jupiter', 'earth'], repaired: ROUTE, completed: true },
    { visited: 'earth,luna,mars', repaired: { earth: true }, completed: true },
  ]) {
    const raw = { ...base, ...patch }, original = copy(raw);
    const normalized = normalizeCampaign(raw);
    assert.equal(canVisit(normalized, 'mars'), false);
    assert.equal(canVisit(normalized, 'jupiter'), false);
    assert.equal(normalized.completed, false);
    assert.deepEqual(raw, original);
  }
  const partial = normalizeCampaign({ ...base, visited: ['earth', 'luna', 'mars', 'jupiter'],
    repaired: ['earth', 'luna', 'mars', 'jupiter'], activePlanet: 'jupiter', completed: true });
  assert.deepEqual(partial.visited, ['earth', 'luna', 'mars']);
  assert.deepEqual(partial.repaired, ['earth', 'luna', 'mars']);
  assert.equal(partial.activePlanet, 'mars');
  assert.equal(nextDestination(partial), 'venus');
  assert.equal(partial.completed, false);
});

test('normalization handles malformed roots, isolates creative data, and preserves proven endings', () => {
  for (const raw of [undefined, null, 42, [], 'bad', {}, { ...completedRun, version: 99 },
    { ...completedRun, campaignKey: 'creative' }]) {
    const state = normalizeCampaign(raw);
    assert.equal(state.activePlanet, 'earth');
    assert.deepEqual(state.visited, ['earth']);
    assert.deepEqual(state.repaired, []);
    assert.equal(state.completed, false);
    assert.ok(state.id);
  }
  const restored = normalizeCampaign({ ...copy(completedRun), completed: false });
  assert.equal(restored.completed, true);
  assert.equal(restored.id, completedRun.id);
  assert.deepEqual(restored.visited, ROUTE);
  restored.visited.pop();
  assert.deepEqual(completedRun.visited, ROUTE);
});

// Like progression.test.mjs, this is a resource closure over generated terrain,
// actual harvest tiers, crafting inputs and smelts. It also requires a reachable
// fabricator for 3x3 recipes, and a furnace plus fuel for smelting. It proves
// material reachability, not a timed play-through or a survival difficulty bound.
function locallyReachable(planet) {
  const gen = new WorldGen(planet, 20240), present = new Set(), have = new Set();
  for (let chunk = 0; chunk < 6; chunk++) {
    for (const blockId of gen.generate(chunk - 3, (chunk * 5) % 7)) {
      if (blockId !== AIR) present.add(blockId);
    }
  }
  const satisfies = (spec) => [...have].some((id) => matchesIngredient(id, spec));
  for (let pass = 0; pass < ITEMS.length; pass++) {
    const before = have.size;
    const pickaxe = [...have].filter((id) => ITEMS[id]?.tool?.type === 'pickaxe')
      .sort((a, b) => ITEMS[b].tool.tier - ITEMS[a].tool.tier)[0] ?? 0;
    for (const blockId of present) {
      if (!canHarvest(blockId, pickaxe)) continue;
      const drop = dropFor(blockId, pickaxe, 0.99);
      if (drop) have.add(drop.item);
    }
    for (const recipe of RECIPES) {
      if (recipe.size > 2 && !have.has(itemIdOf('fabricator'))) continue;
      if (ingredientsOf(recipe).every(satisfies)) have.add(recipe.out.item);
    }
    if (have.has(itemIdOf('furnace')) && [...have].some((id) => fuelSeconds(id) > 0)) {
      for (const itemId of [...have]) {
        const smelt = smeltingResult(itemId);
        if (smelt) have.add(smelt.item);
      }
    }
    if (have.size === before) break;
  }
  return have;
}

for (const planet of PLANETS) {
  test(`${planet.id}: every relay material can be harvested or made locally from bare hands`, () => {
    const reachable = locallyReachable(planet);
    for (const { spec } of stageFor(planet.id).cost) {
      assert.ok([...reachable].some((id) => matchesIngredient(id, spec)), `${spec} is unreachable`);
    }
  });
}

console.log(`campaign: ${checks} checks passed - ordered story, atomic resources, safe restores and reachable costs`);
