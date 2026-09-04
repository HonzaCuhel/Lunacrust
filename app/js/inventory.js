// Stack containers and the click semantics the inventory UI drives.
//
// Everything here is pure data: no DOM, no three.js, no globals. The UI layer
// owns the pixels and the "stack under the mouse" (the cursor); this module owns
// the rules, so the same rules can be unit-tested headlessly and reused by the
// crafting grid, the furnace and the player's 36 slots without duplication.
//
// A stack is {item, count, dur?} or null. `dur` is remaining durability and only
// ever appears on tools - which is also why tools must never merge: two picks
// with different wear are two different things, not two of a thing.

import { ITEMS, maxStack, isTool, isArmour } from './items.js';
import { ARMOUR_SLOTS, fitsSlot } from './armour.js';

export const HOTBAR_SIZE = 9;
export const MAIN_SIZE = 27;

// --------------------------------------------------------------- stack helpers

/** Stack ceiling, floored at 1 so a bad/unknown id can never make a slot useless. */
const capOf = (itemId) => Math.max(1, maxStack(itemId) || 1);

/** Known to this build? Old saves may name items that no longer exist. */
const knownItem = (id) => Number.isInteger(id) && id > 0 && id < ITEMS.length && !!ITEMS[id];

/**
 * Normalise into the canonical stack shape, or null. Every write goes through
 * here, which is what guarantees a slot is null or has count >= 1 - the UI never
 * has to defend against a zero-count ghost stack.
 */
function norm(stack) {
  if (!stack) return null;
  const item = Math.trunc(stack.item);
  const count = Math.floor(stack.count);
  // Finite check as well as >= 1: an Infinity count would survive Math.floor,
  // then JSON-serialise to null and quietly delete the slot on the next load.
  if (!item || !Number.isFinite(count) || count < 1) return null;
  const out = { item, count };
  if (stack.dur !== undefined && stack.dur !== null && Number.isFinite(Number(stack.dur))) {
    out.dur = Number(stack.dur);
  }
  return out;
}

const withCount = (stack, count) => norm({ ...stack, count });

/** Can `b` absorb items from `a`? Tools and anything carrying wear stay separate. */
function mergeable(a, b) {
  if (!a || !b || a.item !== b.item) return false;
  // Armour has stack:1 already, so capOf alone stops this in practice - but
  // stating the rule here documents the intent next to the identical one for
  // tools, and it stops working "by accident" if stack sizes ever change.
  if (isTool(a.item) || isArmour(a.item)) return false;
  return a.dur === undefined && b.dur === undefined;
}

// -------------------------------------------------------------------- container

export class Container {
  constructor(size, name = '') {
    this.size = size | 0;
    this.name = name;
    /** @type {Array<{item:number,count:number,dur?:number}|null>} */
    this.slots = new Array(this.size).fill(null);
  }

  get(i) {
    return (i >= 0 && i < this.size) ? this.slots[i] : null;
  }

  /**
   * Would this container take `stack` in slot `i`? A plain container takes
   * anything anywhere; ArmourContainer overrides this to enforce one item type
   * per slot. clickSlot() checks this before every write that could introduce
   * a *new* item into a slot, so a refused placement leaves the cursor intact
   * instead of silently eating the item.
   */
  accepts(i, stack) {
    return !!stack;
  }

  set(i, stack) {
    if (i < 0 || i >= this.size) return this;
    this.slots[i] = norm(stack);
    return this;
  }

  isEmpty() {
    for (let i = 0; i < this.size; i++) if (this.slots[i]) return false;
    return true;
  }

  count(itemId) {
    let n = 0;
    for (let i = 0; i < this.size; i++) {
      const s = this.slots[i];
      if (s && s.item === itemId) n += s.count;
    }
    return n;
  }

  counts() {
    const m = new Map();
    for (let i = 0; i < this.size; i++) {
      const s = this.slots[i];
      if (s) m.set(s.item, (m.get(s.item) ?? 0) + s.count);
    }
    return m;
  }

  /**
   * Insert into slots [from,to), topping up partial stacks before opening a new
   * one - otherwise a player with 3 half-stacks of dirt would fill the grid with
   * fourths. `skip` keeps a shift-click from merging a slot into itself.
   * @returns leftover stack, or null if it all fitted.
   */
  addRange(stack, from = 0, to = this.size, skip = -1) {
    const s = norm(stack);
    if (!s) return null;
    const max = capOf(s.item);
    let left = s.count;
    const lo = Math.max(0, from), hi = Math.min(this.size, to);

    if (max > 1) {   // max === 1 (every tool) can never have a partial to top up
      for (let i = lo; i < hi && left > 0; i++) {
        if (i === skip) continue;
        const cur = this.slots[i];
        if (!cur || !mergeable(s, cur)) continue;
        const room = max - cur.count;
        if (room <= 0) continue;
        const move = Math.min(room, left);
        cur.count += move;
        left -= move;
      }
    }
    for (let i = lo; i < hi && left > 0; i++) {
      if (i === skip || this.slots[i]) continue;
      const move = Math.min(max, left);
      this.slots[i] = withCount(s, move);
      left -= move;
    }
    return left > 0 ? withCount(s, left) : null;
  }

