// Adversarial browser integration: real game/UI with delayed desktop-style I/O.
// The isolated profile keeps all writes in localStorage; no user saves/settings
// or actual desktop data are read or changed by the fixture backend.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const url = process.env.LUNACRUST_TEST_URL || 'http://127.0.0.1:5178';
const out = 'output/playwright/transactions';
const campaignKey = 'spacemc:save:campaign-current';
const checks = [], errors = [];
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
let failure = null;
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); console.log('PASS', name); };

async function setupPage(corruptCampaign = false) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ corruptCampaign }) => {
    const key = id => `spacemc:save:${id}`;
    const probe = window.__transactions = { writes: [], reads: [], closeResults: [], writeGate: null, loadGate: null };
    if (corruptCampaign) localStorage.setItem(key('campaign-current'), '{');
    localStorage.setItem(key('mars'), JSON.stringify({ legacy: 'preserve-original-planet' }));
    localStorage.setItem(key('guest-transaction-probe'), JSON.stringify({ guest: 'preserve-visited-character' }));
    const delay = async gate => {
      gate.entered = true;
      await new Promise(resolve => { gate.release = resolve; });
      if (gate.fail) throw new Error('Injected durable write failure');
    };
    window.spaceAPI = {
      isDesktop: true,
      async saveWorld(id, payload) {
        const body = JSON.stringify(payload);
        probe.writes.push(id);
        if (id === 'campaign-current' && probe.writeGate) await delay(probe.writeGate);
        localStorage.setItem(key(id), body);
        return true;
      },
      async loadWorld(id) {
        probe.reads.push(id);
        if (probe.loadGate?.id === id) await delay(probe.loadGate);
        try { return JSON.parse(localStorage.getItem(key(id))); } catch { return null; }
      },
      async listWorlds() { return Object.keys(localStorage).filter(name => name.startsWith('spacemc:save:')).map(name => name.slice('spacemc:save:'.length)); },
      async deleteWorld(id) { localStorage.removeItem(key(id)); return true; },
      onBeforeClose(callback) { probe.beforeClose = callback; },
      confirmClose(result) { probe.closeResults.push(result); },
    };
  }, { corruptCampaign });
  await page.goto(url);
  await page.waitForFunction(() => window.__space?.state.selected && window.__space.state.screen === 'menu');
  await page.evaluate(() => {
    Object.assign(window.__space.state.settings, { renderDistance: 3, volume: 0, musicVolume: 0 });
    window.__space.selectPlanet('earth');
  });
  return page;
}

async function pause(page) {
  await page.evaluate(() => {
    document.exitPointerLock?.();
    window.__space.game.setPaused(true);
    window.__space.show('pause');
  });
}

async function ready(page) {
  await page.waitForFunction(() => window.__space.game.running && window.__space.game.spawned
    && window.__space.game.planet.id === 'earth' && ['play', 'pause'].includes(window.__space.state.screen), null, { timeout: 60000 });
  await pause(page);
}

async function openCheckpoints(page) {
  await pause(page);
  await page.locator('#btn-pause-checkpoints').click();
  await page.locator('#checkpoint-dialog').waitFor({ state: 'visible' });
}

async function loadThroughUi(page, id) {
  await page.locator(`[data-checkpoint-id="${id}"]`).getByRole('button', { name: 'Load', exact: true }).click();
  await page.locator('#expedition-confirm-accept').click();
}

