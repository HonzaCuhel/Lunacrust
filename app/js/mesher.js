// Chunk meshing: voxels -> triangles.
//
// Only faces that touch something see-through are emitted, which throws away
// ~95% of a chunk's 196 608 potential faces. Vertex colours carry both ambient
// occlusion and a cheap sky-depth term, so caves go dark and block corners get
// contact shading without a single dynamic light.

import { BLOCKS, AIR } from './blocks.js';
import { TILE_INDEX, tileUV } from './textures.js';
import { CHUNK_SX, CHUNK_SZ, WORLD_H } from './worldgen.js';

export const PAD = 1;
export const PX = CHUNK_SX + PAD * 2;   // 18
export const PZ = CHUNK_SZ + PAD * 2;   // 18
export const pIndex = (x, y, z) => x + z * PX + y * (PX * PZ);
export const PADDED_VOLUME = PX * PZ * WORLD_H;

// Per-face brightness: a flat sun would make every cube look like a silhouette.
const FACE_SHADE = [0.72, 0.72, 1.0, 0.46, 0.86, 0.86]; // +X -X +Y -Y +Z -Z

const FACES = [
  { dir: [1, 0, 0], corners: [[1, 1, 1], [1, 0, 1], [1, 1, 0], [1, 0, 0]], uv: [[0, 1], [0, 0], [1, 1], [1, 0]] },
  { dir: [-1, 0, 0], corners: [[0, 1, 0], [0, 0, 0], [0, 1, 1], [0, 0, 1]], uv: [[0, 1], [0, 0], [1, 1], [1, 0]] },
  { dir: [0, 1, 0], corners: [[0, 1, 1], [1, 1, 1], [0, 1, 0], [1, 1, 0]], uv: [[0, 0], [1, 0], [0, 1], [1, 1]] },
  { dir: [0, -1, 0], corners: [[1, 0, 1], [0, 0, 1], [1, 0, 0], [0, 0, 0]], uv: [[1, 0], [0, 0], [1, 1], [0, 1]] },
  { dir: [0, 0, 1], corners: [[0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]], uv: [[0, 0], [1, 0], [0, 1], [1, 1]] },
  { dir: [0, 0, -1], corners: [[1, 0, 0], [0, 0, 0], [1, 1, 0], [0, 1, 0]], uv: [[0, 0], [1, 0], [0, 1], [1, 1]] },
];

// Precomputed per-face tangent axes + per-corner AO probe offsets.
const AO_PROBES = FACES.map((f) => {
  const axis = f.dir[0] !== 0 ? 0 : f.dir[1] !== 0 ? 1 : 2;
  const t1 = (axis + 1) % 3, t2 = (axis + 2) % 3;
  return f.corners.map((c) => {
    const s1 = c[t1] * 2 - 1, s2 = c[t2] * 2 - 1;
    const mk = (a, b) => {
      const o = [f.dir[0], f.dir[1], f.dir[2]];
      if (a) o[t1] += s1;
      if (b) o[t2] += s2;
      return o;
    };
    return { side1: mk(1, 0), side2: mk(0, 1), corner: mk(1, 1) };
  });
});

const TEX_TILES = BLOCKS.map((b) => b.tex.map((t) => TILE_INDEX.get(t) ?? 0));
const UV_RECT = BLOCKS.map((b) => b.tex.map((t) => tileUV(TILE_INDEX.get(t) ?? 0)));
const IS_OPAQUE = Uint8Array.from(BLOCKS.map((b) => (b.opaque ? 1 : 0)));
const IS_LIQUID = Uint8Array.from(BLOCKS.map((b) => (b.liquid ? 1 : 0)));
const IS_CUTOUT = Uint8Array.from(BLOCKS.map((b) => (b.cutout ? 1 : 0)));
const LIGHT = Float32Array.from(BLOCKS.map((b) => b.light));
// Water/lava/glass go in a second, transparent pass; leaves stay in the opaque
// pass because alpha *testing* is cheap and needs no back-to-front sorting.
const IS_TRANSPARENT = Uint8Array.from(BLOCKS.map((b) => (!b.opaque && !b.cutout && b.id !== AIR ? 1 : 0)));

class MeshBuilder {
  constructor(cap = 4096) {
    this.pos = new Float32Array(cap * 3);
    this.norm = new Float32Array(cap * 3);
    this.uv = new Float32Array(cap * 2);
    this.col = new Float32Array(cap * 3);
    this.idx = new Uint32Array(cap * 2);
    this.v = 0;
    this.i = 0;
  }
  ensure(verts, indices) {
    if ((this.v + verts) * 3 > this.pos.length) this.growVerts();
    if (this.i + indices > this.idx.length) {
      const n = new Uint32Array(this.idx.length * 2);
      n.set(this.idx); this.idx = n;
    }
  }
  growVerts() {
    const grow = (arr, comps) => { const n = new (arr.constructor)(arr.length * 2); n.set(arr); return n; };
    this.pos = grow(this.pos); this.norm = grow(this.norm);
    this.uv = grow(this.uv); this.col = grow(this.col);
  }
  get empty() { return this.i === 0; }
  finish() {
    return {
      pos: this.pos.slice(0, this.v * 3),
      norm: this.norm.slice(0, this.v * 3),
      uv: this.uv.slice(0, this.v * 2),
      col: this.col.slice(0, this.v * 3),
      idx: this.idx.slice(0, this.i),
    };
  }
}

/** Standard three-sample voxel AO: two edges plus the diagonal. */
function vertexAO(s1, s2, c) {
  if (s1 && s2) return 0;
  return 3 - (s1 + s2 + c);
}

/**
 * @param {Uint8Array} pad  padded 18 x WORLD_H x 18 voxel volume
 * @param {{lightTint?:[number,number,number], skyFade?:number}} opts
 */