  /** How many of `stack` this container could take right now, without mutating. */
  roomFor(stack) {
    const s = norm(stack);
    if (!s) return 0;
    const max = capOf(s.item);
    let room = 0;
    for (const cur of this.slots) {
      if (!cur) room += max;
      else if (max > 1 && mergeable(s, cur)) room += Math.max(0, max - cur.count);
    }
    return room;
  }

  /** @returns leftover stack, or null if it all fitted. */
  addStack(stack) {
    return this.addRange(stack, 0, this.size);
  }

  /** @returns how many could not be stored. */
  addItem(itemId, count = 1, dur) {
    const left = this.addStack(dur === undefined ? { item: itemId, count } : { item: itemId, count, dur });
    return left ? left.count : 0;
  }

  /**
   * All-or-nothing removal: crafting must never eat half the ingredients and
   * then discover the last one is missing.
   */
  removeItems(itemId, n) {
    // Whole items only - a fractional n would leave a fractional count behind.
    const want = Math.floor(n);
    if (!(want > 0)) return true;
    if (this.count(itemId) < want) return false;
    let left = want;
    for (let i = 0; i < this.size && left > 0; i++) {
      const s = this.slots[i];
      if (!s || s.item !== itemId) continue;
      const take = Math.min(s.count, left);
      s.count -= take;
      left -= take;
      if (s.count <= 0) this.slots[i] = null;
    }
    return true;
  }

  /** @returns the stack that was taken out, or null. */
  removeAt(i, n = Infinity) {
    const s = this.get(i);
    if (!s || !(n > 0)) return null;
    // Floor before splitting, not after: taking 2.6 of 5 used to hand back 2 and
    // leave 2 (norm floors both halves), silently destroying an item.
    const take = Math.min(s.count, Math.floor(n));
    if (take < 1) return null;
    const out = withCount(s, take);
    const rest = s.count - take;
    this.slots[i] = rest > 0 ? withCount(s, rest) : null;
    return out;
  }

  clear() {
    this.slots.fill(null);
    return this;
  }

  /** Compact form: null | [item,count] | [item,count,dur]. */
  serialize() {
    return this.slots.map((s) => {
      if (!s) return null;
      return s.dur === undefined ? [s.item, s.count] : [s.item, s.count, s.dur];
    });
  }

  /**
   * Restores in place. Unknown item ids are dropped rather than thrown on, so a
   * save written by an older build still loads (minus the items that vanished).
   * Also accepts {slots,...} so a save wrapper can hand its whole record over.
   */
  restore(data) {
    const list = Array.isArray(data) ? data : (data && Array.isArray(data.slots) ? data.slots : []);
    this.clear();
    for (let i = 0; i < this.size; i++) {
      const e = list[i];
      if (!Array.isArray(e)) continue;
      const [id, count, dur] = e;
      if (!knownItem(id)) continue;
      const n = Math.floor(count);
      if (!Number.isFinite(n) || n < 1) continue;
      const s = { item: id, count: n };
      const d = Number(dur);
      if (dur !== undefined && dur !== null && Number.isFinite(d)) s.dur = d;
      this.slots[i] = s;
    }
    return this;
  }

  static from(size, data) {
    // `new this(...)` so PlayerInventory.from() returns a PlayerInventory.
    const c = new this(size);
    c.restore(data);
    return c;
  }
}

// ------------------------------------------------------------ player inventory

export class PlayerInventory extends Container {
  constructor() {
    super(HOTBAR_SIZE + MAIN_SIZE, 'player');
    this.selected = 0;   // 0..8, the hotbar slot in hand
  }

  held() {
    return this.get(this.selected);
  }

  setHeld(stack) {
    return this.set(this.selected, stack);
  }

  /** @returns false when the slot cannot cover `n` - callers must not act then. */
  consumeHeld(n = 1) {
    const s = this.held();
    const want = Math.floor(n);   // whole items only; see removeItems
    if (!s || !(want > 0) || s.count < want) return false;
    s.count -= want;
    if (s.count <= 0) this.slots[this.selected] = null;
    return true;
  }

