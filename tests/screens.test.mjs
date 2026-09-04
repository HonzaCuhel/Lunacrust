// Drives app/js/screens.js against a mini-DOM and the REAL siblings.
//
// The first cut of this file stubbed inventory.js / recipes.js / itemart.js
// because they were being written in the same batch. Stubs are why it passed
// while the panel deleted every item you clicked: the stub's clickSlot took the
// cursor *wrapper* and mutated it, the real one takes the cursor *stack* and
// returns the new one. So nothing is stubbed any more - the only fake here is
// the DOM (an El tree plus a canvas that swallows paint calls), and every
// container, recipe, sprite and furnace is the shipping module.
//
//   node tests/screens.test.mjs

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const appJs = path.join(root, 'app', 'js');

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed++;
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err.stack ?? String(err));
    process.exitCode = 1;
    throw err;
  }
};

// ============================================================== mini DOM
class El {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this.doc = doc;
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.attrs = {};
    this.textContent = '';
    this._html = '';
    this._id = '';
    this._cls = new Set();
    this._listeners = new Map();
    this.style = makeStyle();
    this.classList = makeClassList(this._cls);
    this.value = '';
    this.type = '';
    this.placeholder = '';
    this.offsetWidth = 0;
    if (this.tagName === 'CANVAS') makeCanvas(this);
  }

  get id() { return this._id; }
  set id(v) { this._id = v; this.doc.ids.set(v, this); }

  get className() { return [...this._cls].join(' '); }
  set className(v) {
    this._cls.clear();
    for (const c of String(v).split(/\s+/)) if (c) this._cls.add(c);
  }

  get innerHTML() { return this._html; }
  set innerHTML(v) {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    this._html = String(v);
  }

  appendChild(child) {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parentNode = null;
    return child;
  }

  remove() { this.parentNode?.removeChild(this); }

  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  focus() {}

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }

  removeEventListener(type, fn) {
    const list = this._listeners.get(type);
    if (list) this._listeners.set(type, list.filter((f) => f !== fn));
  }
}

/** Enough 2d context for icons.js and itemart.js to paint into the void. */
function makeCanvas(el) {
  el.width = 0;
  el.height = 0;
  const ctx = {
    imageSmoothingEnabled: true,
    filter: 'none',
    fillStyle: '#000',
    save() {}, restore() {}, setTransform() {}, drawImage() {},
    putImageData() {}, fillRect() {}, clearRect() {},
  };
  el.getContext = () => ctx;
}

function makeStyle() {
  const s = {};
  Object.defineProperty(s, 'setProperty', {
    value: (k, v) => { s[k] = v; },
    enumerable: false,
  });
  return s;
}

