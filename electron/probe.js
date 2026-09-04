// Drives the running game through walk / jump / mine / place on every planet and
// prints a table. Attached only when SPACEMC_PROBE is set.
import { app } from 'electron';

const SCRIPT = `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const S = window.__space, g = S.game;
  g.hooks.onPointerLost = () => {};
  // This probe is about movement and block editing, so it pins creative mode -
  // survival's tool times and finite blocks are probe-survival's job.
  S.state.mode = 'creative';
  const ids = ['earth','luna','mars','venus','jupiter','europa','io','titan'];
  const rows = [];
  for (const id of ids) {
    S.show('menu'); S.selectPlanet(id);
    document.getElementById('btn-land').click();
    await sleep(2600);
    g.target = null;
    const spawnOk = g.spawned && !g.player.stuck(g.world);
    // let the player settle on the ground
    for (let i = 0; i < 40 && !g.player.onGround; i++) await sleep(50);
    const grounded = g.player.onGround;

    // Try a few headings: a wall (or a cliff edge on Jupiter) in one direction
    // says nothing about whether walking works.
    let moved = 0;
    for (const yaw of [0, 1.57, 3.14, 4.71]) {
      for (let i = 0; i < 40 && !g.player.onGround; i++) await sleep(50);
      g.player.yaw = yaw;
      const p0 = { ...g.player.pos };
      g.keys.add('KeyW'); await sleep(650); g.keys.delete('KeyW');
      moved = Math.max(moved, +Math.hypot(g.player.pos.x - p0.x, g.player.pos.z - p0.z).toFixed(2));
      if (moved > 1.5) break;
    }

    // settle again: walking off a ledge would swallow the jump
    for (let i = 0; i < 60 && !g.player.onGround; i++) await sleep(50);
    const y0 = g.player.pos.y;
    g.keys.add('Space'); await sleep(100); g.keys.delete('Space');
    await sleep(160);
    const jumped = +(g.player.pos.y - y0).toFixed(2);
    for (let i = 0; i < 80 && !g.player.onGround; i++) await sleep(50);

    // Aim at the ground a couple of blocks ahead - mining the block you stand on
    // drops you into the hole, and placing is then correctly refused. Sweep until
    // something solid is actually under the crosshair: liquids are not targets,
    // so facing Earth's ocean or Io's lava would otherwise look like a failure.
    // Sweep yaw as well as pitch: on Titan you can spawn on a dune edge looking
    // out over a methane lake, and liquids are not targets.
    const baseYaw = g.player.yaw;
    let found = false;
    for (const dy of [0, 1.57, 3.14, 4.71]) {
      for (const pitch of [-0.6, -0.9, -1.2, -0.35, -1.45]) {
        g.player.yaw = baseYaw + dy;
        g.player.pitch = pitch;
        await sleep(90);
        if (g.target) { found = true; break; }
      }
      if (found) break;
    }

    // Watch what the game actually writes, rather than guessing where the ray
    // will land after the first block disappears.
    const original = g.world.setBlock.bind(g.world);
    let lastBreak = null, lastPlace = null;
    g.world.setBlock = (x, y, z, id) => {
      const ok = original(x, y, z, id);
      if (ok) (id === 0 ? (lastBreak = [x, y, z]) : (lastPlace = [x, y, z, id]));
      return ok;
    };
    g.mouse.left = true; await sleep(1100); g.mouse.left = false;
    const mined = !!lastBreak && g.world.getBlock(lastBreak[0], lastBreak[1], lastBreak[2]) === 0;

    // Step back out of the hole first: a block you are standing in is correctly
    // refused, which would read as a placement failure.
    g.keys.add('KeyS'); await sleep(260); g.keys.delete('KeyS');
    await sleep(120);

    // Placement needs a face to build against; sweep the aim until one shows up.
    let placed = false;
    let why = 'no target';
    for (const pitch of [-0.6, -0.95, -1.3, -0.3, 0]) {
      g.player.pitch = pitch;
      await sleep(120);
      if (g.target) why = 'target ' + g.target.id + ' face ' + g.target.face.join(',');
      g.mouse.right = true; await sleep(300); g.mouse.right = false;
      placed = !!lastPlace && g.world.getBlock(lastPlace[0], lastPlace[1], lastPlace[2]) === lastPlace[3];
      if (placed) break;
    }
    g.world.setBlock = original;

    rows.push({ id, fps: g.fps, spawnOk, grounded, moved, jumped, mined, placed, why,
      held: g.heldItem(), tris: Math.round(g.world.stats.tris / 1000), chunks: g.world.chunks.size });
  }
  // --- edits must survive a chunk round trip -------------------------------
  // The single most destructive bug this probe has caught: a chunk that streams
  // out and back used to come back as raw terrain, erasing everything built.
  const persist = { id: 'persist', fps: g.fps, spawnOk: true, grounded: true,
    moved: 9, jumped: 9, mined: true, placed: true, tris: 0, chunks: 0, why: '', held: 0 };
  {
    const lamp = 47;
    const bx = Math.floor(g.player.pos.x) + 2, by = Math.floor(g.player.pos.y) + 3,
          bz = Math.floor(g.player.pos.z);
    g.world.setBlock(bx, by, bz, lamp);
    const home = { ...g.player.pos };
    g.player.flying = true;
    g.player.setPosition({ x: home.x + 320, y: home.y + 10, z: home.z + 320 });
    for (let i = 0; i < 60 && g.world.isLoaded(bx, bz); i++) { g.world.update(g.player.pos.x, g.player.pos.z); await sleep(100); }
    persist.mined = !g.world.isLoaded(bx, bz);                 // did it really unload?
    g.player.setPosition(home);
    for (let i = 0; i < 80 && !g.world.isLoaded(bx, bz); i++) { g.world.update(g.player.pos.x, g.player.pos.z); await sleep(100); }
    await sleep(400);
    persist.placed = g.world.getBlock(bx, by, bz) === lamp;
    persist.why = 'unloaded=' + persist.mined + ' block=' + g.world.getBlock(bx, by, bz);
    g.player.flying = false;
  }
  rows.push(persist);

  // --- auto step-up has to work on both horizontal axes ---------------------
  const stepUp = { id: 'step-up', fps: g.fps, spawnOk: true, grounded: true,
    moved: 9, jumped: 9, mined: true, placed: true, tris: 0, chunks: 0, why: '', held: 0 };
  {
    const results = [];
    for (const [axis, yaw, dx, dz] of [['+X', -Math.PI / 2, 2, 0], ['+Z', Math.PI, 0, 2]]) {
      const px = Math.floor(g.player.pos.x), py = Math.floor(g.player.pos.y), pz = Math.floor(g.player.pos.z);
      // A 3x3 platform one block up, not a 1-deep lip: step onto a lip and the
      // next stride walks straight off the far side, which reads as no climb.
      for (let a = -1; a <= 1; a++) {
        for (let b = 0; b <= 2; b++) {
          const sx = px + (dx ? dx + b : a), sz = pz + (dz ? dz + b : a);
          g.world.setBlock(sx, py, sz, 1);
          for (let h = 1; h < 4; h++) g.world.setBlock(sx, py + h, sz, 0);
        }
      }
      g.player.setPosition({ x: px + 0.5, y: py + 0.02, z: pz + 0.5 });
      g.player.yaw = yaw;
      for (let i = 0; i < 40 && !g.player.onGround; i++) await sleep(50);
      const y0 = g.player.pos.y;
      g.keys.add('KeyW'); await sleep(650); g.keys.delete('KeyW');
      await sleep(350);
      results.push(axis + '=' + (g.player.pos.y - y0).toFixed(2));
      if (g.player.pos.y - y0 < 0.7) stepUp.mined = false;
    }
    stepUp.why = 'climbed ' + results.join(' ');
    stepUp.placed = stepUp.mined;
  }
  rows.push(stepUp);

  // Creative's block palette rides on the same E key and the same document-level
  // listeners; open and close it the way a player does.
  const paletteRow = { id: 'palette', fps: g.fps, spawnOk: true, grounded: true,
    moved: 9, jumped: 9, mined: true, placed: true, tris: 0, chunks: 0, why: '', held: 0 };
  document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', bubbles: true }));
  await sleep(300);
  paletteRow.mined = S.state.screen === 'blocks';
  paletteRow.why = 'opened=' + S.state.screen;
  document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', bubbles: true }));
  await sleep(300);
  paletteRow.placed = S.state.screen === 'play';
  paletteRow.why += ' closed=' + S.state.screen;
  rows.push(paletteRow);

  return JSON.stringify(rows);
})()`;

