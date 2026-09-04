// Isometric block icons for the hotbar, drawn straight from the procedural
// texture tiles - the same pixels the world is textured with, so the icon always
// matches the block you are about to place.

import { BLOCKS } from './blocks.js';
import { tilePixels, TILE } from './textures.js';

const tileCanvasCache = new Map();
const iconCache = new Map();

function tileCanvas(name) {
  let c = tileCanvasCache.get(name);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = c.height = TILE;
  const px = tilePixels(name);
  const img = new ImageData(new Uint8ClampedArray(px.buffer, px.byteOffset, px.length), TILE, TILE);
  c.getContext('2d').putImageData(img, 0, 0);
  tileCanvasCache.set(name, c);
  return c;
}

/** @returns {HTMLCanvasElement} a `size` px isometric cube for block `id`. */
export function blockIcon(id, size = 52) {
  const cacheKey = id + ':' + size;
  const hit = iconCache.get(cacheKey);
  if (hit) return hit;

  const block = BLOCKS[id];
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;

  const w = size * 0.42;          // half width
  const h = w * 0.5;              // rhombus half height
  const cx = size / 2, cy = size / 2 - h * 0.35;

  const face = (name, O, U, V, brightness) => {
    g.save();
    g.filter = `brightness(${brightness})`;
    g.setTransform(U[0], U[1], V[0], V[1], cx + O[0], cy + O[1]);
    g.drawImage(tileCanvas(name), 0, 0, TILE, TILE, 0, 0, 1, 1);
    g.restore();
    g.setTransform(1, 0, 0, 1, 0, 0);
  };

  // top, left, right - lit like the world's FACE_SHADE table
  face(block.tex[0], [-w, -h], [w, h], [w, -h], 1.0);
  face(block.tex[1], [-w, -h], [w, h], [0, w], 0.72);
  face(block.tex[1], [0, 0], [w, -h], [0, w], 0.86);

  iconCache.set(cacheKey, c);
  return c;
}
