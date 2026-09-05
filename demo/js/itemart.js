// Procedural 16x16 sprites for every non-block item.
//
// Nothing is loaded from disk here either: a sprite is 16 strings of 16
// characters, each character indexing a per-item palette. Writing the art as a
// grid instead of pixel loops means a shape can be read (and fixed) at a glance,
// and it lets the three tool silhouettes be shared across all four tiers - only
// the palette changes, so a crystal pickaxe can never drift out of shape from
// the wooden one.
//
// Block items do not live here: they already have isometric icons built from the
// world's own texture tiles. itemSprite() forwards them to icons.js so the
// inventory only ever needs one call for "draw whatever is in this slot".

import { ITEMS } from './items.js';
import { blockIcon } from './icons.js';

export const SPRITE = 16;   // logical pixels, same grid as a texture tile

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
const toHex = (c) => '#' + c.map((v) => clamp255(v).toString(16).padStart(2, '0')).join('');

/** Same xorshift as textures.js - private there, and a sprite wants the identical feel. */
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

/** Scale a hex colour, clamped - used to derive shade/highlight from one base. */
const tone = (h, mul) => toHex(hex(h).map((v) => v * mul));

// ---------------------------------------------------------------- tool shapes
// One shape per tool type. ' ' is transparent; h/d/l are head mid/dark/light and
// s/t are handle light/dark, so every tier can reuse them verbatim.

const PICKAXE_SHAPE = [
  '                ',
  '      lhhl      ',
  '    lhhhhhhl    ',
  '  lhhhhhhhhhhl  ',
  ' hdd  dssd  ddh ',
  ' hd    st    dh ',
  '       st       ',
  '       st       ',
  '       st       ',
  '       st       ',
  '       st       ',
  '       st       ',
  '       st       ',
  '       st       ',
  '       st       ',
  '                ',
];

const AXE_SHAPE = [
  '                ',
  '      hhhst     ',
  '    lhhhhst     ',
  '   lhhhhhst     ',
  '  lhhhhhhst     ',
  '  lhhhhhdst     ',
  '   lhhhddst     ',
  '    lhdddst     ',
  '      hddst     ',
  '         st     ',
  '         st     ',
  '         st     ',
  '         st     ',
  '         st     ',
  '         st     ',
  '                ',
];

const SHOVEL_SHAPE = [
  '                ',
  '   lhhhhhhhhl   ',
  '   lhhhhhhhhl   ',
  '   lhhhhhhhhd   ',
  '   lhhhhhhhhd   ',
  '    dhhhhhhd    ',
  '      dssd      ',
  '       st       ',
  '       st       ',
  '       st       ',
  '       st       ',
  '       st       ',
  '       st       ',
  '       st       ',
  '       st       ',
  '                ',
];

// The issued drill is not a tier of the wood/stone/iron ladder, so it gets its
// own silhouette - players should never mistake it for a crafted pickaxe.
const DRILL_SHAPE = [
  '                ',
  '           l    ',
  '          lmd   ',
  '          lmd   ',
  '         lmmmd  ',
  '   lmmmmmmmmmd  ',
  '  lmmmmmmmmmmd  ',
  '  lmmoymmmmmmd  ',
  '  lmmmmmmmmmmd  ',
  '   dmmmmmmmmmd  ',
  '    lggggd      ',
  '    lgggd       ',
  '    lgggd       ',
  '     lggd       ',
  '     lggd       ',
  '                ',
];

// ------------------------------------------------------------ material shapes

const STICK_SHAPE = [
  '                ',
  '           lst  ',
  '           lst  ',
  '          lst   ',
  '          lst   ',
  '         lst    ',
  '         lst    ',
  '        lst     ',
  '        lst     ',
  '       lst      ',
  '       lst      ',
  '      lst       ',
  '      lst       ',
  '     lst        ',
  '     lst        ',
  '    lst         ',
];

