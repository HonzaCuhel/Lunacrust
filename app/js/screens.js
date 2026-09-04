// Survival screens: the inventory / fabricator / smelter panel, the recipe book
// and the death card. Pure DOM. The game owns the containers; this file only
// paints them and routes clicks back through inventory.js.
//
// Three structural choices worth knowing about:
//
// * Slot elements are created once per grid and repainted in place. game.js
//   calls render() every frame while a smelter is open, so a render that
//   rebuilt forty nodes would burn the frame budget it was meant to show off.
// * The cursor stack moves on `transform` from a document mousemove and never
//   touches render(). Re-rendering an inventory on every mouse event is exactly
//   what makes a voxel UI feel like a web page.
// * clickSlot() owns the slots and hands the new cursor back as a value; the
//   cursor object the game shares with us is the only thing this file writes.
//   Dropping that return value silently deletes whatever was clicked.

import { ITEMS, armourOf } from './items.js';
import { itemSprite } from './itemart.js';
import { clickSlot, HOTBAR_SIZE } from './inventory.js';
import { recipesForSize, canCraft, smeltingResult } from './recipes.js';
import { ARMOUR_SLOTS } from './armour.js';

const SLOT_SPRITE = 44;
const BOOK_SPRITE = 26;
const CURSOR_SPRITE = 40;

/** Death causes in plain words. survival.js emits the keys; this is the copy. */
const CAUSE_TEXT = {
  asphyxiation: 'You suffocated.',
  suffocation: 'You suffocated.',
  oxygen: 'You suffocated.',
  vacuum: 'You suffocated.',
  drown: 'You drowned.',
  drowning: 'You drowned.',
  fall: 'You fell.',
  falling: 'You fell.',
  impact: 'You fell.',
  void: 'You fell out of the world.',
  lava: 'You burned.',
  fire: 'You burned.',
  burning: 'You burned.',
  burn: 'You burned.',
  heat: 'You burned.',
  starve: 'You starved.',
  starvation: 'You starved.',
  hunger: 'You starved.',
  cold: 'You froze.',
  freeze: 'You froze.',
  freezing: 'You froze.',
  pressure: 'The pressure crushed your suit.',
  crush: 'You were crushed.',
};

// ---------------------------------------------------------------- containers
// Every grid on the panel is painted through the same two readers so a slot with
// no container behind it (a smelter block that was mined out from under the
// screen) paints empty and inert instead of throwing mid-render.
const sizeOf = (c) => (c ? c.size | 0 : 0);
const stackAt = (c, i) => (c ? c.get(i) ?? null : null);

/**
 * A furnace keeps its three slots as bare stacks - stations.js ticks them in
 * place and reads `f.input` directly - but clickSlot() speaks Container. This
 * one-slot view writes straight back into the furnace record, so an item dropped
 * in is smelting on the very next tick.
 */
