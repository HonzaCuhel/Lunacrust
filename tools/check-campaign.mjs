// Browser integration coverage for story progression and named checkpoints.
// Uses the real game and UI in an isolated Chrome profile. Resource injection
// skips mining time; campaign.test.mjs separately checks local reachability.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const url = process.env.LUNACRUST_TEST_URL || 'http://127.0.0.1:5178';
const out = 'output/playwright/campaign';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [], checks = [];
const ROUTE = ['earth', 'luna', 'mars', 'venus', 'europa', 'io', 'titan', 'jupiter'];
const SAVE_KEY = 'spacemc:save:campaign-current';
let failure = null;
page.on('pageerror', (error) => errors.push({ type: 'pageerror', message: error.message }));
page.on('response', (response) => {
  if (response.status() >= 400) errors.push({ type: 'resource', status: response.status(), url: response.url() });
});
page.on('requestfailed', (request) => {
  if (!request.failure()?.errorText.includes('ERR_ABORTED')) {
    errors.push({ type: 'requestfailed', message: request.failure()?.errorText, url: request.url() });
  }
});
page.on('console', (message) => {
  if (message.type() === 'error') errors.push({ type: 'console', message: message.text() });
});
function check(name, condition) {
  assert.ok(condition, name);
  checks.push(name);
  console.log('PASS', name);
}

const campaign = () => page.evaluate(() => window.__space.campaignRun?.campaign);
const persisted = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), SAVE_KEY);
const rowFor = (id) => page.locator(`[data-checkpoint-id="${id}"]`);
const checkpointEntries = () => page.evaluate(() => Object.keys(localStorage)
  .filter((key) => key.startsWith('spacemc:save:checkpoint-'))
  .map((key) => JSON.parse(localStorage.getItem(key))));

async function ready(planetId) {
  await page.waitForFunction((id) => window.__space.game.spawned
    && window.__space.game.running && window.__space.game.planet.id === id
    && ['play', 'pause'].includes(window.__space.state.screen),
  planetId, { timeout: 60000 });
  await pauseGame();
}

async function pauseGame() {
  await page.evaluate(() => {
    document.exitPointerLock?.();
    window.__space.game.setPaused(true);
    window.__space.show('pause');
  });
}

async function closeMission() {
  if (await page.locator('#mission-dialog').isVisible()) await page.locator('#mission-close').click();
}

async function openMission() {
  await pauseGame();
  if (!(await page.locator('#mission-dialog').isVisible())) await page.locator('#btn-mission').click();
  await page.locator('#mission-dialog').waitFor({ state: 'visible' });
}

async function openCheckpoints() {
  await closeMission();
  await pauseGame();
  await page.locator('#btn-pause-checkpoints').click();
  await page.locator('#checkpoint-dialog').waitFor({ state: 'visible' });
}

async function saveCheckpoint(name) {
  await page.locator('#checkpoint-name').fill(name);
  await page.locator('#checkpoint-save').click();
  await page.waitForFunction((expected) => Object.keys(localStorage)
    .filter((key) => key.startsWith('spacemc:save:checkpoint-'))
    .some((key) => JSON.parse(localStorage.getItem(key)).name === expected), name);
  const entry = (await checkpointEntries()).find((candidate) => candidate.name === name);
  await rowFor(entry.id).waitFor({ state: 'visible' });
  return entry;
}

async function screenshotPair(name, selector) {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 960, height: 600 }]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => document.fonts.ready);
    await page.locator(selector).evaluate((dialog) => { dialog.scrollTop = 0; });
    const bounds = await page.locator(selector).boundingBox();
    check(`${name} fits ${viewport.width}×${viewport.height}`, bounds && bounds.x >= -1 && bounds.y >= -1
      && bounds.x + bounds.width <= viewport.width + 1 && bounds.y + bounds.height <= viewport.height + 1);
    await page.screenshot({ path: `${out}/${name}-${viewport.width}x${viewport.height}.png` });
    const close = page.locator(selector === '#checkpoint-dialog' ? '#checkpoint-close' : '#mission-close');
    await close.scrollIntoViewIfNeeded();
    const actionBounds = await close.boundingBox();
    check(`${name} close action is fully reachable at ${viewport.width}×${viewport.height}`,
      actionBounds && actionBounds.y >= bounds.y && actionBounds.y + actionBounds.height <= bounds.y + bounds.height + 1);
    if (await page.locator(selector).evaluate((dialog) => dialog.scrollTop > 0)) {
      await page.screenshot({ path: `${out}/${name}-${viewport.width}x${viewport.height}-actions.png` });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator(selector).evaluate((dialog) => { dialog.scrollTop = 0; });
}

