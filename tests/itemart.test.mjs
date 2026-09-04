// itemart: every non-block item must have readable, deterministic pixel art.
//
// itemPixels() is deliberately DOM-free, so the whole art pass is checked here
// without a browser. The contact sheet at the end is the part a human still has
// to judge - the assertions can only prove a sprite is not blank, not that it
// looks like a pickaxe.

import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SPRITE, SPRITE_KEYS, itemPixels, hasSprite } from '../app/js/itemart.js';
import { ITEMS, ITEM_BY_KEY } from '../app/js/items.js';

// Derived from the registry rather than hard-coded: the point of this check is
// that art and items cannot drift apart, and a literal list only catches that
// until somebody adds an item and edits the list to match. Adding an item now
// fails here until it has a sprite - which is exactly how the twelve armour
// pieces were caught.
const EXPECTED = ITEMS
  .filter((it) => it && it.kind !== 'block' && it.kind !== 'none')
  .map((it) => it.key);

assert.equal(SPRITE, 16);
assert.ok(EXPECTED.length >= 27, `expected the non-block registry to be sizeable, got ${EXPECTED.length}`);

// ---- the art covers exactly the non-block half of the item registry ---------
for (const key of EXPECTED) {
  assert.ok(hasSprite(key), `missing sprite for ${key}`);
  assert.ok(ITEM_BY_KEY.has(key), `${key} is not a real item id`);
}
assert.deepEqual([...SPRITE_KEYS].sort(), [...EXPECTED].sort());

// Nothing that needs art may slip through: every item that is not a block and
// not the empty slot has to be drawable, or the inventory shows a grey box.
for (const item of ITEMS) {
  if (!item || item.kind === 'block' || item.kind === 'none') continue;
  assert.ok(hasSprite(item.key), `non-block item ${item.key} has no sprite`);
}
// ...and no block item may claim a sprite, since those go through blockIcon.
assert.equal(hasSprite('stone'), false);
assert.equal(hasSprite('grass'), false);
assert.equal(hasSprite('definitely_not_an_item'), false);
assert.throws(() => itemPixels('definitely_not_an_item'), /no sprite/);

// ---- buffer shape, coverage and colour sanity -------------------------------
const pixels = new Map();
for (const key of EXPECTED) {
  const px = itemPixels(key);
  pixels.set(key, px);

  assert.ok(px instanceof Uint8Array, `${key} must return a Uint8Array`);
  assert.equal(px.length, SPRITE * SPRITE * 4, `${key} buffer size`);

  let opaque = 0;
  for (let i = 0; i < px.length; i += 4) {
    for (let c = 0; c < 4; c++) {
      const v = px[i + c];
      assert.ok(Number.isInteger(v) && v >= 0 && v <= 255, `${key} channel out of range: ${v}`);
    }
    const a = px[i + 3];
    assert.ok(a === 0 || a === 255, `${key} has partial alpha ${a}`);
    if (a === 255) {
      opaque++;
    } else {
      // A transparent pixel must be fully cleared, or upscaling smears colour
      // out of the silhouette on canvases that premultiply.
      assert.equal(px[i] + px[i + 1] + px[i + 2], 0, `${key} has colour under a transparent pixel`);
    }
  }

  const fill = opaque / (SPRITE * SPRITE);
  assert.ok(fill >= 0.15, `${key} is nearly blank (${(fill * 100).toFixed(1)}%)`);
  assert.ok(fill <= 0.92, `${key} is a solid square (${(fill * 100).toFixed(1)}%)`);
}

// ---- tiers share a silhouette but never share pixels -------------------------
const same = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const alphaOf = (px) => px.filter((_, i) => i % 4 === 3);

for (const type of ['pickaxe', 'axe', 'shovel']) {
  const tiers = ['wood', 'stone', 'iron', 'crystal'].map((t) => `${t}_${type}`);
  for (let i = 0; i < tiers.length; i++) {
    for (let j = i + 1; j < tiers.length; j++) {
      const a = pixels.get(tiers[i]), b = pixels.get(tiers[j]);
      assert.ok(!same(a, b), `${tiers[i]} and ${tiers[j]} are identical`);
      // Same shape, different metal - the alpha mask has to match exactly.
      assert.ok(same(alphaOf(a), alphaOf(b)), `${tiers[i]} and ${tiers[j]} silhouettes differ`);
    }
  }
}
// Different tool types must not share a silhouette.
assert.ok(!same(alphaOf(pixels.get('iron_pickaxe')), alphaOf(pixels.get('iron_axe'))));
assert.ok(!same(alphaOf(pixels.get('iron_axe')), alphaOf(pixels.get('iron_shovel'))));
assert.ok(!same(alphaOf(pixels.get('hand_drill')), alphaOf(pixels.get('iron_pickaxe'))));

// ---- determinism, and no shared mutable buffer -------------------------------
const again = itemPixels('ration');
assert.ok(same(again, pixels.get('ration')), 'itemPixels is not deterministic');
assert.notEqual(again, pixels.get('ration'), 'itemPixels handed back a shared buffer');
again[0] = 1;
assert.ok(same(itemPixels('ration'), pixels.get('ration')), 'a caller mutated the cached art');

