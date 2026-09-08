// Exercise the real WebGL viewer in isolated Chromium profiles, including
// rendered pixels, pointer/keyboard/touch controls, lifecycle and fallback.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
const url = process.env.LUNACRUST_SITE_URL || "http://127.0.0.1:5180/";
const out = process.env.LUNACRUST_MODEL_REPORT || "output/model-check";
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  channel: process.env.PLAYWRIGHT_CHANNEL || "chrome",
  headless: true,
});
const checks = [],
  errors = [];
const check = (name, ok) => {
  assert.ok(ok, name);
  checks.push(name);
  console.log("PASS", name);
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const settle = (p) =>
  p.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
async function open(options = {}) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
    ...options,
  });
  await context.addInitScript(() => {
    window.__viewerDraws = 0;
    for (const name of ["drawElements", "drawElementsInstanced"]) {
      const original = WebGL2RenderingContext.prototype[name];
      WebGL2RenderingContext.prototype[name] = function (...args) {
        window.__viewerDraws++;
        return original.apply(this, args);
      };
    }
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(url);
  return { context, page };
}
async function ready(page) {
  await page.locator(".world-stage").scrollIntoViewIfNeeded();
  await page.waitForFunction(
    () =>
      document.querySelector(".world-stage").dataset.viewerState === "ready" &&
      window.__viewerDraws > 0,
  );
  await settle(page);
}
try {
  const { context, page } = await open();
  check(
    "3D code stays unloaded above the world section",
    !(await page.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .some((r) => r.name.includes("world-viewer.js")),
    )),
  );
  await ready(page);
  const stage = page.locator(".world-stage"),
    canvas = page.locator(".model-viewport canvas");
  check(
    "actual WebGL2 scene renders",
    await canvas.evaluate(
      (e) =>
        e
          .getContext("webgl2")
          .getParameter(e.getContext("webgl2").MAX_TEXTURE_SIZE) > 0,
    ),
  );
  check(
    "reduced-motion entry is static",
    (await page
      .locator('[data-camera="motion"]')
      .getAttribute("aria-pressed")) === "false",
  );
  const snapshots = new Set();
  for (const id of [
    "earth",
    "moon",
    "mars",
    "venus",
    "europa",
    "io",
    "titan",
    "jupiter",
  ]) {
    await page.locator(`[data-world="${id}"]`).click();
    await page.waitForFunction(
      (id) =>
        document.querySelector(".world-stage").dataset.modelWorld ===
        (id === "moon" ? "luna" : id),
      id,
    );
    await settle(page);
    const shot = await canvas.screenshot({ path: `${out}/${id}.png` });
    check(`${id} changes the rendered diorama`, !snapshots.has(digest(shot)));
    snapshots.add(digest(shot));
  }
  for (const [id, health] of [
    ["skitter", "16"],
    ["resonator", "40"],
  ]) {
    await page.locator(`[data-subject="${id}"]`).click();
    check(
      `${id} opens its own model and accurate health`,
      (await stage.getAttribute("data-model-subject")) === id &&
        (await page.locator(".model-species").innerText()).includes(health),
    );
    await canvas.screenshot({ path: `${out}/${id}.png` });
  }
  await page.locator('[data-world="europa"]').click();
  await page.locator('[data-subject="both"]').click();
  await page.waitForFunction(
    () =>
      document.querySelector(".world-stage").dataset.modelWorld === "europa",
  );
  await settle(page);
  const baseline = digest(await canvas.screenshot());
  await canvas.focus();
  await page.keyboard.press("ArrowRight");
  check(
    "keyboard arrows rotate actual rendered pixels",
    digest(await canvas.screenshot()) !== baseline,
  );
  await page.locator('[data-camera="reset"]').click();
  check(
    "reset restores the initial camera",
    digest(await canvas.screenshot()) === baseline,
  );
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6, {
    steps: 8,
  });
  await page.mouse.up();
  check(
    "pointer drag orbits the model",
    digest(await canvas.screenshot()) !== baseline,
  );
  await page.locator('[data-camera="reset"]').click();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  check(
    "zoom button enlarges the view",
    digest(await canvas.screenshot()) !== baseline,
  );
  await page.getByRole("button", { name: "Zoom out", exact: true }).click();
  check(
    "zoom out reverses zoom in",
    digest(await canvas.screenshot()) === baseline,
  );
  await page.locator('[data-camera="motion"]').click();
  const moving = await page.evaluate(() => window.__viewerDraws);
  await page.waitForFunction((n) => window.__viewerDraws > n + 30, moving);
  check(
    "explicit rotation animates the scene",
    (await page
      .locator('[data-camera="motion"]')
      .getAttribute("aria-pressed")) === "true",
  );
  await page.locator('[data-preview="photo"]').click();
  await settle(page);
  const photoDraws = await page.evaluate(() => window.__viewerDraws);
  await page.waitForTimeout(180);
  check(
    "photograph mode stops WebGL rendering",
    (await page.evaluate(() => window.__viewerDraws)) === photoDraws &&
      (await canvas.isHidden()),
  );
  await page.locator('[data-preview="model"]').click();
  await page.waitForFunction((n) => window.__viewerDraws > n + 10, photoDraws);
  check("returning to 3D resumes the scene", await canvas.isVisible());
  await page.locator("h1").scrollIntoViewIfNeeded();
  await page.waitForTimeout(180);
  const offscreenDraws = await page.evaluate(() => window.__viewerDraws);
  await page.waitForTimeout(180);
  check(
    "offscreen viewer stops GPU rendering",
    (await page.evaluate(() => window.__viewerDraws)) === offscreenDraws,
  );
  await stage.scrollIntoViewIfNeeded();
  await page.locator('[data-camera="reset"]').click();
  for (const width of [1440, 960, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await stage.scrollIntoViewIfNeeded();
    await settle(page);
    check(
      `3D controls fit at ${width}px`,
      await page.evaluate(() => {
        const s = document
          .querySelector(".world-stage")
          .getBoundingClientRect();
        return (
          [
            ...document.querySelectorAll(
              ".model-actions button,.model-subjects button,.world-view-switch button",
            ),
          ].every((e) => {
            const r = e.getBoundingClientRect();
            return (
              r.width >= 40 &&
              r.height >= 40 &&
              r.left >= s.left &&
              r.right <= s.right + 1 &&
              r.top >= s.top &&
              r.bottom <= s.bottom
            );
          }) && document.documentElement.scrollWidth <= innerWidth
        );
      }),
    );
    await stage.screenshot({ path: `${out}/viewer-${width}.png` });
    await page.locator('[data-preview="photo"]').click();
    check(
      `photograph copy and switch stay legible at ${width}px`,
      await page.evaluate(() => {
        const description = getComputedStyle(
          document.querySelector("#world-description"),
        );
        const a = document
          .querySelector(".world-view-switch")
          .getBoundingClientRect();
        const b = document
          .querySelector(".world-number")
          .getBoundingClientRect();
        const overlaps =
          a.left < b.right &&
          a.right > b.left &&
          a.top < b.bottom &&
          a.bottom > b.top;
        return !overlaps && description.lineHeight !== "normal";
      }),
    );
    await stage.screenshot({ path: `${out}/photo-${width}.png` });
    await page.locator('[data-preview="model"]').click();
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await settle(page);
  // A lost GPU must leave a useful photograph and recover without a reload.
  await canvas.evaluate((e) => {
    window.__lose = e.getContext("webgl2").getExtension("WEBGL_lose_context");
    window.__lose.loseContext();
  });
  await page.waitForFunction(
    () => document.querySelector(".world-stage").dataset.viewerState === "lost",
  );
  check(
    "GPU context loss reveals fallback and disables 3D",
    (await page.locator('[data-preview="model"]').isDisabled()) &&
      (await canvas.isHidden()),
  );
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__lose.restoreContext());
  await page.waitForFunction(
    () =>
      document.querySelector(".world-stage").dataset.viewerState === "ready",
  );
  await page.locator('[data-preview="model"]').click();
  const restored = await page.evaluate(() => window.__viewerDraws);
  await page.locator('[data-camera="zoom-in"]').click();
  check(
    "GPU context restoration renders again",
    (await page.evaluate(() => window.__viewerDraws)) > restored,
  );
  await context.close();

  const touch = await open({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  await ready(touch.page);
  const tc = touch.page.locator(".model-viewport canvas"),
    tb = await tc.boundingBox();
  const client = await touch.context.newCDPSession(touch.page);
  const beforeTouch = digest(await tc.screenshot());
  const point = (x, y, id = 0) => ({
    x,
    y,
    id,
    radiusX: 4,
    radiusY: 4,
    force: 1,
  });
  const cx = tb.x + tb.width / 2,
    cy = tb.y + tb.height / 2;
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [point(cx, cy)],
  });
  await client.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [point(cx + 60, cy + 10)],
  });
  await client.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  check(
    "single-finger touch rotates the model",
    digest(await tc.screenshot()) !== beforeTouch,
  );
  const beforePinch = digest(await tc.screenshot());
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [point(cx - 30, cy, 0), point(cx + 30, cy, 1)],
  });
  await client.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [point(cx - 65, cy, 0), point(cx + 65, cy, 1)],
  });
  await client.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  check(
    "two-finger pinch zooms the model",
    digest(await tc.screenshot()) !== beforePinch,
  );
  await touch.context.close();

  const fallback = await browser.newContext({ reducedMotion: "reduce" });
  await fallback.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      return type === "webgl2" ? null : original.call(this, type, ...args);
    };
  });
  const fp = await fallback.newPage();
  await fp.goto(url);
  await fp.locator(".world-stage").scrollIntoViewIfNeeded();
  await fp.waitForFunction(
    () =>
      document.querySelector(".world-stage").dataset.viewerState ===
      "unavailable",
  );
  await fp.locator('[data-world="mars"]').click();
  await fp.waitForFunction(
    () => document.querySelector("#world-name").textContent === "Mars",
  );
  check(
    "without WebGL the world photographs still work",
    (await fp.locator(".model-status").isVisible()) &&
      (await fp.locator(".world-view-switch").isHidden()) &&
      (await fp.locator("#world-image").isVisible()),
  );
  await fp.screenshot({ path: `${out}/webgl-fallback.png` });
  await fallback.close();
  const nojs = await browser.newContext({ javaScriptEnabled: false });
  const np = await nojs.newPage();
  await np.goto(url);
  check(
    "without JavaScript a photograph and playable-demo link remain",
    (await np.locator("#world-image").isVisible()) &&
      (await np.locator(".world-view-switch").isHidden()) &&
      (await np.locator('a[href="./demo/"]').count()) > 0,
  );
  await nojs.close();
  check("zero browser errors", errors.length === 0);
  await writeFile(
    `${out}/report.json`,
    JSON.stringify({ url, passed: true, checks, errors }, null, 2) + "\n",
  );
} finally {
  await browser.close();
}
