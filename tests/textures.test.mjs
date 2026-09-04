// textures.js: the atlas after the crack-tile growth (62 tiles / 4 rows ->
// 72 tiles / 5 rows).
//
// The real risk here is not the crack art itself, it's that growing ROWS
// reflows the v coordinate of every tile that already existed - stone, dirt,
// grass, all of it. tests/drops.test.mjs already guards that indirectly (it
// compares dropped-cube UVs against real mesher output), so this file guards
// it directly: every rect stays inside the atlas and the growth actually
// happened rather than being silently absorbed.

import assert from 'node:assert/strict';
import {
  TEXTURE_NAMES, TILE_INDEX, ROWS, COLS, TILE, UPSCALE,
  buildAtlas, tilePixels, tileUV,
} from '../app/js/textures.js';
import { CRACK_STAGES, crackTileName } from '../app/js/crack.js';

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

// -------------------------------------------------------------- atlas growth
check('the atlas grew from 62 to 72 tiles and from 4 to 5 rows', () => {
  assert.equal(TEXTURE_NAMES.length, 72);
  assert.equal(ROWS, 5);
  assert.equal(COLS, 16);
});

check('the ten crack tiles were appended, not interleaved', () => {
  assert.equal(TEXTURE_NAMES.length - 10, 62);
  for (let s = 0; s < CRACK_STAGES; s++) {
    assert.equal(TEXTURE_NAMES[62 + s], crackTileName(s));
  }
  // and nothing that existed before shifted position
  assert.equal(TEXTURE_NAMES[0], 'stone');
  assert.equal(TEXTURE_NAMES[61], 'brick');
});

check('every crack stage is indexed and resolvable through TILE_INDEX', () => {
  for (let s = 0; s < CRACK_STAGES; s++) {
    assert.ok(TILE_INDEX.has(crackTileName(s)), `crack_${s} missing from TILE_INDEX`);
    assert.equal(TILE_INDEX.get(crackTileName(s)), 62 + s);
  }
});

check('the row growth actually shifted an existing tile\'s v origin', () => {
  // brick sits at index 61, row 3. Under the old ROWS=4 that would have been
  // v0=0.75; under the new ROWS=5 it must be 0.6. If a future edit silently
  // reverted ROWS to be hardcoded instead of derived, this catches it here
  // rather than only as a subtle atlas-wide texture shift in the running game.
  const rect = tileUV(TILE_INDEX.get('brick'));
  assert.equal(rect[1], 0.6 + .5 / (ROWS * TILE * UPSCALE));
  assert.notEqual(rect[1], 0.75);
  assert.equal(rect[3], 1 / 5 - 1 / (ROWS * TILE * UPSCALE));
});

// ------------------------------------------------------------------ tileUV
check('every tile rect stays inside [0,1] and lines up on the grid', () => {
  const seen = new Set();
  for (let i = 0; i < TEXTURE_NAMES.length; i++) {
    const [u0, v0, uw, vh] = tileUV(i);
    assert.ok(u0 >= 0 && u0 < 1, `u0 in range: ${u0}`);
    assert.ok(v0 >= 0 && v0 < 1, `v0 in range: ${v0}`);
    assert.ok(u0 + uw <= 1 + 1e-9, `u0+uw in range: ${u0 + uw}`);
    assert.ok(v0 + vh <= 1 + 1e-9, `v0+vh in range: ${v0 + vh}`);
    assert.equal(uw, 1 / COLS - 1 / (COLS * TILE * UPSCALE));
    assert.equal(vh, 1 / ROWS - 1 / (ROWS * TILE * UPSCALE));
    const key = Math.round(u0 * COLS) + ',' + Math.round(v0 * ROWS);
    assert.ok(!seen.has(key), `two tiles share the same cell: ${key}`);
    seen.add(key);
  }
  assert.equal(seen.size, TEXTURE_NAMES.length);
});

// -------------------------------------------------------------- buildAtlas
check('buildAtlas produces a 1024x320 RGBA buffer', () => {
  const atlas = buildAtlas();
  assert.equal(atlas.width, COLS * TILE * UPSCALE);
  assert.equal(atlas.height, ROWS * TILE * UPSCALE);
  assert.equal(atlas.width, 1024);
  assert.equal(atlas.height, 320);
  assert.equal(atlas.data.length, atlas.width * atlas.height * 4);
});

// ---------------------------------------------------------- rendered crack stages
// tilePixels() runs the real paintTile() path (RECIPES + the 'crack_stage'
// case), so this checks the rendered tiles end-to-end rather than just the
// raw field crack.test.mjs already covers.
const opaqueCount = (name) => {
  const px = tilePixels(name);
  let n = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i] > 0) n++;
  return n;
};

check('crack tile opaque-pixel count strictly increases stage to stage', () => {
  let prev = -1;
  for (let s = 0; s < CRACK_STAGES; s++) {
    const n = opaqueCount(crackTileName(s));
    assert.ok(n > prev, `stage ${s}: ${n} must exceed stage ${s - 1}: ${prev}`);
    prev = n;
  }
});

check('stage 9 covers under 60% of the tile', () => {
  const n = opaqueCount(crackTileName(CRACK_STAGES - 1));
  assert.ok(n / (TILE * TILE) < 0.6, `coverage: ${(n / (TILE * TILE) * 100).toFixed(1)}%`);
});

check('crack_0 is a strict subset of crack_9 pixel-for-pixel (rendered, not just the field)', () => {
  const px0 = tilePixels(crackTileName(0));
  const px9 = tilePixels(crackTileName(CRACK_STAGES - 1));
  for (let i = 0; i < TILE * TILE; i++) {
    if (px0[i * 4 + 3] > 0) assert.ok(px9[i * 4 + 3] > 0, `pixel ${i} present at stage 0 but not stage 9`);
  }
});

console.log(`textures: ${pass} checks passed`);