const COAL_SHAPE = [
  '                ',
  '                ',
  '      dd        ',
  '    ddkkd       ',
  '   dkkkkkd      ',
  '  dkklkkkkd     ',
  '  dkkkkkkkkd    ',
  ' dkkkkkkkkkd    ',
  ' dkkkkkkkkkkd   ',
  ' dkkkkkkkkkd    ',
  '  dkkkkkkkkd    ',
  '  ddkkkkkkd     ',
  '   ddkkkkd      ',
  '    dddd        ',
  '                ',
  '                ',
];

// Raw ore: lumpier and more lopsided than a smelted bar, on purpose.
const NUGGET_SHAPE = [
  '                ',
  '                ',
  '        dd      ',
  '      ddnnd     ',
  '    ddnnnnnd    ',
  '   dnnlnnnnnd   ',
  '  dnnnnnnnnnd   ',
  '  dnnnnnnnnnnd  ',
  ' dnnlnnnnnnnnd  ',
  ' dnnnnnnnnnnd   ',
  ' dnnnnnnnnnd    ',
  '  dnnnnnnnd     ',
  '   dnnnnnd      ',
  '    ddddd       ',
  '                ',
  '                ',
];

const INGOT_SHAPE = [
  '                ',
  '                ',
  '                ',
  '                ',
  '                ',
  '                ',
  '      lwwlllll  ',
  '    lwwlllllll  ',
  '  llllllllllll  ',
  '  bbbbbbbbbbb   ',
  '  blbbbbbbbbb   ',
  '  bbbbbbbbbbb   ',
  '   ddddddddd    ',
  '                ',
  '                ',
  '                ',
];

const SHARD_SHAPE = [
  '                ',
  '       w        ',
  '       wc       ',
  '      cwc       ',
  '      cwcd      ',
  '     ccwcd      ',
  '     ccwccd     ',
  '     ccwccd     ',
  '     ccwccd     ',
  '     ccwccd     ',
  '     ccwccd     ',
  '      cwccd     ',
  '      cwcd      ',
  '       wcd      ',
  '       wd       ',
  '                ',
];

const VOLATILES_SHAPE = [
  '                ',
  '             *  ',
  '      iiiii     ',
  '    iiiiiiii    ',
  '   iiwiiiiiid   ',
  '  iiiiiiiiiiid  ',
  '  iiiiiiiiiiid  ',
  ' iiiwiiiiiiiid  ',
  ' iiiiiiiiiiiid  ',
  ' iiiiiiiiiiid   ',
  '  iiiiiiiiiid   ',
  '  iiiiiiiiid    ',
  '   iiiiiiid     ',
  '    ddddd       ',
  ' *              ',
  '                ',
];

// ---------------------------------------------------------------- food shapes

const ALGAE_SHAPE = [
  '                ',
  '                ',
  '                ',
  '    G   G  G    ',
  '   Gg  Gg Gg    ',
  '   Ggg GgggGg   ',
  '  gGgggggGgggg  ',
  ' gggGgggggggGgg ',
  ' ggggggGggggggg ',
  '  dggggggggggd  ',
  '   dggggggggd   ',
  '     dddddd     ',
  '                ',
  '                ',
  '                ',
  '                ',
];

const SPORE_SHAPE = [
  '                ',
  '       ss       ',
  '       ss       ',
  '      pPPp      ',
  '     pPPPPp     ',
  '    pPPPPPPp    ',
  '    pPPwPPPp    ',
  '   pPPPPPPPPd   ',
  '   pPPwPPPPPd   ',
  '   pPPPPPPPPd   ',
  '    pPPPPPPd    ',
  '    pPPPPPPd    ',
  '     pPPPPd     ',
  '      dddd      ',
  '                ',
  '                ',
];

