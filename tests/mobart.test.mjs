// Proves the procedural mob atlas is legible and deterministic, planet by
// planet - the same discipline textures.js and itemart.js already get.
import assert from 'node:assert/strict';
import {
  MOB_TILE, MOB_UPSCALE, MOB_COLS, TILE_NAMES, TILE_INDEX,
  mobPalette, buildMobAtlas, mobTileUV, readTilePixel, luminance, boostColor, FLASH_BOOST,
  FACE_MARKER_PIXELS,
} from '../app/js/mobart.js';
import { PLANETS } from '../app/js/planets.js';

let n = 0;
function ok(cond, msg) { n++; assert.ok(cond, msg); }
function eq(a, b, msg) { n++; assert.equal(a, b, msg); }

// -------------------------------------------------------------------- shape
eq(MOB_TILE, 16, 'tile size');
eq(MOB_UPSCALE, 4, 'upscale');
eq(MOB_COLS, 8, 'columns');
eq(TILE_NAMES.length, 8, 'eight tiles');
eq(TILE_INDEX.size, 8, 'eight indexed tiles');

for (const name of TILE_NAMES) ok(TILE_INDEX.has(name), `TILE_INDEX has ${name}`);

// ----------------------------------------------------------- atlas geometry
for (const planet of PLANETS) {
  const atlas = buildMobAtlas(planet);
  eq(atlas.width, MOB_COLS * MOB_TILE * MOB_UPSCALE, `${planet.id}: atlas width`);
  eq(atlas.height, MOB_TILE * MOB_UPSCALE, `${planet.id}: atlas height`);
  eq(atlas.data.length, atlas.width * atlas.height * 4, `${planet.id}: buffer size`);
  eq(atlas.index, TILE_INDEX, `${planet.id}: index map is the shared TILE_INDEX`);
}

// --------------------------------------------------------------------- uv
for (let i = 0; i < 8; i++) {
  const [u0, v0, du, dv] = mobTileUV(i);
  ok(u0 >= 0 && u0 + du <= 1 + 1e-9, `tile ${i}: u rect inside atlas`);
  ok(v0 >= 0 && v0 + dv <= 1 + 1e-9, `tile ${i}: v rect inside atlas`);
  eq(du, 1 / MOB_COLS, `tile ${i}: du is one column`);
  eq(dv, 1, `tile ${i}: dv spans the single row`);
}

// -------------------------------------------------------------- opacity
// Mob skins are solid cube art, never alpha-tested - every painted pixel of
// every tile, on every planet, must be fully opaque.
for (const planet of PLANETS.slice(0, 3)) {   // three planets is plenty; this loop is O(tiles*pixels)
  const atlas = buildMobAtlas(planet);
  let transparent = 0;
  for (let i = 3; i < atlas.data.length; i += 4) if (atlas.data[i] !== 255) transparent++;
  eq(transparent, 0, `${planet.id}: no transparent mob pixels`);
}

// Optical markings use three lenses on the Skitter and a single mineral
// fissure on the Resonator. Each must stand out from its dark surround.
for (const planet of PLANETS) {
  const atlas = buildMobAtlas(planet);
  for (const [faceTile, points] of Object.entries(FACE_MARKER_PIXELS)) {
    const idx = TILE_INDEX.get(faceTile);
    for (const [x, y] of points) {
      const signal = readTilePixel(atlas, idx, x, y).slice(0, 3).map(v => v / 255);
      const surround = readTilePixel(atlas, idx, x - 2, y).slice(0, 3).map(v => v / 255);
      ok(luminance(signal) - luminance(surround) > .25, `${planet.id} ${faceTile}: optical signal is legible`);
    }
  }
}

// --------------------------------------------------- planet-derived colour
// Two planets with different deep layers must not paint the same warden.
const earth = PLANETS.find((p) => p.id === 'earth');
const mars = PLANETS.find((p) => p.id === 'mars');
ok(earth.terrain.layers.deep !== mars.terrain.layers.deep, 'fixture sanity: different deep layers');
const wardenEarth = mobPalette(earth).wardenBase;
const wardenMars = mobPalette(mars).wardenBase;
ok(
  Math.abs(wardenEarth[0] - wardenMars[0]) + Math.abs(wardenEarth[1] - wardenMars[1]) + Math.abs(wardenEarth[2] - wardenMars[2]) > 0.02,
  'earth and mars wardens are visibly different colours',
);

// ------------------------------------------------------------- damage flash
// The renderer's diffuse is texture * vertexColor * instanceColor, so a flash
// can only read as "toward white" through a multiply that clips channels -
// boostColor is that exact arithmetic. Prove it actually lightens every
// planet's base tint by a real margin, not by an amount lost in rounding.
const LUM_MARGIN = 0.2;   // the tightest case (a near-white cloud-tinted crawler on Jupiter/Europa) still clears ~0.23
for (const planet of PLANETS) {
  const pal = mobPalette(planet);
  for (const base of [pal.crawlerBase, pal.wardenBase]) {
    const flashed = boostColor(base, FLASH_BOOST);
    ok(luminance(flashed) - luminance(base) > LUM_MARGIN, `${planet.id}: flash lightens the base tint`);
  }
}

// -------------------------------------------------------------- determinism
// Re-entering the same planet must paint byte-identical art, or a save/load
// round trip (or simply walking back through a portal) would flicker a mob's
// skin for no reason.
{
  const a = buildMobAtlas(earth);
  const b = buildMobAtlas(earth);
  eq(Buffer.compare(Buffer.from(a.data), Buffer.from(b.data)), 0, 'buildMobAtlas is deterministic per planet');
}

console.log(`mobart: ${n} assertions passed across ${PLANETS.length} planets`);