async function setFixture({ dirt, health, hunger, oxygen, block = 'brick', marker = null }) {
  return page.evaluate(async (fixture) => {
    const { game } = window.__space;
    const { ITEMS, itemIdOf } = await import('./js/items.js');
    const { BY_KEY } = await import('./js/blocks.js');
    game.setPaused(true);
    game.inventory.clear();
    game.inventory.addItem(itemIdOf('dirt'), fixture.dirt);
    game.armourInv.set(0, { item: ITEMS.find((item) => item?.armour?.slot === 'head').id, count: 1, dur: 23 });
    Object.assign(game.survival, {
      health: fixture.health, hunger: fixture.hunger, oxygen: fixture.oxygen,
      saturation: 0, exertion: 0, regen: 0, burning: 0, alive: true,
    });
    const mark = fixture.marker ?? {
      x: Math.floor(game.player.pos.x) + 2,
      y: Math.min(125, Math.max(2, Math.floor(game.player.pos.y))),
      z: Math.floor(game.player.pos.z) + 2,
    };
    const blockId = BY_KEY.get(fixture.block).id;
    game.editWorld(mark.x, mark.y, mark.z, blockId);
    game.pushHotbar();
    return { marker: { ...mark, blockId }, snapshot: game.snapshot() };
  }, { dirt, health, hunger, oxygen, block, marker });
}

async function addRepairMaterials() {
  return page.evaluate(async () => {
    const { game, campaignRun } = window.__space;
    const { stageFor } = await import('./js/campaign.js');
    const { ingredientItems } = await import('./js/items.js');
    const stage = stageFor(campaignRun.campaign.activePlanet);
    for (const { spec, count } of stage.cost) {
      if (game.inventory.addItem(ingredientItems(spec)[0], count) !== 0) throw new Error(`No room for ${spec}`);
    }
    game.pushHotbar();
    return stage;
  });
}

async function dirtCount() {
  return page.evaluate(async () => {
    const { itemIdOf } = await import('./js/items.js');
    return window.__space.game.inventory.count(itemIdOf('dirt'));
  });
}

async function markerValue(marker) {
  return page.evaluate(({ x, y, z }) => window.__space.game.world.getBlock(x, y, z), marker);
}

async function repairThroughUi(expectedCount) {
  const stage = await addRepairMaterials();
  await openMission();
  check(`${stage.planetId}: mission explains its chapter and objective`,
    (await page.locator('#mission-dialog').innerText()).includes(stage.title)
    && (await page.locator('#mission-dialog').innerText()).includes(stage.objective));
  check(`${stage.planetId}: exact materials enable relay repair`, await page.locator('#mission-repair').isEnabled());
  await page.locator('#mission-repair').click();
  await page.waitForFunction((count) => window.__space.campaignRun.campaign.repaired.length === count, expectedCount);
  check(`${stage.planetId}: repaired progression reaches durable storage`,
    (await persisted()).campaign.repaired.length === expectedCount);
  return stage;
}

async function travelThroughUi(planetId) {
  check(`${planetId}: next destination is available in the mission`, await page.locator('#mission-travel').isEnabled());
  await page.locator('#mission-travel').click();
  await ready(planetId);
}

async function travelDirect(planetId) {
  await closeMission();
  await page.evaluate(async (id) => window.__space.travelCampaign(id), planetId);
  await ready(planetId);
}

async function toOrbit() {
  await closeMission();
  await pauseGame();
  await page.locator('#btn-orbit').click();
  await page.waitForFunction(() => window.__space.state.screen === 'menu');
}

