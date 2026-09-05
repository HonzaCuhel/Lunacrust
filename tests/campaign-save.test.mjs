import assert from 'node:assert/strict';
import { createCampaign, arrive, canVisit } from '../app/js/campaign.js';
import { PlayerInventory, ArmourContainer } from '../app/js/inventory.js';
import { Survival } from '../app/js/survival.js';
import { PLANET_BY_ID } from '../app/js/planets.js';
import { itemIdOf } from '../app/js/items.js';

const persistence = await import('../app/js/campaign-save.js').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.message.includes('/campaign-save.js')) return null;
  throw error;
});
assert.ok(persistence, 'Campaign persistence must validate saves and carry the active inventory between worlds');
const { validateCampaignSave, captureCampaign, travelSave } = persistence;
const copy = value => structuredClone(value);
let checks = 0;
function test(name, fn) {
  try { fn(); checks++; }
  catch (error) { error.message = `${name}: ${error.message}`; throw error; }
}
function world(planetId = 'earth', count = 3) {
  const inventory = new PlayerInventory();
  inventory.set(0, { item: itemIdOf('raw_iron'), count });
  return {
    version: 2, planetId, mode: 'survival', seed: 1729,
    worldUid: `${planetId}-fixture`, savedAt: 100, time: 0.35,
    player: { pos: { x: 2.5, y: 65, z: -3.5 }, yaw: 1, pitch: 0.2, flying: false },
    edits: { '1,64,1': 2 }, inventory: inventory.serialize(),
    armour: new ArmourContainer().serialize(),
    survival: { ...new Survival(PLANET_BY_ID.get(planetId)).serialize(), health: 13,
      hunger: 8, oxygen: 27, burning: 2 },
    stations: { furnaces: [], life: ['4,64,4'] },
    drops: [{ x: 3, y: 65, z: 3, item: itemIdOf('raw_iron'), count: 2, age: 10 }],
  };
}
function run() {
  return { kind: 'campaign', version: 1, campaign: createCampaign(),
    worlds: { earth: world() }, savedAt: 100 };
}
function unlocked() {
  const value = run(); value.campaign.repaired = ['earth']; return value;
}
function twoWorlds() {
  const value = unlocked();
  value.campaign = arrive(value.campaign, 'luna');
  value.worlds.luna = world('luna', 12);
  return value;
}

test('valid campaign loading returns independent world and progress trees', () => {
  const original = twoWorlds(), before = copy(original);
  const restored = validateCampaignSave(original);
  assert.deepEqual(restored, original);
  restored.worlds.earth.inventory[0][1] = 99;
  restored.worlds.luna.player.pos.y = 0;
  restored.campaign.visited.push('mars');
  assert.deepEqual(original, before);
});

test('capture fills the first spawn and makes an independent checkpoint payload', () => {
  const original = run(); original.worlds = {};
  const snapshot = world(), before = copy(snapshot);
  const captured = captureCampaign(original, snapshot);
  assert.deepEqual(validateCampaignSave(captured), captured);
  assert.equal(Object.keys(original.worlds).length, 0);
  assert.ok(captured.savedAt >= original.savedAt);
  captured.worlds.earth.inventory[0][1] = 99;
  assert.deepEqual(snapshot, before);
});

test('capture rejects a snapshot from a different planet or an already missing visited world', () => {
  assert.throws(() => captureCampaign(run(), world('luna')), /active|planet/i);
  const broken = twoWorlds(); delete broken.worlds.earth;
  assert.throws(() => captureCampaign(broken, world('luna')), /missing|world/i);
});

test('travel cannot skip locked destinations and leaves its input unchanged', () => {
  const original = run(), before = copy(original);
  for (const destination of ['luna', 'mars', 'moon', 'bogus']) {
    assert.throws(() => travelSave(original, destination), /locked|planet|destination/i);
  }
  assert.deepEqual(original, before);
});

test('new travel preserves health and hunger, refreshes the suit, and waits for a real spawn snapshot', () => {
  const original = unlocked(), before = copy(original);
  const { run: traveling, save } = travelSave(original, 'luna');
  assert.equal(traveling.campaign.activePlanet, 'luna');
  assert.deepEqual(traveling.campaign.visited, ['earth', 'luna']);
  assert.equal(save.mode, 'survival'); assert.equal(save.planetId, 'luna');
  assert.equal(save.player, undefined);
  assert.ok(Number.isSafeInteger(save.seed));
  assert.match(save.worldUid, /^luna-[a-f0-9-]{36}$/);
  assert.deepEqual(save.inventory, original.worlds.earth.inventory);
  assert.equal(save.survival.health, 13); assert.equal(save.survival.hunger, 8);
  assert.equal(save.survival.oxygen, 100); assert.equal(save.survival.burning, 0);
  assert.deepEqual(original, before);
  assert.throws(() => validateCampaignSave(traveling), /missing|world/i);
  const spawned = { ...save, player: world('luna').player };
  const captured = captureCampaign(traveling, spawned);
  assert.equal(validateCampaignSave(captured).campaign.activePlanet, 'luna');
  save.inventory[0][1] = 64;
  assert.deepEqual(original, before);
});

