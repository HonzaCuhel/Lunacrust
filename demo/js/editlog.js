// EditLog: every block edit ever applied to a world, independent of which
// chunks are currently streamed in. `World` composes one of these - see the
// spec's `World.applyEdit` contract for why the log and the voxel mirror are
// allowed to disagree (a remote edit 150 blocks away still has to be
// remembered even though there is no chunk resident to write it into).
//
// The digest exists so two machines that received the same edits in whatever
// order their frames happened to arrive can prove it in 8 bytes instead of
// diffing the whole log over the wire. See set() for the invariant that
// makes the comparison order-independent.

import { CHUNK_SX, CHUNK_SZ, WORLD_H, vIndex } from './worldgen.js';

export const chunkKey = (cx, cz) => cx + ',' + cz;

const CHUNK_LAYER = CHUNK_SX * CHUNK_SZ;
const CHUNK_VOLUME = CHUNK_LAYER * WORLD_H;

// Outside the Uint8 block-id range (0..255), so it can stand for "this cell
// has never been set" without needing a second data structure to track it.
const NOT_EDITED = 256;

// Two independent FNV-1a lanes, XOR-folded together on read. A single lane
// can in principle let one edit's tuple cancel another's; folding two
// independently-seeded lanes makes that collision require both to agree,
// which is the whole reason two lanes exist for an 8-hex-char digest instead
// of just using one FNV-1a pass directly.
const LANE_A = 0x811c9dc5;
const LANE_B = 0x9747b28c;
const FNV_PRIME = 0x01000193;

function foldByte(h, byte) {
  return Math.imul(h ^ (byte & 0xff), FNV_PRIME) >>> 0;
}

/** Fold a 32-bit integer in four bytes, no allocation - set() can run a lot. */
function foldInt(h, n) {
  h = foldByte(h, n);
  h = foldByte(h, n >>> 8);
  h = foldByte(h, n >>> 16);
  h = foldByte(h, n >>> 24);
  return h;
}

function laneHash(seed, x, y, z, value) {
  let h = foldInt(seed, x);
  h = foldInt(h, y);
  h = foldInt(h, z);
  h = foldInt(h, value);
  return h;
}

export class EditLog {
  constructor() {
    /** @type {Map<string, Map<number, number>>} "cx,cz" -> (voxelIndex -> blockId) */
    this._chunks = new Map();
    this.size = 0;
    this._a = 0;   // lane A running XOR
    this._b = 0;   // lane B running XOR
  }

  /** Same shape game.js's restoreLights() already walks. */
  get map() { return this._chunks; }

  get digest() {
    return ((this._a ^ this._b) >>> 0).toString(16).padStart(8, '0');
  }

  forChunk(cx, cz) {
    return this._chunks.get(chunkKey(cx, cz));
  }

  get(x, y, z) {
    const cx = x >> 4, cz = z >> 4;
    const m = this._chunks.get(chunkKey(cx, cz));
    if (!m) return null;
    const i = vIndex(x - (cx << 4), y, z - (cz << 4));
    const v = m.get(i);
    return v === undefined ? null : v;
  }

  set(x, y, z, id) {
    const cx = x >> 4, cz = z >> 4, key = chunkKey(cx, cz);
    let m = this._chunks.get(key);
    if (!m) { m = new Map(); this._chunks.set(key, m); }
    const i = vIndex(x - (cx << 4), y, z - (cz << 4));
    const had = m.has(i);
    const prev = had ? m.get(i) : NOT_EDITED;
    // XOR the previous contribution out, the new one in. Whatever chain of
    // values this cell passed through to get here, the net term left in the
    // accumulator is always exactly hash(cell, NOT_EDITED) ^ hash(cell, id) -
    // which is why replaying the same final edits in a different order (or a
    // different number of intermediate overwrites) still lands on the same
    // digest.
    this._a ^= laneHash(LANE_A, x, y, z, prev);
    this._a ^= laneHash(LANE_A, x, y, z, id);
    this._b ^= laneHash(LANE_B, x, y, z, prev);
    this._b ^= laneHash(LANE_B, x, y, z, id);
    if (!had) this.size++;
    m.set(i, id);
  }

  /** Exactly today's World.serializeEdits() output. */
  serialize() {
    const out = {};
    for (const [key, m] of this._chunks) {
      const arr = new Array(m.size * 2);
      let i = 0;
      for (const [idx, id] of m) { arr[i++] = idx; arr[i++] = id; }
      out[key] = arr;
    }
    return out;
  }

  /**
   * Rebuilds the log (and its digest) from a serialize() object, going
   * through set() cell by cell so the two stay in lockstep. Saves are
   * user-editable files, so every field is re-validated rather than trusted -
   * the same defensive posture stations.restore() takes with a hand-edited
   * furnace record.
   */
  load(obj) {
    this.clear();
    for (const [key, arr] of Object.entries(obj ?? {})) {
      if (!Array.isArray(arr)) continue;
      const comma = key.indexOf(',');
      if (comma < 0) continue;
      const cx = Number(key.slice(0, comma)), cz = Number(key.slice(comma + 1));
      if (!Number.isInteger(cx) || !Number.isInteger(cz)) continue;
      for (let k = 0; k + 1 < arr.length; k += 2) {
        const idx = arr[k], id = arr[k + 1];
        if (!Number.isInteger(idx) || idx < 0 || idx >= CHUNK_VOLUME) continue;
        if (!Number.isInteger(id) || id < 0 || id > 255) continue;
        const y = (idx / CHUNK_LAYER) | 0;
        const rem = idx - y * CHUNK_LAYER;
        const z = (rem / CHUNK_SX) | 0;
        const x = rem - z * CHUNK_SX;
        this.set((cx << 4) + x, y, (cz << 4) + z, id);
      }
    }
  }

  clear() {
    this._chunks.clear();
    this.size = 0;
    this._a = 0;
    this._b = 0;
  }
}