export function meshChunk(pad, opts = {}) {
  const tint = opts.lightTint ?? [1, 1, 1];
  const skyFade = opts.skyFade ?? 0.032;
  const opaque = new MeshBuilder(8192);
  const trans = new MeshBuilder(1024);

  // Column heights over the padded area drive the "how deep am I?" darkening.
  const raw = new Int16Array(PX * PZ);
  for (let z = 0; z < PZ; z++) {
    for (let x = 0; x < PX; x++) {
      let top = 0;
      for (let y = WORLD_H - 1; y >= 0; y--) {
        if (IS_OPAQUE[pad[pIndex(x, y, z)]]) { top = y; break; }
      }
      raw[x + z * PX] = top;
    }
  }
  // Take the minimum over each 3x3 neighbourhood. Without this, a single 1x1
  // tree trunk casts a black stripe all the way down its own column: sky access
  // is really about the opening around you, not the one block overhead.
  const heights = new Int16Array(PX * PZ);
  for (let z = 0; z < PZ; z++) {
    for (let x = 0; x < PX; x++) {
      let m = raw[x + z * PX];
      for (let dz = -1; dz <= 1; dz++) {
        const zz = z + dz;
        if (zz < 0 || zz >= PZ) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= PX) continue;
          const v = raw[xx + zz * PX];
          if (v < m) m = v;
        }
      }
      heights[x + z * PX] = m;
    }
  }

  const solidAt = (x, y, z) => {
    if (y < 0) return 1;
    if (y >= WORLD_H || x < 0 || z < 0 || x >= PX || z >= PZ) return 0;
    return IS_OPAQUE[pad[pIndex(x, y, z)]];
  };

  for (let y = 0; y < WORLD_H; y++) {
    for (let z = PAD; z < PZ - PAD; z++) {
      for (let x = PAD; x < PX - PAD; x++) {
        const id = pad[pIndex(x, y, z)];
        if (id === AIR) continue;
        const transparent = IS_TRANSPARENT[id];
        const target = transparent ? trans : opaque;
        const emissive = LIGHT[id];

        for (let f = 0; f < 6; f++) {
          const face = FACES[f];
          const nx = x + face.dir[0], ny = y + face.dir[1], nz = z + face.dir[2];
          if (ny < 0 || ny >= WORLD_H) continue;
          const nid = (nx < 0 || nz < 0 || nx >= PX || nz >= PZ) ? AIR : pad[pIndex(nx, ny, nz)];

          if (transparent) {
            if (nid === id) continue;                    // no interior water walls
            if (IS_OPAQUE[nid]) continue;
            if (IS_LIQUID[nid] && IS_LIQUID[id]) continue;
          } else if (IS_CUTOUT[id]) {
            if (IS_OPAQUE[nid] || nid === id) continue;
          } else if (IS_OPAQUE[nid]) {
            continue;
          }

          // sky depth of the *air* side of the face
          const col = heights[Math.min(PX - 1, Math.max(0, nx)) + Math.min(PZ - 1, Math.max(0, nz)) * PX];
          const depth = Math.max(0, col - ny);
          const sky = Math.max(0.38, 1 - depth * skyFade);

          const shade = FACE_SHADE[f];
          const rect = UV_RECT[id][f === 2 ? 0 : f === 3 ? 2 : 1];
          const probes = AO_PROBES[f];
          const ao = [0, 0, 0, 0];
          for (let c = 0; c < 4; c++) {
            const p = probes[c];
            ao[c] = vertexAO(
              solidAt(x + p.side1[0], y + p.side1[1], z + p.side1[2]),
              solidAt(x + p.side2[0], y + p.side2[1], z + p.side2[2]),
              solidAt(x + p.corner[0], y + p.corner[1], z + p.corner[2]),
            );
          }

          target.ensure(4, 6);
          const base = target.v;
          for (let c = 0; c < 4; c++) {
            const cp = face.corners[c];
            const o3 = (base + c) * 3, o2 = (base + c) * 2;
            target.pos[o3] = x - PAD + cp[0];
            target.pos[o3 + 1] = y + cp[1];
            target.pos[o3 + 2] = z - PAD + cp[2];
            target.norm[o3] = face.dir[0];
            target.norm[o3 + 1] = face.dir[1];
            target.norm[o3 + 2] = face.dir[2];
            target.uv[o2] = rect[0] + face.uv[c][0] * rect[2];
            target.uv[o2 + 1] = rect[1] + face.uv[c][1] * rect[3];
            const aoAmt = 0.58 + (ao[c] / 3) * 0.42;
            const lum = Math.min(1.35, shade * aoAmt * sky + emissive * 1.1);
            target.col[o3] = lum * tint[0];
            target.col[o3 + 1] = lum * tint[1];
            target.col[o3 + 2] = lum * tint[2];
          }
          target.v += 4;

          // Flip the split so the AO gradient runs along the darker diagonal;
          // otherwise strongly-occluded corners show an obvious triangle seam.
          const flip = ao[0] + ao[3] > ao[1] + ao[2];
          const i = target.i;
          if (flip) {
            target.idx[i] = base + 1; target.idx[i + 1] = base + 3; target.idx[i + 2] = base;
            target.idx[i + 3] = base + 3; target.idx[i + 4] = base + 2; target.idx[i + 5] = base;
          } else {
            target.idx[i] = base; target.idx[i + 1] = base + 1; target.idx[i + 2] = base + 2;
            target.idx[i + 3] = base + 2; target.idx[i + 4] = base + 1; target.idx[i + 5] = base + 3;
          }
          target.i += 6;
        }
      }
    }
  }

  return {
    opaque: opaque.empty ? null : opaque.finish(),
    transparent: trans.empty ? null : trans.finish(),
  };
}