function makeClassList(set) {
  return {
    add: (...c) => c.forEach((x) => set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    contains: (c) => set.has(c),
    toggle: (c, force) => {
      const on = force === undefined ? !set.has(c) : !!force;
      if (on) set.add(c); else set.delete(c);
      return on;
    },
  };
}

function makeDom() {
  const doc = {
    ids: new Map(),
    _listeners: new Map(),
    createElement(tag) { return new El(tag, doc); },
    getElementById(id) { return doc.ids.get(id) ?? null; },
    addEventListener(type, fn) {
      if (!doc._listeners.has(type)) doc._listeners.set(type, []);
      doc._listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = doc._listeners.get(type);
      if (list) doc._listeners.set(type, list.filter((f) => f !== fn));
    },
  };
  doc.body = new El('body', doc);
  globalThis.document = doc;
  globalThis.window = { innerWidth: 1440, innerHeight: 900 };
  globalThis.ImageData = class ImageData {
    constructor(data, w, h) { this.data = data; this.width = w; this.height = h; }
  };
  return doc;
}

/** Fire a listener registered through the shim. Returns the synthetic event. */
function fire(node, type, extra = {}) {
  const list = (node._listeners ?? new Map()).get(type) ?? [];
  let defaultPrevented = false, immediateStopped = false;
  const ev = {
    type,
    preventDefault() { defaultPrevented = true; },
    stopPropagation() {},
    stopImmediatePropagation() { immediateStopped = true; },
    shiftKey: false,
    button: 0,
    clientX: 0,
    clientY: 0,
    target: node,
    ...extra,
  };
  for (const fn of [...list]) { fn(ev); if(immediateStopped) break; }
  ev.defaultPrevented = defaultPrevented;
  ev.immediateStopped = immediateStopped;
  return ev;
}

/** Depth-first search of the shim tree by class name. */
function byClass(node, cls, out = []) {
  if (node._cls?.has(cls)) out.push(node);
  for (const c of node.children ?? []) byClass(c, cls, out);
  return out;
}

// ============================================== real modules, DOM ready first
const doc = makeDom();
// Pre-create half the shells so both the "already in index.html" and the
// "build it yourself" branches of mount() are exercised.
for (const id of ['screen-inventory', 'inv-cursor']) {
  const n = doc.createElement(id.startsWith('screen') ? 'section' : 'div');
  n.id = id;
  doc.body.appendChild(n);
}

const { GameScreens } = await import('../app/js/screens.js');
const { Container, PlayerInventory, ArmourContainer } = await import('../app/js/inventory.js');
const { itemIdOf, ITEMS } = await import('../app/js/items.js');
const { ARMOUR_SLOTS } = await import('../app/js/armour.js');
const { RECIPES, recipesForSize, canCraft, smeltingResult } = await import('../app/js/recipes.js');
const { Stations, newFurnace } = await import('../app/js/stations.js');
const { Survival } = await import('../app/js/survival.js');

const ID = (key) => itemIdOf(key);
const stack = (key, count, dur) => {
  const s = { item: ID(key), count };
  if (dur != null) s.dur = dur;
  return s;
};

/** Every item the player owns, wherever it currently sits. */
function census(...holders) {
  const m = new Map();
  const add = (s) => { if (s) m.set(s.item, (m.get(s.item) ?? 0) + s.count); };
  for (const h of holders) {
    if (!h) continue;
    if (Array.isArray(h.slots)) h.slots.forEach(add);
    else if (h.stack !== undefined) add(h.stack);
    else add(h);
  }
  return [...m.entries()].sort((a, b) => a[0] - b[0]);
}

const planet = { name: 'Mars', atmosphere: { breathable: false, label: 'CO₂ at 0.6 kPa', suitDrain: 0.2 } };

const inventory = new PlayerInventory();
inventory.set(0, stack('hand_drill', 1, 96));      // worn tool, hotbar slot 0
inventory.set(1, stack('iron_pickaxe', 1, 251));   // pristine tool
inventory.set(3, stack('cobble', 12));
inventory.set(9, stack('log', 3));                 // first cargo slot
inventory.set(10, stack('ration', 1));
inventory.selected = 2;

const survival = new Survival(planet);
survival.health = 15;
survival.hunger = 7;
survival.oxygen = 42;

const calls = { change: 0, close: 0, take: 0, quick: [] };
const screens = new GameScreens({
  audio: null,
  onChange: () => { calls.change++; },
  onClose: () => { calls.close++; },
  onCraftTake: () => { calls.take++; },
  onQuickCraft: (r) => { calls.quick.push(r); },
});

const data = {
  inventory,
  armour: new ArmourContainer(),
  craftGrid: new Container(4, 'craft'),
  craftResult: new Container(1, 'result'),
  furnace: null,
  cursor: { stack: null },
  survival,
  mode: 'survival',
  planet,
};

const START = census(inventory, data.cursor, data.craftGrid);

// ==================================================================== run
test('shells exist and start hidden', () => {
  for (const id of ['screen-inventory', 'screen-death', 'inv-cursor', 'inv-tip']) {
    const node = doc.getElementById(id);
    assert.ok(node, `${id} missing`);
    assert.ok(node.classList.contains('hidden'), `${id} should start hidden`);
  }
  assert.equal(screens.isOpen(), false);
  assert.equal(screens.kind(), null);
});

test('open("inventory") lays out 27 cargo + 9 hotbar + 2x2 craft + result', () => {
  screens.open('inventory', data);
  assert.equal(screens.isOpen(), true);
  assert.equal(screens.kind(), 'inventory');
  assert.equal(doc.getElementById('screen-inventory').classList.contains('hidden'), false);
  assert.equal(screens.mainView.slots.length, 27);
  assert.equal(screens.hotView.slots.length, 9);
  assert.equal(screens._workViews.grid.slots.length, 4);
  assert.ok(screens._workViews.result);
  assert.equal(screens.headTitle.textContent, 'Suit Inventory');
  assert.equal(screens.bookEl.classList.contains('hidden'), false);
});

test('stats strip draws 10 hearts, 10 drumsticks and an oxygen bar', () => {
  assert.equal(screens.hearts.length, 10);
  assert.equal(screens.food.length, 10);
  // health 15 of 20 -> seven full hearts, one half, two empty
  assert.equal(screens.hearts[6].style['--fill'], '100%');
  assert.equal(screens.hearts[7].style['--fill'], '50%');
  assert.equal(screens.hearts[8].style['--fill'], '0%');
  assert.ok(screens.hearts[8].classList.contains('inv-pip-off'));
  assert.ok(screens.hearts[7].classList.contains('inv-heart'));
  // hunger 7 of 20 -> three and a half drumsticks
  assert.equal(screens.food[3].style['--fill'], '50%');
  assert.ok(screens.food[3].classList.contains('inv-food'));
  assert.equal(screens.o2Fill.style.width, '42.0%');
  assert.equal(screens.o2Text.textContent, '42%');
  assert.ok(screens.o2Track.classList.contains('low'));
  assert.equal(screens.o2Track.classList.contains('critical'), false);
  assert.match(screens.atmoText.textContent, /Suit sealed/);
});

test('hotbar highlights the selected slot only', () => {
  const sel = screens.hotView.slots.map((s) => s.el.classList.contains('inv-slot-sel'));
  assert.deepEqual(sel, [false, false, true, false, false, false, false, false, false]);
  assert.equal(screens.mainView.slots.some((s) => s.el.classList.contains('inv-slot-sel')), false);
});

test('cargo grid is the flat store offset past the hotbar', () => {
  assert.equal(screens.mainView.slots[0].stack, inventory.get(9));
  assert.equal(screens.hotView.slots[0].stack, inventory.get(0));
});

test('counts print above 1 only, with a 44px sprite per filled slot', () => {
  assert.equal(screens.hotView.slots[3].count.textContent, '12');
  assert.equal(screens.hotView.slots[0].count.textContent, '');   // count 1
  assert.equal(screens.hotView.slots[2].count.textContent, '');   // empty
  assert.equal(screens.hotView.slots[3].ico.children.length, 1);
  assert.equal(screens.hotView.slots[3].ico.children[0].width, 44);
  assert.equal(screens.hotView.slots[2].ico.children.length, 0);
});

test('durability bar shows only for a worn tool, green to red', () => {
  const worn = screens.hotView.slots[0];      // hand_drill 96/160
  const fresh = screens.hotView.slots[1];     // iron_pickaxe 251/251
  assert.equal(worn.dur.classList.contains('hidden'), false);
  assert.equal(worn.durFill.style.width, '60.0%');
  assert.equal(worn.durFill.style.background, 'hsl(72, 72%, 46%)');
  assert.ok(fresh.dur.classList.contains('hidden'));
  assert.ok(screens.hotView.slots[2].dur.classList.contains('hidden'));
});

test('tooltip names the item and spells out durability', () => {
  fire(screens.hotView.slots[0].el, 'mouseenter');
  assert.equal(screens.tipName.textContent, 'Standard Hand Drill');
  assert.equal(screens.tipSub.textContent, 'durability 96 / 160');
  assert.equal(screens.tipEl.classList.contains('hidden'), false);
  fire(screens.hotView.slots[3].el, 'mouseenter');
  assert.equal(screens.tipName.textContent, ITEMS[ID('cobble')].name);
  assert.equal(screens.tipSub.textContent, '');
  fire(screens.hotView.slots[3].el, 'mouseleave');
  assert.ok(screens.tipEl.classList.contains('hidden'));
});

// --- the suit -----------------------------------------------------------
test('the suit panel renders exactly four slots, one per ARMOUR_SLOTS entry', () => {
  assert.equal(screens.armourView.slots.length, ARMOUR_SLOTS.length);
  screens.armourView.slots.forEach((s, i) => {
    assert.ok(s.el.classList.contains('inv-slot-' + ARMOUR_SLOTS[i]), `slot ${i} missing its gear class`);
  });
});

test('a helmet on the cursor equips into head; the same click into boots is refused', () => {
  data.cursor.stack = { item: ID('patch_helmet'), count: 1 };
  fire(screens.armourView.slots[0].el, 'mousedown', { button: 0 });
  assert.equal(data.armour.get(0)?.item, ID('patch_helmet'));
  assert.equal(data.cursor.stack, null, 'the helmet left the hand');

  // Boots onto the same (head) slot: ArmourContainer must refuse it, and the
  // cursor must still be holding it - not eaten as if the drop had succeeded.
  data.cursor.stack = { item: ID('patch_boots'), count: 1 };
  fire(screens.armourView.slots[0].el, 'mousedown', { button: 0 });
  assert.ok(data.cursor.stack, 'a refused click must not empty the hand');
  assert.equal(data.cursor.stack.item, ID('patch_boots'));
  assert.equal(data.armour.get(0)?.item, ID('patch_helmet'), 'the worn helmet must not be swapped out');

  // The boots do fit their own (feet) slot.
  fire(screens.armourView.slots[3].el, 'mousedown', { button: 0 });
  assert.equal(data.armour.get(3)?.item, ID('patch_boots'));
  assert.equal(data.cursor.stack, null);
  data.armour.clear();
  screens.render();
});

test('the armour tooltip reports defence, durability and the helmet O2 saving', () => {
  data.armour.set(0, { item: ID('patch_helmet'), count: 1, dur: 100 });
  screens.render();
  fire(screens.armourView.slots[0].el, 'mouseenter');
  assert.equal(screens.tipName.textContent, ITEMS[ID('patch_helmet')].name);
  assert.equal(screens.tipSub.textContent, '+1 armour · durability 100 / 165 · O₂ −20%');

  // Chest carries no o2Save, so its tooltip stops after durability.
  data.armour.set(1, { item: ID('patch_chest'), count: 1 });
  screens.render();
  fire(screens.armourView.slots[1].el, 'mouseenter');
  assert.equal(screens.tipSub.textContent, '+3 armour · durability 240 / 240');

  data.armour.clear();
  screens.render();
});

// --- the bug the stubbed version could not see -----------------------------
test('a left click lifts the stack onto the cursor instead of deleting it', () => {
  const before = calls.change;
  fire(screens.hotView.slots[3].el, 'mousedown', { button: 0, shiftKey: false });
  assert.equal(inventory.get(3), null, 'slot empties');
  assert.ok(data.cursor.stack, 'cursor must be holding the stack, not nothing');
  assert.equal(data.cursor.stack.item, ID('cobble'));
  assert.equal(data.cursor.stack.count, 12);
  assert.equal(calls.change, before + 1);
  assert.equal(screens.cursorEl.classList.contains('hidden'), false);
  assert.equal(screens.cursorCount.textContent, '12');
  assert.equal(screens.cursorIco.children[0].width, 40);
  assert.equal(screens.hotView.slots[3].count.textContent, '');
  assert.deepEqual(census(inventory, data.cursor), START, 'nothing may be destroyed');
});

test('clicking an empty slot drops the carried stack there', () => {
  fire(screens.hotView.slots[4].el, 'mousedown', { button: 0 });
  assert.equal(data.cursor.stack, null);
  assert.equal(inventory.get(4).count, 12);
  assert.ok(screens.cursorEl.classList.contains('hidden'));
  assert.deepEqual(census(inventory, data.cursor), START);
});

test('right-click splits the stack, odd counts favouring the hand', () => {
  fire(screens.hotView.slots[4].el, 'mousedown', { button: 2 });
  assert.equal(data.cursor.stack.count, 6);
  assert.equal(inventory.get(4).count, 6);
  fire(screens.hotView.slots[4].el, 'mousedown', { button: 0 });   // put it back
  assert.equal(inventory.get(4).count, 12);
  assert.equal(data.cursor.stack, null);
  assert.deepEqual(census(inventory, data.cursor), START);
});

test('shift-click moves a hotbar stack into cargo and back', () => {
  fire(screens.hotView.slots[4].el, 'mousedown', { button: 0, shiftKey: true });
  assert.equal(inventory.get(4), null);
  const landed = inventory.slots.findIndex((s, i) => i >= 9 && s?.item === ID('cobble'));
  assert.ok(landed >= 9, 'the stack went to cargo');
  assert.equal(data.cursor.stack, null, 'a quick-move never touches the hand');
  fire(screens.mainView.slots[landed - 9].el, 'mousedown', { button: 0, shiftKey: true });
  const back = inventory.slots.findIndex((s) => s?.item === ID('cobble'));
  assert.ok(back >= 0 && back < 9, 'and comes back to the first free hotbar slot');
  assert.equal(inventory.get(back).count, 12);
  assert.deepEqual(census(inventory, data.cursor), START);
});

test('a click that changes nothing does not report a change', () => {
  const before = { change: calls.change, take: calls.take };
  assert.equal(inventory.get(8), null);
  fire(screens.hotView.slots[8].el, 'mousedown', { button: 0 });   // empty, empty hand
  assert.equal(calls.change, before.change);
  assert.equal(calls.take, before.take);
});

test('the result slot is take-only and calls onCraftTake, not onChange', () => {
  data.craftResult.set(0, { item: ID('planks'), count: 4 });
  screens.render();
  const before = { change: calls.change, take: calls.take };
  fire(screens._workViews.result.el, 'mousedown', { button: 0 });
  assert.equal(calls.take, before.take + 1);
  assert.equal(calls.change, before.change);
  assert.equal(data.cursor.stack.count, 4);
  assert.equal(data.craftResult.get(0), null);
});

test('a refused result click never consumes the grid', () => {
  // Hand is full of something the result cannot merge with: clickSlot refuses,
  // so onCraftTake (which eats the crafting grid) must not fire.
  data.cursor.stack = { item: ID('cobble'), count: 3 };
  data.craftResult.set(0, { item: ID('planks'), count: 4 });
  screens.render();
  const before = { change: calls.change, take: calls.take };
  fire(screens._workViews.result.el, 'mousedown', { button: 0 });
  assert.equal(calls.take, before.take, 'no take, no consume');
  assert.equal(calls.change, before.change);
  assert.equal(data.craftResult.get(0).count, 4, 'the result stayed on the anvil');
  assert.equal(data.cursor.stack.count, 3);
  data.cursor.stack = null;
  data.craftResult.set(0, null);
  screens.render();
});

test('craft-grid slots write into the grid the game recomputes from', () => {
  const before = calls.change;
  fire(screens.mainView.slots[0].el, 'mousedown', { button: 0 });        // pick up the log
  fire(screens._workViews.grid.slots[0].el, 'mousedown', { button: 0 }); // into the grid
  assert.equal(data.craftGrid.get(0).item, ID('log'));
  assert.equal(data.craftGrid.get(0).count, 3);
  assert.equal(calls.change, before + 2, 'the game recomputes after every grid edit');
  // shift-click sends it back to the player, which is how a grid is emptied
  fire(screens._workViews.grid.slots[0].el, 'mousedown', { button: 0, shiftKey: true });
  assert.equal(data.craftGrid.get(0), null);
  assert.deepEqual(census(inventory, data.cursor, data.craftGrid), START);
});

test('recipe book lists exactly the 2x2 recipes, greying out the unaffordable', () => {
  screens.render();
  const rows = byClass(screens.bookList, 'inv-recipe');
  const expected = recipesForSize(2);
  assert.equal(rows.length, expected.length);
  assert.ok(expected.length > 1 && expected.length < RECIPES.length, 'a real subset');
  const names = rows.map((r) => byClass(r, 'inv-recipe-name')[0].textContent);
  const planksName = ITEMS[ID('planks')].name;
  const at = names.indexOf(planksName);
  assert.ok(at >= 0, 'planks is a 2x2 recipe');
  assert.equal(rows[at].classList.contains('inv-recipe-off'), false, 'a log is enough for planks');
  assert.ok(rows.some((r) => r.classList.contains('inv-recipe-off')), 'and something is out of reach');
  // affordability must agree with recipes.js rather than guess
  const counts = inventory.counts();
  const off = rows.filter((r) => r.classList.contains('inv-recipe-off')).length;
  assert.equal(off, expected.filter((r) => !canCraft(r, counts)).length);
  assert.equal(byClass(rows[at], 'inv-recipe-n')[0].textContent, '×4');
});

test('only a craftable row quick-crafts', () => {
  const rows = byClass(screens.bookList, 'inv-recipe');
  const dead = rows.find((r) => r.classList.contains('inv-recipe-off'));
  const live = rows.find((r) => !r.classList.contains('inv-recipe-off'));
  fire(dead, 'click');
  assert.equal(calls.quick.length, 0);
  fire(live, 'click');
  assert.equal(calls.quick.length, 1);
  assert.ok(RECIPES.includes(calls.quick[0]), 'the row hands back a real recipe object');
});

test('the book filter narrows the list without rebuilding the field', () => {
  const field = screens.filterInput;
  const planksName = ITEMS[ID('planks')].name;
  field.value = planksName.toLowerCase();
  fire(field, 'input');
  const rows = byClass(screens.bookList, 'inv-recipe');
  assert.ok(rows.length >= 1);
  for (const r of rows) {
    assert.match(byClass(r, 'inv-recipe-name')[0].textContent.toLowerCase(), new RegExp(planksName.toLowerCase()));
  }
  assert.equal(field.parentNode.classList.contains('inv-book-head'), true, 'field survived');
  field.value = 'nothing-matches-this';
  fire(field, 'input');
  assert.equal(byClass(screens.bookList, 'inv-recipe').length, 0);
  assert.equal(byClass(screens.bookList, 'inv-book-empty').length, 1);
  field.value = '';
  fire(field, 'input');
  assert.equal(byClass(screens.bookList, 'inv-recipe').length, recipesForSize(2).length);
});

test('the cursor follows the mouse without a render', () => {
  data.cursor.stack = { item: ID('cobble'), count: 5 };
  screens.render();
  let renders = 0;
  const real = screens.render.bind(screens);
  screens.render = () => { renders++; real(); };
  fire(doc, 'mousemove', { clientX: 640, clientY: 300 });
  assert.equal(screens.cursorEl.style.transform, 'translate(640px, 300px)');
  fire(doc, 'mousemove', { clientX: 641, clientY: 301 });
  assert.equal(screens.cursorEl.style.transform, 'translate(641px, 301px)');
  assert.equal(renders, 0, 'mousemove must never re-render the panel');
  screens.render = real;
  data.cursor.stack = null;
  screens.render();
});

test('Escape and E close; typing an e in the filter does not', () => {
  const before = calls.close;
  assert.equal(fire(doc, 'keydown', { code: 'Escape' }).defaultPrevented, true);
  assert.equal(calls.close, before + 1);
  fire(doc, 'keydown', { code: 'KeyE' });
  assert.equal(calls.close, before + 2);
  fire(doc, 'keydown', { code: 'KeyE', target: screens.filterInput });
  assert.equal(calls.close, before + 2, 'E belongs to the filter field while it has focus');
  fire(doc, 'keydown', { code: 'KeyW' });
  assert.equal(calls.close, before + 2, 'no other key is ours');
});

test('close() hides everything and stops listening to the mouse', () => {
  screens.close();
  assert.equal(screens.isOpen(), false);
  assert.equal(screens.kind(), null);
  assert.ok(doc.getElementById('screen-inventory').classList.contains('hidden'));
  assert.ok(screens.cursorEl.classList.contains('hidden'));
  const before = calls.close;
  fire(doc, 'keydown', { code: 'Escape' });
  assert.equal(calls.close, before, 'closed panels ignore keys');
  screens.render();  // must be a no-op, not a crash
});

test('fabricator opens a 3x3 grid and the book grows to match', () => {
  data.craftGrid = new Container(9, 'craft');
  screens.open('fabricator', data);
  assert.equal(screens.kind(), 'fabricator');
  assert.equal(screens._workViews.grid.slots.length, 9);
  assert.equal(screens.headTitle.textContent, 'Fabricator');
  const rows = byClass(screens.bookList, 'inv-recipe');
  assert.equal(rows.length, recipesForSize(3).length);
  assert.ok(recipesForSize(3).length > recipesForSize(2).length, '3x3 unlocks more');
  screens.close();
  data.craftGrid = new Container(4, 'craft');
});

// --- smelter: the other shape the stubs got wrong ---------------------------
test('an empty smelter paints three inert slots and no book', () => {
  data.furnace = newFurnace();
  screens.open('furnace', data);
  const v = screens._workViews;
  assert.equal(screens.headTitle.textContent, 'Smelter');
  assert.ok(screens.bookEl.classList.contains('hidden'), 'no crafting grid, no book');
  assert.ok(v.input && v.fuel && v.output);
  assert.equal(v.input.stack, null);
  assert.equal(v.flameFill.style.height, '0.0%');
  assert.equal(v.arrowFill.style.width, '0.0%');
  assert.equal(v.note.textContent, 'Cold — add fuel');
});

test('clicking ore into the smelter writes the bare stacks stations.js ticks', () => {
  const v = screens._workViews;
  const f = data.furnace;
  data.cursor.stack = { item: ID('raw_iron'), count: 4 };
  fire(v.input.el, 'mousedown', { button: 0 });
  assert.equal(data.cursor.stack, null);
  assert.equal(f.input.item, ID('raw_iron'), 'furnace.input is a stack, not a container');
  assert.equal(f.input.count, 4);

  data.cursor.stack = { item: ID('coal'), count: 2 };
  fire(v.fuel.el, 'mousedown', { button: 2 });   // right-click drops exactly one
  assert.equal(f.fuel.count, 1);
  assert.equal(data.cursor.stack.count, 1);
  fire(v.fuel.el, 'mousedown', { button: 0 });   // and the rest merges in
  assert.equal(f.fuel.count, 2);
  assert.equal(data.cursor.stack, null);
});

test('the gauges read burn and progress off the live furnace', () => {
  const v = screens._workViews;
  const f = data.furnace;
  f.burn = 3; f.burnMax = 12; f.progress = 5; f.lit = true;
  screens.render();
  assert.equal(v.flameFill.style.height, '25.0%');
  // raw iron smelts in 10s, so 5s of heat is exactly half an arrow
  assert.equal(smeltingResult(ID('raw_iron')).time, 10);
  assert.equal(v.arrowFill.style.width, '50.0%');
  assert.equal(v.note.textContent, 'Burning');
  f.burn = 0; f.lit = false;
  screens.render();
  assert.equal(v.flameFill.style.height, '0.0%');
  assert.equal(v.note.textContent, 'Idle', 'fuel is still in the tray');
});

test('a real Stations tick smelts what the panel put in', () => {
  const stations = new Stations();
  const f = stations.furnaceAt(2, 3, 4, true);
  data.furnace = f;
  screens.open('furnace', data);
  const v = screens._workViews;
  data.cursor.stack = { item: ID('raw_iron'), count: 1 };
  fire(v.input.el, 'mousedown', { button: 0 });
  data.cursor.stack = { item: ID('coal'), count: 1 };
  fire(v.fuel.el, 'mousedown', { button: 0 });

  stations.update(11);            // 10s to smelt one ingot, coal burns 40
  assert.equal(f.input, null);
  assert.equal(f.output.item, ID('iron_ingot'));
  screens.render();
  assert.equal(v.output.stack.item, ID('iron_ingot'));
  assert.ok(Number(v.flameFill.style.height.replace('%', '')) > 0, 'still burning');
});

test('the smelter output is take-only and is not a craft result', () => {
  const v = screens._workViews;
  const f = data.furnace;
  const before = { take: calls.take, change: calls.change };
  fire(v.output.el, 'mousedown', { button: 0 });
  assert.equal(data.cursor.stack.item, ID('iron_ingot'));
  assert.equal(f.output, null, 'an emptied output collapses to null, never {count: 0}');
  assert.equal(calls.take, before.take, 'a smelter output is not a craft result');
  assert.equal(calls.change, before.change + 1);
  // and it refuses a deposit
  fire(v.output.el, 'mousedown', { button: 0 });
  assert.equal(f.output, null);
  assert.ok(data.cursor.stack, 'the hand keeps what a take-only slot will not accept');
  data.cursor.stack = null;
  screens.render();
  screens.close();
});

test('death card names the world, the cause, and respawns', () => {
  assert.equal(screens.deathRoot.id, 'screen-death');
  assert.equal(screens.deathTitle.id, 'death-title');
  assert.equal(screens.deathCause.id, 'death-cause');
  assert.equal(screens.deathBtn.id, 'death-respawn');

  let respawned = 0;
  screens.showDeath({ planet, cause: 'asphyxiation', onRespawn: () => { respawned++; } });
  assert.equal(screens.deathRoot.classList.contains('hidden'), false);
  assert.equal(screens.deathTitle.textContent, 'You died on Mars');
  assert.equal(screens.deathCause.textContent, 'You suffocated.');
  fire(screens.deathBtn, 'click');
  assert.equal(respawned, 1);
  assert.ok(screens.deathRoot.classList.contains('hidden'), 'respawning closes the card');

  // every cause survival.js and game.js can actually emit, plus the fallback
  for (const [cause, text] of [
    ['fall', 'You fell.'], ['lava', 'You burned.'], ['burning', 'You burned.'],
    ['starvation', 'You starved.'], ['void', 'You fell out of the world.'],
    ['generic', 'Your suit gave out.'], ['', 'Your suit gave out.'],
  ]) {
    screens.showDeath({ planet: 'Titan', cause });
    assert.equal(screens.deathCause.textContent, text, cause || '(none)');
  }
  assert.equal(screens.deathTitle.textContent, 'You died on Titan');
  screens.hideDeath();
  assert.ok(screens.deathRoot.classList.contains('hidden'));
});

test('destroy() unhooks the keyboard', () => {
  screens.destroy();
  const before = calls.close;
  fire(doc, 'keydown', { code: 'Escape' });
  assert.equal(calls.close, before);
});

// ---- the markup and styles this file depends on ---------------------------
test('index.html keeps the existing shell and gains the survival shells', () => {
  const html = fs.readFileSync(path.join(root, 'app', 'index.html'), 'utf8');
  for (const id of ['screen-menu', 'screen-loading', 'screen-pause', 'hud', 'hotbar']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} must survive`);
  }
  for (const id of ['screen-inventory', 'screen-death', 'inv-cursor', 'inv-tip']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} must exist`);
  }
  assert.ok(html.includes('<script type="module" src="./js/main.js">'), 'entry point intact');
});