const PASTE_SHAPE = [
  '                ',
  '      cccc      ',
  '      cccc      ',
  '     dbbbbd     ',
  '    dlbbbbbd    ',
  '    dlbbbbbd    ',
  '    dlgggggd    ',
  '    dlgggggd    ',
  '    dlbbbbbd    ',
  '    dlbbbbbd    ',
  '    dlbbbbbd    ',
  '    dlbbbbbd    ',
  '    dlbbbbbd    ',
  '    dbbbbbbd    ',
  '    dddddddd    ',
  '                ',
];

const RATION_SHAPE = [
  '                ',
  '   cccccccccc   ',
  '   cccccccccc   ',
  '  dssssssssssd  ',
  '  dssssssssssd  ',
  '  dooooooooood  ',
  '  dooooooooood  ',
  '  dssssssssssd  ',
  '  dsslsssssssd  ',
  '  dssssssssssd  ',
  '  dssssssssssd  ',
  '  dssssssssssd  ',
  '  dssssssssssd  ',
  '   cccccccccc   ',
  '   cccccccccc   ',
  '                ',
];

// ------------------------------------------------------------- usable shapes

const CANISTER_SHAPE = [
  '                ',
  '      vvvv      ',
  '       vv       ',
  '    ddbbbbdd    ',
  '   dlbbbbbbbd   ',
  '   dlbbbbbbbd   ',
  '   dlwwwwwwwd   ',
  '   dlwwwwwwwd   ',
  '   dlbbbbbbbd   ',
  '   dlbbbbbbbd   ',
  '   dlbbbbbbbd   ',
  '   dlbbbbbbbd   ',
  '   dlbbbbbbbd   ',
  '    ddbbbbdd    ',
  '     dddddd     ',
  '                ',
];

const MEDKIT_SHAPE = [
  '                ',
  '      hhhh      ',
  '      h  h      ',
  '  dddddddddddd  ',
  '  dwwwwwwwwwwd  ',
  '  dwwwrrrrwwwd  ',
  '  dwwwrrrrwwwd  ',
  '  dwrrrrrrrrwd  ',
  '  dwrrrrrrrrwd  ',
  '  dwrrrrrrrrwd  ',
  '  dwrrrrrrrrwd  ',
  '  dwwwrrrrwwwd  ',
  '  dwwwrrrrwwwd  ',
  '  dwwwwwwwwwwd  ',
  '  dddddddddddd  ',
  '                ',
];

// ------------------------------------------------------------------ palettes

/** Head colour drives its own shade/highlight so a new tier is one hex string. */
function toolPalette(head, handle) {
  return {
    h: head,
    d: tone(head, 0.62),
    l: tone(head, 1.30),
    s: handle,
    t: tone(handle, 0.70),
  };
}

const WOOD_HANDLE = '#7a5a33';    // only the wooden tier keeps a bare wood grip
const RIG_HANDLE = '#7e848c';     // everything above it is issued with a metal one

const TOOL_TIERS = {
  wood: toolPalette('#9a7a46', WOOD_HANDLE),
  stone: toolPalette('#8f8f8f', RIG_HANDLE),
  iron: toolPalette('#d8d8d8', RIG_HANDLE),
  crystal: toolPalette('#63e8ff', RIG_HANDLE),
};

const TOOL_SHAPES = { pickaxe: PICKAXE_SHAPE, axe: AXE_SHAPE, shovel: SHOVEL_SHAPE };

// --------------------------------------------------------------------- armour
// Four silhouettes, three tiers. Same trick as the tools: the shape says what
// the piece is, the palette says what it is made of.
const HELMET_SHAPE = [
  '                ',
  '     ssssss     ',
  '   pppppppppp   ',
  '  pplllllllldp  ',
  '  plvvvvvvvvdp  ',
  ' pplvvvvvvvvdpp ',
  ' pdlvvvvvvvvddp ',
  ' pd vvvvvvvv dp ',
  ' pd  vvvvvv  dp ',
  ' ppd        dpp ',
  '  ppdd    ddpp  ',
  '   pppssssppp   ',
  '    ssssssss    ',
  '                ',
  '                ',
  '                ',
];

