// Two real Electron processes and real LAN sockets, using disposable profiles.
// This tests same-machine transport and campaign ownership, not Wi-Fi discovery.
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = resolve(root, 'output/campaign-lan-specific');
await mkdir(out, { recursive: true });
const checks = [], errors = [], instances = [];
let failure = null;
function check(name, condition) {
  assert.ok(condition, name);
  checks.push(name);
  console.log('PASS', name);
}
async function bounded(promise, milliseconds, label) {
  let timeout;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(label)), milliseconds);
    })]);
  } finally { clearTimeout(timeout); }
}

async function start(name) {
  const profile = await mkdtemp(join(tmpdir(), `lunacrust-campaign-lan-${name}-`));
  const instance = { name, profile, app: null, page: null, stderr: '' };
  instances.push(instance);
  const env = { ...process.env, LUNACRUST_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) if (/^SPACEMC_(PROBE|SMOKE)(_|$)/.test(key)) delete env[key];
  instance.app = await electron.launch({ cwd: root, args: [root], env, chromiumSandbox: true, timeout: 90000 });
  const child = instance.app.process();
  instance.closed = new Promise((done) => child.once('close', (code, signal) => done({ code, signal })));
  child.stdout?.resume();
  child.stderr?.on('data', (data) => { instance.stderr = (instance.stderr + data).slice(-10000); });
  instance.page = await instance.app.firstWindow();
  instance.page.on('pageerror', (error) => errors.push({ instance: name, type: 'pageerror', message: error.message }));
  instance.page.on('console', (message) => {
    if (message.type() === 'error') errors.push({ instance: name, type: 'console', message: message.text() });
  });
  instance.page.on('response', (response) => {
    if (response.status() >= 400) errors.push({ instance: name, type: 'resource', status: response.status(), url: response.url() });
  });
  await instance.page.waitForFunction(() => window.__space?.state.selected && document.querySelectorAll('.card').length === 8);
  check(`${name}: real application origin and LAN bridge`, instance.page.url() === 'app://space/index.html'
    && await instance.page.evaluate(() => !!window.spaceAPI?.net));
  check(`${name}: isolated save profile`, await instance.app.evaluate(({ app }) => app.getPath('userData')) === profile);
  await instance.page.evaluate((playerName) => {
    const { game, state } = window.__space;
    Object.assign(state.settings, { renderDistance: 3, renderScale: 1, playerName, volume: 0, musicVolume: 0 });
    game.applySettings(state.settings);
    game.hooks.onPointerLost = () => {};
  }, `Campaign ${name}`);
  return instance;
}

async function pause(instance) {
  await instance.page.evaluate(() => {
    document.exitPointerLock?.();
    window.__space.game.setPaused(true);
    window.__space.show('pause');
  });
}
async function ready(instance, planetId) {
  await instance.page.waitForFunction((id) => window.__space.game.running && window.__space.game.spawned
    && window.__space.game.planet.id === id && ['play', 'pause'].includes(window.__space.state.screen),
  planetId, { timeout: 75000 });
  await pause(instance);
}
async function startWorld(instance, planetId, mode, seed) {
  await instance.page.evaluate(async ({ id, mode, seed }) => {
    const S = window.__space;
    S.state.mode = mode;
    S.selectPlanet(id);
    document.getElementById('seed-input').value = String(seed);
    await S.land(false);
  }, { id: planetId, mode, seed });
  await ready(instance, planetId);
}
async function orbit(instance) {
  await pause(instance);
  await instance.page.locator('#btn-orbit').click();
  await instance.page.waitForFunction(() => window.__space.state.screen === 'menu' && !window.__space.game.running);
}
async function ownSaves(instance) {
  return instance.page.evaluate(async () => ({
    campaign: await window.spaceAPI.loadWorld('campaign-current'),
    earth: await window.spaceAPI.loadWorld('earth'),
    mars: await window.spaceAPI.loadWorld('mars'),
    luna: await window.spaceAPI.loadWorld('luna'),
  }));
}
async function joinGuest(host, guest, planetId) {
  const hosted = await host.page.evaluate(async () => window.__space.hostLan());
  check(`${planetId}: host opened real LAN listener`, hosted?.ok && Number.isInteger(hosted.port));
  await guest.page.evaluate(async (port) => {
    await window.__space.joinLan({ address: '127.0.0.1', port });
  }, hosted.port);
  await ready(guest, planetId);
  await host.page.waitForFunction(() => window.__space.game.net?.role === 'host' && window.__space.game.net.players.size === 1);
  check(`${planetId}: guest joined the host through LAN`, await guest.page.evaluate(() =>
    window.__space.game.net?.role === 'client' && window.__space.game.net.selfId != null
    && window.__space.game.guestWorld && !window.__space.campaignActive));
  return hosted;
}

