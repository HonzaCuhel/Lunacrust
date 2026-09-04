// crack.js: the block-break art data, with zero rendering involved.
//
// The property that actually matters is the anti-flicker one - stage n's
// painted pixels must be a strict superset of stage n-1's, so the overlay
// only ever grows as a block is mined instead of a crack popping in and out
// as stageFor() rounds progress differently frame to frame. Everything else
// here (bounds, determinism, alpha vocabulary) exists to pin the field down
// so a future edit to the walk can't quietly break that property again.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CRACK_STAGES, crackTileName, stageFor, crackField } from '../app/js/crack.js';

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

// ------------------------------------------------------------- crackTileName
check('crackTileName names every stage crack_0..crack_9', () => {
  for (let s = 0; s < CRACK_STAGES; s++) assert.equal(crackTileName(s), 'crack_' + s);
});

// ------------------------------------------------------------------ stageFor
check('stageFor(0) and negative progress draw nothing', () => {
  assert.equal(stageFor(0), -1);
  assert.equal(stageFor(-0.1), -1);
  assert.equal(stageFor(-5), -1);
});
check('stageFor is 0 for a sliver of progress', () => {
  assert.equal(stageFor(0.001), 0);
  assert.equal(stageFor(0.09), 0);
});
check('stageFor climbs through the middle stages', () => {
  assert.equal(stageFor(0.5), 5);
});
check('stageFor clamps at CRACK_STAGES - 1 for full and over-full progress', () => {
  assert.equal(stageFor(0.99), CRACK_STAGES - 1);
  assert.equal(stageFor(1), CRACK_STAGES - 1);
  assert.equal(stageFor(1.5), CRACK_STAGES - 1);
});

// ------------------------------------------------------------------- shape
const field = crackField();

check('crackField is non-empty and lazily cached (same content on refetch)', () => {
  assert.ok(field.length > 0);
  const again = crackField();
  assert.equal(again, field, 'the same array instance - built once, not rebuilt per call');
});

check('every pixel sits inside the 16x16 tile', () => {
  for (const f of field) {
    assert.ok(Number.isInteger(f.x) && f.x >= 0 && f.x < 16, `x in range: ${f.x}`);
    assert.ok(Number.isInteger(f.y) && f.y >= 0 && f.y < 16, `y in range: ${f.y}`);
  }
});

check('every pixel is tagged with a stage inside 0..CRACK_STAGES-1', () => {
  for (const f of field) {
    assert.ok(Number.isInteger(f.stage) && f.stage >= 0 && f.stage < CRACK_STAGES, `stage: ${f.stage}`);
  }
});

check('alpha only ever takes the three named values - core, halo, chip', () => {
  const seen = new Set(field.map((f) => f.a));
  for (const a of seen) assert.ok([70, 150, 210].includes(a), `unexpected alpha ${a}`);
});

check('no two entries share a pixel (crackField is already deduplicated)', () => {
  const keys = new Set(field.map((f) => f.x + ',' + f.y));
  assert.equal(keys.size, field.length);
});

check('no clock or Math.random leaks into the field - only the fixed seed does', () => {
  // The real cross-machine-determinism guarantee is architectural (the module
  // has zero imports and one fixed string seed), so assert that structurally:
  // a source-level regression back to Math.random()/Date.now() would flip
  // this rather than only show up as an occasional flaky pixel somewhere.
  const src = readFileSync(fileURLToPath(new URL('../app/js/crack.js', import.meta.url)), 'utf8');
  assert.ok(!/Math\.random|Date\.now|performance\.now/.test(src), 'crack.js must stay seeded, not randomised');
  assert.ok(src.includes("strSeed('destroy')"), "the field's seed string is the fixed 'destroy'");
});

// -------------------------------------------------------- the anti-flicker invariant
check("each stage's pixel set is a strict superset of the previous stage's", () => {
  const setAt = (n) => new Set(field.filter((f) => f.stage <= n).map((f) => f.x + ',' + f.y));
  let prev = setAt(0);
  assert.ok(prev.size > 0, 'stage 0 already draws something');
  for (let n = 1; n < CRACK_STAGES; n++) {
    const cur = setAt(n);
    for (const key of prev) assert.ok(cur.has(key), `stage ${n} lost a pixel stage ${n - 1} had: ${key}`);
    assert.ok(cur.size > prev.size, `stage ${n} (${cur.size}) must add at least one pixel over stage ${n - 1} (${prev.size})`);
    prev = cur;
  }
});

check('stage 9 covers less than 60% of the tile - shattered, not solid', () => {
  const count = field.filter((f) => f.stage <= CRACK_STAGES - 1).length;
  assert.ok(count / 256 < 0.6, `stage 9 coverage: ${(count / 256 * 100).toFixed(1)}%`);
});

console.log(`crack: ${pass} checks passed`);