const CHEST_SHAPE = [
  '                ',
  '  pppp    pppp  ',
  ' pllllp  pllllp ',
  ' pldddpppppdddp ',
  ' pldddddddddddp ',
  ' pldddddddddddp ',
  ' plddd ssss dddp'.slice(0, 16),
  ' plddd ssss dddp'.slice(0, 16),
  ' plddddssssddddp'.slice(0, 16),
  ' plddddddddddddp'.slice(0, 16),
  ' pldddddddddddp ',
  ' ppddddddddddpp ',
  '  pdd      ddp  ',
  '  spp      pps  ',
  '                ',
  '                ',
];

const LEGS_SHAPE = [
  '                ',
  '                ',
  '  ppppppppppppp '.slice(0, 16),
  ' plllllllllllld ',
  ' pdddddddddddddp'.slice(0, 16),
  ' pdddd    ddddp ',
  ' pldd      ddlp ',
  ' pldd      ddlp ',
  ' pldd      ddlp ',
  ' pldd      ddlp ',
  ' pldd      ddlp ',
  ' pldd      ddlp ',
  ' pspp      ppsp ',
  '  ss        ss  ',
  '                ',
  '                ',
];

const BOOTS_SHAPE = [
  '                ',
  '                ',
  '                ',
  '  ppp      ppp  ',
  ' pllp      pllp ',
  ' pldp      pdlp ',
  ' pldp      pdlp ',
  ' pldp      pdlp ',
  ' plddp    pddlp ',
  ' plddpp  ppddlp ',
  ' pldddppppdddlp ',
  ' pdddddddddddlp '.slice(0, 16),
  ' ssssssssssssss ',
  '  sssss  sssss  ',
  '                ',
  '                ',
];

/** Plate tone drives its own shade and highlight, like toolPalette does. */
function armourPalette(plate, visor, strap) {
  return {
    p: plate,
    d: tone(plate, 0.66),
    l: tone(plate, 1.28),
    v: visor,
    s: strap,
  };
}

const ARMOUR_TIERS = {
  // salvage plate: scuffed, warm grey, an amber scratched visor
  patch: armourPalette('#8d8378', '#c9a25e', '#4f4740'),
  // alloy: clean iron with a cold blue visor
  alloy: armourPalette('#c3c9d1', '#8fd0ff', '#5b626b'),
  // void crystal: the same cyan the crystal tools use
  void: armourPalette('#63e8ff', '#dffaff', '#2a5f6d'),
};

const ARMOUR_SHAPES = { helmet: HELMET_SHAPE, chest: CHEST_SHAPE, legs: LEGS_SHAPE, boots: BOOTS_SHAPE };

// Null prototype on purpose: a bare {} would answer SPRITES['toString'] with an
// inherited function, and itemPixels would then crash on it instead of throwing
// its own "no sprite" error.
/** @type {Record<string, {shape: string[], palette: Record<string,string>, dither?: number}>} */
const SPRITES = Object.create(null);

const sprite = (key, shape, palette, dither) => {
  SPRITES[key] = { shape, palette, dither };
};

sprite('hand_drill', DRILL_SHAPE, {
  m: '#6a7480', d: '#3d454e', l: '#98a4b0', o: '#ff8a1e', y: '#ffd98a', g: '#2f353c',
}, 10);

for (const tier of ['wood', 'stone', 'iron', 'crystal']) {
  for (const type of ['pickaxe', 'axe', 'shovel']) {
    sprite(`${tier}_${type}`, TOOL_SHAPES[type], TOOL_TIERS[tier], 12);
  }
}

for (const tier of Object.keys(ARMOUR_TIERS)) {
  for (const piece of Object.keys(ARMOUR_SHAPES)) {
    sprite(`${tier}_${piece}`, ARMOUR_SHAPES[piece], ARMOUR_TIERS[tier], 10);
  }
}

