// Procedural mob skins.
//
// Same discipline as textures.js and itemart.js: nothing is loaded from disk,
// every tile is painted pixel-by-pixel into one shared RGBA buffer. The
// difference is *when* it happens - the block atlas is built once at boot, but
// a mob atlas is tinted from a planet's own palette (mobPalette), so it has to
// be rebuilt once per planet-enter. buildMobAtlas costs about a millisecond
// (see tools/bench-mobs.js), which is cheap next to a 6-12ms chunk remesh.
//
// No THREE, no DOM - this file is unit-testable in plain node, exactly like
// textures.js and itemart.js. mobrender.js is the THREE-only consumer.

import { BY_KEY } from './blocks.js';
import { tileBaseColor } from './textures.js';

export const MOB_TILE = 16;      // logical pixel-art resolution, same grid as a block tile
export const MOB_UPSCALE = 4;
export const MOB_COLS = 8;       // all eight tiles fit in one atlas row

// Stable draw order: this array's index IS the atlas column, and mobrender.js
// only ever refers to a tile by name through TILE_INDEX, so the order here can
// never silently drift out of sync with what gets painted.
export const TILE_NAMES = [
  'crawler_skin', 'crawler_face', 'crawler_fuse', 'crawler_leg',
  'warden_body', 'warden_face', 'warden_limb', 'warden_core',
];
export const TILE_INDEX = new Map(TILE_NAMES.map((n, i) => [n, i]));

const hex = (h) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const tone = (c, m) => [clamp01(c[0] * m), clamp01(c[1] * m), clamp01(c[2] * m)];

/** Same xorshift PRNG textures.js/itemart.js already use - one house feel. */
function prng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}
const strSeed = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};

// A violet energy pod keeps the Skitter distinct from green voxel monsters.
const FLUX = [.42, .23, .72];

/** tex[1] is always a real recipe name (the side texture); a bare block key
 *  (e.g. 'grass') usually is not - see textures.js's tileBaseColor. */
const sideTex = (blockKey) => {
  const b = BY_KEY.get(blockKey);
  return b ? b.tex[1] : blockKey;
};

/**
 * Derived, not authored: every planet gets a crawler and a warden tint without
 * one line of new per-planet data, and the two can never fall out of sync with
 * a planet's terrain because they are read from the same block registry the
 * chunk mesher uses.
 * @param {{terrain:{layers:{surface:string, deep:string}}, orb:{glow:string}}} planet
 */
export function mobPalette(planet) {
  const crawlerBase = mix(tileBaseColor(sideTex(planet.terrain.layers.surface)), FLUX, 0.72);
  const wardenBase = tileBaseColor(sideTex(planet.terrain.layers.deep));
  return {
    crawlerBase,
    crawlerDark: tone(crawlerBase, 0.62),
    crawlerLight: tone(crawlerBase, 1.25),
    wardenBase,
    wardenDark: tone(wardenBase, 0.60),
    wardenLight: tone(wardenBase, 1.20),
    accent: hex(planet.orb?.glow ?? '#ffffff'),
  };
}

/** 0..1 relative luminance - used to prove a flash actually reads as lighter. */
export function luminance(rgb) {
  return rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114;
}

// The renderer's diffuse is texture * vertexColor(FACE_SHADE) * instanceColor.
// A flash cannot be expressed by *mixing toward white* the way tileBaseColor
// consumers do elsewhere, because instanceColor MULTIPLIES: mixing an already-
// neutral (1,1,1) instance colour toward white leaves it (1,1,1), i.e. no
// visual change at all. The only way a multiply reads as "flashing white" is a
// scalar > 1 that pushes every channel toward the display's clip. boostColor
// simulates exactly that clipped multiply in plain JS - the same arithmetic
// mobrender.js's instanceColor write performs on the GPU - so this file's own
// tests can prove the effect is visible without needing WebGL.
export function boostColor(rgb, boost, out = [0, 0, 0]) {
  out[0] = clamp01(rgb[0] * boost);
  out[1] = clamp01(rgb[1] * boost);
  out[2] = clamp01(rgb[2] * boost);
  return out;
}

// Peak instanceColor scalar at full damage-flash / fuse-glow. Shared by name
// (not by re-deriving the number) with mobrender.js, so the render path and
// this file's flash-legibility test can never drift apart.
export const FLASH_BOOST = 3.2;