export function attach(win) {
  win.webContents.once('did-finish-load', async () => {
    let failed = false;
    try {
      await new Promise((r) => setTimeout(r, 1200));
      const rows = JSON.parse(await win.webContents.executeJavaScript(SCRIPT));
      const pad = (v, n) => String(v).padEnd(n);
      console.log('\nplanet   fps  spawn ground  moved  jump  mine place   tris chunks');
      for (const r of rows) {
        const ok = r.spawnOk && r.grounded && r.moved > 1 && r.jumped > 0.2 && r.mined && r.placed;
        if (!ok) failed = true;
        console.log(
          pad(r.id, 8), pad(r.fps, 4), pad(r.spawnOk ? 'ok' : 'FAIL', 5),
          pad(r.grounded ? 'ok' : 'FAIL', 6), pad(r.moved, 6), pad(r.jumped, 5),
          pad(r.mined ? 'ok' : 'FAIL', 4), pad(r.placed ? 'ok' : 'FAIL', 5),
          pad(r.tris + 'k', 6), pad(r.chunks, 5), ok ? '' : '  <-- ' + (r.placed ? '' : 'place: ' + r.why + ' held ' + r.held));
      }
      console.log(failed ? '\nPROBE FAILED' : '\nPROBE PASSED - all eight worlds playable');
    } catch (err) {
      console.error('[probe] error:', err);
      failed = true;
    }
    process.exitCode = failed ? 1 : 0;
    app.quit();
  });
}
