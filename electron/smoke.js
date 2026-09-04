// Dev-only: boot the app, land on a planet, capture the real desktop window to a
// PNG and quit. Used to verify the packaged shell without a human at the screen.
//   SPACEMC_SMOKE=/tmp/shot.png npm start
import { app } from 'electron';
import { writeFile } from 'node:fs/promises';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export function attach(win, outPath, planetId = process.env.SPACEMC_SMOKE_PLANET ?? 'mars') {
  win.webContents.once('did-finish-load', async () => {
    try {
      await delay(1200);
      const landing = planetId !== 'menu';
      const mode = process.env.SPACEMC_SMOKE_MODE === 'survival' ? 'survival' : 'creative';
      const screen = process.env.SPACEMC_SMOKE_SCREEN ?? '';
      await win.webContents.executeJavaScript(
        `(() => { const S = window.__space; if (!S) return 'no-shell';
           S.game.hooks.onPointerLost = () => {};
           S.state.mode = ${JSON.stringify(mode)};
           ${landing ? `S.selectPlanet(${JSON.stringify(planetId)}); document.getElementById('btn-land').click();` : ''}
           return 'ok'; })()`);
      await delay(landing ? 7000 : 1800);
      if (screen) {
        await win.webContents.executeJavaScript(
          `(() => { const g = window.__space.game;
             g.inventory.addItem(30, 12); g.inventory.addItem(32, 5); g.inventory.addItem(64, 3);
             g.inventory.addItem(70, 9); g.inventory.addItem(75, 6);
             ${screen === 'fabricator'
               ? `g.openStation('crafting', { x: Math.floor(g.player.pos.x), y: Math.floor(g.player.pos.y), z: Math.floor(g.player.pos.z) });`
               : 'g.openInventoryScreen();'}
             return 'screen'; })()`);
        await delay(900);
      }
      const state = await win.webContents.executeJavaScript(
        `JSON.stringify({screen: window.__space.state.screen, fps: window.__space.game.fps,
          chunks: window.__space.game.world?.chunks.size ?? 0, spawned: window.__space.game.spawned})`);
      console.log('[smoke]', state);
      const img = await win.webContents.capturePage();
      await writeFile(outPath, img.toPNG());
      console.log('[smoke] wrote', outPath);
    } catch (err) {
      console.error('[smoke] failed:', err);
      process.exitCode = 1;
    }
    app.quit();
  });
}
