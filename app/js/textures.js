// Procedural texture atlas.
//
// Nothing here is loaded from disk: every tile is painted pixel-by-pixel into a
// single RGBA buffer that becomes one THREE.DataTexture. One texture for the
// whole world means every chunk can share one material, which is what keeps the
// draw-call count equal to the chunk count instead of the block-type count.

import { crackField, CRACK_STAGES, crackTileName } from './crack.js';

export const TILE = 16;      // logical pixel art resolution
export const UPSCALE = 4;    // blown up so minification filtering stays sane
export const COLS = 16;      // tiles per atlas row

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

/** Small deterministic PRNG so a texture looks identical on every launch. */
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

// Every recipe: p = pattern, c = base colour, c2 = accent, j = jitter, a = alpha.
const RECIPES = {
  stone:        { p: 'speckle', c: '#7d7d7d', j: 26 },
  cobble:       { p: 'cobble',  c: '#9c9c9c', c2: '#7a7a7a' },
  dirt:         { p: 'speckle', c: '#79553a', j: 22 },
  grass_top:    { p: 'grass',   c: '#5b9a3f', j: 26 },
  grass_side:   { p: 'overlay', c: '#79553a', c2: '#5b9a3f', j: 22 },
  sand:         { p: 'fine',    c: '#dbcf9a', j: 16 },
  gravel:       { p: 'speckle', c: '#867d78', j: 34 },
  sandstone:    { p: 'bands',   c: '#d8ca8e', c2: '#c3b276' },
  sandstone_top:{ p: 'fine',    c: '#d8ca8e', j: 14 },
  bedrock:      { p: 'speckle', c: '#3a3a42', j: 40 },
  obsidian:     { p: 'gem',     c: '#1b1424', c2: '#6d4fa6' },
  basalt:       { p: 'bands',   c: '#4a4750', c2: '#3a3840' },
  basalt_top:   { p: 'speckle', c: '#4a4750', j: 20 },

  log:          { p: 'bark',    c: '#6b4f2a', c2: '#543d20' },
  log_top:      { p: 'rings',   c: '#a8834b', c2: '#6b4f2a' },
  planks:       { p: 'planks',  c: '#b08a52', c2: '#8a6a3c' },
  leaves:       { p: 'leaves',  c: '#3f7a34', c2: '#2d5a26' },
  alien_log:    { p: 'bark',    c: '#5c4a7a', c2: '#41345a' },
  alien_log_top:{ p: 'rings',   c: '#8a76b5', c2: '#5c4a7a' },
  alien_leaves: { p: 'leaves',  c: '#7d4fb0', c2: '#54338a' },
  moss:         { p: 'grass',   c: '#8a6a3a', j: 30 },

  water:        { p: 'liquid',  c: '#286f8b', c2: '#4b95a5', a: 185 },
  lava:         { p: 'liquid',  c: '#e0561b', c2: '#ffb43c', a: 255 },
  methane:      { p: 'liquid',  c: '#2a3f52', c2: '#3d6070', a: 200 },

  ice:          { p: 'crack',   c: '#9fd4f0', c2: '#d6f0ff', a: 205 },
  pack_ice:     { p: 'speckle', c: '#a8cfe6', j: 16 },
  snow:         { p: 'fine',    c: '#f2f6fa', j: 10 },
  europa_ice:   { p: 'crack',   c: '#cfe3ef', c2: '#b0784f' },
  europa_ice_top:{ p: 'crack',  c: '#dcecf5', c2: '#b0784f' },
  ammonia_ice:  { p: 'crack',   c: '#dfd2a8', c2: '#fff6d8' },

  coal_ore:     { p: 'ore',     c: '#7d7d7d', c2: '#22222a' },
  iron_ore:     { p: 'ore',     c: '#7d7d7d', c2: '#c98f6a' },
  gold_ore:     { p: 'ore',     c: '#7d7d7d', c2: '#f4cf46' },
  crystal_ore:  { p: 'ore',     c: '#6f6f7a', c2: '#63e8ff' },
  ice_ore:      { p: 'ore',     c: '#6f6f7a', c2: '#bfe9ff' },
  luminite:     { p: 'glow',    c: '#f6d98a', c2: '#fff6cf' },
  crystal_block:{ p: 'gem',     c: '#3ec6e8', c2: '#c8f6ff', a: 190 },

  mars_sand:    { p: 'fine',    c: '#b4623a', j: 20 },
  mars_rock:    { p: 'speckle', c: '#8f4b2e', j: 26 },
  mars_clay:    { p: 'bands',   c: '#a9553a', c2: '#8d422c' },
  moon_dust:    { p: 'crater',  c: '#9a9a97', c2: '#6f6f6d' },
  moon_rock:    { p: 'speckle', c: '#b6b6b0', j: 24 },
  venus_crust:  { p: 'speckle', c: '#8c7040', j: 28 },
  sulfur:       { p: 'fine',    c: '#e0c246', j: 22 },
  sulfur_crust: { p: 'cobble',  c: '#cfa93f', c2: '#a8842c' },
  titan_sand:   { p: 'dune',    c: '#8a5a2c', c2: '#6d4520' },
  titan_rock:   { p: 'speckle', c: '#6b6154', j: 24 },
  cloud:        { p: 'cloud',   c: '#e7dcc6', c2: '#cbb896' },
  storm_stone:  { p: 'speckle', c: '#6a5a7d', j: 28 },
  helium_ice:   { p: 'glow',    c: '#8fa8d8', c2: '#dfe9ff' },

  hull:         { p: 'metal',   c: '#9aa3ad', c2: '#69727c' },
  fabricator_top:{ p: 'solar',  c: '#8a6a3c', c2: '#c49a5c' },
  fabricator:   { p: 'planks',  c: '#9a7a46', c2: '#6b5230' },
  furnace_top:  { p: 'cobble',  c: '#8e8e8e', c2: '#6d6d6d' },
  furnace:      { p: 'port',    c: '#8e8e8e', c2: '#2a2a2e' },
  furnace_lit:  { p: 'port',    c: '#8e8e8e', c2: '#ff9a3c' },
  life_support: { p: 'window',  c: '#9aa3ad', c2: '#5fe0ff' },
  life_support_top:{ p: 'metal',c: '#8f98a2', c2: '#5fe0ff' },
  glass:        { p: 'glass',   c: '#bfe4f2', a: 46 },
  lamp:         { p: 'glow',    c: '#ffd98a', c2: '#ffffff' },
  solar:        { p: 'solar',   c: '#1d2a52', c2: '#3f5fa8' },
  brick:        { p: 'brick',   c: '#a4664a', c2: '#7d4a34' },
};

