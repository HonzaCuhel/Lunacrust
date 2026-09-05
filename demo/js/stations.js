// Block entities: the handful of blocks that keep working after you walk away.
//
// A chunk stores one Uint8 per voxel, which is exactly enough room for "this is
// a smelter" and nothing else. Anything with state - three item stacks and two
// timers for a furnace - lives here instead, keyed by voxel position, and is
// saved alongside the world edits rather than inside the chunk arrays.
//
// Life-support units are the cheap case: they have no state at all, so the set
// of their positions *is* the state. They are kept in a flat coordinate array
// as well because nearLifeSupport() is polled every frame.

import { ITEMS, maxStack } from './items.js';
import { smeltingResult, fuelSeconds } from './recipes.js';

/** Used when a recipe forgets to declare a time, so progress can never go NaN. */
const DEFAULT_SMELT_TIME = 10;

/** Interrupted smelts bleed off at 2x, so a half-done ore is cold in a few seconds. */
const DECAY_RATE = 2;

// Thousands of float additions of 1/144 drift by ~1e-12 against the same span
// added at 1/30. Completing a smelt a nanosecond early is invisible, and it is
// what makes two players at different framerates get the same number of ingots.
const EPS = 1e-9;

/** Voxel positions are the map key; block coords are integers by construction. */
export const stationKey = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;

/**
 * 'x,y,z' back to a voxel, or null when the key is not one we can act on.
 * Saves are user-editable files: a malformed key must be dropped here rather
 * than turned into NaN coordinates that reach world.setBlock().
 */
function parseKey(key) {
  if (typeof key !== 'string') return null;
  const p = key.split(',');
  if (p.length !== 3) return null;
  const x = Number(p[0]), y = Number(p[1]), z = Number(p[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) };
}

/** A timer off a save file, coerced to something the tick can safely do maths on. */
const seconds = (v) => (Number.isFinite(+v) && +v > 0 ? +v : 0);

/** A fresh, empty smelter. */
export function newFurnace() {
  return { input: null, fuel: null, output: null, burn: 0, burnMax: 0, progress: 0, lit: false };
}

/** Known to this build? An old save may name an item that no longer exists. */
const knownItem = (id) => Number.isInteger(id) && id > 0 && id < ITEMS.length && !!ITEMS[id];

const cloneStack = (s) => (s && s.count > 0 && knownItem(s.item)
  ? (s.dur === undefined ? { item: s.item, count: s.count } : { item: s.item, count: s.count, dur: s.dur })
  : null);

/** Take one item off a stack, collapsing it to an empty slot when it runs out. */
function consumeOne(stack) {
  if (!stack) return null;
  const left = stack.count - 1;
  if (left <= 0) return null;
  stack.count = left;
  return stack;
}

/** Can the output slot take `count` more of `itemId` right now? */
function accepts(out, itemId, count) {
  if (!out || !out.item || out.count <= 0) return true;
  if (out.item !== itemId) return false;
  return out.count + count <= maxStack(itemId);
}

/**
 * What this furnace would produce if it were burning: {item, count, time}, or
 * null when the input is empty, unsmeltable, or the output slot is blocked.
 * Deliberately evaluated before fuel is touched - see _tickFurnace().
 */
function pendingSmelt(f) {
  if (!f.input || f.input.count <= 0) return null;
  const res = smeltingResult(f.input.item);
  if (!res || !res.item) return null;
  const count = res.count ?? 1;
  if (!accepts(f.output, res.item, count)) return null;
  // The timer is guarded rather than trusted: a zero would drain a whole stack
  // in one tick, a missing one would turn progress into NaN forever, and one
  // below EPS would spin the completion loop without ever finishing.
  return { item: res.item, count, time: res.time > EPS ? res.time : DEFAULT_SMELT_TIME };
}

export class Stations {
  constructor() {
    /** @type {Map<string, any>} 'x,y,z' -> FurnaceState */
    this.furnaces = new Map();
    /** @type {Set<string>} 'x,y,z' of every life-support unit */
    this.lifeSupports = new Set();
    // Flat [x,y,z, x,y,z, ...] block centres mirroring lifeSupports. Parsing the
    // string keys inside the per-frame proximity test would cost more than the
    // distance maths it exists to perform.
    this._lsPts = [];
  }

  // ------------------------------------------------------------------ furnaces

  /** @returns {any|null} the furnace at this voxel, optionally creating it. */
  furnaceAt(x, y, z, create = false) {
    const key = stationKey(x, y, z);
    let f = this.furnaces.get(key);
    if (!f && create) {
      f = newFurnace();
      this.furnaces.set(key, f);
    }
    return f ?? null;
  }

  /** Removes and returns the furnace so the caller can scatter its contents. */
  removeFurnace(x, y, z) {
    const key = stationKey(x, y, z);
    const f = this.furnaces.get(key) ?? null;
    if (f) this.furnaces.delete(key);
    return f;
  }

  // -------------------------------------------------------------- life support

  addLifeSupport(x, y, z) {
    const key = stationKey(x, y, z);
    if (this.lifeSupports.has(key)) return false;
    this.lifeSupports.add(key);
    this._syncLifeSupport();
    return true;
  }

  removeLifeSupport(x, y, z) {
    const key = stationKey(x, y, z);
    if (!this.lifeSupports.delete(key)) return false;
    this._syncLifeSupport();
    return true;
  }

