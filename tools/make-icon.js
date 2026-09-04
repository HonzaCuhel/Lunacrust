// Draws the app icon procedurally - no image editor, same spirit as the game's
// textures. Renders at 2x and box-downsamples, because every edge here is a
// circle or a squircle and pure-JS rasterisation has no anti-aliasing of its own.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = process.argv[2] ?? join(ROOT, 'build', 'icon.png');
const SIZE = 1024;
const SS = 2;                 // supersample factor
const N = SIZE * SS;

const buf = new Float32Array(N * N * 4);   // premultiplied-ish RGBA, 0..255

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function put(x, y, rgb, a = 1) {
  if (x < 0 || y < 0 || x >= N || y >= N || a <= 0) return;
  const o = (y * N + x) * 4;
  const inv = 1 - a;
  buf[o] = buf[o] * inv + rgb[0] * a;
  buf[o + 1] = buf[o + 1] * inv + rgb[1] * a;
  buf[o + 2] = buf[o + 2] * inv + rgb[2] * a;
  buf[o + 3] = clamp(buf[o + 3] * inv + 255 * a, 0, 255);
}

/** Signed distance to a rounded rectangle, negative inside. */
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

// --- deterministic starfield ------------------------------------------------
let seed = 20240820;
const rnd = () => {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 4294967296;
};

// --- 1. the squircle plate --------------------------------------------------
const pad = N * 0.055;
const plateR = N * 0.225;
const top = hex('#101a44'), bottom = hex('#04050e');
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    const d = sdRoundRect(x, y, N / 2, N / 2, N / 2 - pad, N / 2 - pad, plateR);
    if (d > 1) continue;
    const cover = clamp(0.5 - d, 0, 1);
    const t = y / N;
    let c = mix(top, bottom, Math.pow(t, 0.75));
    // faint aurora glow in the upper third
    const g = Math.max(0, 1 - Math.hypot(x - N * 0.42, y - N * 0.24) / (N * 0.55));
    c = mix(c, hex('#2b4fa8'), g * g * 0.35);
    put(x, y, c, cover);
  }
}

// --- 2. stars ---------------------------------------------------------------
for (let i = 0; i < 260; i++) {
  const x = rnd() * N, y = rnd() * N;
  if (sdRoundRect(x, y, N / 2, N / 2, N / 2 - pad, N / 2 - pad, plateR) > -6) continue;
  const r = 1 + rnd() * 2.6 * SS;
  const b = 150 + rnd() * 105;
  for (let dy = -3 * SS; dy <= 3 * SS; dy++) {
    for (let dx = -3 * SS; dx <= 3 * SS; dx++) {
      const a = clamp(1 - Math.hypot(dx, dy) / r, 0, 1);
      if (a > 0) put(Math.round(x + dx), Math.round(y + dy), [b, b, b * 1.02], a * 0.9);
    }
  }
}

// --- 3. the planet ----------------------------------------------------------
const pcx = N * 0.44, pcy = N * 0.43, pr = N * 0.245;
const base = hex('#d8a86a'), band = hex('#a8713c'), pale = hex('#f0dcc0');
for (let y = Math.floor(pcy - pr - 4); y <= pcy + pr + 4; y++) {
  for (let x = Math.floor(pcx - pr - 4); x <= pcx + pr + 4; x++) {
    const d = Math.hypot(x - pcx, y - pcy) - pr;
    if (d > 1) continue;
    const cover = clamp(0.5 - d, 0, 1);
    const v = (y - (pcy - pr)) / (pr * 2);
    const wob = Math.sin(v * 26 + Math.sin(v * 7) * 1.4);
    let c = mix(base, wob > 0.15 ? band : pale, Math.abs(wob) * 0.55);
    // limb darkening + terminator from the upper left
    const nx = (x - pcx) / pr, ny = (y - pcy) / pr;
    const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
    const lit = clamp(nx * -0.45 + ny * -0.5 + nz * 0.74, 0, 1);
    c = mix([6, 8, 20], c, 0.22 + lit * 0.78);
    put(x, y, c, cover);
  }
}
// the storm spot, and a cyan rim light along the lit edge
for (let y = Math.floor(pcy - pr); y <= pcy + pr; y++) {
  for (let x = Math.floor(pcx - pr); x <= pcx + pr; x++) {
    const ex = (x - (pcx + pr * 0.22)) / (pr * 0.3);
    const ey = (y - (pcy + pr * 0.26)) / (pr * 0.16);
    if (ex * ex + ey * ey < 1 && Math.hypot(x - pcx, y - pcy) < pr) {
      put(x, y, hex('#b4543a'), 0.55 * (1 - Math.sqrt(ex * ex + ey * ey)));
    }
  }
}
for (let a = 0; a < 4400; a++) {
  const th = (a / 4400) * Math.PI * 2;
  const lit = clamp(Math.cos(th + 2.35), 0, 1);
  if (lit <= 0.02) continue;
  for (let k = -2 * SS; k <= 2 * SS; k++) {
    const r = pr + k * 0.5;
    put(Math.round(pcx + Math.cos(th) * r), Math.round(pcy + Math.sin(th) * r),
      hex('#7fe6ff'), lit * 0.5 * clamp(1 - Math.abs(k) / (2 * SS), 0, 1));
  }
}

// --- 4. original lunar navigation glyph: a faceted silver wayfinder ---------
// Two angular chevrons form a landing marker, not a textured voxel block.
function triangle(ax, ay, bx, by, cx, cy, color) {
  const edge = (x1,y1,x2,y2,x,y) => (x-x1)*(y2-y1)-(y-y1)*(x2-x1);
  const sign = edge(ax,ay,bx,by,cx,cy) < 0 ? -1 : 1;
  for (let y=Math.floor(Math.min(ay,by,cy)); y<=Math.ceil(Math.max(ay,by,cy)); y++) {
    for (let x=Math.floor(Math.min(ax,bx,cx)); x<=Math.ceil(Math.max(ax,bx,cx)); x++) {
      if (sign*edge(ax,ay,bx,by,x,y)>=0 && sign*edge(bx,by,cx,cy,x,y)>=0 && sign*edge(cx,cy,ax,ay,x,y)>=0) put(x,y,color);
    }
  }
}
const gx=N*.70, gy=N*.67, gw=N*.17, gh=N*.24;
triangle(gx,gy-gh,gx-gw,gy+gh*.64,gx,gy+gh*.20,hex('#eff9fc'));
triangle(gx,gy-gh,gx+gw,gy+gh*.64,gx,gy+gh*.20,hex('#75b7c7'));
triangle(gx-gw*.49,gy+gh*.83,gx+gw*.49,gy+gh*.83,gx,gy+gh*1.04,hex('#e9b96d'));

// --- downsample and encode --------------------------------------------------
const out = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const o = ((y * SS + sy) * N + (x * SS + sx)) * 4;
        r += buf[o]; g += buf[o + 1]; b += buf[o + 2]; a += buf[o + 3];
      }
    }
    const n = SS * SS, o = (y * SIZE + x) * 4;
    out[o] = clamp(r / n, 0, 255); out[o + 1] = clamp(g / n, 0, 255);
    out[o + 2] = clamp(b / n, 0, 255); out[o + 3] = clamp(a / n, 0, 255);
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b) => {
  let c = 0xffffffff;
  for (const v of b) c = crcTable[(c ^ v) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  out.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6;
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
]));
console.log('wrote', OUT, SIZE + 'x' + SIZE);