function furnaceSlot(furnace, key) {
  return {
    size: 1,
    get: (i) => (i === 0 ? furnace[key] ?? null : null),
    set(i, stack) {
      // Collapse an emptied slot to null rather than leaving {count: 0} behind:
      // a zero-count ghost would keep the furnace looking busy and would spill a
      // drop of nothing when the block is broken.
      if (i === 0) furnace[key] = stack && stack.count > 0 ? stack : null;
      return this;
    },
  };
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const pct = (frac) => (frac * 100).toFixed(1) + '%';

// --------------------------------------------------------------------- dom
function mount(id, tag, cls) {
  let node = document.getElementById(id);
  let created = false;
  if (!node) {
    node = document.createElement(tag);
    node.id = id;
    document.body.appendChild(node);
    created = true;
  }
  node.className = cls;
  return { node, created };
}

const div = (cls, parent) => {
  const d = document.createElement('div');
  d.className = cls;
  parent?.appendChild(d);
  return d;
};

const span = (cls, parent, text) => {
  const s = document.createElement('span');
  s.className = cls;
  if (text != null) s.textContent = text;
  parent?.appendChild(s);
  return s;
};

/**
 * One heart or drumstick. The shape is a pixel-art clip-path in the stylesheet
 * and the fill is a hard-stopped gradient driven by --fill, so 3 health reads as
 * one and a half hearts. The HUD in main.js draws its pips the same way, which
 * is why the geometry lives in CSS rather than here.
 */
const pip = (cls, parent) => span('inv-pip ' + cls, parent);

// ===========================================================================
export class GameScreens {
  constructor(opts = {}) {
    this.opts = opts;
    this.audio = opts.audio ?? null;
    this.data = null;
    this._kind = null;
    this._filter = '';
    this._bookSig = null;
    this._workShape = null;
    this._furnaceOf = null;
    this._mx = -999;
    this._my = -999;
    this._tipOn = false;
    this._respawn = null;

    this._buildPanel();
    this._buildFloaters();
    this._buildDeath();

    this._onMove = (e) => {
      this._mx = e.clientX;
      this._my = e.clientY;
      this._placeFloaters();
    };
    // The only key handler this file owns. The game owns everything else, so it
    // is scoped to "close while open" and nothing more.
    this._onKey = (e) => {
      if (!this._kind) return;
      const typing = e.target === this.filterInput;
      if (e.code === 'Escape' || (e.code === 'KeyE' && !typing)) {
        e.preventDefault();
        // Closing inventory consumes this key. Otherwise the shell receives
        // the same Escape after closure and immediately opens the pause menu.
        e.stopImmediatePropagation();
        this.opts.onClose?.();
      }
    };
    document.addEventListener('keydown', this._onKey);
  }

  // --------------------------------------------------------------- lifecycle
  open(kind, data) {
    this.data = data ?? null;
    this._kind = kind;
    this._filter = '';
    this._bookSig = null;
    if (this.filterInput) this.filterInput.value = '';
    this.root.classList.remove('hidden');
    document.addEventListener('mousemove', this._onMove);
    this.render();
    this.audio?.ui?.(true);
  }

  close() {
    this._kind = null;
    this.data = null;
    this.root.classList.add('hidden');
    this.cursorEl.classList.add('hidden');
    this._cursorItem = -1;
    this._hideTip();
    document.removeEventListener('mousemove', this._onMove);
  }

  isOpen() { return this._kind !== null; }

  kind() { return this._kind; }

  destroy() {
    this.close();
    this.hideDeath();
    document.removeEventListener('keydown', this._onKey);
    document.removeEventListener('mousemove', this._onMove);
    for (const [node, created] of [
      [this.root, this._ownRoot], [this.cursorEl, this._ownCursor],
      [this.tipEl, this._ownTip], [this.deathRoot, this._ownDeath],
    ]) {
      if (created) node.remove();
      else node.innerHTML = '';
    }
  }

  // ------------------------------------------------------------------ render
  render() {
    if (!this._kind || !this.data) return;
    this._renderStats();
    this._renderArmour();
    this._renderWork();
    this._renderStorage();
    this._renderBook();
    this._renderCursor();
  }

  // -------------------------------------------------------------------- dom
  _buildPanel() {
    const m = mount('screen-inventory', 'section', 'screen dim hidden');
    this.root = m.node;
    this._ownRoot = m.created;
    this.root.innerHTML = '';
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());

    const shell = div('inv-shell', this.root);
    const panel = div('inv-panel', shell);

    const head = div('inv-head', panel);
    this.headTitle = document.createElement('h2');
    head.appendChild(this.headTitle);
    this.headHint = span('inv-hint', head,
      'Esc or E to close · shift-click moves a stack · right-click splits one');

    this.statsEl = div('inv-stats', panel);

    const gear = div('inv-section inv-gear', panel);
    span('inv-label', gear, 'Suit');
    this.armourView = { el: div('inv-grid inv-armour', gear), slots: [] };

    this.workEl = div('inv-work', panel);

    const cargo = div('inv-section', panel);
    span('inv-label', cargo, 'Cargo');
    this.mainView = { el: div('inv-grid', cargo), slots: [] };

    const belt = div('inv-section', panel);
    span('inv-label', belt, 'Hotbar');
    this.hotView = { el: div('inv-grid inv-belt', belt), slots: [] };

    this.bookEl = document.createElement('aside');
    this.bookEl.className = 'inv-book';
    shell.appendChild(this.bookEl);
    const bookHead = div('inv-book-head', this.bookEl);
    span('inv-label', bookHead, 'Recipes');
    this.filterInput = document.createElement('input');
    this.filterInput.type = 'text';
    this.filterInput.className = 'inv-filter';
    this.filterInput.placeholder = 'filter…';
    bookHead.appendChild(this.filterInput);
    // Only the list is rebuilt on input, so the field keeps focus mid-word.
    this.filterInput.addEventListener('input', () => {
      this._filter = String(this.filterInput.value ?? '').trim().toLowerCase();
      this._bookSig = null;
      this._renderBook();
    });
    this.bookList = div('inv-book-list', this.bookEl);
  }

  _buildFloaters() {
    const c = mount('inv-cursor', 'div', 'inv-cursor hidden');
    this.cursorEl = c.node;
    this._ownCursor = c.created;
    this.cursorEl.innerHTML = '';
    this.cursorIco = div('inv-ico', this.cursorEl);
    this.cursorCount = span('inv-count', this.cursorEl);
    this._cursorItem = -1;

    const t = mount('inv-tip', 'div', 'inv-tip hidden');
    this.tipEl = t.node;
    this._ownTip = t.created;
    this.tipEl.innerHTML = '';
    this.tipName = div('inv-tip-name', this.tipEl);
    this.tipSub = div('inv-tip-sub', this.tipEl);
  }

  _buildDeath() {
    const d = mount('screen-death', 'section', 'screen dim hidden');
    this.deathRoot = d.node;
    this._ownDeath = d.created;
    this.deathRoot.innerHTML = '';
    const box = div('death-box', this.deathRoot);
    div('death-mark', box);
    this.deathTitle = document.createElement('h2');
    this.deathTitle.id = 'death-title';
    box.appendChild(this.deathTitle);
    this.deathCause = document.createElement('p');
    this.deathCause.id = 'death-cause';
    this.deathCause.className = 'death-cause';
    box.appendChild(this.deathCause);
    this.deathBtn = document.createElement('button');
    this.deathBtn.id = 'death-respawn';
    this.deathBtn.className = 'btn primary';
    this.deathBtn.textContent = 'Respawn';
    box.appendChild(this.deathBtn);
    this.deathBtn.addEventListener('click', () => {
      const fn = this._respawn;
      this.hideDeath();
      fn?.();
    });
  }

  // ------------------------------------------------------------------ slots
  _makeSlot() {
    const el = div('inv-slot');
    const view = {
      el,
      ico: div('inv-ico', el),
      count: span('inv-count', el),
      dur: div('inv-dur', el),
      item: -1,
      stack: null,
      route: null,
    };
    view.durFill = document.createElement('i');
    view.dur.appendChild(view.durFill);
    el.addEventListener('mousedown', (e) => this._click(e, view));
    el.addEventListener('mouseenter', () => this._showTip(view));
    el.addEventListener('mouseleave', () => this._hideTip());
    return view;
  }

  _syncGrid(view, n) {
    while (view.slots.length < n) {
      const s = this._makeSlot();
      view.slots.push(s);
      view.el.appendChild(s.el);
    }
    while (view.slots.length > n) view.slots.pop().el.remove();
  }

  _paintSlot(view, container, index, opts = {}) {
    const stack = stackAt(container, index);
    view.route = container ? {
      container,
      index,
      // otherFor picks the shift-click destination from what is actually in
      // the slot - it is how a cargo/hotbar shift-click on a helmet routes to
      // the armour container while every other item still goes to the plain
      // inventory. opts.other is the fixed-destination fallback everything
      // else (crafting grids, the suit panel itself) still uses.
      other: opts.otherFor ? opts.otherFor(stack) : (opts.other ?? null),
      takeOnly: !!opts.takeOnly,
      // A furnace output is take-only too, but only the craft result makes the
      // game consume a grid, so the two flags are kept apart.
      craftResult: !!opts.craftResult,
    } : null;
    view.stack = stack;

    const id = stack?.item ?? 0;
    if (view.item !== id) {
      view.item = id;
      view.ico.innerHTML = '';
      if (id) view.ico.appendChild(itemSprite(id, opts.size ?? SLOT_SPRITE));
    }
    view.count.textContent = stack && stack.count > 1 ? String(stack.count) : '';

    const tool = id ? ITEMS[id]?.tool : null;
    const max = tool?.durability ?? 0;
    if (tool && max > 0 && stack?.dur != null && stack.dur < max) {
      const frac = clamp01(stack.dur / max);
      view.dur.classList.remove('hidden');
      view.durFill.style.width = pct(frac);
      view.durFill.style.background = `hsl(${Math.round(120 * frac)}, 72%, 46%)`;
    } else {
      view.dur.classList.add('hidden');
    }
    view.el.classList.toggle('inv-slot-empty', !id);
    view.el.classList.toggle('inv-slot-take', !!opts.takeOnly);
    view.el.classList.toggle('inv-slot-sel', !!opts.selected);
  }

  _click(e, view) {
    e.preventDefault();
    const r = view.route;
    if (!r || !this.data?.cursor) return;
    const cursor = this.data.cursor;
    const res = clickSlot(r.container, r.index, cursor.stack, {
      shift: !!e.shiftKey,
      button: e.button ?? 0,
      otherContainer: r.other,
      takeOnly: r.takeOnly,
    });
    // clickSlot mutates the container but returns the cursor by value: the shared
    // cursor object is ours to write, and this is the only line that writes it.
    cursor.stack = res.cursor ?? null;
    // A refused click (full hand over a result, a locked slot) must not reach
    // onCraftTake - that would eat the grid and hand the player nothing.
    if (!res.changed) return;

    // Taking the craft result is the game's business: it has to consume the grid
    // and recompute before anything is repainted.
    if (r.craftResult) this.opts.onCraftTake?.();
    else this.opts.onChange?.();
    this.render();
    this._showTip(view);
    this.audio?.ui?.(true);
  }

  // ------------------------------------------------------------------ stats
  _renderStats() {
    const s = this.data.survival ?? {};
    const health = num(s.health, 20);
    const hunger = num(s.hunger, 20);
    const oxygen = num(s.oxygen, 100);

    if (!this._statsBuilt) {
      this._statsBuilt = true;
      this.statsEl.innerHTML = '';
      this.hearts = [];
      this.food = [];
      const hpRow = div('inv-bar-row', this.statsEl);
      for (let i = 0; i < 10; i++) this.hearts.push(pip('inv-heart', hpRow));
      const foodRow = div('inv-bar-row', this.statsEl);
      for (let i = 0; i < 10; i++) this.food.push(pip('inv-food', foodRow));
      const o2Row = div('inv-bar-row inv-o2-row', this.statsEl);
      span('inv-o2-tag', o2Row, 'O₂');
      this.o2Track = div('inv-o2', o2Row);
      this.o2Fill = document.createElement('i');
      this.o2Track.appendChild(this.o2Fill);
      this.o2Text = span('inv-o2-text', o2Row);
      this.atmoText = span('inv-atmo', this.statsEl);
    }

    // Each pip covers two points, so odd values land as halves.
    for (let i = 0; i < 10; i++) {
      const hp = clamp01((health - i * 2) / 2);
      this.hearts[i].style.setProperty('--fill', (hp * 100).toFixed(0) + '%');
      this.hearts[i].classList.toggle('inv-pip-off', hp === 0);
      const fd = clamp01((hunger - i * 2) / 2);
      this.food[i].style.setProperty('--fill', (fd * 100).toFixed(0) + '%');
      this.food[i].classList.toggle('inv-pip-off', fd === 0);
    }

    // The worst suitDrain in planets.js is 0.6/s, so a full tank is ~166 s.
    // Amber at 45% is about 75 seconds of air; red at 20% is about 33.
    const o2 = clamp01(oxygen / 100);
    this.o2Fill.style.width = pct(o2);
    this.o2Track.classList.toggle('low', o2 < 0.45);
    this.o2Track.classList.toggle('critical', o2 < 0.2);
    this.o2Text.textContent = Math.round(oxygen) + '%';

    const atmo = this.data.planet?.atmosphere ?? s.planet?.atmosphere ?? null;
    this.atmoText.textContent = atmo
      ? (atmo.breathable ? `Breathable · ${atmo.label}` : `Suit sealed · ${atmo.label}`)
      : '';
  }

  // ------------------------------------------------------------------ suit
  /**
   * Four fixed slots, one per ARMOUR_SLOTS entry. Each also carries an
   * inv-slot-<slot> class so the stylesheet can paint a faint silhouette
   * (helmet/chest/legs/boots) behind an empty slot the way the hearts already
   * draw their shape with clip-path - no image asset either way.
   */
  _renderArmour() {
    this._syncGrid(this.armourView, ARMOUR_SLOTS.length);
    for (let i = 0; i < ARMOUR_SLOTS.length; i++) {
      const view = this.armourView.slots[i];
      view.el.classList.add('inv-slot-' + ARMOUR_SLOTS[i]);
      this._paintSlot(view, this.data.armour ?? null, i, { other: this.data.inventory });
    }
  }

  // ------------------------------------------------------- craft / furnace
  _renderWork() {
    const isFurnace = this._kind === 'furnace';
    const dim = sizeOf(this.data.craftGrid) === 9 ? 3 : 2;
    const shape = isFurnace ? 'furnace' : 'craft' + dim;

    this.headTitle.textContent = isFurnace ? 'Smelter'
      : this._kind === 'fabricator' ? 'Fabricator' : 'Suit Inventory';
    this.bookEl.classList.toggle('hidden', isFurnace);

    if (this._workShape !== shape) {
      this._workShape = shape;
      this.workEl.innerHTML = '';
      this._workViews = null;
      if (isFurnace) this._buildFurnace();
      else this._buildCraft(dim);
    }
    if (isFurnace) this._paintFurnace(this.data.furnace ?? null);
    else this._paintCraft(dim);
  }

  _buildCraft(dim) {
    const wrap = div('inv-craft', this.workEl);
    const gridEl = div('inv-grid inv-craft-grid', wrap);
    gridEl.style.setProperty('--cols', String(dim));
    const grid = { el: gridEl, slots: [] };
    this._syncGrid(grid, dim * dim);
    this._arrow(wrap, false);
    const result = this._makeSlot();
    result.el.classList.add('inv-result');
    wrap.appendChild(result.el);
    this._workViews = { grid, result };
  }

  _paintCraft(dim) {
    const { grid, result } = this._workViews;
    const inventory = this.data.inventory;
    const n = dim * dim;
    this._syncGrid(grid, n);
    for (let i = 0; i < n; i++) {
      this._paintSlot(grid.slots[i], this.data.craftGrid, i, { other: inventory });
    }
    this._paintSlot(result, this.data.craftResult, 0, {
      other: inventory, takeOnly: true, craftResult: true,
    });
  }

  _buildFurnace() {
    const wrap = div('inv-furnace', this.workEl);
    const left = div('inv-furnace-col', wrap);
    const input = this._makeSlot();
    left.appendChild(input.el);
    const flameWrap = div('inv-flame', left);
    const flameFill = document.createElement('i');
    flameWrap.appendChild(flameFill);
    const fuel = this._makeSlot();
    left.appendChild(fuel.el);
    const arrow = this._arrow(wrap, true);
    const output = this._makeSlot();
    output.el.classList.add('inv-result');
    wrap.appendChild(output.el);
    this._workViews = {
      input, fuel, output, flameFill,
      arrowFill: arrow.fill,
      note: span('inv-furnace-note', this.workEl),
    };
  }

  /** One set of slot views per furnace record, rebuilt only when it changes. */
  _furnaceSlots(f) {
    if (!f) return null;
    if (this._furnaceOf !== f) {
      this._furnaceOf = f;
      this._furnaceViews = {
        input: furnaceSlot(f, 'input'),
        fuel: furnaceSlot(f, 'fuel'),
        output: furnaceSlot(f, 'output'),
      };
    }
    return this._furnaceViews;
  }

  _paintFurnace(f) {
    const v = this._workViews;
    const inventory = this.data.inventory;
    const slots = this._furnaceSlots(f);

    this._paintSlot(v.input, slots?.input ?? null, 0, { other: inventory });
    this._paintSlot(v.fuel, slots?.fuel ?? null, 0, { other: inventory });
    this._paintSlot(v.output, slots?.output ?? null, 0, { other: inventory, takeOnly: true });

    // Both gauges come off the same fields stations.js ticks: seconds of flame
    // left over the size of the log that lit it, and seconds of heat applied
    // over what this particular item needs.
    const burnMax = num(f?.burnMax);
    const burn = burnMax > 0 ? clamp01(num(f?.burn) / burnMax) : 0;
    const job = f?.input ? smeltingResult(f.input.item) : null;
    const cook = job && job.time > 0 ? clamp01(num(f?.progress) / job.time) : 0;

    v.flameFill.style.height = pct(burn);
    v.arrowFill.style.width = pct(cook);
    v.note.textContent = !f ? '' : f.lit ? 'Burning' : f.fuel ? 'Idle' : 'Cold — add fuel';
  }

  /** Arrow between input and output; the fill layer doubles as smelt progress. */
  _arrow(parent, progress) {
    const wrap = div('inv-arrow' + (progress ? ' inv-arrow-prog' : ''), parent);
    const svg = '<svg viewBox="0 0 40 16" aria-hidden="true"><path d="M0 6h26V1l13 7-13 7v-5H0z"/></svg>';
    const bg = div('inv-arrow-bg', wrap);
    bg.innerHTML = svg;
    const fill = div('inv-arrow-fill', wrap);
    fill.innerHTML = svg;
    fill.style.width = progress ? '0%' : '100%';
    return { wrap, fill };
  }

  // ------------------------------------------------------ cargo and hotbar
  /**
   * PlayerInventory is one flat store: slots 0..8 are the hotbar you fly with,
   * the rest is cargo. Both grids point at the same container, which is what
   * lets a shift-click move a stack between them with no partner window.
   */
  _renderStorage() {
    const inv = this.data.inventory;
    const armour = this.data.armour ?? null;
    const total = sizeOf(inv);
    const hot = Math.min(HOTBAR_SIZE, total);
    // Shift-clicking an armour piece anywhere in the pack sends it to the suit
    // instead of shuffling hotbar<->main; everything else keeps today's route.
    const otherFor = (st) => (armour && armourOf(st?.item) ? armour : inv);
    this._paintRange(this.mainView, inv, hot, Math.max(0, total - hot), -1, otherFor);
    this._paintRange(this.hotView, inv, 0, hot, num(inv?.selected, -1), otherFor);
  }

  _paintRange(view, container, from, count, selected, otherFor) {
    this._syncGrid(view, count);
    for (let i = 0; i < count; i++) {
      this._paintSlot(view.slots[i], container, from + i, {
        otherFor,
        selected: from + i === selected,
      });
    }
  }

  // ------------------------------------------------------------ recipe book
  _renderBook() {
    if (this._kind === 'furnace') return;
    const dim = sizeOf(this.data.craftGrid) === 9 ? 3 : 2;
    const counts = this.data.inventory?.counts?.() ?? new Map();
    const rows = [];
    for (const recipe of recipesForSize(dim)) {
      const name = ITEMS[recipe.out.item]?.name ?? '';
      if (this._filter && !name.toLowerCase().includes(this._filter)) continue;
      rows.push({ recipe, name, ok: canCraft(recipe, counts) });
    }
    rows.sort((a, b) => (b.ok - a.ok) || a.name.localeCompare(b.name));

    // Rebuild only when something the list shows actually moved - render() runs
    // on every click, and a rebuild would drop the row you are hovering.
    const sig = dim + '|' + this._filter + '|' + rows.map((r) => r.recipe.id + (r.ok ? '+' : '-')).join(',');
    if (sig === this._bookSig) return;
    this._bookSig = sig;

    this.bookList.innerHTML = '';
    if (!rows.length) {
      span('inv-book-empty', this.bookList, this._filter ? 'Nothing matches.' : 'No recipes registered.');
      return;
    }
    for (const row of rows) {
      const out = row.recipe.out;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'inv-recipe' + (row.ok ? '' : ' inv-recipe-off');
      const ico = div('inv-ico', btn);
      if (out.item) ico.appendChild(itemSprite(out.item, BOOK_SPRITE));
      span('inv-recipe-name', btn, row.name);
      if (out.count > 1) span('inv-recipe-n', btn, '×' + out.count);
      if (row.ok) {
        btn.addEventListener('click', () => {
          this.opts.onQuickCraft?.(row.recipe);
          this._bookSig = null;
          this.render();
          this.audio?.ui?.(true);
        });
      }
      this.bookList.appendChild(btn);
    }
  }

  // ---------------------------------------------------------------- cursor
  _renderCursor() {
    const stack = this.data?.cursor?.stack ?? null;
    const id = stack?.item ?? 0;
    this.cursorEl.classList.toggle('hidden', !id);
    if (!id) { this._cursorItem = -1; return; }
    if (this._cursorItem !== id) {
      this._cursorItem = id;
      this.cursorIco.innerHTML = '';
      this.cursorIco.appendChild(itemSprite(id, CURSOR_SPRITE));
    }
    this.cursorCount.textContent = stack.count > 1 ? String(stack.count) : '';
    this._placeFloaters();
  }

  _placeFloaters() {
    this.cursorEl.style.transform = `translate(${this._mx}px, ${this._my}px)`;
    if (!this._tipOn) return;
    const w = this.tipEl.offsetWidth || 180;
    const vw = (typeof window !== 'undefined' ? window.innerWidth : 1280);
    const x = Math.min(this._mx + 18, vw - w - 12);
    this.tipEl.style.transform = `translate(${Math.max(8, x)}px, ${this._my + 20}px)`;
  }

  _showTip(view) {
    const stack = view.stack;
    if (!stack?.item) { this._hideTip(); return; }
    const item = ITEMS[stack.item];
    this.tipName.textContent = item?.name ?? '';
    const tool = item?.tool;
    const armour = item?.armour;
    let sub;
    if (tool) {
      sub = `durability ${Math.max(0, Math.round(stack.dur ?? tool.durability))} / ${tool.durability}`;
    } else if (armour) {
      const dur = Math.max(0, Math.round(stack.dur ?? armour.durability));
      sub = `+${armour.defense} armour · durability ${dur} / ${armour.durability}`;
      if (armour.o2Save > 0) sub += ` · O₂ −${Math.round(armour.o2Save * 100)}%`;
    } else {
      sub = item?.food ? `+${item.food.hunger} hunger` : '';
    }
    this.tipSub.textContent = sub;
    this.tipSub.classList.toggle('hidden', !this.tipSub.textContent);
    this._tipOn = true;
    this.tipEl.classList.remove('hidden');
    this._placeFloaters();
  }

  _hideTip() {
    this._tipOn = false;
    this.tipEl.classList.add('hidden');
  }

  // ----------------------------------------------------------------- death
  showDeath(info = {}) {
    const planet = typeof info.planet === 'string'
      ? info.planet
      : (info.planet?.name ?? 'this world');
    this.deathTitle.textContent = `You died on ${planet}`;
    this.deathCause.textContent = CAUSE_TEXT[String(info.cause ?? '').toLowerCase()] ?? 'Your suit gave out.';
    this._respawn = typeof info.onRespawn === 'function' ? info.onRespawn : null;
    this.deathRoot.classList.remove('hidden');
  }

  hideDeath() {
    this.deathRoot.classList.add('hidden');
    this._respawn = null;
  }
}