try {
  const page = await setupPage();
  await page.locator('#seed-input').fill('314159');
  await page.locator('#btn-land').click();
  await ready(page);
  await page.evaluate(async () => {
    const { game } = window.__space;
    const { stageFor } = await import('./js/campaign.js');
    const { ingredientItems, itemIdOf } = await import('./js/items.js');
    game.inventory.clear();
    game.inventory.addItem(itemIdOf('dirt'), 9);
    for (const { spec, count } of stageFor('earth').cost) game.inventory.addItem(ingredientItems(spec)[0], count);
    Object.assign(game.survival, { health: 17, hunger: 15, oxygen: 100, saturation: 0, exertion: 0, regen: 0, alive: true });
    game.pushHotbar();
    await window.__space.saveNow(true);
    const enter = game.enter;
    window.__transactions.enterCalls = 0;
    game.enter = function (...args) { window.__transactions.enterCalls++; return enter.apply(this, args); };
  });
  await openCheckpoints(page);
  await page.locator('#checkpoint-name').fill('Before transaction');
  await page.locator('#checkpoint-save').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-checkpoint-id]').length === 1);
  const checkpointId = await page.locator('[data-checkpoint-id]').getAttribute('data-checkpoint-id');

  const before = await page.evaluate((key) => ({
    inventory: JSON.stringify(window.__space.game.inventory.serialize()),
    run: JSON.stringify(window.__space.campaignRun), durable: localStorage.getItem(key),
  }), campaignKey);
  await page.evaluate(() => {
    const probe = window.__transactions;
    probe.writeGate = { fail: true, entered: false };
    probe.repairPromise = window.__space.repairMission().then(() => ({ ok: true }), error => ({ ok: false, error: error.message }));
  });
  await page.waitForFunction(() => window.__transactions.writeGate.entered);
  check('repair owns the persistence lock while its durable write is pending', await page.evaluate(() => window.__space.game.persistenceBusy));
  check('repair cannot publish progression before durability succeeds', await page.evaluate(() => window.__space.campaignRun.campaign.repaired.length === 0));
  check('repair stages resource consumption during the pending write', await page.evaluate((inventory) => JSON.stringify(window.__space.game.inventory.serialize()) !== inventory, before.inventory));

  const freeze = await page.evaluate(async () => {
    const { game } = window.__space;
    const { itemIdOf } = await import('./js/items.js');
    const originalSurvival = game.survival.serialize();
    const drop = game.drops.spawn(game.player.pos.x, game.player.pos.y + .9, game.player.pos.z, itemIdOf('dirt'), 3);
    Object.assign(drop, { age: 1, vx: 0, vy: 0, vz: 0 });
    const snapshot = () => JSON.stringify({ inventory: game.inventory.serialize(), drops: game.drops.serialize(),
      player: game.player.serialize(), survival: game.survival.serialize(), sky: game.sky.time, dead: game.dead });
    const healthy = snapshot();
    game.step(1 / 60);
    const pickupFrozen = healthy === snapshot();
    Object.assign(game.survival, { health: .01, hunger: 0, saturation: 0, alive: true });
    const lethal = snapshot();
    game.step(1);
    const deathFrozen = lethal === snapshot() && !game.dead;
    game.survival.restore(originalSurvival);
    const oldPause = game.paused;
    game.paused = false; game.clearInput();
    game._onKeyDown(new KeyboardEvent('keydown', { code: 'KeyW' }));
    const inputFrozen = !game.keys.has('KeyW');
    game.paused = oldPause;
    window.__transactions.drop = drop;
    return { pickupFrozen, deathFrozen, inputFrozen };
  });
  check('real Game.step cannot pick up items or advance the owner during repair persistence', freeze.pickupFrozen);
  check('real Game.step cannot kill the owner during repair persistence', freeze.deathFrozen);
  check('owner movement input is ignored during repair persistence', freeze.inputFrozen);

  const collisions = await page.evaluate(async () => {
    const probe = window.__transactions;
    const writes = probe.writes.length;
    const results = await Promise.allSettled([
      window.__space.travelCampaign('earth'), window.__space.repairMission(), window.__space.saveNow(true),
    ]);
    await probe.beforeClose();
    return { refused: results.every(result => result.status === 'rejected'),
      closeRefused: probe.closeResults.at(-1) === false, noWrites: probe.writes.length === writes,
      noEnter: probe.enterCalls === 0 };
  });
  check('competing travel, repair and save reject before changing a pending repair', collisions.refused && collisions.noWrites && collisions.noEnter);
  check('desktop close refuses to discard a pending repair', collisions.closeRefused);
  await loadThroughUi(page, checkpointId);
  await page.waitForFunction(() => document.querySelector('#checkpoint-dialog [role="status"]').textContent.includes('current operation'));
  check('checkpoint restore refuses to replace a pending repair', await page.evaluate(() => window.__transactions.enterCalls === 0 && window.__space.game.persistenceBusy));

  const rollback = await page.evaluate(async (key) => {
    window.__transactions.writeGate.release();
    const result = await window.__transactions.repairPromise;
    window.__transactions.writeGate = null;
    return { result, inventory: JSON.stringify(window.__space.game.inventory.serialize()),
      run: JSON.stringify(window.__space.campaignRun), durable: localStorage.getItem(key), busy: window.__space.game.persistenceBusy };
  }, campaignKey);
  check('failed repair exposes the injected storage error', !rollback.result.ok && rollback.result.error.includes('Injected durable write failure'));
  check('failed repair restores the exact inventory and complete campaign envelope', rollback.inventory === before.inventory && rollback.run === before.run);
  check('failed repair leaves the durable campaign unchanged and releases the lock', rollback.durable === before.durable && !rollback.busy);
  const pickupControl = await page.evaluate(async () => {
    const { game } = window.__space;
    const { itemIdOf } = await import('./js/items.js');
    const count = game.inventory.count(itemIdOf('dirt'));
    game.step(1 / 60);
    return game.inventory.count(itemIdOf('dirt')) > count;
  });
  check('pickup fixture executes through real Game.step after the persistence lock releases', pickupControl);

  await page.locator('#checkpoint-close').click();
  await openCheckpoints(page);
  await page.evaluate(id => { window.__transactions.loadGate = { id, entered: false }; }, checkpointId);
  await loadThroughUi(page, checkpointId);
  await page.waitForFunction(() => window.__transactions.loadGate.entered);
  const restoreLock = await page.evaluate(async id => {
    const probe = window.__transactions;
    const readCount = probe.reads.filter(value => value === id).length;
    const before = JSON.stringify({ campaign: window.__space.campaignRun, inventory: window.__space.game.inventory.serialize() });
    const writes = probe.writes.length;
    const results = await Promise.allSettled([
      window.__space.travelCampaign('earth'), window.__space.repairMission(), window.__space.saveNow(true),
    ]);
    await probe.beforeClose();
    const load = [...document.querySelector(`[data-checkpoint-id="${id}"]`).querySelectorAll('button')].find(button => button.textContent === 'Load');
    const disabled = load.disabled;
    load.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    return { refused: results.every(result => result.status === 'rejected'), disabled,
      closeRefused: probe.closeResults.at(-1) === false, noEnter: probe.enterCalls === 0,
      noWrites: probe.writes.length === writes, noSecondRead: probe.reads.filter(value => value === id).length === readCount,
      unchanged: before === JSON.stringify({ campaign: window.__space.campaignRun, inventory: window.__space.game.inventory.serialize() }) };
  }, checkpointId);
  check('restore reserves the transition before awaiting the checkpoint read', restoreLock.refused && restoreLock.noWrites && restoreLock.unchanged);
  check('pending checkpoint read cannot enter a world or start a second load', restoreLock.disabled && restoreLock.noEnter && restoreLock.noSecondRead);
  check('desktop close refuses while checkpoint restore is waiting for storage', restoreLock.closeRefused);
  await page.evaluate(() => { const gate = window.__transactions.loadGate; window.__transactions.loadGate = null; gate.release(); });
  await page.waitForFunction(() => !document.querySelector('#checkpoint-dialog').open && window.__transactions.enterCalls === 1, null, { timeout: 60000 });
  await ready(page);
  check('a released checkpoint read performs exactly one world replacement', await page.evaluate(() => window.__transactions.enterCalls === 1 && !window.__space.game.persistenceBusy));

  await openCheckpoints(page);
  await page.evaluate(() => {
    const { game } = window.__space;
    game.dead = true; game.survival.alive = false;
    game.hooks.onDeath('Transaction regression');
  });
  check('death fixture creates the real death overlay while the checkpoint library is open', await page.evaluate(() => !window.__space.screens.deathRoot.classList.contains('hidden') && document.querySelector('#checkpoint-dialog').open));
  await loadThroughUi(page, checkpointId);
  await page.waitForFunction(() => !document.querySelector('#checkpoint-dialog').open && window.__transactions.enterCalls === 2, null, { timeout: 60000 });
  await ready(page);
  check('checkpoint restore clears the death overlay and revives the saved character', await page.evaluate(() => window.__space.screens.deathRoot.classList.contains('hidden') && !window.__space.game.dead && window.__space.game.survival.alive));
  await page.evaluate(() => {
    const { game } = window.__space;
    const original = game.reviveSurvival;
    window.__transactions.revives = 0;
    game.reviveSurvival = function (...args) { window.__transactions.revives++; return original.apply(this, args); };
  });
  await page.keyboard.press('Escape');
  check('Escape after checkpoint restore cannot invoke the previous death respawn action', await page.evaluate(() => window.__transactions.revives === 0 && window.__space.screens._respawn === null));
  await pause(page);
  check('transaction scenarios preserve original planet and guest saves', await page.evaluate(() =>
    JSON.parse(localStorage.getItem('spacemc:save:mars')).legacy === 'preserve-original-planet'
    && JSON.parse(localStorage.getItem('spacemc:save:guest-transaction-probe')).guest === 'preserve-visited-character'));
  await page.close();

  const corrupt = await setupPage(true);
  check('unreadable campaign boot detects an existing file despite a null backend read', await corrupt.evaluate(() => window.__space.campaignRun === null && localStorage.getItem('spacemc:save:campaign-current') === '{'));
  await corrupt.locator('#btn-land').click();
  await corrupt.locator('#new-world-dialog').waitFor({ state: 'visible' });
  check('new landing requires confirmation before replacing an unreadable campaign', await corrupt.evaluate(() => !window.__space.game.running
    && localStorage.getItem('spacemc:save:campaign-current') === '{' && window.__transactions.writes.length === 0));
  await corrupt.locator('#btn-cancel-new').click();
  check('canceling replacement retains the unreadable campaign file', await corrupt.evaluate(() => localStorage.getItem('spacemc:save:campaign-current') === '{' && !window.__space.game.running));
  await corrupt.locator('#btn-land').click();
  await corrupt.locator('#btn-confirm-new').click();
  await ready(corrupt);
  check('explicit replacement confirmation creates a durable new campaign', await corrupt.evaluate(() => JSON.parse(localStorage.getItem('spacemc:save:campaign-current')).kind === 'campaign' && window.__space.campaignActive));
  await corrupt.close();
  check('transaction integration emits no uncaught browser errors', errors.length === 0);
} catch (error) {
  failure = error;
  console.error(error);
} finally {
  await writeFile(`${out}/report.json`, JSON.stringify({ ok: !failure, checks, errors, failure: failure?.stack ?? null }, null, 2));
  await browser.close();
}
if (failure) process.exitCode = 1;
else console.log(`All ${checks.length} transaction checks passed.`);