sprite('stick', STICK_SHAPE, { s: '#7a5a33', t: '#5b4126', l: '#a07c4c' }, 14);
// Coal sits a few steps above true black: a #0b0b0f lump vanishes against the
// inventory's dark panel, and the silhouette matters more than the realism.
sprite('coal', COAL_SHAPE, { k: '#2b2b34', d: '#141419', l: '#5e5e6e' }, 16);
sprite('raw_iron', NUGGET_SHAPE, { n: '#c98f6a', d: '#8d5c40', l: '#e8bb9c' }, 18);
sprite('raw_gold', NUGGET_SHAPE, { n: '#dcae38', d: '#a2781b', l: '#f7dd80' }, 18);
sprite('iron_ingot', INGOT_SHAPE, { b: '#b6bcc4', l: '#d9dee4', w: '#f4f8fc', d: '#7c828a' }, 6);
sprite('gold_ingot', INGOT_SHAPE, { b: '#e8c04a', l: '#f6da78', w: '#fff4c2', d: '#a67c1c' }, 6);
sprite('crystal_shard', SHARD_SHAPE, { c: '#3ec6e8', w: '#ccf7ff', d: '#1a7c9a' }, 10);
sprite('volatiles', VOLATILES_SHAPE, { i: '#b6d8ea', w: '#e9f7ff', d: '#7ea9c0', '*': '#ffffff' }, 12);

sprite('algae', ALGAE_SHAPE, { g: '#3f8a3a', G: '#61ba50', d: '#2a5f28' }, 16);
sprite('spore_pod', SPORE_SHAPE, { p: '#6a3f9c', P: '#8f5fc8', w: '#cba8f2', d: '#452870', s: '#5f8a3f' }, 12);
sprite('nutrient_paste', PASTE_SHAPE, {
  c: '#9aa3ad', b: '#d8dee4', l: '#f1f5f9', d: '#767e88', g: '#5fa84a',
}, 8);
sprite('ration', RATION_SHAPE, {
  c: '#b8bfc6', s: '#ced5db', l: '#eef2f6', d: '#8b9299', o: '#e8802a',
}, 8);

sprite('oxygen_canister', CANISTER_SHAPE, {
  v: '#9aa3ad', b: '#2f7fd0', l: '#6fb2ec', d: '#1b4d88', w: '#e9f2fa',
}, 8);
sprite('medkit', MEDKIT_SHAPE, {
  h: '#9aa3ad', w: '#eef2f6', d: '#89909a', r: '#d8332e',
}, 6);

/** Stable draw order for contact sheets and recipe-book listings. */
export const SPRITE_KEYS = Object.keys(SPRITES);

/** @returns {boolean} true when this item key has hand-authored pixel art. */
export function hasSprite(itemKey) {
  return SPRITES[itemKey] !== undefined;
}

/**
 * Paint one sprite as raw RGBA bytes. Pure and DOM-free so it is unit-testable
 * in Node, exactly like textures.js tilePixels().
 * @returns {Uint8Array} SPRITE*SPRITE*4 bytes, alpha is always 0 or 255.
 */
