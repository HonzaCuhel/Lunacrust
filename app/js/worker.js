// Chunk worker: owns terrain generation and meshing so the render loop never
// blocks. The main thread keeps a mirror copy of the voxels for physics and
// ray-picking; both sides apply edits deterministically, so they stay in sync
// without shipping the world back and forth.

import { WorldGen, CHUNK_SX, CHUNK_SZ, WORLD_H, vIndex } from './worldgen.js';
import { meshChunk, pIndex, PADDED_VOLUME, PX, PZ, PAD } from './mesher.js';

let gen = null;
let tint = [1, 1, 1];
let skyFade = 0.055;
const chunks = new Map();          // "cx,cz" -> Uint8Array
const edits = new Map();           // "cx,cz" -> Map(voxelIndex -> blockId)
const queue = [];                  // pending [cx, cz], nearest-first
let pumping = false;
let center = { x: 0, z: 0 };
let radius = 8;

const key = (cx, cz) => cx + ',' + cz;

function voxels(cx, cz) {
  const k = key(cx, cz);
  let v = chunks.get(k);
  if (!v) {
    v = gen.generate(cx, cz);
    // Terrain is a pure function of the seed, so a regenerated chunk comes back
    // pristine - the player's changes have to be replayed on top every time it
    // is rebuilt, or walking away and back erases whatever they built.
    const e = edits.get(k);
    if (e) for (const [i, id] of e) v[i] = id;
    chunks.set(k, v);
  }
  return v;
}

const scratch = new Uint8Array(PADDED_VOLUME);

/** Copy the chunk plus a one-block skirt of all eight neighbours. */
function buildPadded(cx, cz) {
  scratch.fill(0);
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const src = voxels(cx + dx, cz + dz);
      const x0 = dx === -1 ? CHUNK_SX - PAD : 0;
      const x1 = dx === 1 ? PAD : CHUNK_SX;
      const z0 = dz === -1 ? CHUNK_SZ - PAD : 0;
      const z1 = dz === 1 ? PAD : CHUNK_SZ;
      const ox = dx * CHUNK_SX + PAD;
      const oz = dz * CHUNK_SZ + PAD;
      for (let y = 0; y < WORLD_H; y++) {
        for (let z = z0; z < z1; z++) {
          const pz = oz + z;
          if (pz < 0 || pz >= PZ) continue;
          for (let x = x0; x < x1; x++) {
            const px = ox + x;
            if (px < 0 || px >= PX) continue;
            scratch[pIndex(px, y, pz)] = src[vIndex(x, y, z)];
          }
        }
      }
    }
  }
  return scratch;
}

function emit(cx, cz, withVoxels) {
  const mesh = meshChunk(buildPadded(cx, cz), { lightTint: tint, skyFade });
  const transfer = [];
  const pack = (g) => {
    if (!g) return null;
    transfer.push(g.pos.buffer, g.norm.buffer, g.uv.buffer, g.col.buffer, g.idx.buffer);
    return g;
  };
  const msg = {
    type: 'chunk', cx, cz,
    opaque: pack(mesh.opaque),
    transparent: pack(mesh.transparent),
    voxels: null,
  };
  if (withVoxels) {
    const copy = voxels(cx, cz).slice();
    msg.voxels = copy;
    transfer.push(copy.buffer);
  }
  postMessage(msg, transfer);
}

const dirtyChunks = new Set();
let remeshTimer = 0;

/**
 * Record one edit. The log is authoritative and always written; the voxel array
 * is only touched when this chunk is already cached, because materialising a
 * cold chunk here would generate 32 KB of terrain and mesh it for an edit the
 * main thread is not even displaying. voxels() replays the log on generate, so
 * a chunk that streams in later still gets it.
 */