// ---- clamping, not wrapping ---------------------------------------------------
// The medkit's white is #eef2f6 and the top-lit ramp pushes it past 255; if the
// clamp were a bare `| 0` those pixels would wrap to near-black instead.
const medkit = pixels.get('medkit');
let brightest = 0;
for (let i = 0; i < medkit.length; i += 4) if (medkit[i + 3] === 255) brightest = Math.max(brightest, medkit[i]);
assert.ok(brightest >= 240, `medkit white wrapped instead of clamping (max r=${brightest})`);

// Coal has to stay dark but must not be a black hole against the dark UI panel.
const coal = pixels.get('coal');
let coalMax = 0;
for (let i = 0; i < coal.length; i += 4) if (coal[i + 3] === 255) coalMax = Math.max(coalMax, coal[i + 1]);
assert.ok(coalMax > 20 && coalMax < 140, `coal luminance off (max g=${coalMax})`);

// ---- the DOM half, on a stub canvas -------------------------------------------
// itemSprite() hands its result straight to appendChild(), and a DOM node can
// only sit in one parent. The hotbar and the inventory grid both draw at 44px,
// so if the cached canvas itself were returned, opening the inventory would move
// the hotbar's icons into the panel and leave the hotbar blank. Cheap to stub,
// and it is the exact failure a pure test cannot see.
{
  let nextId = 0;
  const makeCtx = () => ({
    imageSmoothingEnabled: true,
    drawn: [],
    fills: 0,
    putImageData() {},
    drawImage(src) { this.drawn.push(src.id); },
    fillRect() { this.fills++; },
    save() {}, restore() {}, setTransform() {},
    set fillStyle(_v) {}, get fillStyle() { return '#000'; },
    set filter(_v) {}, get filter() { return 'none'; },
  });
  globalThis.ImageData = class { constructor(data, w, h) { Object.assign(this, { data, width: w, height: h }); } };
  globalThis.document = {
    createElement() {
      const ctx = makeCtx();
      return { id: ++nextId, width: 0, height: 0, ctx, getContext: () => ctx };
    },
  };

  const { itemSprite } = await import('../app/js/itemart.js');
  const { itemIdOf } = await import('../app/js/items.js');

  for (const key of ['ration', 'iron_pickaxe', 'stone', 'dirt']) {
    const id = itemIdOf(key);
    assert.ok(id > 0, `${key} should be a real item`);
    const a = itemSprite(id, 44);
    const b = itemSprite(id, 44);
    assert.notEqual(a, b, `${key}: itemSprite handed back a shared DOM node`);
    assert.equal(a.width, 44);
    assert.equal(a.height, 44);
    assert.equal(a.ctx.imageSmoothingEnabled, false, `${key}: smoothing left on`);
    // Distinct nodes, but both stamped from the one cached master.
    assert.deepEqual(a.ctx.drawn, b.ctx.drawn, `${key}: copies came from different masters`);
    assert.equal(a.ctx.drawn.length, 1, `${key}: a copy should be one drawImage`);
  }

  assert.equal(itemSprite(itemIdOf('ration')).width, 48, 'default size must be 48');

  // The empty slot is blank, never the grey "missing art" chip.
  const empty = itemSprite(0, 44);
  assert.equal(empty.ctx.fills, 0, 'item 0 must render blank, not a placeholder box');
  assert.equal(empty.ctx.drawn.length, 1);

  // Nothing in the registry may throw mid-render and take the inventory down.
  for (let id = 0; id < ITEMS.length; id++) {
    if (!ITEMS[id]) continue;
    const node = itemSprite(id, 32);
    assert.equal(node.width, 32, `item ${id} rendered at the wrong size`);
  }

  delete globalThis.document;
  delete globalThis.ImageData;
}

// ---- contact sheet -----------------------------------------------------------
// Same minimal PNG encoder as tools/atlas-preview.js: zlib is in node, so no
// image dependency is needed just to eyeball the art.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const SCALE = 4, GAP = 4, COLS = 7;
const CELL = SPRITE * SCALE;
const rows = Math.ceil(EXPECTED.length / COLS);
const W = GAP + COLS * (CELL + GAP);
const H = GAP + rows * (CELL + GAP);
const sheet = new Uint8Array(W * H * 4);

// Checkerboard ground so transparent pixels are obviously transparent.
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const dark = (((x >> 3) + (y >> 3)) & 1) === 0;
    const o = (y * W + x) * 4;
    sheet[o] = dark ? 0x20 : 0x2c;
    sheet[o + 1] = dark ? 0x20 : 0x2c;
    sheet[o + 2] = dark ? 0x28 : 0x36;
    sheet[o + 3] = 255;
  }
}

EXPECTED.forEach((key, i) => {
  const px = pixels.get(key);
  const ox = GAP + (i % COLS) * (CELL + GAP);
  const oy = GAP + ((i / COLS) | 0) * (CELL + GAP);
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) {
      const so = (((y / SCALE) | 0) * SPRITE + ((x / SCALE) | 0)) * 4;
      if (!px[so + 3]) continue;
      const d = ((oy + y) * W + ox + x) * 4;
      sheet[d] = px[so]; sheet[d + 1] = px[so + 1]; sheet[d + 2] = px[so + 2]; sheet[d + 3] = 255;
    }
  }
});

const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0;
  Buffer.from(sheet.buffer, y * W * 4, W * 4).copy(raw, y * (W * 4 + 1) + 1);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
]);

const out = fileURLToPath(new URL('../output/itemart-sheet.png', import.meta.url));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);

console.log(`itemart: ${EXPECTED.length} sprites, ${SPRITE}x${SPRITE} each - sheet ${W}x${H} at ${out}`);