// Ten block-break stages, appended rather than interleaved so every other
// tile index is unaffected. `a: 0` makes the base coat fully transparent
// (paintTile's base loop still runs, it just writes invisible pixels); the
// 'crack_stage' pattern below then paints the real, stage-tagged pixels.
for (let s = 0; s < CRACK_STAGES; s++) {
  RECIPES[crackTileName(s)] = { p: 'crack_stage', stage: s, c: '#0a0a0c', a: 0 };
}

export const TEXTURE_NAMES = Object.keys(RECIPES);
export const TILE_INDEX = new Map(TEXTURE_NAMES.map((n, i) => [n, i]));
export const ROWS = Math.ceil(TEXTURE_NAMES.length / COLS);

/** Paint one 16x16 tile into an RGBA scratch buffer. */
function paintTile(buf, name) {
  const r = RECIPES[name];
  const rnd = prng(strSeed(name));
  const base = hex(r.c);
  const acc = r.c2 ? hex(r.c2) : base;
  const alpha = r.a ?? 255;
  const put = (x, y, rgb, a = alpha) => {
    if (x < 0 || y < 0 || x >= TILE || y >= TILE) return;
    const o = (y * TILE + x) * 4;
    buf[o] = clamp255(rgb[0]); buf[o + 1] = clamp255(rgb[1]); buf[o + 2] = clamp255(rgb[2]); buf[o + 3] = a;
  };
  const jit = (rgb, amount) => {
    const d = (rnd() - 0.5) * 2 * amount;
    return [rgb[0] + d, rgb[1] + d, rgb[2] + d];
  };
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const j = r.j ?? 18;

  // base coat
  for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) put(x, y, jit(base, j));

  switch (r.p) {
    case 'speckle':
      for (let i = 0; i < 26; i++) {
        const x = (rnd() * TILE) | 0, y = (rnd() * TILE) | 0;
        put(x, y, jit(base, j * 2.2));
      }
      break;

    case 'fine':
      break; // the base coat jitter is the whole look

    case 'grass': {
      for (let i = 0; i < 40; i++) {
        const x = (rnd() * TILE) | 0, y = (rnd() * TILE) | 0;
        const c = mix(base, rnd() > 0.5 ? [255, 255, 255] : [0, 0, 0], 0.18);
        put(x, y, c); put(x, y + 1, c);
      }
      break;
    }

    case 'overlay': { // dirt with a ragged band of accent along the top
      for (let x = 0; x < TILE; x++) {
        const h = 3 + ((rnd() * 3) | 0);
        for (let y = 0; y < h; y++) put(x, y, jit(acc, j));
        put(x, h, mix(jit(acc, j), base, 0.45));
      }
      break;
    }

    case 'bands':
      for (let y = 0; y < TILE; y++) {
        const dark = y % 5 === 0 || y % 5 === 1;
        for (let x = 0; x < TILE; x++) put(x, y, jit(dark ? acc : base, j * 0.7));
      }
      break;

    case 'dune':
      for (let y = 0; y < TILE; y++) {
        for (let x = 0; x < TILE; x++) {
          const w = Math.sin((x * 0.7 + y * 1.9) * 0.6) * 0.5 + 0.5;
          put(x, y, jit(mix(base, acc, w * 0.7), j * 0.6));
        }
      }
      break;

    case 'cobble': {
      const cells = 4;
      for (let cy = 0; cy < cells; cy++) {
        for (let cx = 0; cx < cells; cx++) {
          const tone = jit(base, j * 1.6);
          const ox = (rnd() * 2 - 1) | 0;
          for (let y = 0; y < TILE / cells; y++) {
            for (let x = 0; x < TILE / cells; x++) {
              const px = cx * 4 + x + ox, py = cy * 4 + y;
              const edge = x === 0 || y === 0;
              put(px, py, edge ? acc : tone);
            }
          }
        }
      }
      break;
    }

    case 'bark':
      for (let x = 0; x < TILE; x++) {
        const groove = rnd() > 0.72;
        for (let y = 0; y < TILE; y++) put(x, y, jit(groove ? acc : base, 10));
      }
      break;

    case 'rings':
      for (let y = 0; y < TILE; y++) {
        for (let x = 0; x < TILE; x++) {
          const d = Math.hypot(x - 7.5, y - 7.5);
          const ring = Math.sin(d * 2.1) > 0.25;
          put(x, y, jit(ring ? acc : base, 9));
        }
      }
      break;

    case 'planks':
      for (let y = 0; y < TILE; y++) {
        const seam = y % 4 === 3;
        for (let x = 0; x < TILE; x++) put(x, y, jit(seam ? acc : base, 12));
      }
      for (let y = 1; y < TILE; y += 4) { put(1, y, acc); put(9, y, acc); }
      break;

    case 'leaves':
      for (let y = 0; y < TILE; y++) {
        for (let x = 0; x < TILE; x++) {
          const v = rnd();
          if (v < 0.11) put(x, y, base, 0);                 // holes -> alpha-tested away
          else put(x, y, jit(v < 0.55 ? acc : base, 22));
        }
      }
      break;

    case 'liquid':
      for (let y = 0; y < TILE; y++) {
        for (let x = 0; x < TILE; x++) {
          // Seamless low-contrast ripples avoid a bright checkerboard at distance.
          const w = .35 + Math.sin((x + y) / TILE * Math.PI * 2) * .1 + Math.cos(y / TILE * Math.PI * 2) * .08;
          put(x, y, mix(base, acc, Math.max(0, Math.min(1, w))));
        }
      }
      break;

    case 'crack': {
      for (let i = 0; i < 3; i++) {
        let x = (rnd() * TILE) | 0, y = 0;
        while (y < TILE) {
          put(x, y, mix(acc, [0, 0, 0], 0.15));
          y += 1;
          x += (rnd() * 3 | 0) - 1;
          if (x < 0) x = 0; if (x >= TILE) x = TILE - 1;
        }
      }
      for (let i = 0; i < 10; i++) put((rnd() * TILE) | 0, (rnd() * TILE) | 0, [255, 255, 255]);
      break;
    }

    // One block-break stage: every pixel of the shared crackField() that is
    // tagged stage <= r.stage. No jitter - the field already carries its own
    // shape, and re-randomising it here would break the nesting invariant.
    case 'crack_stage':
      for (const f of crackField()) {
        if (f.stage <= r.stage) put(f.x, f.y, base, f.a);
      }
      break;

    case 'ore': {
      const blobs = 5;
      for (let i = 0; i < blobs; i++) {
        const bx = 2 + ((rnd() * 12) | 0), by = 2 + ((rnd() * 12) | 0);
        const size = 1 + ((rnd() * 2) | 0);
        for (let y = -size; y <= size; y++) {
          for (let x = -size; x <= size; x++) {
            if (x * x + y * y > size * size + 1) continue;
            put(bx + x, by + y, jit(acc, 24));
          }
        }
      }
      break;
    }

    case 'gem':
      for (let y = 0; y < TILE; y++) {
        for (let x = 0; x < TILE; x++) {
          const facet = ((x + y) % 6 < 3) ? 0.25 : 0.0;
          put(x, y, mix(jit(base, 12), acc, facet));
        }
      }
      for (let i = 0; i < 8; i++) put((rnd() * TILE) | 0, (rnd() * TILE) | 0, acc);
      break;

    case 'glow':
      for (let y = 0; y < TILE; y++) {
        for (let x = 0; x < TILE; x++) {
          const d = Math.hypot(x - 7.5, y - 7.5) / 11;
          put(x, y, mix(acc, base, Math.min(1, d + rnd() * 0.25)));
        }
      }
      break;

    case 'glass':
      for (let y = 0; y < TILE; y++) {
        for (let x = 0; x < TILE; x++) {
          const border = x === 0 || y === 0 || x === TILE - 1 || y === TILE - 1;
          put(x, y, base, border ? 205 : alpha);
        }
      }
      for (let i = 0; i < 6; i++) put(3 + i, 3 + i, [255, 255, 255], 150);
      break;

    case 'metal':
      for (let y = 0; y < TILE; y++) {
        for (let x = 0; x < TILE; x++) {
          const panel = x === 0 || y === 0 || x === 8 || y === 8;
          put(x, y, jit(panel ? acc : base, 8));
        }
      }
      for (const [rx, ry] of [[2, 2], [6, 2], [2, 6], [6, 6], [10, 10], [14, 10], [10, 14], [14, 14]]) put(rx, ry, [230, 235, 240]);
      break;

    case 'port': {   // a smelter mouth: dark arch, or a lit one
      for (let y = 4; y < 13; y++) {
        for (let x = 3; x < 13; x++) {
          const arch = y === 4 && (x < 4 || x > 11);
          if (arch) continue;
          const glow = r.c2 !== '#2a2a2e';
          const t = glow ? 1 - (y - 4) / 9 : 0;
          put(x, y, glow ? mix(acc, [255, 240, 190], t * 0.6) : jit(acc, 8));
        }
      }
      for (let x = 2; x < 14; x++) { put(x, 13, jit(mix(base, acc, 0.4), 8)); put(x, 3, jit(mix(base, acc, 0.3), 8)); }
      break;
    }

    case 'window': {  // metal plate with a lit inspection port
      for (let y = 0; y < TILE; y++) {
        for (let x = 0; x < TILE; x++) {
          const frame = x < 3 || y < 3 || x > 12 || y > 12;
          put(x, y, jit(frame ? base : mix(acc, base, 0.25), frame ? 10 : 6));
        }
      }
      for (let i = 0; i < 5; i++) put(4 + i, 4 + i, [255, 255, 255]);
      for (const [rx, ry] of [[1, 1], [14, 1], [1, 14], [14, 14]]) put(rx, ry, [225, 232, 240]);
      break;
    }

    case 'solar':
      for (let y = 0; y < TILE; y++) {
        for (let x = 0; x < TILE; x++) {
          const grid = x % 5 === 0 || y % 5 === 0;
          put(x, y, grid ? acc : mix(base, acc, ((x + y) % 10) / 40));
        }
      }
      break;

    case 'brick':
      for (let y = 0; y < TILE; y++) {
        const row = (y / 4) | 0;
        for (let x = 0; x < TILE; x++) {
          const off = (row % 2) * 4;
          const mortar = y % 4 === 0 || (x + off) % 8 === 0;
          put(x, y, jit(mortar ? [190, 180, 170] : base, mortar ? 6 : 14));
        }
      }
      break;

    case 'crater':
      for (let i = 0; i < 6; i++) {
        const bx = (rnd() * TILE) | 0, by = (rnd() * TILE) | 0, rad = 1 + ((rnd() * 2) | 0);
        for (let y = -rad; y <= rad; y++) {
          for (let x = -rad; x <= rad; x++) {
            const d = Math.hypot(x, y);
            if (d > rad) continue;
            put(bx + x, by + y, mix(acc, base, d / rad));
          }
        }
      }
      break;

    case 'cloud':
      for (let i = 0; i < 5; i++) {
        const bx = (rnd() * TILE) | 0, by = (rnd() * TILE) | 0, rad = 2 + ((rnd() * 3) | 0);
        for (let y = -rad; y <= rad; y++) {
          for (let x = -rad; x <= rad; x++) {
            if (Math.hypot(x, y) > rad) continue;
            put(bx + x, by + y, mix(base, acc, 0.5 + rnd() * 0.4));
          }
        }
      }
      break;
  }
}