  // Rebuilt whole rather than patched: a base has a handful of these, and a
  // rebuild keeps the array and the set from ever drifting apart.
  _syncLifeSupport() {
    const pts = [];
    for (const key of this.lifeSupports) {
      const p = parseKey(key);
      if (p) pts.push(p.x + 0.5, p.y + 0.5, p.z + 0.5);
    }
    this._lsPts = pts;
  }

  /** Is `pos` inside any unit's bubble? Squared distance, first hit wins. */
  nearLifeSupport(pos, radius = 9) {
    const pts = this._lsPts;
    if (pts.length === 0) return false;
    const r2 = radius * radius;
    const px = pos.x, py = pos.y, pz = pos.z;
    for (let i = 0; i < pts.length; i += 3) {
      const dx = pts[i] - px, dy = pts[i + 1] - py, dz = pts[i + 2] - pz;
      if (dx * dx + dy * dy + dz * dz <= r2) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- simulation

  /**
   * Advances every furnace by `dt`.
   * @returns {Array<{x:number,y:number,z:number,lit:boolean}>} only the furnaces
   * whose flame flipped this tick, so the caller can swap furnace/furnace_lit
   * without re-writing a block every frame.
   */
  update(dt) {
    const changes = [];
    if (!(dt > 0) || this.furnaces.size === 0) return changes;

    for (const [key, f] of this.furnaces) {
      const was = f.lit;

      // A screen that empties a slot can leave {count: 0} behind. Collapsing it
      // here keeps the idle check below honest and stops breakBlock() from
      // spilling a drop of nothing when the furnace is mined.
      if (f.input && f.input.count <= 0) f.input = null;
      if (f.fuel && f.fuel.count <= 0) f.fuel = null;
      if (f.output && f.output.count <= 0) f.output = null;

      // Cold, empty and idle: the common case for every furnace you ever built.
      if (f.burn <= 0 && f.progress <= 0 && !f.input) {
        f.lit = false;
      } else {
        this._tickFurnace(f, dt);
      }

      if (f.lit !== was) {
        const p = parseKey(key);
        if (p) changes.push({ x: p.x, y: p.y, z: p.z, lit: f.lit });
      }
    }
    return changes;
  }

  _tickFurnace(f, dt) {
    // Seconds of flame this step actually had. Taking min(dt, burn) up front,
    // rather than clamping after the subtraction, is what keeps 30fps and 144fps
    // in step: the clamped form silently threw away whatever slice of a burn was
    // shorter than one frame, and on a long frame it discarded a whole coal.
    let lit = Math.min(dt, f.burn);
    if (lit > 0) f.burn -= lit;

    let job = pendingSmelt(f);

    // Fuel is only ever spent on work that exists: a lit furnace with nothing to
    // smelt must not quietly eat the coal you left in it.
    if (job && f.burn <= 0 && f.fuel && f.fuel.count > 0) {
      const secs = fuelSeconds(f.fuel.item);
      if (secs > 0) {
        f.fuel = consumeOne(f.fuel);
        f.burnMax = secs;
        // The fresh flame only covers the part of this step the old one did not,
        // so relighting on a frame boundary neither loses nor gains burn time.
        const rest = Math.min(dt - lit, secs);
        f.burn = secs - rest;
        lit += rest;
      }
    }

    if (job && lit > 0) {
      f.progress += lit;
      // Loops rather than smelting one item per tick so a long frame (or a
      // catch-up step after a stall) cannot silently drop finished items.
      while (job && f.progress >= job.time - EPS) {
        f.progress = Math.max(0, f.progress - job.time);
        f.input = consumeOne(f.input);
        if (f.output && f.output.item === job.item) f.output.count += job.count;
        else f.output = { item: job.item, count: job.count };
        job = pendingSmelt(f);
      }
    } else if (f.progress > 0) {
      f.progress = Math.max(0, f.progress - dt * DECAY_RATE);
    }

    f.lit = f.burn > 0;
  }

  // ------------------------------------------------------------- persistence

  clear() {
    this.furnaces.clear();
    this.lifeSupports.clear();
    this._lsPts = [];
  }

  serialize() {
    const furnaces = [];
    for (const [at, f] of this.furnaces) {
      furnaces.push({
        at,
        input: cloneStack(f.input),
        fuel: cloneStack(f.fuel),
        output: cloneStack(f.output),
        burn: f.burn,
        burnMax: f.burnMax,
        progress: f.progress,
      });
    }
    return { furnaces, life: [...this.lifeSupports] };
  }

  restore(data) {
    this.clear();
    if (!data) return;
    for (const rec of data.furnaces ?? []) {
      if (!rec) continue;
      // Re-keyed rather than trusted: a hand-edited '1, 2, 3' would otherwise
      // sit in the map unreachable by furnaceAt() while still ticking and still
      // telling the game to light the block above it.
      const p = parseKey(rec.at);
      if (!p) continue;
      const burn = seconds(rec.burn);
      this.furnaces.set(stationKey(p.x, p.y, p.z), {
        input: cloneStack(rec.input),
        fuel: cloneStack(rec.fuel),
        output: cloneStack(rec.output),
        burn,
        burnMax: Math.max(seconds(rec.burnMax), burn),
        progress: seconds(rec.progress),
        // Derived, never stored: one less field that can be saved out of sync.
        lit: burn > 0,
      });
    }
    for (const key of data.life ?? []) {
      const p = parseKey(key);
      if (p) this.lifeSupports.add(stationKey(p.x, p.y, p.z));
    }
    this._syncLifeSupport();
  }
}