  /**
   * Wear the held tool. A stack with no `dur` yet counts as factory-fresh, so
   * crafting and the landing kit can hand out tools without filling the field in.
   * @returns 'broke' | 'damaged' | null (null = nothing there, or not a tool)
   */
  damageHeld(amount = 1) {
    const s = this.held();
    if (!s || !isTool(s.item)) return null;
    const max = ITEMS[s.item]?.tool?.durability ?? 0;
    if (!(max > 0)) return null;
    const next = (s.dur === undefined ? max : s.dur) - amount;
    if (next <= 0) {
      this.slots[this.selected] = null;
      return 'broke';
    }
    s.dur = next;
    return 'damaged';
  }

  hotbarStacks() {
    return this.slots.slice(0, HOTBAR_SIZE);
  }

  /** @returns index of the first free slot, or -1. */
  firstEmpty() {
    for (let i = 0; i < this.size; i++) if (!this.slots[i]) return i;
    return -1;
  }

  restore(data) {
    super.restore(data);
    if (data && Number.isInteger(data.selected)) {
      this.selected = Math.min(HOTBAR_SIZE - 1, Math.max(0, data.selected));
    }
    return this;
  }
}

// ------------------------------------------------------------------- armour
/**
 * Four slot-typed slots, one per ARMOUR_SLOTS entry. Lives here rather than in
 * armour.js because it needs this file's private `norm`/`withCount` - and
 * because it is a Container, which armour.js deliberately knows nothing about.
 *
 * The base Container writes `this.slots[i]` directly inside two methods -
 * addRange() (the shift-click path) and restore() (the load-a-save path) - so
 * overriding only `set()` would still let a shift-click or a hand-edited save
 * put a chestplate on your head. Every write path is repeated here instead.
 */
export class ArmourContainer extends Container {
  constructor() {
    super(ARMOUR_SLOTS.length, 'armour');
  }

  accepts(i, stack) {
    return !!stack && fitsSlot(stack.item, i);
  }

  set(i, stack) {
    if (i < 0 || i >= this.size) return this;
    const s = norm(stack);
    if (s && !this.accepts(i, s)) return this;   // wrong slot: refuse, do not throw
    this.slots[i] = s;
    return this;
  }

  /**
   * One piece into its own slot; everything else bounces back untouched. Stack
   * size is always 1 for armour, so there is never a partial to top up and
   * `from`/`to`/`skip` only ever gate whether the one matching slot is in range.
   * @returns leftover stack, or null if it fitted.
   */
  addRange(stack, from = 0, to = this.size, skip = -1) {
    const s = norm(stack);
    if (!s) return null;
    const i = ARMOUR_SLOTS.findIndex((_, idx) => fitsSlot(s.item, idx));
    if (i < 0 || i < from || i >= to || i === skip || this.slots[i]) return s;
    this.slots[i] = s;
    return null;
  }

  /** 1 if the matching slot is free, 0 otherwise - never a stack count, so
   * quickMove's all-or-nothing check (`roomFor(slot) < slot.count`) is exact. */
  roomFor(stack) {
    const s = norm(stack);
    if (!s) return 0;
    const i = ARMOUR_SLOTS.findIndex((_, idx) => fitsSlot(s.item, idx));
    return i >= 0 && !this.slots[i] ? 1 : 0;
  }

  /** Drops any saved entry that does not match its slot's type - a corrupt or
   * hand-edited save must not be able to put a chestplate on your head either. */
  restore(data) {
    const list = Array.isArray(data) ? data : (data && Array.isArray(data.slots) ? data.slots : []);
    this.clear();
    for (let i = 0; i < this.size; i++) {
      const e = list[i];
      if (!Array.isArray(e)) continue;
      const [id, count, dur] = e;
      const s = norm({ item: id, count, dur });
      if (!s || !this.accepts(i, s)) continue;
      this.slots[i] = s;
    }
    return this;
  }
}

// ------------------------------------------------------------------- clicking

/**
 * Would `container` take `stack` in `index`? Real Container subclasses always
 * have `accepts()` (the base class defines it), but screens.js also hands
 * clickSlot() a bare duck-typed { size, get, set } view over a furnace slot -
 * that object predates accepts() and has no reason to grow it, so a missing
 * method reads as "accepts anything", matching the base Container's own
 * default and every caller's behaviour before accepts() existed.
 */
const accepts = (container, index, stack) => (
  typeof container.accepts !== 'function' || container.accepts(index, stack)
);

/**
 * Shift-click: shove the whole slot somewhere else. Within a PlayerInventory
 * with no partner container that means hotbar <-> main, which is the only place
 * a player can "put it away" without a second window open.
 */
