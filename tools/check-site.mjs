// Real-browser site and hosted-game smoke checks, always in fresh profiles.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
const url = process.env.LUNACRUST_SITE_URL || "http://127.0.0.1:5180/";
const out = process.env.LUNACRUST_SITE_REPORT || "output/site-check";
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  channel: process.env.PLAYWRIGHT_CHANNEL || "chrome",
  headless: true,
});
const errors = [],
  checks = [];
function check(name, value) {
  assert.ok(value, name);
  checks.push(name);
  console.log("PASS", name);
}
function monitor(page) {
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", (r) => {
    if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`);
  });
  page.on("requestfailed", (r) => {
    if (!r.failure()?.errorText.includes("ERR_ABORTED"))
      errors.push(`${r.failure()?.errorText} ${r.url()}`);
  });
}
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  monitor(page);
  await page.goto(url);
  await page.evaluate(() => document.fonts.ready);
  check(
    "title and primary message",
    (await page.title()) === "Lunacrust — Eight worlds. One last signal." &&
      (await page.locator("h1").innerText()).includes("One last signal."),
  );
  check(
    "trailer never autoplays on entry",
    await page.locator("video").evaluate((v) => v.paused && !v.autoplay),
  );
  check(
    "local font loaded",
    await page.evaluate(() => document.fonts.check('16px "Space Grotesk"')),
  );
  const names = [
    "Earth",
    "Moon",
    "Mars",
    "Venus",
    "Europa",
    "Io",
    "Titan",
    "Jupiter",
  ];
  for (let i = 0; i < names.length; i++) {
    await page.locator("[data-world]").nth(i).click();
    await page.waitForFunction(
      (name) => document.querySelector("#world-name").textContent === name,
      names[i],
    );
    check(
      `${names[i]} world selector`,
      (await page.locator('[data-world][aria-pressed="true"]').count()) === 1 &&
        (await page
          .locator("#world-image")
          .evaluate((i) => i.complete && i.naturalWidth === 1920)),
    );
  }
  await page.locator("[data-world]").last().press("Home");
  await page.waitForFunction(
    () => document.querySelector("#world-name").textContent === "Earth",
  );
  check(
    "keyboard navigation selects and focuses Earth",
    await page
      .locator('[data-world="earth"]')
      .evaluate(
        (b) =>
          b === document.activeElement &&
          b.getAttribute("aria-pressed") === "true",
      ),
  );
  const panel = page.locator(".faq-list details").nth(2);
  await panel.locator("summary").click();
  check("FAQ opens accessibly", await panel.evaluate((d) => d.open));
  check(
    "candidate and desktop-only LAN boundaries visible",
    await page
      .locator("body")
      .innerText()
      .then(
        (t) =>
          t.includes("public desktop downloads are not available yet") &&
          t.includes("The browser demo is single-player."),
      ),
  );
  const sources = await page
    .locator('script[src],link[rel="stylesheet"],img[src],source[src]')
    .evaluateAll((nodes) => nodes.map((n) => n.src || n.href));
  check(
    "no external resource origins",
    sources.every((s) => new URL(s).origin === new URL(url).origin),
  );
  const refs = await page
    .locator("a[href]")
    .evaluateAll((nodes) =>
      nodes
        .map((n) => n.getAttribute("href"))
        .filter((h) => h && !h.startsWith("http") && !h.startsWith("#")),
    );
  for (const ref of new Set(refs)) {
    const response = await page.request.get(new URL(ref, url).href);
    check(`local link ${ref}`, response.ok());
  }
  for (const width of [1440, 960, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(url);
    await page.evaluate(() => document.fonts.ready);
    check(
      `no horizontal overflow at ${width}px`,
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    check(
      `play button visible at ${width}px`,
      await page.locator(".nav-play").isVisible(),
    );
    await page.screenshot({ path: `${out}/hero-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator("#trailer").scrollIntoViewIfNeeded();
  await page.locator("video").evaluate((v) => v.load());
  await page.waitForFunction(
    () => document.querySelector("video").readyState >= 1,
  );
  check(
    "35-second Full HD trailer metadata",
    await page
      .locator("video")
      .evaluate(
        (v) =>
          Math.abs(v.duration - 35) < 0.1 &&
          v.videoWidth === 1920 &&
          v.videoHeight === 1080,
      ),
  );
  await page.locator("video").evaluate((v) => {
    v.muted = true;
    return v.play();
  });
  await page.waitForFunction(
    () => document.querySelector("video").currentTime > 0.25,
  );
  check(
    "video decodes and plays",
    await page.locator("video").evaluate((v) => !v.error && v.readyState >= 2),
  );
  await page.locator("video").evaluate((v) => {
    v.pause();
    v.currentTime = 26;
  });
  await page.waitForFunction(() => {
    const v = document.querySelector("video");
    return (
      !v.seeking && v.readyState >= 2 && Math.abs(v.currentTime - 26) < 0.1
    );
  });
  check("trailer seeks through byte ranges", true);
  await page.screenshot({ path: `${out}/trailer.png` });
  await context.close();
  const demo = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  monitor(demo);
  await demo.goto(new URL("demo/", url).href);
  await demo.waitForFunction(
    () => window.__space?.state.screen === "menu",
    null,
    { timeout: 60000 },
  );
  check(
    "real game demo boots below site path",
    await demo.evaluate(() => !!window.__space.game),
  );
  await demo.evaluate(async () => {
    const s = window.__space;
    s.state.mode = "creative";
    s.state.settings.renderDistance = 3;
    s.state.settings.volume = 0;
    document.querySelector("#seed-input").value = "site-smoke-test";
    s.selectPlanet("europa");
    await s.land(false);
    s.music.stop();
  });
  await demo.waitForFunction(() => window.__space.game.spawned, null, {
    timeout: 60000,
  });
  check(
    "actual Europa world and worker generation run",
    await demo.evaluate(() => {
      const g = window.__space.game;
      return (
        g.planet.id === "europa" &&
        g.world.chunks.size > 0 &&
        g.renderer.getContext() instanceof WebGL2RenderingContext
      );
    }),
  );
  await demo.locator("#game").screenshot({ path: `${out}/demo-europa.png` });
  await demo.close();
  check("zero browser and resource errors", errors.length === 0);
  await writeFile(
    `${out}/report.json`,
    JSON.stringify({ url, checks, errors, passed: true }, null, 2) + "\n",
  );
  console.log(`${checks.length} checks passed.`);
} catch (error) {
  await writeFile(
    `${out}/report.json`,
    JSON.stringify(
      { url, checks, errors, passed: false, failure: error.stack },
      null,
      2,
    ) + "\n",
  );
  throw error;
} finally {
  await browser.close();
}