test('styles.css carries every class screens.js paints with', () => {
  const css = fs.readFileSync(path.join(root, 'app', 'styles.css'), 'utf8');
  const src = fs.readFileSync(path.join(appJs, 'screens.js'), 'utf8');
  const used = new Set();
  for (const m of src.matchAll(/'(inv-[a-z0-9-]+(?: inv-[a-z0-9-]+)*)'/g)) {
    for (const c of m[1].split(' ')) used.add(c);
  }
  used.add('inv-pip'); used.add('death-box'); used.add('death-mark'); used.add('death-cause');
  const missing = [...used].filter((c) => !css.includes('.' + c));
  assert.deepEqual(missing, [], 'unstyled classes');
  assert.ok(css.includes('#screen-inventory'), 'panel needs its centring rule');
  assert.ok(css.includes('#screen-death'), 'death card needs its centring rule');
});

test('styles.css also dresses the survival chrome main.js builds', () => {
  // main.js writes the vitals cluster, the wear bars and the mode switch, but it
  // cannot style them - styles.css belongs to this file.
  const css = fs.readFileSync(path.join(root, 'app', 'styles.css'), 'utf8');
  for (const sel of [
    '#vitals', '.pips', '.pip.heart', '.pip.food', '.ox', '.ox.low',
    '#damage-flash', '.mode-toggle', '.mode-toggle button.on',
    '#hotbar .slot .count', '#hotbar .slot .wear', '#hotbar .slot .icon',
  ]) {
    assert.ok(css.includes(sel), `missing rule for ${sel}`);
  }
});

test('screens.js keeps no randomness of its own', () => {
  const src = fs.readFileSync(path.join(appJs, 'screens.js'), 'utf8');
  assert.equal(/Math\.random/.test(src), false);
});

console.log(`ok  ${passed} checks passed`);