function quickMove(container, index, other, allOrNothing = false) {
  const slot = container.get(index);
  if (!slot) return false;

  // A craft result is taken whole or not at all - the same rule the cursor path
  // states. Without this, a nearly full pack silently eats the overflow while
  // the caller happily consumes the ingredients.
  if (allOrNothing) {
    const target = other && other !== container ? other : container;
    if (target.roomFor(slot) < slot.count) return false;
  }

  let leftover;
  if (other && other !== container) {
    leftover = other.addStack(slot);
  } else if (container instanceof PlayerInventory) {
    // Keyed off the type, not off size 36: a plain 36-slot chest has no hotbar
    // and must not shuffle its own contents around when there is no partner.
    const toMain = index < HOTBAR_SIZE;
    leftover = toMain
      ? container.addRange(slot, HOTBAR_SIZE, container.size, index)
      : container.addRange(slot, 0, HOTBAR_SIZE, index);
  } else {
    return false;
  }

  const movedAll = leftover === null;
  if (!movedAll && leftover.count >= slot.count) return false;   // nowhere to go
  container.set(index, movedAll ? null : leftover);
  return true;
}

/**
 * One click on one slot. `cursor` is the stack the mouse is carrying (or null);
 * the container is mutated in place and the new cursor is returned, because the
 * cursor is UI state and the slots are game state.
 *
 * opts: { button: 0|2, shift, otherContainer, allowPlace, takeOnly }
 * @returns {{cursor: object|null, changed: boolean}}
 */
export function clickSlot(container, index, cursor, opts = {}) {
  const button = opts.button ?? 0;
  const takeOnly = !!opts.takeOnly;
  // takeOnly implies no placement; allowPlace defaults to true.
  const allowPlace = !takeOnly && opts.allowPlace !== false;
  const held = norm(cursor);
  const slot = container.get(index);

  if (index < 0 || index >= container.size) return { cursor: held, changed: false };

  if (opts.shift) {
    // Cursor is untouched by a quick-move, even over a result slot: taking the
    // output out is still a take, so takeOnly slots allow it.
    return {
      cursor: held,
      changed: quickMove(container, index, opts.otherContainer ?? null, takeOnly),
    };
  }

  if (takeOnly) {
    if (!slot) return { cursor: held, changed: false };
    if (!held) {
      container.set(index, null);
      return { cursor: norm(slot), changed: true };
    }
    // A result is taken whole or not at all - no partial pull off the anvil.
    if (mergeable(held, slot) && held.count + slot.count <= capOf(slot.item)) {
      container.set(index, null);
      return { cursor: withCount(held, held.count + slot.count), changed: true };
    }
    return { cursor: held, changed: false };
  }

  if (button === 2) {
    if (!held) {
      if (!slot) return { cursor: null, changed: false };
      const take = Math.ceil(slot.count / 2);   // odd counts favour the hand
      const rest = slot.count - take;
      container.set(index, rest > 0 ? withCount(slot, rest) : null);
      return { cursor: withCount(slot, take), changed: true };
    }
    if (!allowPlace) return { cursor: held, changed: false };
    if (!slot) {
      // A slot-typed container (ArmourContainer) can refuse this exact stack -
      // check before writing, or a wrong-slot item vanishes: the cursor would
      // still lose one as if the drop had succeeded.
      if (!accepts(container, index, held)) return { cursor: held, changed: false };
      container.set(index, withCount(held, 1));
      return { cursor: held.count > 1 ? withCount(held, held.count - 1) : null, changed: true };
    }
    if (mergeable(held, slot) && slot.count < capOf(slot.item)) {
      container.set(index, withCount(slot, slot.count + 1));
      return { cursor: held.count > 1 ? withCount(held, held.count - 1) : null, changed: true };
    }
    return { cursor: held, changed: false };
  }

  // left click
  if (!held) {
    if (!slot) return { cursor: null, changed: false };
    container.set(index, null);
    return { cursor: norm(slot), changed: true };
  }
  if (!allowPlace) return { cursor: held, changed: false };
  if (!slot) {
    if (!accepts(container, index, held)) return { cursor: held, changed: false };
    container.set(index, held);
    return { cursor: null, changed: true };
  }
  if (mergeable(held, slot)) {
    const room = capOf(slot.item) - slot.count;
    if (room <= 0) return { cursor: held, changed: false };
    const move = Math.min(room, held.count);
    container.set(index, withCount(slot, slot.count + move));
    const left = held.count - move;
    return { cursor: left > 0 ? withCount(held, left) : null, changed: true };
  }
  // different items, or two tools: swap - unless the container refuses the
  // item now going in, in which case nothing moves at all.
  if (!accepts(container, index, held)) return { cursor: held, changed: false };
  container.set(index, held);
  return { cursor: norm(slot), changed: true };
}
