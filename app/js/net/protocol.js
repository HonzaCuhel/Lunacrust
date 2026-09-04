// Wire constants and pure validators for LAN co-op. No THREE, no DOM, no
// sockets - this module only describes shapes and rates, so it is exactly as
// testable as items.js's dropFor().
//
// Nothing here decides *what* to do with a message, only whether its shape is
// safe to act on. That split is what lets session.js stay the single place
// game logic lives, per the spec's "one host sequences, everyone applies every
// echo unconditionally" design.

import { BLOCKS } from '../blocks.js';
import { ITEMS, maxStack } from '../items.js';
import { WORLD_H } from '../worldgen.js';
import { MOB_TYPES } from '../mobtypes.js';

export const PROTOCOL = 1;
export const MAX_PEERS = 8;
export const TICK_MS = 50;            // host authoritative tick: 20 Hz
export const MOVE_HZ = 20;
export const DROPS_HZ = 10;
export const FURNACE_HZ = 5;
export const TIME_EVERY_S = 10;
export const HEARTBEAT_S = 10;        // digest exchange
export const INTERP_DELAY_MS = 100;
export const DROP_INTEREST = 48;      // metres
export const SNAP_DIST = 4;           // avatar teleport threshold, metres

export const F = { GROUND: 1, FLYING: 2, SNEAK: 4, SPRINT: 8, LIQUID: 16, DEAD: 32 };

// ------------------------------------------------------------------- hashing
// Plain FNV-1a. Not cryptographic - it only has to disagree when two builds'
// BLOCKS/ITEMS tables disagree, which is exactly what a join must refuse on.
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function fnv1a(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h >>> 0;
}

const hex8 = (n) => (n >>> 0).toString(16).padStart(8, '0');

let _contentHash = null;
/**
 * FNV-1a over the id->key mapping of BLOCKS and ITEMS, 8 lowercase hex chars.
 * Ids are Uint8 array indices into these exact tables - a build with a
 * reordered or extended table would silently apply a peer's edits to the
 * wrong blocks, so a mismatch here has to refuse the join outright, with no
 * override. Cached: neither table changes after module load.
 */
export function contentHash() {
  if (_contentHash) return _contentHash;
  const blockPart = BLOCKS.map((b) => b.id + ':' + b.key).join('|');
  const itemPart = ITEMS.map((it, i) => i + ':' + (it?.key ?? '')).join('|');
  _contentHash = hex8(fnv1a(JSON.stringify(MOB_TYPES), fnv1a(itemPart, fnv1a(blockPart, FNV_OFFSET))));
  return _contentHash;
}

// -------------------------------------------------------------- validators
// Every one of these is a pure shape check: no throw on garbage, just true or
// false, so a malformed frame can never make BLOCKS[b] undefined and kill a
// peer's session (see the "garbage" hardening case in the spec).
const isInt = Number.isInteger;
const isNum = Number.isFinite;

/** `{x,y,z,b,tool}` - the shape of a `edit` intent, checked before it is applied. */
export function validEdit(m) {
  return !!m && typeof m === 'object'
    && isInt(m.x) && isInt(m.y) && isInt(m.z)
    && m.y >= 1 && m.y < WORLD_H
    && isInt(m.b) && m.b >= 0 && m.b < BLOCKS.length
    && isInt(m.tool) && m.tool >= 0 && m.tool < ITEMS.length;
}

/** `{item,count,dur}` - an inventory/furnace stack off the wire. */
export function validStack(s) {
  if (!s || typeof s !== 'object') return false;
  if (!isInt(s.item) || s.item < 1 || s.item >= ITEMS.length) return false;
  const cap = maxStack(s.item);
  if (!isInt(s.count) || s.count < 1 || s.count > cap) return false;
  if (s.dur !== undefined && s.dur !== null && !isNum(s.dur)) return false;
  return true;
}

/**
 * A `move`/`players` position entry. This is the guard the *receiver* runs -
 * the host never validates positions it relays, so this is what stops a NaN
 * or a wild coordinate from ever reaching a THREE matrix.
 */
export function validMove(m) {
  if (!m || typeof m !== 'object') return false;
  if (!isNum(m.x) || !isNum(m.y) || !isNum(m.z) || !isNum(m.yaw) || !isNum(m.pitch) || !isNum(m.f)) return false;
  if (Math.abs(m.x) >= 3e6 || Math.abs(m.z) >= 3e6) return false;
  if (m.y < -64 || m.y > WORLD_H + 64) return false;
  return true;
}

/** Token bucket: `rate`/s sustained, `burst` capacity. `now` is milliseconds. */
export class Bucket {
  constructor(rate, burst) {
    this.rate = rate;
    this.capacity = burst;
    this.tokens = burst;
    this._last = null;
  }

  take(now) {
    if (this._last == null) this._last = now;
    const elapsedS = Math.max(0, now - this._last) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedS * this.rate);
    this._last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