test('revisiting keeps destination terrain and position but replaces stale portable state', () => {
  const original = twoWorlds();
  original.worlds.earth.seed = 33;
  original.worlds.earth.survival.health = 20;
  original.worlds.earth.armour[0] = [itemIdOf('raw_iron'), 1];
  original.worlds.earth.carried = { craft: [[itemIdOf('raw_iron'), 64]], cursor: [itemIdOf('raw_iron'), 64] };
  original.worlds.luna.carried = { craft: [null], cursor: [itemIdOf('raw_iron'), 1] };
  const before = copy(original);
  const { run: arrived, save } = travelSave(original, 'earth');
  for (const field of ['seed', 'worldUid', 'time', 'player', 'edits', 'stations', 'drops']) {
    assert.deepEqual(save[field], original.worlds.earth[field], field);
  }
  for (const field of ['inventory', 'armour', 'carried']) assert.deepEqual(save[field], original.worlds.luna[field], field);
  assert.equal(save.survival.health, original.worlds.luna.survival.health);
  assert.deepEqual(arrived.worlds.earth.inventory, save.inventory);
  save.carried.cursor[1] = 20; save.edits['1,64,1'] = 40;
  assert.equal(arrived.worlds.earth.carried.cursor[1], 1);
  assert.deepEqual(original, before);
});

test('an empty active cursor removes an obsolete destination cursor', () => {
  const original = twoWorlds();
  original.worlds.earth.carried = { cursor: [itemIdOf('raw_iron'), 64] };
  const { run: arrived, save } = travelSave(original, 'earth');
  assert.equal(save.carried, undefined);
  assert.equal(arrived.worlds.earth.carried, undefined);
});

test('a round trip never restores the source world inventory from its previous visit', () => {
  const first = travelSave(unlocked(), 'luna');
  const lunaSnapshot = { ...first.save, player: world('luna').player };
  lunaSnapshot.inventory[0][1] = 1;
  const onLuna = captureCampaign(first.run, lunaSnapshot);
  const back = travelSave(onLuna, 'earth');
  assert.equal(back.save.inventory[0][1], 1);
  assert.equal(back.run.worlds.earth.inventory[0][1], 1);
});

test('malformed envelopes, versions and campaign identity are rejected instead of reset', () => {
  for (const broken of [null, [], {}, { ...run(), kind: 'world' }, { ...run(), version: 2 },
    { ...run(), savedAt: NaN }]) assert.throws(() => validateCampaignSave(broken), /campaign|save|version/i);
  for (const patch of [{ version: 99 }, { campaignKey: 'creative' }, { id: null }]) {
    const broken = run(); Object.assign(broken.campaign, patch);
    assert.throws(() => validateCampaignSave(broken), /campaign|version|identity/i);
  }
});

test('every visited world including the active one must exist in a persisted run', () => {
  for (const planetId of ['earth', 'luna']) {
    const broken = twoWorlds(); delete broken.worlds[planetId];
    assert.throws(() => validateCampaignSave(broken), /missing|world/i);
  }
});

test('unknown world keys, planet mismatches and unknown campaign planets are rejected', () => {
  const unknown = run(); unknown.worlds.pluto = world('pluto');
  const mismatch = run(); mismatch.worlds.earth.planetId = 'luna';
  const active = run(); active.campaign.activePlanet = 'pluto';
  const visited = run(); visited.campaign.visited.push('pluto');
  for (const broken of [unknown, mismatch, active, visited]) {
    assert.throws(() => validateCampaignSave(broken), /planet|world/i);
  }
});

test('invalid world seed, position and portable data cannot silently create a fresh world or kit', () => {
  for (const patch of [{ seed: NaN }, { seed: '3' }, { seed: 1.5 }, { player: null },
    { player: { pos: { x: 0, y: Infinity, z: 0 } } }, { edits: null },
    { mode: 'creative' }, { version: 99 }, { inventory: null }, { armour: null },
    { survival: null }, { time: Infinity }]) {
    const broken = run(); Object.assign(broken.worlds.earth, patch);
    assert.throws(() => validateCampaignSave(broken), /world|snapshot|survival/i);
  }
});

test('corrupt repair and completion flags cannot unlock skipped chapters', () => {
  const original = run();
  original.campaign.completed = true;
  original.campaign.repaired = ['jupiter'];
  original.campaign.activePlanet = 'jupiter';
  const normalized = validateCampaignSave(original);
  assert.equal(normalized.campaign.completed, false);
  assert.equal(normalized.campaign.activePlanet, 'earth');
  assert.deepEqual(normalized.campaign.repaired, []);
  assert.equal(canVisit(normalized.campaign, 'luna'), false);
  assert.equal(canVisit(normalized.campaign, 'jupiter'), false);
  assert.equal(original.campaign.completed, true);
});

console.log(`campaign save: ${checks} checks passed`);