async function verifySprintInput() {
  // Build a real, loaded voxel runway. The normal gravity, body collision and
  // Game keyboard handlers remain in use. Only the automatic render clock is
  // suspended so walk and sprint receive the same 90 simulation frames.
  await page.waitForFunction(() => {
    const { game } = window.__space;
    return game.world.isLoaded(Math.floor(game.player.pos.x), Math.floor(game.player.pos.z) - 20);
  });
  await page.evaluate(async () => {
    const { game } = window.__space;
    const { BY_KEY, AIR } = await import('./js/blocks.js');
    const origin = game.player.serialize();
    const start = { x: Math.floor(origin.pos.x) + 0.5,
      y: Math.min(118, Math.max(4, Math.floor(origin.pos.y) + 5)), z: Math.floor(origin.pos.z) + 0.5 };
    const edits = [];
    for (let x = Math.floor(start.x) - 2; x <= Math.floor(start.x) + 2; x++) {
      for (let z = Math.floor(start.z) - 20; z <= Math.floor(start.z) + 2; z++) {
        edits.push(x, start.y - 1, z, BY_KEY.get('stone').id);
        for (let y = start.y; y <= start.y + 3; y++) edits.push(x, y, z, AIR);
      }
    }
    game.world.setBlocks(edits, edits.length / 4);
    window.__campaignSprintProbe = { start, origin, survival: game.survival.serialize(),
      time: game.sky.time, gravity: game.player.gravity, setBlock: game.world.setBlock,
      pointerLost: game.hooks.onPointerLost };
    game.sky.time = 0.25;
    game.hooks.onPointerLost = () => {};
    cancelAnimationFrame(game.raf);
    document.activeElement?.blur();
    document.exitPointerLock?.();
    window.__space.show('play');
  });
  const measure = async (sprint) => {
    await page.evaluate(() => {
      const { game } = window.__space, probe = window.__campaignSprintProbe;
      game.clearInput();
      game.player.setPosition(probe.start);
      Object.assign(game.player, { onGround: true, yaw: 0, pitch: 0, flying: false });
      game.survival.restore(probe.survival);
      game.setPaused(false);
    });
    if (sprint) await page.keyboard.down('Shift');
    await page.keyboard.down('w');
    const result = await page.evaluate(async () => {
      const { game } = window.__space, probe = window.__campaignSprintProbe;
      const keys = [...game.keys];
      await window.advanceTime(1500);
      return { distance: Math.hypot(game.player.pos.x - probe.start.x, game.player.pos.z - probe.start.z),
        height: game.player.pos.y, startHeight: probe.start.y, sprinting: game.player.sprinting, keys,
        physicsUnchanged: game.player.gravity === probe.gravity && game.world.setBlock === probe.setBlock };
    });
    await page.keyboard.up('w');
    if (sprint) await page.keyboard.up('Shift');
    return result;
  };
  try {
    const walk = await measure(false), sprint = await measure(true);
    check('physical W input walks on real voxel ground', walk.keys.includes('KeyW') && walk.distance > 5 && !walk.sprinting);
    check('physical Shift + W sprints faster for identical simulation time', sprint.keys.includes('ShiftLeft')
      && sprint.sprinting && sprint.distance > walk.distance * 1.4 && sprint.distance < walk.distance * 1.8);
    check('sprint preserves normal gravity and voxel collision', walk.physicsUnchanged && sprint.physicsUnchanged
      && Math.abs(walk.height - walk.startHeight) < 0.05 && Math.abs(sprint.height - sprint.startHeight) < 0.05);
  } finally {
    await page.keyboard.up('w');
    await page.keyboard.up('Shift');
    await page.evaluate(() => {
      const { game } = window.__space, probe = window.__campaignSprintProbe;
      game.setPaused(true);
      game.player.restore(probe.origin);
      game.survival.restore(probe.survival);
      game.sky.time = probe.time;
      game.hooks.onPointerLost = probe.pointerLost;
      delete window.__campaignSprintProbe;
      window.__space.show('pause');
      game.loop();
    });
  }
}

