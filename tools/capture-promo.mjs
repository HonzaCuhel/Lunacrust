// Original gameplay capture. Fresh browser contexts never touch player saves.
import { chromium } from "playwright";
import { mkdir, writeFile, copyFile, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
const root = new URL("../", import.meta.url).pathname;
const assets = `${root}site/assets`;
const videoAssets = `${root}videos/lunacrust-promo/assets`;
await mkdir(assets, { recursive: true });
await mkdir(videoAssets, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const route = [
  "earth",
  "luna",
  "mars",
  "venus",
  "europa",
  "io",
  "titan",
  "jupiter",
];
const selected = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const clips = process.argv.includes("--clips");
const evidence = [];
try {
  for (const id of selected.length ? selected : route) {
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("http://127.0.0.1:5178");
    await page.waitForFunction(() => window.__space?.state.screen === "menu");
    await page.evaluate(async (id) => {
      const s = window.__space;
      s.state.mode = "creative";
      s.state.settings.renderDistance = 8;
      s.state.settings.volume = 0;
      s.state.settings.musicVolume = 0;
      document.querySelector("#seed-input").value = "lunacrust-first-signal";
      s.selectPlanet(id);
      await s.land(false);
      s.music.stop();
      s.audio.stopAmbience();
    }, id);
    await page.waitForFunction(
      () => window.__space.game.spawned,
      {},
      { timeout: 60000 },
    );
    await page.evaluate(() => {
      const s = window.__space,
        g = s.game;
      s.show("play");
      g.paused = false;
      g.hooks.onPointerLost = () => {};
      g.player.flying = true;
      g.player.pos.y += 8;
      const companion = g.planet.sky.companions?.[0];
      g.player.pitch = companion ? -0.025 : -0.15;
      g.player.yaw = companion ? companion.az + Math.PI - 0.28 : 0.55;
      g.sky.time = 0.35;
      g.player.vel?.set?.(0, 0, 0);
    });
    await page.waitForTimeout(5000);
    await page.addStyleTag({
      content:
        "body > :not(canvas):not(script):not(style) {visibility:hidden !important} canvas#game {visibility:visible !important}",
    });
    // Only capture the WebGL canvas, excluding the shell and HUD.
    const canvasId = await page.evaluate(
      () => window.__space.game.renderer.domElement.id,
    );
    await page.evaluate(() => {
      const g = window.__space.game;
      cancelAnimationFrame(g.raf);
      g.running = false;
      g.paused = false;
      g.keys.clear();
      g.player.flying = true;
      g.player.vel?.set?.(0, 0, 0);
      window.__promoOrigin = {
        ...g.player.pos,
        yaw: g.player.yaw,
        pitch: g.player.pitch,
      };
      g.renderer.render(g.scene, g.camera);
    });
    const target = page.locator(`#${canvasId}`);
    const name = id === "luna" ? "moon" : id;
    const file = `${assets}/world-${name}.jpg`;
    await target.screenshot({ path: file, type: "jpeg", quality: 90 });
    await copyFile(file, `${videoAssets}/world-${name}.jpg`);
    if (clips) {
      const out = `${videoAssets}/${name}.mp4`;
      const ff = spawn("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "image2pipe",
        "-vcodec",
        "mjpeg",
        "-framerate",
        "30",
        "-i",
        "pipe:0",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        out,
      ]);
      let ffErr = "";
      ff.stderr.on("data", (b) => (ffErr += b));
      const done = once(ff, "close");
      for (let frame = 0; frame < 210; frame++) {
        await page.evaluate(
          ({ frame }) => {
            const g = window.__space.game,
              o = window.__promoOrigin,
              t = frame / 30;
            g.player.pos.x = o.x + Math.sin(t * 0.12) * 5;
            g.player.pos.z = o.z - t * 0.6;
            g.player.pos.y = o.y + Math.sin(t * 0.2) * 0.5;
            g.player.yaw = o.yaw + t * 0.022;
            g.player.pitch = o.pitch + Math.sin(t * 0.22) * 0.025;
            g.updateCamera(1 / 30);
            g.sky.update(1 / 30, g.player.pos);
            g.renderer.render(g.scene, g.camera);
          },
          { frame },
        );
        const bytes = await target.screenshot({ type: "jpeg", quality: 92 });
        if (!ff.stdin.write(bytes)) await once(ff.stdin, "drain");
      }
      ff.stdin.end();
      const [code] = await done;
      if (code) throw Error(ffErr);
    }
    evidence.push({
      world: id,
      seed: "lunacrust-first-signal",
      image: `site/assets/world-${name}.jpg`,
      clip: clips ? `${name}.mp4` : null,
      errors,
    });
    console.log(
      `Captured ${id}: ${clips ? "210 frames + " : ""}1920x1080 still, ${errors.length} errors`,
    );
    await context.close();
  }
} finally {
  await browser.close();
}
let previous = [];
try {
  previous = JSON.parse(
    await readFile(`${videoAssets}/capture-evidence.json`, "utf8"),
  );
} catch {}
const combined = new Map(previous.map((row) => [row.world, row]));
for (const row of evidence)
  combined.set(row.world, {
    ...row,
    clip: row.clip ?? combined.get(row.world)?.clip ?? null,
  });
await writeFile(
  `${videoAssets}/capture-evidence.json`,
  JSON.stringify(route.map((id) => combined.get(id)).filter(Boolean), null, 2) +
    "\n",
);