export function itemPixels(itemKey) {
  const spec = SPRITES[itemKey];
  if (!spec) throw new Error(`itemart: no sprite for item '${itemKey}'`);
  const { shape } = spec;
  const dither = spec.dither ?? 12;

  if (shape.length !== SPRITE) throw new Error(`itemart: '${itemKey}' has ${shape.length} rows`);
  const pal = {};
  for (const ch of Object.keys(spec.palette)) pal[ch] = hex(spec.palette[ch]);

  const rnd = prng(strSeed(itemKey));
  const buf = new Uint8Array(SPRITE * SPRITE * 4);

  for (let y = 0; y < SPRITE; y++) {
    const row = shape[y];
    if (row.length !== SPRITE) throw new Error(`itemart: '${itemKey}' row ${y} is ${row.length} wide`);
    // A flat fill reads like a vinyl sticker next to the noisy block icons, so
    // every pixel gets a seeded wobble plus a top-lit vertical ramp. The PRNG is
    // stepped for transparent pixels too, which pins the noise to the grid
    // rather than to fill order - two tiers of the same tool then dither
    // identically and only the hue changes.
    const lift = 1.11 - 0.22 * (y / (SPRITE - 1));
    for (let x = 0; x < SPRITE; x++) {
      const n = (rnd() - 0.5) * 2 * dither;
      const ch = row[x];
      if (ch === ' ') continue;
      const base = pal[ch];
      if (!base) throw new Error(`itemart: '${itemKey}' uses '${ch}' with no palette entry`);
      // Bottom-most pixel of a column: darken it into a contact shadow so the
      // silhouette still has volume at 48px without an explicit outline.
      const grounded = y === SPRITE - 1 || shape[y + 1][x] === ' ';
      const k = grounded ? lift * 0.78 : lift;
      const o = (y * SPRITE + x) * 4;
      buf[o] = clamp255(base[0] * k + n);
      buf[o + 1] = clamp255(base[1] * k + n);
      buf[o + 2] = clamp255(base[2] * k + n);
      buf[o + 3] = 255;
    }
  }
  return buf;
}

// ------------------------------------------------------------------ DOM side

// Cache of *master* canvases, keyed itemId + ':' + size. Callers never get one
// of these back - see itemSprite().
const spriteCache = new Map();

function canvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

function upscale(px, size) {
  const src = canvas(SPRITE);
  const img = new ImageData(new Uint8ClampedArray(px.buffer, px.byteOffset, px.length), SPRITE, SPRITE);
  src.getContext('2d').putImageData(img, 0, 0);

  const c = canvas(size);
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;   // nearest-neighbour keeps the pixels square
  g.drawImage(src, 0, 0, SPRITE, SPRITE, 0, 0, size, size);
  return c;
}

/** Last-resort tile so a missing sprite shows as a gap, never as a thrown UI. */
function placeholder(size) {
  const c = canvas(size);
  const g = c.getContext('2d');
  const pad = Math.max(1, Math.round(size * 0.14));
  g.fillStyle = '#4a4a56';
  g.fillRect(pad, pad, size - pad * 2, size - pad * 2);
  g.fillStyle = '#8a8a9a';
  g.fillRect(pad * 2, pad * 2, size - pad * 4, size - pad * 4);
  return c;
}

/** Paint the one canvas per itemId+size that every copy is stamped from. */
function master(itemId, size) {
  const item = ITEMS[itemId];
  // Item 0 is the empty slot. It must be blank, not the grey "missing art" chip,
  // or a caller that skips its own emptiness check paints boxes over the UI.
  if (!item || item.kind === 'none') return canvas(size);
  if (item.kind === 'block') {
    // A block whose texture recipe is missing must not take the whole inventory
    // render down with it - the slot degrades to the placeholder instead.
    try {
      return blockIcon(item.blockId ?? itemId, size);
    } catch {
      return placeholder(size);
    }
  }
  if (hasSprite(item.key)) return upscale(itemPixels(item.key), size);
  return placeholder(size);
}

/**
 * One call for any slot: block items become isometric cubes from icons.js,
 * everything else becomes pixel art from this module.
 *
 * The rasterisation is cached per itemId+size, but the returned canvas is always
 * a fresh node. A DOM element can only have one parent, so handing out the
 * cached canvas would make the second slot holding an item yank the icon out of
 * the first - and since the HUD hotbar and the inventory grid both draw at 44px,
 * opening the inventory would empty the hotbar for good. Stamping a copy costs
 * one 1:1 drawImage, and every call site already redraws only on item change.
 * @returns {HTMLCanvasElement}
 */
export function itemSprite(itemId, size = 48) {
  const cacheKey = itemId + ':' + size;
  let src = spriteCache.get(cacheKey);
  if (!src) {
    src = master(itemId, size);
    spriteCache.set(cacheKey, src);
  }

  const c = canvas(size);
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(src, 0, 0);
  return c;
}