try {
  await page.goto(url);
  await page.waitForFunction(() => window.__space?.state.selected);
  await page.evaluate(() => document.fonts.ready);
  check('fresh survival offers Earth and seven locked worlds',
    await page.locator('button.card:disabled').count() === 7);
  check('menu exposes named checkpoints', await page.locator('#btn-checkpoints').isVisible());
  await page.evaluate(async () => {
    window.__space.selectPlanet('mars');
    await window.__space.land(false);
  });
  check('direct locked landing cannot bypass the survival UI',
    await page.locator('#btn-land').isDisabled()
    && await page.evaluate(() => !window.__space.game.running && !window.__space.campaignActive));

  await page.locator('[data-mode="creative"]').click();
  check('creative immediately makes all eight worlds available', await page.locator('button.card:disabled').count() === 0);
  await page.locator('[data-mode="survival"]').click();
  await page.evaluate(() => {
    window.__space.selectPlanet('earth');
    Object.assign(window.__space.state.settings, { renderDistance: 3, renderScale: 1, volume: 0, musicVolume: 0 });
  });
  await page.locator('#seed-input').fill('90210');
  await page.locator('#btn-land').click();
  await ready('earth');
  const originalRunId = (await campaign()).id;
  check('new survival is an active Earth campaign', await page.evaluate(() => window.__space.campaignActive
    && window.__space.game.mode === 'survival' && window.__space.campaignRun.campaign.activePlanet === 'earth'));
  check('gameplay includes a mission tracker', await page.locator('#mission-tracker').isVisible());
  await verifySprintInput();

  const first = await setFixture({ dirt: 11, health: 16, hunger: 14, oxygen: 100, block: 'stone' });
  await openMission();
  check('relay repair is unavailable without its materials', await page.locator('#mission-repair').isDisabled());
  await closeMission();
  const failedRepair = await page.evaluate(async () => {
    const before = JSON.stringify({ inventory: window.__space.game.inventory.serialize(), campaign: window.__space.campaignRun.campaign });
    let refused = false;
    try { await window.__space.repairMission(); }
    catch (error) { refused = /resources|materials|missing/i.test(error.message); }
    return refused && before === JSON.stringify({ inventory: window.__space.game.inventory.serialize(), campaign: window.__space.campaignRun.campaign });
  });
  check('direct unfunded repair preserves inventory and progress', failedRepair);
  const lockedTravel = await page.evaluate(async () => {
    const before = JSON.stringify({ inventory: window.__space.game.inventory.serialize(), campaign: window.__space.campaignRun.campaign });
    let refused = false;
    try { await window.__space.travelCampaign('jupiter'); }
    catch (error) { refused = /relay|locked/i.test(error.message); }
    return refused && window.__space.game.planet.id === 'earth'
      && before === JSON.stringify({ inventory: window.__space.game.inventory.serialize(), campaign: window.__space.campaignRun.campaign });
  });
  check('direct travel cannot bypass a locked campaign destination', lockedTravel);
  await openCheckpoints();
  const checkpointA = await saveCheckpoint('Home before the signal');
  await page.locator('#checkpoint-close').click();
  check('first named checkpoint captures exact Earth inventory and progress',
    checkpointA.snapshot.kind === 'campaign'
    && checkpointA.snapshot.campaign.repaired.length === 0
    && JSON.stringify(checkpointA.snapshot.worlds.earth.inventory) === JSON.stringify(first.snapshot.inventory));

  await addRepairMaterials();
  const failedSave = await page.evaluate(async () => {
    const key = 'spacemc:save:campaign-current';
    const before = JSON.stringify({ run: window.__space.campaignRun, inventory: window.__space.game.inventory.serialize() });
    const durableBefore = localStorage.getItem(key);
    const original = Storage.prototype.setItem;
    let refused = false;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException('Campaign save test: storage quota exhausted', 'QuotaExceededError');
      return original.call(this, name, value);
    };
    try { await window.__space.repairMission(); }
    catch (error) { refused = error.name === 'QuotaExceededError'; }
    finally { Storage.prototype.setItem = original; }
    return refused && before === JSON.stringify({ run: window.__space.campaignRun, inventory: window.__space.game.inventory.serialize() })
      && localStorage.getItem(key) === durableBefore;
  });
  check('failed durable repair save rolls back both materials and unlocks', failedSave);
  await openMission();
  await screenshotPair('mission', '#mission-dialog');
  await page.locator('#mission-repair').click();
  await page.waitForFunction(() => window.__space.campaignRun.campaign.repaired.includes('earth'));
  await travelThroughUi('luna');
  check('travel carries inventory without issuing another landing kit', await dirtCount() === 11
    && await page.evaluate(() => window.__space.game.inventory.slots.filter(Boolean).length === 1));
  const carried = await page.evaluate(() => ({
    armour: window.__space.game.armourInv.serialize(), survival: window.__space.game.survival.serialize(),
  }));
  check('travel preserves equipped armour and survival condition',
    JSON.stringify(carried.armour) === JSON.stringify(first.snapshot.armour)
    && Math.abs(carried.survival.health - 16) < 0.2 && Math.abs(carried.survival.hunger - 14) < 0.2
    && Math.abs(carried.survival.oxygen - 100) < 1);

  const second = await setFixture({ dirt: 23, health: 12, hunger: 10, oxygen: 66 });
  await openCheckpoints();
  const checkpointB = await saveCheckpoint('Lunar foothold');
  check('two named positions coexist with distinct snapshots', checkpointA.id !== checkpointB.id
    && (await checkpointEntries()).length === 2 && checkpointB.snapshot.campaign.activePlanet === 'luna'
    && checkpointB.snapshot.campaign.repaired.join(',') === 'earth'
    && JSON.stringify(checkpointB.snapshot.worlds.luna.inventory) === JSON.stringify(second.snapshot.inventory));
  await rowFor(checkpointA.id).locator('input').fill('Home · preserved');
  await rowFor(checkpointA.id).getByRole('button', { name: 'Rename', exact: true }).click();
  await page.waitForFunction((id) => JSON.parse(localStorage.getItem(`spacemc:save:${id}`)).name === 'Home · preserved', checkpointA.id);
  const renamed = (await checkpointEntries()).find((entry) => entry.id === checkpointA.id);
  check('renaming changes only the selected checkpoint label', renamed.name === 'Home · preserved'
    && JSON.stringify(renamed.snapshot) === JSON.stringify(checkpointA.snapshot)
    && (await checkpointEntries()).find((entry) => entry.id === checkpointB.id).name === 'Lunar foothold');
  await screenshotPair('checkpoints', '#checkpoint-dialog');

  await rowFor(checkpointA.id).getByRole('button', { name: 'Load', exact: true }).click();
  await page.locator('#expedition-confirm-dialog').waitFor({ state: 'visible' });
  await page.locator('#expedition-confirm-cancel').click();
  check('cancelled checkpoint load retains the current lunar position',
    (await campaign()).activePlanet === 'luna' && await dirtCount() === 23
    && await markerValue(second.marker) === second.marker.blockId);
  await rowFor(checkpointA.id).getByRole('button', { name: 'Load', exact: true }).click();
  await page.locator('#expedition-confirm-accept').click();
  await ready('earth');
  check('checkpoint load rolls back inventory, world edits and campaign progression together',
    await dirtCount() === 11 && await markerValue(first.marker) === first.marker.blockId
    && (await campaign()).repaired.length === 0 && (await campaign()).visited.join(',') === 'earth'
    && (await campaign()).id === originalRunId);
  const restoredPlayer = await page.evaluate(() => ({
    pos: { ...window.__space.game.player.pos }, armour: window.__space.game.armourInv.serialize(),
    survival: window.__space.game.survival.serialize(),
  }));
  check('checkpoint load also restores position, armour and health',
    ['x', 'y', 'z'].every((axis) => Math.abs(restoredPlayer.pos[axis] - first.snapshot.player.pos[axis]) < 0.1)
    && JSON.stringify(restoredPlayer.armour) === JSON.stringify(first.snapshot.armour)
    && Math.abs(restoredPlayer.survival.health - first.snapshot.survival.health) < 0.1
    && Math.abs(restoredPlayer.survival.hunger - first.snapshot.survival.hunger) < 0.1);
  const restored = await persisted();
  check('checkpoint rollback replaces the current campaign snapshot',
    restored.campaign.repaired.length === 0 && Object.keys(restored.worlds).join(',') === 'earth');
  await openCheckpoints();
  await rowFor(checkpointB.id).getByRole('button', { name: 'Delete', exact: true }).click();
  await page.locator('#expedition-confirm-accept').click();
  await rowFor(checkpointB.id).waitFor({ state: 'detached' });
  const remaining = await checkpointEntries();
  check('deleting one checkpoint preserves the other and current campaign', remaining.length === 1
    && remaining[0].id === checkpointA.id && (await campaign()).id === originalRunId);
  await page.locator('#checkpoint-close').click();

  const markers = { earth: first.marker };
  for (let index = 0; index < ROUTE.length; index++) {
    const planetId = ROUTE[index];
    check(`${planetId}: arrival follows the expected route`, (await campaign()).activePlanet === planetId);
    if (index > 0) {
      const fixture = await setFixture({ dirt: 11, health: 16, hunger: 14, oxygen: 100 });
      markers[planetId] = fixture.marker;
    }
    await repairThroughUi(index + 1);
    check(`${planetId}: materials are actually consumed`, await dirtCount() === 11
      && await page.evaluate(() => window.__space.game.inventory.slots.filter(Boolean).length === 1));
    if (index === ROUTE.length - 1) break;
    await travelThroughUi(ROUTE[index + 1]);

    if (index === 0) {
      await page.evaluate(async () => {
        const { itemIdOf } = await import('./js/items.js');
        window.__space.game.inventory.addItem(itemIdOf('dirt'), 20);
      });
      await travelDirect('earth');
      check('returning to Earth restores its edits and uses the current inventory',
        await dirtCount() === 31 && await markerValue(first.marker) === first.marker.blockId);
      await page.evaluate(async () => {
        const { itemIdOf } = await import('./js/items.js');
        window.__space.game.inventory.removeItems(itemIdOf('dirt'), 9);
      });
      await travelDirect('luna');
      check('revisiting a saved world cannot duplicate its stale inventory', await dirtCount() === 22);
    }
  }
  check('only restoration of all eight relays completes the story', (await campaign()).completed
    && (await campaign()).repaired.join(',') === ROUTE.join(','));
  await page.locator('.campaign-ending').waitFor({ state: 'visible' });
  check('the final chapter displays a concrete ending', (await page.locator('.campaign-ending').innerText()).includes('Dawn'));
  await screenshotPair('ending', '#mission-dialog');
  await page.evaluate(async () => window.__space.saveNow(true));
  const allWorlds = await persisted();
  check('the durable campaign contains all eight survival worlds',
    Object.keys(allWorlds.worlds).sort().join(',') === [...ROUTE].sort().join(',')
    && Object.values(allWorlds.worlds).every((world) => world.mode === 'survival'));
  const editsIntact = await page.evaluate(async ({ allMarkers }) => {
    const { EditLog } = await import('./js/editlog.js');
    const run = JSON.parse(localStorage.getItem('spacemc:save:campaign-current'));
    return Object.entries(allMarkers).every(([planetId, marker]) => {
      const log = new EditLog();
      log.load(run.worlds[planetId].edits);
      return log.get(marker.x, marker.y, marker.z) === marker.blockId;
    });
  }, { allMarkers: markers });
  check('every visited world retains its independently edited terrain', editsIntact);

  await toOrbit();
  check('menu offers Continue for a saved campaign', await page.locator('#btn-continue').isVisible());
  await page.reload();
  await page.waitForFunction(() => window.__space?.state.selected);
  await page.locator('#btn-continue').click();
  await ready('jupiter');
  check('reload and Continue preserve the completed campaign identity and inventory',
    (await campaign()).completed && (await campaign()).id === originalRunId && await dirtCount() === 11);
  await openMission();
  check('the ending remains available after restart', await page.locator('.campaign-ending').isVisible());
  await toOrbit();
  await page.evaluate(() => window.__space.selectPlanet('earth'));
  await page.locator('#btn-land').click();
  check('starting another survival campaign requires explicit replacement confirmation', await page.locator('#new-world-dialog').isVisible());
  await page.locator('#btn-cancel-new').click();
  check('cancelling a new campaign retains the completed run and named checkpoint',
    (await persisted()).campaign.id === originalRunId && (await checkpointEntries()).length === 1);

  const savedCampaign = await page.evaluate((key) => localStorage.getItem(key), SAVE_KEY);
  await page.locator('[data-mode="creative"]').click();
  check('creative keeps all destinations unlocked after a story run', await page.locator('button.card:disabled').count() === 0);
  await page.evaluate(() => window.__space.selectPlanet('mars'));
  await page.locator('#btn-land').click();
  await ready('mars');
  check('creative starts directly on the selected world outside campaign mode',
    await page.evaluate(() => window.__space.game.mode === 'creative' && !window.__space.campaignActive));
  await page.evaluate(async () => window.__space.saveNow(true));
  check('creative saving cannot overwrite the survival campaign',
    await page.evaluate((key) => localStorage.getItem(key), SAVE_KEY) === savedCampaign);
  check('no browser runtime or resource errors', errors.length === 0);
  console.log(`campaign browser: ${checks.length} checks passed`);
} catch (error) {
  failure = { message: error.message, stack: error.stack };
  await page.screenshot({ path: `${out}/failure.png` }).catch(() => {});
  throw error;
} finally {
  await writeFile(`${out}/report.json`, JSON.stringify({ url, checks, errors, failure }, null, 2));
  await browser.close();
}