// Texture-space optical signals, shared with the legibility tests.
export const FACE_MARKER_PIXELS = {
  crawler_face: [[3, 8], [8, 5], [12, 10]],
  warden_face: [[8, 7]],
};

// --------------------------------------------------------------- tile paint

function put(buf, x, y, rgb, a = 255) {
  if (x < 0 || y < 0 || x >= MOB_TILE || y >= MOB_TILE) return;
  const o = (y * MOB_TILE + x) * 4;
  buf[o] = clamp255(rgb[0] * 255);
  buf[o + 1] = clamp255(rgb[1] * 255);
  buf[o + 2] = clamp255(rgb[2] * 255);
  buf[o + 3] = a;
}
const jitter = (rgb, amt, rnd) => {
  const d = (rnd() - 0.5) * 2 * amt;
  return [clamp01(rgb[0] + d), clamp01(rgb[1] + d), clamp01(rgb[2] + d)];
};

function paintSkin(buf, base, dark, rnd) {
  for (let y = 0; y < MOB_TILE; y++) for (let x = 0; x < MOB_TILE; x++) put(buf, x, y, jitter(base, 0.05, rnd));
  // mottled hide: a scatter of darker blotches, two pixels wide
  for (let i = 0; i < 16; i++) {
    const x = (rnd() * MOB_TILE) | 0, y = (rnd() * MOB_TILE) | 0;
    const c = jitter(dark, 0.06, rnd);
    put(buf, x, y, c);
    if (rnd() > 0.4) put(buf, x + 1, y, c);
  }
}

function paintFace(buf, base, dark, accent, rnd) {
  paintSkin(buf, base, dark, rnd);
  // Three staggered lenses in a dark visor, rather than a humanoid face.
  for (const [cx, cy] of FACE_MARKER_PIXELS.crawler_face) {
    for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) {
      put(buf, cx + x, cy + y, tone(dark, .2));
    }
    put(buf, cx, cy, mix(accent, [1, 1, 1], .8));
    put(buf, cx + 1, cy, accent);
  }
}

function paintFuse(buf, dark, base, accent, rnd) {
  // Dark armour plates split by glowing accent seams - the "loaded" belly a
  // crawler always carries, not something swapped in only while it is fusing.
  for (let y = 0; y < MOB_TILE; y++) {
    for (let x = 0; x < MOB_TILE; x++) {
      const plate = (((x / 4) | 0) + ((y / 4) | 0)) % 2 === 0;
      put(buf, x, y, jitter(plate ? dark : tone(dark, 0.8), 0.04, rnd));
    }
  }
  for (let x = 0; x < MOB_TILE; x++) {
    if (x % 4 !== 3) continue;
    put(buf, x, 7, accent);
    put(buf, x, 8, mix(accent, [1, 1, 1], 0.35));
  }
}

function paintLeg(buf, dark, rnd) {
  for (let y = 0; y < MOB_TILE; y++) for (let x = 0; x < MOB_TILE; x++) put(buf, x, y, jitter(dark, 0.05, rnd));
  // a joint band every 5 rows
  for (let y = 0; y < MOB_TILE; y += 5) for (let x = 0; x < MOB_TILE; x++) put(buf, x, y, jitter(tone(dark, 0.8), 0.04, rnd));
}

function paintWardenBody(buf, base, dark, rnd) {
  // Mineral strata sweep diagonally through the plates, without cobble bricks.
  for (let y = 0; y < MOB_TILE; y++) for (let x = 0; x < MOB_TILE; x++) {
    const vein = (x + y * 2) % 9 < 2;
    put(buf, x, y, jitter(vein ? dark : base, .06, rnd));
  }
}

function paintWardenFace(buf, base, dark, accent, rnd) {
  paintWardenBody(buf, base, dark, rnd);
  // A single vertical crystalline fissure runs through each crown shard.
  for (let y = 1; y < 15; y++) {
    for (let x = 5; x <= 10; x++) put(buf, x, y, tone(dark, .2));
    put(buf, 8, y, mix(accent, [1, 1, 1], .75));
    put(buf, 9, y, accent);
  }
}

function paintWardenLimb(buf, dark, rnd) {
  for (let y = 0; y < MOB_TILE; y++) for (let x = 0; x < MOB_TILE; x++) put(buf, x, y, jitter(dark, 0.05, rnd));
  for (let y = 0; y < MOB_TILE; y += 4) for (let x = 0; x < MOB_TILE; x++) put(buf, x, y, jitter(tone(dark, 0.75), 0.04, rnd));
}

