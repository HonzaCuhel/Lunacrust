// Container / PlayerInventory / clickSlot rules.
// Run: node tests/inventory.test.mjs   (exit 0 = pass)

import assert from 'node:assert/strict';
import { Container, PlayerInventory, ArmourContainer, clickSlot, HOTBAR_SIZE, MAIN_SIZE } from '../app/js/inventory.js';
import { itemIdOf, maxStack } from '../app/js/items.js';
import { ARMOUR_SLOTS } from '../app/js/armour.js';

const DIRT = itemIdOf('dirt');
const STONE = itemIdOf('stone');
const PLANKS = itemIdOf('planks');
const PICK = itemIdOf('wood_pickaxe');
const AXE = itemIdOf('wood_axe');
const CAN = itemIdOf('oxygen_canister');   // stack 16, proves cap is per-item
const HELMET = itemIdOf('patch_helmet');   // slot 'head' (ARMOUR_SLOTS[0])
const HELMET2 = itemIdOf('alloy_helmet');  // a different helmet, same slot
const BOOTS = itemIdOf('patch_boots');     // slot 'feet' (ARMOUR_SLOTS[3])

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; } catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`); }
};
const stack = (item, count, dur) => (dur === undefined ? { item, count } : { item, count, dur });

// ------------------------------------------------------------------ containers

test('constructor gives null slots', () => {
  const c = new Container(5, 'chest');
  assert.equal(c.size, 5);
  assert.equal(c.name, 'chest');
  assert.equal(c.isEmpty(), true);
  assert.deepEqual(c.slots, [null, null, null, null, null]);
  assert.equal(c.get(9), null);
  assert.equal(c.get(-1), null);
});

test('set normalises zero/garbage counts to null', () => {
  const c = new Container(3);
  c.set(0, stack(DIRT, 0));
  c.set(1, { item: DIRT });
  c.set(2, stack(DIRT, 2.7));
  assert.equal(c.get(0), null);
  assert.equal(c.get(1), null);
  assert.deepEqual(c.get(2), stack(DIRT, 2));
});

test('addStack tops up partial stacks before opening a new one', () => {
  const c = new Container(5);
  c.set(0, stack(DIRT, 60));
  c.set(2, stack(DIRT, 30));
  const left = c.addStack(stack(DIRT, 40));
  assert.equal(left, null);
  assert.deepEqual(c.get(0), stack(DIRT, 64));
  assert.deepEqual(c.get(2), stack(DIRT, 64));
  assert.deepEqual(c.get(1), stack(DIRT, 2));   // remainder lands in the first empty
  assert.equal(c.count(DIRT), 130);
});

test('addStack does not mutate the stack it was handed', () => {
  const c = new Container(1);
  const s = stack(DIRT, 100);
  const left = c.addStack(s);
  assert.deepEqual(s, stack(DIRT, 100));
  assert.deepEqual(left, stack(DIRT, 36));
});

test('addItem overflows and reports the leftover count', () => {
  const c = new Container(2);
  assert.equal(c.addItem(DIRT, 200), 72);
  assert.deepEqual(c.get(0), stack(DIRT, 64));
  assert.deepEqual(c.get(1), stack(DIRT, 64));
});

test('addStack honours per-item stack size', () => {
  assert.equal(maxStack(CAN), 16);
  const c = new Container(2);
  assert.equal(c.addItem(CAN, 20), 0);
  assert.deepEqual(c.get(0), stack(CAN, 16));
  assert.deepEqual(c.get(1), stack(CAN, 4));
});

test('tools never stack, even two identical ones', () => {
  const c = new Container(3);
  c.addItem(PICK, 1, 60);
  c.addItem(PICK, 1, 60);
  assert.deepEqual(c.get(0), stack(PICK, 1, 60));
  assert.deepEqual(c.get(1), stack(PICK, 1, 60));
  const left = c.addStack(stack(PICK, 3, 12));   // one per empty slot, rest bounces
  assert.deepEqual(c.get(2), stack(PICK, 1, 12));
  assert.deepEqual(left, stack(PICK, 2, 12));
});

test('tools with no durability field yet still never stack', () => {
  // Freshly crafted tools have no `dur` at all, so the "different wear" argument
  // does not apply to them - only the tool check keeps them apart.
  const c = new Container(3);
  c.addItem(PICK, 1);
  c.addItem(PICK, 1);
  assert.deepEqual(c.get(0), stack(PICK, 1));
  assert.deepEqual(c.get(1), stack(PICK, 1));
  assert.equal(c.count(PICK), 2);
  const left = c.addStack(stack(PICK, 2));
  assert.deepEqual(c.get(2), stack(PICK, 1));
  assert.deepEqual(left, stack(PICK, 1));
});

test('counts() sums per item', () => {
  const c = new Container(4);
  c.set(0, stack(DIRT, 10));
  c.set(1, stack(STONE, 3));
  c.set(2, stack(DIRT, 5));
  assert.deepEqual([...c.counts()].sort((a, b) => a[0] - b[0]), [[STONE, 3], [DIRT, 10 + 5]].sort((a, b) => a[0] - b[0]));
});

test('removeItems is all-or-nothing', () => {
  const c = new Container(3);
  c.set(0, stack(DIRT, 4));
  c.set(1, stack(DIRT, 3));
  assert.equal(c.removeItems(DIRT, 10), false);
  assert.equal(c.count(DIRT), 7, 'a failed removal must not eat anything');
  assert.equal(c.removeItems(DIRT, 6), true);
  assert.equal(c.count(DIRT), 1);
  assert.equal(c.get(0), null);
  assert.deepEqual(c.get(1), stack(DIRT, 1));
});

test('removeAt returns what it took and empties at zero', () => {
  const c = new Container(2);
  c.set(0, stack(DIRT, 5));
  assert.deepEqual(c.removeAt(0, 2), stack(DIRT, 2));
  assert.deepEqual(c.get(0), stack(DIRT, 3));
  assert.deepEqual(c.removeAt(0), stack(DIRT, 3));
  assert.equal(c.get(0), null);
  assert.equal(c.removeAt(0, 1), null);
  assert.equal(c.removeAt(1, 1), null);
});

test('clear empties every slot', () => {
  const c = new Container(3);
  c.addItem(DIRT, 5);
  c.clear();
  assert.equal(c.isEmpty(), true);
});

// --------------------------------------------------------------- serialization

test('serialize/restore round-trips exactly, durability included', () => {
  const c = new Container(6, 'chest');
  c.set(0, stack(DIRT, 64));
  c.set(2, stack(CAN, 5));
  c.set(5, stack(PICK, 1, 33));
  const wire = JSON.parse(JSON.stringify(c.serialize()));
  assert.deepEqual(wire, [[DIRT, 64], null, [CAN, 5], null, null, [PICK, 1, 33]]);
  const back = Container.from(6, wire);
  assert.deepEqual(back.serialize(), c.serialize());
  assert.deepEqual(back.get(5), stack(PICK, 1, 33));
  assert.equal(back.get(5).dur, 33);
});

test('restore drops unknown ids and junk instead of throwing', () => {
  const c = new Container(6);
  c.restore([[9999, 4], [DIRT, 5], null, ['nope', 1], [DIRT, 0], 'garbage']);
  assert.equal(c.get(0), null, 'item id from an older build is dropped');
  assert.deepEqual(c.get(1), stack(DIRT, 5));
  assert.equal(c.get(3), null);
  assert.equal(c.get(4), null);
  assert.equal(c.get(5), null);
  assert.equal(c.count(DIRT), 5);
});

test('restore tolerates a short/missing payload', () => {
  const c = new Container(3);
  c.addItem(DIRT, 5);
  c.restore(undefined);
  assert.equal(c.isEmpty(), true);
});

test('PlayerInventory.from returns a PlayerInventory', () => {
  const p = new PlayerInventory();
  p.set(0, stack(DIRT, 2));
  p.selected = 4;
  const back = PlayerInventory.from(p.size, p.serialize());
  assert.ok(back instanceof PlayerInventory);
  assert.equal(back.size, HOTBAR_SIZE + MAIN_SIZE);
  assert.deepEqual(back.serialize(), p.serialize());
});

// ------------------------------------------------------------ player inventory

test('player inventory is 9 hotbar + 27 main', () => {
  const p = new PlayerInventory();
  assert.equal(p.size, 36);
  assert.equal(HOTBAR_SIZE, 9);
  assert.equal(MAIN_SIZE, 27);
  assert.equal(p.selected, 0);
  assert.equal(p.hotbarStacks().length, 9);
  assert.equal(p.firstEmpty(), 0);
});

test('held/setHeld follow the selected slot', () => {
  const p = new PlayerInventory();
  p.selected = 3;
  p.setHeld(stack(DIRT, 7));
  assert.deepEqual(p.held(), stack(DIRT, 7));
  assert.deepEqual(p.get(3), stack(DIRT, 7));
  assert.equal(p.firstEmpty(), 0);
});

test('consumeHeld empties the slot at zero and refuses overdrafts', () => {
  const p = new PlayerInventory();
  p.setHeld(stack(DIRT, 2));
  assert.equal(p.consumeHeld(1), true);
  assert.deepEqual(p.held(), stack(DIRT, 1));
  assert.equal(p.consumeHeld(3), false);
  assert.deepEqual(p.held(), stack(DIRT, 1), 'a refused consume changes nothing');
  assert.equal(p.consumeHeld(1), true);
  assert.equal(p.held(), null);
  assert.equal(p.consumeHeld(1), false);
});

test('damageHeld wears a tool then breaks it', () => {
  const p = new PlayerInventory();
  p.setHeld(stack(PICK, 1));              // no dur yet = factory fresh
  assert.equal(p.damageHeld(1), 'damaged');
  assert.equal(p.held().dur, 59);
  assert.equal(p.damageHeld(50), 'damaged');
  assert.equal(p.held().dur, 9);
  assert.equal(p.damageHeld(9), 'broke');
  assert.equal(p.held(), null, 'a broken tool leaves an empty slot, not a 0-count ghost');
});

test('damageHeld ignores blocks and empty hands', () => {
  const p = new PlayerInventory();
  assert.equal(p.damageHeld(1), null);
  p.setHeld(stack(DIRT, 4));
  assert.equal(p.damageHeld(1), null);
  assert.deepEqual(p.held(), stack(DIRT, 4));
});

// -------------------------------------------------------------------- clicking

test('left click on a full slot with an empty cursor picks it all up', () => {
  const c = new Container(3);
  c.set(0, stack(DIRT, 10));
  const r = clickSlot(c, 0, null, { button: 0 });
  assert.deepEqual(r.cursor, stack(DIRT, 10));
  assert.equal(r.changed, true);
  assert.equal(c.get(0), null);
});

test('left click on an empty slot with an empty cursor does nothing', () => {
  const c = new Container(3);
  const r = clickSlot(c, 0, null, { button: 0 });
  assert.equal(r.cursor, null);
  assert.equal(r.changed, false);
});

test('left click deposits the whole cursor into an empty slot', () => {
  const c = new Container(3);
  const r = clickSlot(c, 1, stack(DIRT, 12), { button: 0 });
  assert.equal(r.cursor, null);
  assert.equal(r.changed, true);
  assert.deepEqual(c.get(1), stack(DIRT, 12));
});

test('left click merges as much as fits and keeps the rest on the cursor', () => {
  const c = new Container(3);
  c.set(0, stack(DIRT, 60));
  const r = clickSlot(c, 0, stack(DIRT, 10), { button: 0 });
  assert.deepEqual(c.get(0), stack(DIRT, 64));
  assert.deepEqual(r.cursor, stack(DIRT, 6));
  assert.equal(r.changed, true);
});

test('left click on a full same-item slot is a no-op', () => {
  const c = new Container(3);
  c.set(0, stack(DIRT, 64));
  const r = clickSlot(c, 0, stack(DIRT, 5), { button: 0 });
  assert.deepEqual(c.get(0), stack(DIRT, 64));
  assert.deepEqual(r.cursor, stack(DIRT, 5));
  assert.equal(r.changed, false);
});

test('left click swaps different items', () => {
  const c = new Container(3);
  c.set(0, stack(STONE, 5));
  const r = clickSlot(c, 0, stack(DIRT, 3), { button: 0 });
  assert.deepEqual(c.get(0), stack(DIRT, 3));
  assert.deepEqual(r.cursor, stack(STONE, 5));
  assert.equal(r.changed, true);
});

test('left click swaps identical tools instead of merging them', () => {
  const c = new Container(3);
  c.set(0, stack(PICK, 1, 10));
  const r = clickSlot(c, 0, stack(PICK, 1, 60), { button: 0 });
  assert.deepEqual(c.get(0), stack(PICK, 1, 60));
  assert.deepEqual(r.cursor, stack(PICK, 1, 10));
  assert.equal(r.changed, true);
});

test('left click swaps two unworn tools rather than stacking them', () => {
  const c = new Container(3);
  c.set(0, stack(PICK, 1));
  const r = clickSlot(c, 0, stack(PICK, 1), { button: 0 });
  assert.deepEqual(c.get(0), stack(PICK, 1));
  assert.deepEqual(r.cursor, stack(PICK, 1));
  assert.equal(c.count(PICK), 1, 'the slot must still hold exactly one pick');
  assert.equal(r.changed, true);
});

test('right click cannot drip a second tool into a tool slot', () => {
  const c = new Container(3);
  c.set(0, stack(PICK, 1));
  const r = clickSlot(c, 0, stack(PICK, 1, 60), { button: 2 });
  assert.deepEqual(c.get(0), stack(PICK, 1));
  assert.deepEqual(r.cursor, stack(PICK, 1, 60));
  assert.equal(r.changed, false);
});

test('right click with an empty cursor takes half, rounded up', () => {
  const c = new Container(3);
  c.set(0, stack(DIRT, 7));
  const r = clickSlot(c, 0, null, { button: 2 });
  assert.deepEqual(r.cursor, stack(DIRT, 4));
  assert.deepEqual(c.get(0), stack(DIRT, 3));

  c.set(1, stack(STONE, 1));
  const r2 = clickSlot(c, 1, null, { button: 2 });
  assert.deepEqual(r2.cursor, stack(STONE, 1));
  assert.equal(c.get(1), null);
});

test('right click while holding places exactly one at a time', () => {
  const c = new Container(3);
  let cur = stack(DIRT, 3);
  let r = clickSlot(c, 0, cur, { button: 2 });
  assert.deepEqual(c.get(0), stack(DIRT, 1));
  assert.deepEqual(r.cursor, stack(DIRT, 2));
  r = clickSlot(c, 0, r.cursor, { button: 2 });
  assert.deepEqual(c.get(0), stack(DIRT, 2));
  r = clickSlot(c, 0, r.cursor, { button: 2 });
  assert.deepEqual(c.get(0), stack(DIRT, 3));
  assert.equal(r.cursor, null, 'cursor empties rather than going to count 0');
});

test('right click onto a different item does nothing', () => {
  const c = new Container(3);
  c.set(0, stack(STONE, 2));
  const r = clickSlot(c, 0, stack(DIRT, 3), { button: 2 });
  assert.deepEqual(c.get(0), stack(STONE, 2));
  assert.deepEqual(r.cursor, stack(DIRT, 3));
  assert.equal(r.changed, false);
});

test('shift click moves hotbar -> main and back, cursor untouched', () => {
  const p = new PlayerInventory();
  p.set(0, stack(DIRT, 20));
  const cur = stack(STONE, 1);
  const r = clickSlot(p, 0, cur, { button: 0, shift: true });
  assert.equal(p.get(0), null);
  assert.deepEqual(p.get(HOTBAR_SIZE), stack(DIRT, 20));
  assert.deepEqual(r.cursor, cur);
  assert.equal(r.changed, true);

  const back = clickSlot(p, HOTBAR_SIZE, null, { button: 0, shift: true });
  assert.deepEqual(p.get(0), stack(DIRT, 20));
  assert.equal(p.get(HOTBAR_SIZE), null);
  assert.equal(back.changed, true);
});

test('shift click merges into partial stacks first and leaves the remainder', () => {
  const p = new PlayerInventory();
  p.set(0, stack(DIRT, 20));
  p.set(HOTBAR_SIZE, stack(DIRT, 60));
  for (let i = HOTBAR_SIZE + 1; i < p.size; i++) p.set(i, stack(STONE, 64));  // main is otherwise full
  const r = clickSlot(p, 0, null, { button: 0, shift: true });
  assert.deepEqual(p.get(HOTBAR_SIZE), stack(DIRT, 64));
  assert.deepEqual(p.get(0), stack(DIRT, 16));
  assert.equal(r.changed, true);

  const again = clickSlot(p, 0, null, { button: 0, shift: true });
  assert.equal(again.changed, false, 'nowhere left to go = no change');
  assert.deepEqual(p.get(0), stack(DIRT, 16));
});

test('shift click hands the stack to otherContainer when one is open', () => {
  const p = new PlayerInventory();
  const chest = new Container(4, 'chest');
  p.set(2, stack(DIRT, 30));
  const r = clickSlot(p, 2, null, { button: 0, shift: true, otherContainer: chest });
  assert.equal(p.get(2), null);
  assert.deepEqual(chest.get(0), stack(DIRT, 30));
  assert.equal(r.changed, true);
});

test('shift click on an empty slot is a no-op', () => {
  const p = new PlayerInventory();
  const r = clickSlot(p, 5, null, { button: 0, shift: true });
  assert.equal(r.changed, false);
});

test('takeOnly slots hand the result over and refuse placements', () => {
  const out = new Container(1, 'result');
  out.set(0, stack(PLANKS, 4));
  const taken = clickSlot(out, 0, null, { button: 0, takeOnly: true });
  assert.deepEqual(taken.cursor, stack(PLANKS, 4));
  assert.equal(out.get(0), null);

  out.set(0, stack(PLANKS, 4));
  const blocked = clickSlot(out, 0, stack(DIRT, 1), { button: 0, takeOnly: true });
  assert.deepEqual(out.get(0), stack(PLANKS, 4), 'the result slot never accepts a placement');
  assert.deepEqual(blocked.cursor, stack(DIRT, 1));
  assert.equal(blocked.changed, false);

  const merged = clickSlot(out, 0, stack(PLANKS, 2), { button: 0, takeOnly: true });
  assert.deepEqual(merged.cursor, stack(PLANKS, 6));
  assert.equal(out.get(0), null);
  assert.equal(merged.changed, true);
});

test('takeOnly refuses a take that would not fit on the cursor', () => {
  const out = new Container(1, 'result');
  out.set(0, stack(PLANKS, 4));
  const r = clickSlot(out, 0, stack(PLANKS, 62), { button: 0, takeOnly: true });
  assert.equal(r.changed, false);
  assert.deepEqual(out.get(0), stack(PLANKS, 4));
  assert.deepEqual(r.cursor, stack(PLANKS, 62));
});

test('takeOnly right click still takes the whole result', () => {
  const out = new Container(1, 'result');
  out.set(0, stack(PLANKS, 4));
  const r = clickSlot(out, 0, null, { button: 2, takeOnly: true });
  assert.deepEqual(r.cursor, stack(PLANKS, 4));
  assert.equal(out.get(0), null);
});

test('allowPlace:false slots can be emptied but not filled', () => {
  const c = new Container(2);
  c.set(0, stack(PLANKS, 4));
  const blocked = clickSlot(c, 1, stack(DIRT, 1), { button: 0, allowPlace: false });
  assert.equal(c.get(1), null);
  assert.deepEqual(blocked.cursor, stack(DIRT, 1));
  assert.equal(blocked.changed, false);
  const ok = clickSlot(c, 0, null, { button: 0, allowPlace: false });
  assert.deepEqual(ok.cursor, stack(PLANKS, 4));
  assert.equal(c.get(0), null);
});

test('clicking out of range is harmless', () => {
  const c = new Container(2);
  const r = clickSlot(c, 7, stack(DIRT, 1), { button: 0 });
  assert.deepEqual(r.cursor, stack(DIRT, 1));
  assert.equal(r.changed, false);
});

// ------------------------------------------------------------- regressions
// Each of these covers a defect that shipped once; keep them.

test('removeAt with a fractional n neither loses nor invents items', () => {
  // take and rest were both floored independently, so 2.6 of 5 handed back 2
  // and left 2 - one item deleted per call.
  const c = new Container(1);
  c.set(0, stack(DIRT, 5));
  const out = c.removeAt(0, 2.6);
  assert.equal(out.count + c.get(0).count, 5);
  assert.ok(Number.isInteger(out.count) && Number.isInteger(c.get(0).count));
  assert.equal(c.removeAt(0, 0.4), null, 'less than one item is not a take');
  assert.equal(c.count(DIRT), 5 - out.count);
});

test('consumeHeld and removeItems only ever move whole items', () => {
  const p = new PlayerInventory();
  p.setHeld(stack(DIRT, 5));
  p.consumeHeld(1.5);
  assert.ok(Number.isInteger(p.held().count), `fractional slot count ${p.held().count}`);
  const c = new Container(2);
  c.set(0, stack(DIRT, 5));
  c.removeItems(DIRT, 1.5);
  assert.ok(Number.isInteger(c.get(0).count), `fractional slot count ${c.get(0).count}`);
});

test('a non-finite count can never reach a slot', () => {
  // Infinity survives Math.floor, then JSON-encodes as null and silently
  // deletes the slot on the next load - so it must be rejected on the way in.
  const c = new Container(3);
  c.set(0, stack(DIRT, Infinity));
  assert.equal(c.get(0), null);
  c.restore([[DIRT, Infinity], [DIRT, NaN], [DIRT, '4']]);
  assert.equal(c.get(0), null);
  assert.equal(c.get(1), null);
  assert.deepEqual(c.get(2), stack(DIRT, 4));
});

test('a plain 36-slot container is not treated as a player inventory', () => {
  // hotbar <-> main is a PlayerInventory concept; a same-sized cargo chest with
  // no partner container has nowhere to send a shift-click.
  const chest = new Container(HOTBAR_SIZE + MAIN_SIZE, 'cargo');
  chest.set(0, stack(DIRT, 5));
  const r = clickSlot(chest, 0, null, { button: 0, shift: true });
  assert.equal(r.changed, false);
  assert.deepEqual(chest.get(0), stack(DIRT, 5));
});

test('shift-clicking between two containers conserves every item', () => {
  const p = new PlayerInventory();
  const chest = new Container(9, 'chest');
  for (let i = 0; i < 9; i++) p.set(i, stack(i % 2 ? DIRT : STONE, 10 + i));
  for (let i = 0; i < 5; i++) chest.set(i, stack(DIRT, 60));
  const total = () => p.count(DIRT) + p.count(STONE) + chest.count(DIRT) + chest.count(STONE);
  const before = total();
  let seed = 99;
  const next = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  for (let i = 0; i < 600; i++) {
    const intoChest = next(2) === 0;
    const from = intoChest ? p : chest;
    const to = intoChest ? chest : p;
    clickSlot(from, next(from.size), null, { button: 0, shift: true, otherContainer: to });
    assert.equal(total(), before, `item count drifted on iteration ${i}`);
  }
});

test('every click leaves slots null or count >= 1', () => {
  // A deterministic sweep: no Math.random, so a failure is reproducible.
  const p = new PlayerInventory();
  p.set(0, stack(DIRT, 64));
  p.set(1, stack(PICK, 1, 40));
  p.set(2, stack(CAN, 9));
  let cur = stack(AXE, 1, 60);
  let seed = 12345;
  const next = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  for (let i = 0; i < 500; i++) {
    const r = clickSlot(p, next(p.size), cur, {
      button: next(2) === 0 ? 0 : 2,
      shift: next(4) === 0,
    });
    cur = r.cursor;
    if (cur !== null) assert.ok(cur.count >= 1, 'cursor count >= 1');
    for (const s of p.slots) {
      if (s === null) continue;
      assert.ok(s.count >= 1 && Number.isInteger(s.count), `slot invariant broken: ${JSON.stringify(s)}`);
      assert.ok(s.count <= maxStack(s.item), `slot over cap: ${JSON.stringify(s)}`);
    }
  }
  // Nothing may be conjured or lost by clicking alone.
  const total = p.count(PICK) + p.count(AXE) + (cur && (cur.item === PICK || cur.item === AXE) ? cur.count : 0);
  assert.equal(total, 2);
});

// ------------------------------------------------------------------- armour

test('ArmourContainer has exactly one slot per ARMOUR_SLOTS entry', () => {
  const a = new ArmourContainer();
  assert.equal(a.size, ARMOUR_SLOTS.length);
  assert.equal(a.size, 4);
});

test('set() puts a piece in its own slot and refuses everywhere else', () => {
  const a = new ArmourContainer();
  a.set(0, stack(HELMET, 1));
  assert.deepEqual(a.get(0), stack(HELMET, 1));
  a.set(3, stack(HELMET, 1));            // wrong slot for a helmet
  assert.equal(a.get(3), null, 'set() must silently refuse a slot mismatch');
  a.set(1, stack(DIRT, 5));              // not armour at all
  assert.equal(a.get(1), null);
});

test('addStack (addRange) routes each piece to its own slot and refuses the rest', () => {
  // addRange is one of the two methods that write this.slots[i] directly in
  // the base Container - this is the regression the spec calls out by name.
  const a = new ArmourContainer();
  assert.equal(a.addStack(stack(HELMET, 1)), null, 'a helmet should fit head');
  assert.deepEqual(a.get(0), stack(HELMET, 1));
  assert.equal(a.addStack(stack(BOOTS, 1)), null, 'boots should fit feet, not head');
  assert.deepEqual(a.get(3), stack(BOOTS, 1));

  // Neither a duplicate for an occupied slot nor a non-armour item can land.
  const dupe = a.addStack(stack(HELMET2, 1));
  assert.deepEqual(dupe, stack(HELMET2, 1), 'head is already worn');
  const notArmour = a.addStack(stack(DIRT, 5));
  assert.deepEqual(notArmour, stack(DIRT, 5), 'dirt fits no armour slot at all');
  assert.equal(a.get(0).item, HELMET, 'the helmet already there must be untouched');
  assert.equal(a.get(1), null);
  assert.equal(a.get(2), null);
});

test('restore() drops any entry that does not match its slot, not just unknown ids', () => {
  // A hand-edited or cross-version save putting boots in the head slot must
  // not survive the load - restore() is the other method that bypasses set().
  const a = new ArmourContainer();
  a.restore([[BOOTS, 1], [HELMET, 1], null, [HELMET, 1]]);
  assert.equal(a.get(0), null, 'boots do not belong in head');
  assert.equal(a.get(1), null, 'a helmet does not belong in chest');
  assert.equal(a.get(2), null);
  assert.equal(a.get(3), null, 'a helmet does not belong in feet');
  // The same data, correctly placed, must load.
  const ok = new ArmourContainer().restore([[HELMET, 1], null, null, [BOOTS, 1]]);
  assert.deepEqual(ok.get(0), stack(HELMET, 1));
  assert.deepEqual(ok.get(3), stack(BOOTS, 1));
});

test('roomFor an armour piece is 0 or 1, never a stack size', () => {
  const a = new ArmourContainer();
  assert.equal(a.roomFor(stack(HELMET, 1)), 1);
  a.set(0, stack(HELMET, 1));
  assert.equal(a.roomFor(stack(HELMET2, 1)), 0, 'head is already taken');
  assert.equal(a.roomFor(stack(BOOTS, 1)), 1, 'feet is still free');
  assert.equal(a.roomFor(stack(DIRT, 1)), 0, 'dirt fits no armour slot');
});

test('two helmets never merge, even in a plain Container', () => {
  const c = new Container(2);
  c.set(0, stack(HELMET, 1));
  const left = c.addStack(stack(HELMET, 1));
  assert.deepEqual(left, null, 'the second helmet opens its own slot');
  assert.deepEqual(c.get(0), stack(HELMET, 1));
  assert.deepEqual(c.get(1), stack(HELMET, 1));
});

test('a click that ArmourContainer refuses leaves the cursor intact', () => {
  const a = new ArmourContainer();
  const cur = stack(BOOTS, 1);
  const r = clickSlot(a, 0, cur, { button: 0 });   // boots onto the empty head slot
  assert.equal(r.changed, false);
  assert.deepEqual(r.cursor, cur, 'a refused placement must not eat the held item');
  assert.equal(a.get(0), null);

  // Same refusal on a right-click place-one.
  const r2 = clickSlot(a, 0, cur, { button: 2 });
  assert.equal(r2.changed, false);
  assert.deepEqual(r2.cursor, cur);
  assert.equal(a.get(0), null);

  // And a refused swap: something already sits in the right slot.
  a.set(0, stack(HELMET, 1));
  const r3 = clickSlot(a, 0, cur, { button: 0 });   // boots swapped onto a helmet slot
  assert.equal(r3.changed, false);
  assert.deepEqual(r3.cursor, cur);
  assert.deepEqual(a.get(0), stack(HELMET, 1), 'the worn helmet must not be swapped out for boots');
});

test('a shift-clicked helmet equips into head; a second one has nowhere to go', () => {
  const p = new PlayerInventory();
  const armour = new ArmourContainer();
  p.set(0, stack(HELMET, 1));
  const equip = clickSlot(p, 0, null, { button: 0, shift: true, otherContainer: armour });
  assert.equal(equip.changed, true);
  assert.equal(p.get(0), null);
  assert.deepEqual(armour.get(0), stack(HELMET, 1));

  // Boots still shift-click straight into the empty feet slot...
  p.set(1, stack(BOOTS, 1));
  const equipBoots = clickSlot(p, 1, null, { button: 0, shift: true, otherContainer: armour });
  assert.equal(equipBoots.changed, true);
  assert.deepEqual(armour.get(3), stack(BOOTS, 1));

  // ...but a second helmet is refused: head is already worn, and armour never
  // swaps on a shift-click, only equips into an empty slot.
  p.set(2, stack(HELMET2, 1));
  const blocked = clickSlot(p, 2, null, { button: 0, shift: true, otherContainer: armour });
  assert.equal(blocked.changed, false);
  assert.deepEqual(p.get(2), stack(HELMET2, 1), 'a refused shift-click must not eat the stack');
  assert.deepEqual(armour.get(0), stack(HELMET, 1), 'the worn helmet must not be replaced');
});

console.log(`inventory: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