/**
 * Build the whole atlas as a raw RGBA byte array (no DOM needed, so this is
 * unit-testable in Node and could run in a worker).
 */
export function buildAtlas() {
  const size = COLS * TILE * UPSCALE;
  const height = ROWS * TILE * UPSCALE;
  const data = new Uint8Array(size * height * 4);
  const tile = new Uint8Array(TILE * TILE * 4);

  TEXTURE_NAMES.forEach((name, index) => {
    tile.fill(0);
    paintTile(tile, name);
    const tx = (index % COLS) * TILE * UPSCALE;
    const ty = ((index / COLS) | 0) * TILE * UPSCALE;
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const so = (y * TILE + x) * 4;
        for (let sy = 0; sy < UPSCALE; sy++) {
          for (let sx = 0; sx < UPSCALE; sx++) {
            const dx = tx + x * UPSCALE + sx;
            const dy = ty + (TILE - 1 - y) * UPSCALE + sy;   // flip: v=0 is the bottom
            const dofs = (dy * size + dx) * 4;
            data[dofs] = tile[so];
            data[dofs + 1] = tile[so + 1];
            data[dofs + 2] = tile[so + 2];
            data[dofs + 3] = tile[so + 3];
          }
        }
      }
    }
  });

  return { data, width: size, height, cols: COLS, rows: ROWS };
}

/** Raw RGBA pixels of a single 16x16 tile - used to build hotbar icons. */
export function tilePixels(name) {
  const buf = new Uint8Array(TILE * TILE * 4);
  paintTile(buf, name);
  return buf;
}

/** Base colour of a recipe, 0..1 - used for block-break particles and UI chips. */
export function tileBaseColor(name) {
  const r = RECIPES[name];
  if (!r) return [1, 1, 1];
  const c = hex(r.c);
  return [c[0] / 255, c[1] / 255, c[2] / 255];
}

/** UV rect of a tile, in atlas space. */
export function tileUV(index) {
  // Sample texel centers. Exact atlas boundaries blended unrelated neighbor
  // tiles into every block edge, most visibly as gold grid lines over water.
  const halfU = .5 / (COLS * TILE * UPSCALE), halfV = .5 / (ROWS * TILE * UPSCALE);
  const u0 = (index % COLS) / COLS + halfU;
  const v0 = ((index / COLS) | 0) / ROWS + halfV;
  return [u0, v0, 1 / COLS - 2 * halfU, 1 / ROWS - 2 * halfV];
}
