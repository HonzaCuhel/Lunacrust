// Survival regression, driven inside the real Electron window: land in survival
// mode, then exercise every system the mode adds - drops, tools, crafting,
// smelting, oxygen, hunger, fall damage and death.
import { app } from 'electron';

const SCRIPT = `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const S = window.__space, g = S.game;
  const items = await import('./js/items.js');
  const results = [];
  const runtimeState = () => JSON.stringify({screen:S.state.screen,paused:g.paused,spawned:g.spawned,ground:g.player?.onGround,fps:g.fps,frames:g._frames,pos:g.player?.pos,focused:document.hasFocus(),visible:document.visibilityState});
  const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: String(detail) });
  // The native window may lose focus while another release probe runs. A wall
  // clock sleep can then contain only one rendered tick (dt is capped at .05).
  // Observe the production loop rather than injecting updates or accepting a
  // shorter gameplay interval. A stopped/paused loop still fails the deadline.
  let simulatedSeconds = 0;
  const originalStep = g.step;
  g.step = function(dt) {
    const ready = this.spawned;
    const out = originalStep.call(this, dt);
    if (ready && !this.paused) simulatedSeconds += dt;
    return out;
  };
  const waitUntil = async (predicate, label, timeout = 20000) => {
    const deadline = performance.now() + timeout;
    while (!predicate()) {
      if (performance.now() >= deadline) throw new Error(label + ' timed out: ' + runtimeState());
      await sleep(25);
    }
  };
  const waitSim = async (seconds, label) => {
    const until = simulatedSeconds + seconds;
    await waitUntil(() => simulatedSeconds >= until, label);
  };


  // --------------------------------------------------------------- landing
  // Neutralise this BEFORE landing: requestPointerLock() cannot succeed without a
  // real user gesture, and the resulting pointerlockchange pauses the game
  // mid-load, which then looks like "nothing can be mined".
  g.hooks.onPointerLost = () => {};
  S.state.mode = 'survival';
  S.show('menu'); S.selectPlanet('mars');
  // Fixed seed: a probe that lands somewhere different every run reports
  // terrain luck as regressions.
  document.getElementById('seed-input').value = '20240';
  document.getElementById('btn-land').click();
  await waitUntil(() => S.state.screen === 'play' && g.spawned && g.player.onGround, 'grounded survival landing');

  check('mode is survival', g.mode === 'survival', g.mode);
  check('spawned on ground', g.spawned && g.player.onGround, runtimeState());
  const kit = items.LANDING_KIT.every(k => g.inventory.count(items.itemIdOf(k.key)) >= k.count);
  check('landing kit present', kit, JSON.stringify(g.inventory.serialize().filter(Boolean).slice(0, 6)));
  check('full health/hunger', g.survival.health === 20 && g.survival.hunger === 20,
        g.survival.health + '/' + g.survival.hunger);
  check('vitals visible', !document.getElementById('vitals').classList.contains('hidden'));

  // ------------------------------------------------------- mining and drops
  // stand on a known block and mine the one in front, drill in hand
  g.selectSlot(0);
  const drillId = items.itemIdOf('hand_drill');
  check('drill in hand', g.heldItem() === drillId, g.heldItem());
  const durBefore = g.inventory.held().dur;

  const px = Math.floor(g.player.pos.x), py = Math.floor(g.player.pos.y), pz = Math.floor(g.player.pos.z);
  const rockId = items.itemIdOf('mars_rock');
  // Build a clean shooting lane: one target block two steps ahead, nothing
  // between it and the crosshair.
  for (let d = 1; d <= 3; d++) {
    for (let h = 0; h <= 2; h++) g.world.setBlock(px + d, py + h, pz, 0);
  }
  g.world.setBlock(px + 2, py, pz, rockId);
  g.player.yaw = -Math.PI / 2;            // face +x
  g.player.pitch = -0.35;
  await waitUntil(() => g.target?.x === px + 2 && g.target?.y === py && g.target?.z === pz, 'targeting the mining fixture');
  const dropsBefore = g.drops.count;
  const invBefore = g.inventory.count(rockId);
  g.mouse.left = true;
  try { await waitUntil(() => g.world.getBlock(px + 2, py, pz) === 0, 'mining the rock with a drill'); }
  finally { g.mouse.left = false; }
  check('block was mined', g.world.getBlock(px + 2, py, pz) === 0,
        'block=' + g.world.getBlock(px + 2, py, pz) +
        ' target=' + (g.target ? [g.target.x - px, g.target.y - py, g.target.z - pz].join('/') + ':' + g.target.id : 'none') +
        ' pos=' + [g.player.pos.x - px, g.player.pos.y - py, g.player.pos.z - pz].map(n => n.toFixed(2)).join('/') +
        ' runtime=' + runtimeState() + ' held=' + g.heldItem() + ' mining=' + (g.mining ? g.mining.t.toFixed(2) : 'null'));
  const dropped = g.drops.count > dropsBefore || g.inventory.count(rockId) > invBefore;
  check('mining dropped an item', dropped, 'entities ' + g.drops.count);
  // Step onto the drop rather than walking to it: whether the terrain between
  // here and there is walkable is the movement probe's problem, not this one's.
  const ent = g.drops.list[0];
  if (ent) g.player.setPosition({ x: ent.x, y: ent.y - 0.4, z: ent.z });
  await waitUntil(() => g.inventory.count(rockId) > invBefore, 'collecting the mined resource');
  check('drop collected into inventory', g.inventory.count(rockId) > invBefore,
        'have ' + g.inventory.count(rockId) + ' entities left ' + g.drops.count);
  check('tool lost durability', g.inventory.count(drillId) === 0 || g.inventory.held()?.dur < durBefore ||
        g.inventory.serialize().some(s => s && s[0] === drillId && s[2] < durBefore), 'was ' + durBefore);

  // ------------------------------------------------------------- crafting
  // hand-feed the 2x2 grid: 1 metal -> 4 rods
  g.inventory.addItem(items.itemIdOf('iron_ingot'), 4);
  // Open it the way a player does, and watch for the pointer-lock release: with
  // the pointer still locked there is no cursor, so the inventory is unclickable.
  let unlocked = 0;
  const realExit = document.exitPointerLock?.bind(document);
  document.exitPointerLock = () => { unlocked++; realExit?.(); };
  document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', bubbles: true }));
  await sleep(300);
  check('E opens the inventory screen', S.screensOpen(), S.screensOpen());
  check('opening a screen frees the mouse', unlocked > 0, 'exitPointerLock calls: ' + unlocked);
  document.exitPointerLock = realExit;
  g.craftGrid.set(0, { item: items.itemIdOf('iron_ingot'), count: 1 });
  g.recomputeCraft();
  const res = g.craftResult.get(0);
  check('2x2 craft produced rods', !!res && res.item === items.itemIdOf('stick'),
        res ? items.ITEMS[res.item].key + ' x' + res.count : 'null');
  const rodsBefore = g.inventory.count(items.itemIdOf('stick'));
  if (res) { g.inventory.addStack({ ...res }); g.onCraftTaken(); }
  check('craft consumed the grid', g.craftGrid.get(0) === null);
  check('rods in inventory', g.inventory.count(items.itemIdOf('stick')) > rodsBefore);

  // recipe book quick-craft: stone pickaxe from rock + rods
  g.inventory.addItem(rockId, 8);
  const recipes = await import('./js/recipes.js');
  const pick = recipes.RECIPES.find(r => items.ITEMS[r.out.item].key === 'stone_pickaxe');
  g.closeScreen();
  await sleep(120);
  // needs the 3x3 fabricator: place one and open it
  const fabId = items.itemIdOf('fabricator');
  g.inventory.addItem(fabId, 1);
  g.world.setBlock(px + 1, py, pz, fabId);
  g.openStation('crafting', { x: px + 1, y: py, z: pz });
  await sleep(250);
  check('fabricator screen opened', S.screensOpen() && g.openScreenKind === 'fabricator', g.openScreenKind);
  const okFill = g.quickCraft(pick);
  g.recomputeCraft();
  const pickRes = g.craftResult.get(0);
  check('quick-craft filled a 3x3 recipe', okFill && !!pickRes &&
        items.ITEMS[pickRes.item].key === 'stone_pickaxe',
        pickRes ? items.ITEMS[pickRes.item].key : 'null');
  check('crafted tool carries durability', !!pickRes && pickRes.dur > 0, pickRes && pickRes.dur);
  if (pickRes) { g.inventory.addStack({ ...pickRes }); g.onCraftTaken(); }
  g.closeScreen();
  await sleep(150);

  // ------------------------------------------------------------- smelting
  const furnaceId = items.itemIdOf('furnace');
  g.world.setBlock(px - 1, py, pz, furnaceId);
  g.openStation('furnace', { x: px - 1, y: py, z: pz });
  await sleep(200);
  check('furnace screen opened', g.openScreenKind === 'furnace');
  const f = g.furnace;
  f.input = { item: items.itemIdOf('raw_iron'), count: 3 };
  f.fuel = { item: items.itemIdOf('coal'), count: 2 };
  let simulated = 0;
  for (let i = 0; i < 40 && !(f.output && f.output.count >= 1); i++) {
    g.stations.update(0.5); simulated += 0.5;
    await sleep(16);
  }
  check('furnace smelted an ingot', !!f.output && items.ITEMS[f.output.item].key === 'iron_ingot',
        f.output ? items.ITEMS[f.output.item].key + ' after ' + simulated + 's' : 'nothing');
  check('furnace burned fuel', f.fuel === null || f.fuel.count < 2, f.fuel && f.fuel.count);
  check('lit furnace swapped the block',
        [items.itemIdOf('furnace'), items.itemIdOf('furnace_lit')].includes(g.world.getBlock(px - 1, py, pz)),
        g.world.getBlock(px - 1, py, pz));
  g.closeScreen();
  await sleep(150);

  // -------------------------------------------------------------- oxygen
  const o2Start = g.survival.oxygen;
  await waitSim(1.6, 'oxygen drain simulation');
  check('oxygen drains off Earth', g.survival.oxygen < o2Start,
        o2Start.toFixed(3) + ' -> ' + g.survival.oxygen.toFixed(3) + ' runtime=' + runtimeState());
  g.survival.oxygen = 20;
  g.selectSlot(3);
  const canIdx = g.inventory.serialize().findIndex(s => s && s[0] === items.itemIdOf('oxygen_canister'));
  const canStack = g.inventory.get(canIdx);
  g.inventory.set(canIdx, null);
  g.inventory.set(3, canStack);
  const before = g.survival.oxygen;
  const used = g.useHeldItem();
  check('canister refills oxygen', used && g.survival.oxygen > before + 30,
        before.toFixed(0) + ' -> ' + g.survival.oxygen.toFixed(0));

  // life support
  const lsId = items.itemIdOf('life_support');
  const ls = { x: Math.floor(g.player.pos.x) + 2, y: Math.floor(g.player.pos.y), z: Math.floor(g.player.pos.z) };
  g.world.setBlock(ls.x, ls.y, ls.z, lsId);
  g.stations.addLifeSupport(ls.x, ls.y, ls.z);
  g.survival.oxygen = 30;
  await waitSim(.9, 'life support refill simulation');
  check('life support tops the suit up', g.survival.oxygen > 32, g.survival.oxygen.toFixed(0));

  // -------------------------------------------------------------- hunger
  g.survival.hunger = 6;
  g.survival.saturation = 0;
  const rationId = items.itemIdOf('ration');
  const rIdx = g.inventory.serialize().findIndex(s => s && s[0] === rationId);
  g.inventory.set(4, g.inventory.get(rIdx)); g.inventory.set(rIdx, null);
  g.selectSlot(4);
  const hungerBefore = g.survival.hunger;
  g.useHeldItem();
  check('eating raises hunger', g.survival.hunger > hungerBefore,
        hungerBefore + ' -> ' + g.survival.hunger);

  // ---------------------------------------------------------- fall damage
  // Fly up through verified-empty air, then cut the thrusters: teleporting blind
  // can drop you inside a canyon wall, where you land instantly and never fall.
  g.survival.health = 20;
  g.player.flying = true;
  // Find a nearby column with real headroom - standing under an overhang would
  // silently turn this into a one-block hop and prove nothing.
  const base = Math.floor(g.player.pos.y);
  let fx = Math.floor(g.player.pos.x), fz = Math.floor(g.player.pos.z), top = base, best = 0;
  for (let dx = -6; dx <= 6; dx += 3) {
    for (let dz = -6; dz <= 6; dz += 3) {
      const cx = Math.floor(g.player.pos.x) + dx, cz = Math.floor(g.player.pos.z) + dz;
      let ground = base;
      while (ground > 2 && g.world.getBlock(cx, ground - 1, cz) === 0) ground--;
      let head = ground;
      while (head < 120 && g.world.getBlock(cx, head + 1, cz) === 0 && head - ground < 46) head++;
      if (head - ground > best) { best = head - ground; fx = cx; fz = cz; top = head; }
    }
  }
  const climbed = best;
  g.player.setPosition({ x: fx + 0.5, y: top - 0.5, z: fz + 0.5 });
  await sleep(200);
  g.player.flying = false;
  await waitUntil(() => g.player.onGround, 'landing after the test fall');
  await sleep(250);
  check('a long fall hurts', climbed < 12 || g.survival.health < 20,
        'fell ' + climbed + ' blocks, impact ' + g.player.impactSpeed.toFixed(1) +
        ' m/s, health ' + g.survival.health);

  // ---------------------------------------------------------------- death
  g.survival.health = 20;
  g.applyEvents(g.survival.damage(40, 'test'));
  await sleep(400);
  check('lethal damage kills', g.dead && !g.survival.alive);
  const deathEl = document.getElementById('screen-death');
  check('death card shown', !!deathEl && !deathEl.classList.contains('hidden'),
        deathEl ? (deathEl.className + ' | ' + (deathEl.textContent || '').trim().slice(0, 40)) : 'no #screen-death');
  g.reviveSurvival();
  await sleep(300);
  check('respawn restores the player', !g.dead && g.survival.alive && g.survival.health === 20,
        g.survival.health);

  // ------------------------------------------------------------ save/load
  const snap = g.snapshot();
  check('save is v2 with survival state', snap.version === 2 && !!snap.survival && !!snap.inventory,
        'mode ' + snap.mode);

  // The real round trip a player takes: leave to orbit, then Continue.
  const markerId = items.itemIdOf('crystal_shard');
  g.inventory.addItem(markerId, 7);
  g.survival.hunger = 11;
  const fx2 = Math.floor(g.player.pos.x) + 3, fy2 = Math.floor(g.player.pos.y), fz2 = Math.floor(g.player.pos.z);
  g.world.setBlock(fx2, fy2, fz2, items.itemIdOf('furnace'));
  const keptFurnace = g.stations.furnaceAt(fx2, fy2, fz2, true);
  keptFurnace.input = { item: items.itemIdOf('raw_gold'), count: 5 };
  keptFurnace.fuel = { item: items.itemIdOf('coal'), count: 3 };
  const lsX = Math.floor(g.player.pos.x) + 4;
  g.world.setBlock(lsX, fy2, fz2, items.itemIdOf('life_support'));
  g.stations.addLifeSupport(lsX, fy2, fz2);
  const beforeCounts = {
    marker: g.inventory.count(markerId),
    hunger: g.survival.hunger,
    seed: g.seed,
    lifeSupports: g.stations.lifeSupports.size,
  };

  // Snapshot the smelter as it stands at the moment of saving: it is already lit,
  // so its fuel count is a moving target and hard-coding 3 would be wrong.
  const furnaceAtSave = JSON.parse(JSON.stringify({
    input: keptFurnace.input, fuel: keptFurnace.fuel, output: keptFurnace.output,
  }));
  document.getElementById('btn-orbit').click();
  // Returning to orbit writes the save first, and that round trip goes through
  // IPC to the main process - wait for the menu rather than for a stopwatch.
  for (let i = 0; i < 60 && S.state.screen !== 'menu'; i++) await sleep(150);
  check('returned to orbit', S.state.screen === 'menu', S.state.screen);

  S.selectPlanet('mars');
  await sleep(200);
  document.getElementById('btn-continue').click();
  await waitUntil(() => g.spawned && S.state.screen === 'play', 'reloading the survival world');

  check('reload keeps the seed and mode', g.seed === beforeCounts.seed && g.mode === 'survival',
        g.seed + '/' + g.mode);
  check('reload keeps the inventory', g.inventory.count(markerId) === beforeCounts.marker,
        g.inventory.count(markerId) + ' of ' + beforeCounts.marker);
  check('reload keeps hunger', Math.abs(g.survival.hunger - beforeCounts.hunger) <= 1.5,
        g.survival.hunger + ' vs ' + beforeCounts.hunger);
  const f2 = g.stations.furnaceAt(fx2, fy2, fz2);
  // A lit smelter keeps burning between this snapshot and the actual write, so
  // the fuel count is allowed to have dropped by one - the contents must survive.
  const sameItem = (a, b) => (!a && !b) || (!!a && !!b && a.item === b.item);
  check('reload keeps smelter contents',
        !!f2 && sameItem(f2.input, furnaceAtSave.input) && sameItem(f2.fuel, furnaceAtSave.fuel)
          && f2.input.count === furnaceAtSave.input.count
          && f2.fuel.count >= furnaceAtSave.fuel.count - 1,
        f2 ? JSON.stringify({ now: { i: f2.input, f: f2.fuel, o: f2.output }, saved: furnaceAtSave })
           : 'no furnace');
  check('reload keeps life support', g.stations.lifeSupports.size === beforeCounts.lifeSupports,
        g.stations.lifeSupports.size + ' vs ' + beforeCounts.lifeSupports);
  check('reload keeps placed blocks',
        g.world.getBlock(fx2, fy2, fz2) === items.itemIdOf('furnace') ||
        g.world.getBlock(fx2, fy2, fz2) === items.itemIdOf('furnace_lit'),
        g.world.getBlock(fx2, fy2, fz2));

  g.step = originalStep;
  return JSON.stringify(results);
})()`;

export function attach(win) {
  win.webContents.once('did-finish-load', async () => {
    let failed = 0;
    try {
      await new Promise((r) => setTimeout(r, 1200));
      const rows = JSON.parse(await win.webContents.executeJavaScript(SCRIPT));
      console.log('\nSURVIVAL PROBE');
      for (const r of rows) {
        if (!r.ok) failed++;
        console.log(` ${r.ok ? 'ok  ' : 'FAIL'}  ${r.name.padEnd(38)} ${r.detail}`);
      }
      console.log(failed ? `\n${failed} survival checks FAILED` : '\nSURVIVAL PROBE PASSED');
    } catch (err) {
      console.error('[probe-survival] error:', err);
      failed = 1;
    }
    process.exitCode = failed ? 1 : 0;
    app.quit();
  });
}