try {
  const starts = await Promise.allSettled([start('host'), start('guest')]);
  for (const result of starts) if (result.status === 'rejected') throw result.reason;
  const [host, guest] = starts.map((result) => result.value);

  // Give the guest valid, independently generated saves before any LAN join.
  await startWorld(guest, 'earth', 'survival', 24680);
  await orbit(guest);
  await startWorld(guest, 'mars', 'creative', 13579);
  await orbit(guest);
  const guestBefore = await ownSaves(guest);
  check('guest owns a separate valid campaign and creative world',
    guestBefore.campaign?.campaign.activePlanet === 'earth' && guestBefore.mars?.mode === 'creative');

  await startWorld(host, 'earth', 'survival', 90210);
  const marker = await host.page.evaluate(async () => {
    const S = window.__space, game = S.game;
    const { stageFor } = await import('./js/campaign.js');
    const { ingredientItems, itemIdOf } = await import('./js/items.js');
    const { BY_KEY } = await import('./js/blocks.js');
    game.inventory.clear();
    game.inventory.addItem(itemIdOf('dirt'), 17);
    for (const { spec, count } of stageFor('earth').cost) game.inventory.addItem(ingredientItems(spec)[0], count);
    game.sky.time = 0.25;
    const marker = { x: Math.floor(game.player.pos.x) + 3, y: Math.floor(game.player.pos.y) + 2,
      z: Math.floor(game.player.pos.z), blockId: BY_KEY.get('brick').id };
    if (!game.editWorld(marker.x, marker.y, marker.z, marker.blockId)) throw new Error('Host marker could not be placed');
    await S.saveNow(true);
    return marker;
  });
  const hostRunId = await host.page.evaluate(() => window.__space.campaignRun.campaign.id);
  await joinGuest(host, guest, 'earth');
  await guest.page.waitForFunction(({ x, y, z, blockId }) => window.__space.game.world.getBlock(x, y, z) === blockId, marker);
  check('guest receives host terrain edits in the real welcome snapshot', true);
  check('guest cannot open checkpoint replacement while controlling the host world',
    await guest.page.locator('#btn-pause-checkpoints').isDisabled()
    && await guest.page.evaluate(() => typeof window.__space.restoreCheckpoint === 'undefined'));

  await host.page.locator('#btn-mission').click();
  check('host can repair a funded campaign relay while a guest is connected', await host.page.locator('#mission-repair').isEnabled());
  await host.page.locator('#mission-repair').click();
  await host.page.waitForFunction(() => window.__space.campaignRun.campaign.repaired.includes('earth'));
  const repaired = await host.page.evaluate(async () => ({
    saved: await window.spaceAPI.loadWorld('campaign-current'),
    net: window.__space.game.net?.role, peers: window.__space.game.net?.players.size,
    inventory: window.__space.game.inventory.serialize(),
  }));
  check('host relay repair commits progress and exact resource consumption',
    repaired.saved.campaign.repaired.join(',') === 'earth'
    && repaired.saved.campaign.id === hostRunId && repaired.inventory.filter(Boolean).length === 1
    && repaired.inventory.find(Boolean)[1] === 17);
  check('relay repair leaves the guest connected', repaired.net === 'host' && repaired.peers === 1
    && await guest.page.evaluate(() => window.__space.game.net?.role === 'client' && window.__space.game.running));

  const checkpoint = await host.page.evaluate(async () => {
    const { saveCheckpoint, loadCheckpoint } = await import('./js/checkpoints.js');
    const S = window.__space;
    await S.saveNow(true);
    const saved = await saveCheckpoint('Earth relay · crew connected', S.campaignRun);
    return loadCheckpoint(saved.id);
  });
  check('host named checkpoint persists the repaired Earth campaign through desktop IPC',
    checkpoint.snapshot.campaign.id === hostRunId && checkpoint.snapshot.campaign.repaired.join(',') === 'earth'
    && checkpoint.snapshot.worlds.earth.inventory.filter(Boolean).length === 1);

  await host.page.locator('#mission-travel').click();
  await host.page.locator('#expedition-confirm-dialog').waitFor({ state: 'visible' });
  check('travel explicitly asks to close the connected LAN session',
    (await host.page.locator('#expedition-confirm-dialog').innerText()).includes('Close this LAN session?')
    && await host.page.evaluate(() => window.__space.game.planet.id === 'earth' && window.__space.game.net?.players.size === 1));
  await host.page.locator('#expedition-confirm-cancel').click();
  check('cancelled travel retains both players on Earth',
    await host.page.evaluate(() => window.__space.game.planet.id === 'earth' && window.__space.game.net?.players.size === 1)
    && await guest.page.evaluate(() => window.__space.game.net?.role === 'client'));
  await host.page.locator('#mission-travel').click();
  await host.page.locator('#expedition-confirm-accept').click();
  await ready(host, 'luna');
  await guest.page.waitForFunction(() => window.__space.state.screen === 'menu' && !window.__space.game.running, null, { timeout: 30000 });
  check('confirmed campaign travel disconnects the guest cleanly to orbit',
    await guest.page.evaluate(() => !window.__space.game.net)
    && await host.page.evaluate(() => !window.__space.game.net));
  const afterTravel = await host.page.evaluate(async () => {
    const { EditLog } = await import('./js/editlog.js');
    const { itemIdOf } = await import('./js/items.js');
    const saved = await window.spaceAPI.loadWorld('campaign-current');
    const log = new EditLog();
    log.load(saved.worlds.earth.edits);
    return { saved, dirt: window.__space.game.inventory.count(itemIdOf('dirt')), edits: log.serialize() };
  });
  check('Luna keeps host inventory, progression and the saved Earth world',
    afterTravel.dirt === 17 && afterTravel.saved.campaign.id === hostRunId
    && afterTravel.saved.campaign.activePlanet === 'luna'
    && afterTravel.saved.campaign.visited.join(',') === 'earth,luna'
    && afterTravel.saved.campaign.repaired.join(',') === 'earth'
    && JSON.stringify(afterTravel.edits) === JSON.stringify(checkpoint.snapshot.worlds.earth.edits));
  check('guest departure preserves all own campaign and planet saves',
    JSON.stringify(await ownSaves(guest)) === JSON.stringify(guestBefore));

  await joinGuest(host, guest, 'luna');
  check('guest can rejoin the same campaign on the newly unlocked Moon',
    await guest.page.evaluate(() => window.__space.game.planet.id === 'luna' && window.__space.game.mode === 'survival'));
  check('guest checkpoint controls remain unavailable after rejoining',
    await guest.page.locator('#btn-pause-checkpoints').isDisabled());
  await guest.page.evaluate(async () => window.__space.saveNow(true));
  check('guest saving after lunar rejoin writes only guest character data',
    JSON.stringify(await ownSaves(guest)) === JSON.stringify(guestBefore)
    && await guest.page.evaluate(async () => (await window.spaceAPI.listWorlds()).filter((id) => id.startsWith('guest-')).length === 2));
  check('the host checkpoint remains a separate Earth snapshot after lunar travel',
    await host.page.evaluate(async (id) => {
      const { loadCheckpoint } = await import('./js/checkpoints.js');
      const entry = await loadCheckpoint(id);
      return entry.snapshot.campaign.activePlanet === 'earth' && entry.snapshot.campaign.visited.join(',') === 'earth';
    }, checkpoint.id));
  await host.page.screenshot({ path: join(out, 'host-luna.png') });
  await guest.page.screenshot({ path: join(out, 'guest-luna.png') });
  check('both Electron renderers completed without JavaScript or resource errors', errors.length === 0);
} catch (error) {
  failure = { message: error.message, stack: error.stack };
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
  for (const instance of instances) {
    if (instance.page) await instance.page.screenshot({ path: join(out, `${instance.name}-failure.png`) }).catch(() => {});
  }
} finally {
  // Close guests first so their final character writes finish before the host.
  for (const instance of [...instances].reverse()) {
    if (instance.app) {
      const child = instance.app.process();
      try {
        await bounded(instance.app.close(), 20000, `${instance.name}: graceful close timed out`);
        const result = await bounded(instance.closed, 10000, `${instance.name}: process exit timed out`);
        if (result.code !== 0) throw new Error(`${instance.name}: exit code ${result.code}, signal ${result.signal}`);
      } catch (error) {
        errors.push({ instance: instance.name, type: 'shutdown', message: error.message });
        process.exitCode = 1;
        if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
        await bounded(instance.closed, 10000, 'Forced shutdown timed out').catch(() => {});
      }
    }
    await rm(instance.profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch((error) => {
      errors.push({ instance: instance.name, type: 'cleanup', message: error.message });
      process.exitCode = 1;
    });
  }
  await writeFile(join(out, 'report.json'), JSON.stringify({ checks, errors, failure,
    diagnostics: failure ? instances.map(({ name, stderr }) => ({ name, stderr })) : [] }, null, 2));
}
if (!process.exitCode) console.log(`campaign LAN: ${checks.length} checks passed; both processes exited and disposable profiles removed`);