function paintWardenCore(buf, dark, accent, rnd) {
  // A radial glow, same shape as textures.js's 'glow' pattern: an accent-hot
  // centre fading out to the rock it is set into.
  for (let y = 0; y < MOB_TILE; y++) {
    for (let x = 0; x < MOB_TILE; x++) {
      const d = Math.hypot(x - 7.5, y - 7.5) / 11;
      put(buf, x, y, mix(accent, dark, Math.min(1, d + rnd() * 0.15)));
    }
  }
}

const PAINTERS = [
  (buf, pal, rnd) => paintSkin(buf, pal.crawlerBase, pal.crawlerDark, rnd),
  (buf, pal, rnd) => paintFace(buf, pal.crawlerBase, pal.crawlerDark, pal.accent, rnd),
  (buf, pal, rnd) => paintFuse(buf, pal.crawlerDark, pal.crawlerBase, pal.accent, rnd),
  (buf, pal, rnd) => paintLeg(buf, pal.crawlerDark, rnd),
  (buf, pal, rnd) => paintWardenBody(buf, pal.wardenBase, pal.wardenDark, rnd),
  (buf, pal, rnd) => paintWardenFace(buf, pal.wardenBase, pal.wardenDark, pal.accent, rnd),
  (buf, pal, rnd) => paintWardenLimb(buf, pal.wardenDark, rnd),
  (buf, pal, rnd) => paintWardenCore(buf, pal.wardenDark, pal.accent, rnd),
];

/**
 * Paint all eight tiles into one RGBA atlas, upscaled and v-flipped exactly
 * like textures.js's buildAtlas (row 0 of the source art lands at the top of
 * the tile in UV space). 512 x 64 x 4 bytes = 128 KB.
 * @param {object} planet
 * @returns {{data:Uint8Array, width:number, height:number, index:Map<string,number>}}
 */
export function buildMobAtlas(planet) {
  const pal = mobPalette(planet);
  const width = MOB_COLS * MOB_TILE * MOB_UPSCALE;
  const height = MOB_TILE * MOB_UPSCALE;
  const data = new Uint8Array(width * height * 4);
  const tile = new Uint8Array(MOB_TILE * MOB_TILE * 4);
  const seedBase = String(planet?.id ?? 'planet');

  TILE_NAMES.forEach((name, index) => {
    tile.fill(0);
    const rnd = prng(strSeed(seedBase + ':' + name));
    PAINTERS[index](tile, pal, rnd);

    const tx0 = index * MOB_TILE * MOB_UPSCALE;
    for (let y = 0; y < MOB_TILE; y++) {
      for (let x = 0; x < MOB_TILE; x++) {
        const so = (y * MOB_TILE + x) * 4;
        for (let sy = 0; sy < MOB_UPSCALE; sy++) {
          for (let sx = 0; sx < MOB_UPSCALE; sx++) {
            const dx = tx0 + x * MOB_UPSCALE + sx;
            const dy = (MOB_TILE - 1 - y) * MOB_UPSCALE + sy;   // flip: v=0 is the bottom
            const dofs = (dy * width + dx) * 4;
            data[dofs] = tile[so]; data[dofs + 1] = tile[so + 1];
            data[dofs + 2] = tile[so + 2]; data[dofs + 3] = tile[so + 3];
          }
        }
      }
    }
  });

  return { data, width, height, index: TILE_INDEX };
}

/** UV rect of a tile in atlas space: [u0, v0, du, dv]. One row, eight columns. */
export function mobTileUV(index) {
  return [index / MOB_COLS, 0, 1 / MOB_COLS, 1];
}

/**
 * Sample the atlas at a tile-local pixel, honouring buildMobAtlas's v-flip -
 * the one place both this file's tests and any future debug tooling should
 * read a painted pixel from, so nobody re-derives the flip maths twice.
 * @param {{data:Uint8Array, width:number}} atlas
 */
export function readTilePixel(atlas, tileIndex, x, y) {
  const tx = tileIndex * MOB_TILE * MOB_UPSCALE + x * MOB_UPSCALE;
  const ty = (MOB_TILE - 1 - y) * MOB_UPSCALE;
  const o = (ty * atlas.width + tx) * 4;
  return [atlas.data[o], atlas.data[o + 1], atlas.data[o + 2], atlas.data[o + 3]];
}