function applyEdit(wx, wy, wz, id) {
  const cx = Math.floor(wx / CHUNK_SX), cz = Math.floor(wz / CHUNK_SZ);
  const lx = wx - cx * CHUNK_SX, lz = wz - cz * CHUNK_SZ;
  const k = key(cx, cz);
  let log = edits.get(k);
  if (!log) { log = new Map(); edits.set(k, log); }
  log.set(vIndex(lx, wy, lz), id);

  const cached = chunks.get(k);
  if (cached) cached[vIndex(lx, wy, lz)] = id;
  else return;                       // nothing meshed here, nothing to remesh

  dirtyChunks.add(k);
  if (lx === 0) dirtyChunks.add(key(cx - 1, cz));
  if (lx === CHUNK_SX - 1) dirtyChunks.add(key(cx + 1, cz));
  if (lz === 0) dirtyChunks.add(key(cx, cz - 1));
  if (lz === CHUNK_SZ - 1) dirtyChunks.add(key(cx, cz + 1));
}

/**
 * Coalesce remeshes. One explosion, or four players building at once, would
 * otherwise remesh the same chunk many times in the same millisecond.
 */
function scheduleRemesh() {
  if (remeshTimer || dirtyChunks.size === 0) return;
  remeshTimer = setTimeout(() => {
    remeshTimer = 0;
    for (const k of dirtyChunks) {
      if (!chunks.has(k)) continue;
      const comma = k.indexOf(',');
      emit(Number(k.slice(0, comma)), Number(k.slice(comma + 1)), false);
    }
    dirtyChunks.clear();
  }, 16);
}

function pump() {
  pumping = false;
  if (!gen || queue.length === 0) return;
  const started = performance.now();
  // Nearest-first: the player should never see a hole in front of them while a
  // chunk behind them is being built.
  queue.sort((a, b) => dist2(a) - dist2(b));
  while (queue.length && performance.now() - started < 12) {
    const [cx, cz] = queue.shift();
    emit(cx, cz, true);
  }
  schedule();
}

function dist2(c) {
  const dx = c[0] - center.x, dz = c[1] - center.z;
  return dx * dx + dz * dz;
}

function schedule() {
  if (pumping || queue.length === 0) return;
  pumping = true;
  setTimeout(pump, 0);
}

/**
 * Evict cached chunks that are far from the player. buildPadded() generates the
 * eight neighbours of every meshed chunk, and those never appear in the main
 * thread's drop list - without this sweep the worker's map only ever grows.
 */
function sweep() {
  const limit = (radius + 4) * (radius + 4);
  for (const k of chunks.keys()) {
    const comma = k.indexOf(',');
    const dx = Number(k.slice(0, comma)) - center.x;
    const dz = Number(k.slice(comma + 1)) - center.z;
    if (dx * dx + dz * dz > limit) chunks.delete(k);
  }
}

self.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case 'init':
      gen = new WorldGen(m.planet, m.seed);
      tint = m.tint ?? [1, 1, 1];
      skyFade = m.skyFade ?? 0.055;
      chunks.clear();
      edits.clear();
      queue.length = 0;
      if (m.edits) {
        for (const [k, list] of Object.entries(m.edits)) {
          const map = new Map();
          for (let i = 0; i < list.length; i += 2) map.set(list[i], list[i + 1]);
          edits.set(k, map);
        }
      }
      postMessage({ type: 'ready' });
      break;

    case 'center':
      center = { x: m.x, z: m.z };
      break;

    case 'request':
      for (const c of m.chunks) {
        const k = key(c[0], c[1]);
        if (!queue.some((q) => q[0] === c[0] && q[1] === c[1])) queue.push(c);
      }
      center = { x: m.cx ?? center.x, z: m.cz ?? center.z };
      if (m.radius) radius = m.radius;
      schedule();
      break;

    case 'edit':
      applyEdit(m.x, m.y, m.z, m.id);
      scheduleRemesh();
      break;

    case 'editBatch': {
      const e = m.edits;
      for (let i = 0; i + 3 < e.length; i += 4) applyEdit(e[i], e[i + 1], e[i + 2], e[i + 3]);
      scheduleRemesh();
      break;
    }

    case 'drop':
      for (const c of m.chunks) chunks.delete(key(c[0], c[1]));
      sweep();
      break;

    case 'clear':
      chunks.clear();
      queue.length = 0;
      dirtyChunks.clear();
      break;
  }
};
