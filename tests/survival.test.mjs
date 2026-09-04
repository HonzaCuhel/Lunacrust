// Survival model tests. Run: node tests/survival.test.mjs
//
// Everything here steps the model by hand at a fixed dt, which is the whole
// point of keeping survival.js free of THREE and the DOM.

import assert from 'node:assert/strict';
import { itemIdOf } from '../app/js/items.js';
import {
  Survival, MAX_HEALTH, MAX_HUNGER, MAX_OXYGEN, OXYGEN_LOW, HUNGER_LOW,
} from '../app/js/survival.js';

// --- harness ----------------------------------------------------------------
let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; }
  catch (err) { failures.push({ name, err }); }
}
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b} (+-${eps})`);

// --- fixtures ---------------------------------------------------------------
const EARTH = {
  id: 'earth', gravity: 9.81,
  atmosphere: { breathable: true, label: 'N2/O2 at 101 kPa', suitDrain: 0 },
};
const MOON = {
  id: 'moon', gravity: 1.62,
  atmosphere: { breathable: false, label: 'vacuum', suitDrain: 0.25 },
};

const ctx = (over = {}) => ({
  planet: EARTH, inLiquid: false, submerged: false, liquidKey: null,
  sprinting: false, onGround: true, moved: 0, nearLifeSupport: false,
  creative: false, ...over,
});

/** Run `seconds` of game time in fixed steps, returning every event raised. */
function run(s, seconds, over = {}, dt = 0.1) {
  const events = [];
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) events.push(...s.update(dt, ctx(over)));
  return events;
}
const count = (events, type) => events.filter((e) => e.type === type).length;

/** Drag-free impact speed, which is exactly how player.js integrates gravity. */
const impact = (g, h) => Math.sqrt(2 * g * h);

// --- fall damage ------------------------------------------------------------
test('fall below 13 m/s is free', () => {
  const s = new Survival(EARTH);
  assert.deepEqual(s.onLand(12), []);
  assert.deepEqual(s.onLand(13), []);
  assert.equal(s.health, MAX_HEALTH);
});

test('30 m/s impact costs 9', () => {
  const s = new Survival(EARTH);
  const ev = s.onLand(30);            // round((30-13)*0.55) = 9
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0], { type: 'damage', amount: 9, cause: 'fall', raw: 9, absorbed: 0 });
  assert.equal(s.health, 11);
});

test('sign of the impact speed is ignored (callers pass vel.y)', () => {
  const s = new Survival(EARTH);
  s.onLand(-30);
  assert.equal(s.health, 11);
});

test('the same 130 m drop kills on Earth and is a scratch on the Moon', () => {
  const earthling = new Survival(EARTH);
  const ev = earthling.onLand(impact(EARTH.gravity, 130));   // ~50.5 m/s -> 21
  assert.equal(earthling.alive, false);
  assert.equal(earthling.health, 0);
  assert.equal(count(ev, 'death'), 1);
  assert.equal(ev.at(-1).cause, 'fall');

  const lunar = new Survival(MOON);
  lunar.onLand(impact(MOON.gravity, 130));                   // ~20.5 m/s -> 4
  assert.equal(lunar.alive, true);
  assert.equal(lunar.health, 16);
});

// --- lava & burning ---------------------------------------------------------
test('lava deals 4/s and sets you on fire for 4 s', () => {
  const s = new Survival(EARTH);
  const ev = run(s, 1, { liquidKey: 'lava', inLiquid: true });
  near(s.health, 16, 1e-9);
  near(s.burning, 4);
  assert.ok(ev.some((e) => e.type === 'damage' && e.cause === 'lava'));
});

test('burning keeps costing 1/s out of the lava, and water puts it out', () => {
  const s = new Survival(EARTH);
  run(s, 1, { liquidKey: 'lava', inLiquid: true });
  const ev = run(s, 1, {});                       // dry land, still alight
  near(s.health, 15, 1e-9);
  near(s.burning, 3, 1e-9);
  assert.ok(ev.some((e) => e.type === 'damage' && e.cause === 'burning'));

  const health = s.health;
  const wet = run(s, 1, { liquidKey: 'water', inLiquid: true, submerged: false });
  assert.equal(s.burning, 0);
  assert.equal(count(wet, 'damage'), 0);
  assert.equal(s.health, health);
});

test('methane is cold enough to count as an extinguisher', () => {
  const s = new Survival(EARTH);
  s.burning = 4;
  run(s, 0.5, { liquidKey: 'methane', inLiquid: true });
  assert.equal(s.burning, 0);
});

// --- oxygen -----------------------------------------------------------------
test('a breathable sky keeps the tank full until your head goes under', () => {
  const s = new Survival(EARTH);
  run(s, 5, { sprinting: true, moved: 30 });
  assert.equal(s.oxygen, MAX_OXYGEN);
});

test('drowning on Earth: 7/s, one warning, then asphyxiation', () => {
  const s = new Survival(EARTH);
  const under = { submerged: true, inLiquid: true, liquidKey: 'water' };
  const first = run(s, 10, under);
  near(s.oxygen, 30, 1e-9);
  assert.equal(count(first, 'oxygen-low'), 0);

  const rest = run(s, 5, under);                  // crosses 25, then bottoms out
  assert.equal(count(rest, 'oxygen-low'), 1);
  assert.equal(s.oxygen, 0);
  assert.ok(rest.some((e) => e.type === 'damage' && e.cause === 'asphyxiation'));
  assert.ok(s.health < MAX_HEALTH && s.alive);

  run(s, 0.1, {});                                // surface
  assert.equal(s.oxygen, MAX_OXYGEN);
});

test('the low-oxygen warning fires once per crossing, not per frame', () => {
  const s = new Survival(MOON);
  s.oxygen = OXYGEN_LOW + 0.5;
  const down = run(s, 20, { planet: MOON }, 0.1);   // 0.25/s -> under 25 and stays
  assert.equal(count(down, 'oxygen-low'), 1);
  s.refillOxygen(MAX_OXYGEN);
  const again = run(s, 320, { planet: MOON }, 1);   // drain back under the line
  assert.equal(count(again, 'oxygen-low'), 1);
});

test('suit drain off Earth, doubled while sprinting', () => {
  const s = new Survival(MOON);
  s.update(1, ctx({ planet: MOON }));
  near(s.oxygen, 99.75, 1e-9);
  s.update(1, ctx({ planet: MOON, sprinting: true }));
  near(s.oxygen, 99.25, 1e-9);
});

test('an empty tank costs 1.6 health per second', () => {
  const s = new Survival(MOON);
  s.oxygen = 0;
  const ev = s.update(1, ctx({ planet: MOON }));
  near(s.health, 18.4, 1e-9);
  assert.ok(ev.some((e) => e.type === 'damage' && e.cause === 'asphyxiation'));
});

test('life support out-refills a sprinting suit drain', () => {
  const s = new Survival(MOON);
  s.oxygen = 20;
  s.update(1, ctx({ planet: MOON, sprinting: true, nearLifeSupport: true }));
  near(s.oxygen, 34, 1e-9);
  s.update(10, ctx({ planet: MOON, nearLifeSupport: true }));
  assert.equal(s.oxygen, MAX_OXYGEN);            // and it clamps
});

test('a canister refills, but not when the tank is already full', () => {
  const s = new Survival(MOON);
  s.oxygen = 10;
  const first = s.applyUse(itemIdOf('oxygen_canister'));
  assert.equal(first.ok, true);
  near(s.oxygen, 75);
  const second = s.applyUse(itemIdOf('oxygen_canister'));
  assert.equal(second.ok, true);
  assert.equal(s.oxygen, MAX_OXYGEN);
  assert.equal(s.applyUse(itemIdOf('oxygen_canister')).ok, false);
});

test('a medkit heals and refuses at full health', () => {
  const s = new Survival(EARTH);
  s.health = 5;
  const r = s.applyUse(itemIdOf('medkit'));
  assert.equal(r.ok, true);
  assert.equal(s.health, 13);
  assert.equal(count(r.events, 'heal'), 1);
  s.health = MAX_HEALTH;
  assert.equal(s.applyUse(itemIdOf('medkit')).ok, false);
  assert.equal(s.applyUse(itemIdOf('cobble')).ok, false);   // not a usable
});

// --- hunger -----------------------------------------------------------------
test('sprinting 100 m costs one hunger once saturation is gone', () => {
  const s = new Survival(EARTH);
  s.saturation = 0;
  run(s, 2, { sprinting: true, moved: 5 }, 0.1);   // 20 steps x 5 m = 100 m
  near(s.exertion, 1.5, 1e-9);                     // 100 * 0.055 = 5.5 -> 4 spent
  assert.equal(s.hunger, MAX_HUNGER - 1);
});

test('walking the same 100 m is nearly free', () => {
  const s = new Survival(EARTH);
  s.saturation = 0;
  run(s, 2, { moved: 5 }, 0.1);
  near(s.exertion, 1.2, 1e-9);
  assert.equal(s.hunger, MAX_HUNGER);
});

test('saturation is spent before hunger', () => {
  const s = new Survival(EARTH);
  s.saturation = 2;
  s.exert(12);                                     // three points worth
  s.update(0.016, ctx());
  assert.equal(s.saturation, 0);
  assert.equal(s.hunger, MAX_HUNGER - 1);
});

test('hunger-low warns once per crossing', () => {
  const s = new Survival(EARTH);
  s.saturation = 0;
  s.hunger = HUNGER_LOW + 1;
  s.exert(4);
  const ev = s.update(0.016, ctx());
  assert.equal(s.hunger, HUNGER_LOW);
  assert.equal(count(ev, 'hunger-low'), 1);
  assert.equal(count(s.update(0.016, ctx()), 'hunger-low'), 0);
});

test('starving costs 0.5/s and announces itself once', () => {
  const s = new Survival(EARTH);
  s.hunger = 0; s.saturation = 0;
  const first = s.update(1, ctx());
  near(s.health, 19.5, 1e-9);
  assert.equal(count(first, 'starving'), 1);
  assert.ok(first.some((e) => e.type === 'damage' && e.cause === 'starvation'));
  const second = s.update(1, ctx());
  near(s.health, 19, 1e-9);
  assert.equal(count(second, 'starving'), 0);
});

// --- regeneration -----------------------------------------------------------
test('a full stomach heals 1 every 3.5 s and pays for it', () => {
  const s = new Survival(EARTH);
  s.health = 10; s.hunger = 20; s.saturation = 0;
  const ev = run(s, 4, {}, 0.05);
  assert.equal(count(ev, 'heal'), 1);
  assert.equal(s.health, 11);
  near(s.exertion, 0.8, 1e-9);
});

test('nothing regenerates below 18 hunger', () => {
  const s = new Survival(EARTH);
  s.health = 10; s.hunger = 17; s.saturation = 0;
  const ev = run(s, 10, {}, 0.05);
  assert.equal(count(ev, 'heal'), 0);
  assert.equal(s.health, 10);
});

// --- eating -----------------------------------------------------------------
test('eating clamps hunger and adds saturation and health', () => {
  const s = new Survival(EARTH);
  s.hunger = 15; s.saturation = 0; s.health = 10;
  const r = s.eat(itemIdOf('ration'));             // {hunger: 9, heal: 2}
  assert.equal(r.ok, true);
  assert.equal(s.hunger, MAX_HUNGER);              // 15 + 9 clamped
  near(s.saturation, 3.6, 1e-9);
  assert.equal(s.health, 12);
  assert.deepEqual(r.events, [{ type: 'heal', amount: 2 }]);
});

test('a full stomach refuses food that only feeds', () => {
  const s = new Survival(EARTH);
  const r = s.eat(itemIdOf('algae'));              // heals nothing
  assert.equal(r.ok, false);
  assert.equal(s.hunger, MAX_HUNGER);
  assert.equal(s.saturation, 5);                   // untouched
  assert.equal(s.eat(itemIdOf('cobble')).ok, false);
});

test('a full stomach still accepts food that heals', () => {
  const s = new Survival(EARTH);
  s.health = 10;
  assert.equal(s.eat(itemIdOf('ration')).ok, true);
  assert.equal(s.health, 12);
});

// --- death ------------------------------------------------------------------
test('death freezes the sim until reset()', () => {
  const s = new Survival(EARTH);
  const ev = s.damage(100, 'lava');
  assert.equal(s.alive, false);
  assert.equal(s.health, 0);
  assert.deepEqual(ev.at(-1), { type: 'death', cause: 'lava' });

  const after = run(s, 5, { liquidKey: 'lava', submerged: true, moved: 40, sprinting: true });
  assert.deepEqual(after, []);
  assert.equal(s.health, 0);
  assert.equal(s.hunger, MAX_HUNGER);
  assert.deepEqual(s.damage(5, 'fall'), []);
  assert.deepEqual(s.onLand(60), []);

  s.reset();
  assert.equal(s.alive, true);
  assert.equal(s.health, MAX_HEALTH);
  assert.equal(s.hunger, 12);
  assert.equal(s.oxygen, MAX_OXYGEN);
  assert.equal(s.burning, 0);
  assert.ok(run(s, 1, { liquidKey: 'lava' }).length > 0);   // and it ticks again
});

test('the killing blow names the cause', () => {
  const s = new Survival(MOON);
  s.health = 1; s.oxygen = 0;
  const ev = s.update(1, ctx({ planet: MOON }));
  assert.equal(s.alive, false);
  assert.deepEqual(ev.at(-1), { type: 'death', cause: 'asphyxiation' });
});

// --- persistence ------------------------------------------------------------
test('serialize/restore round-trips through JSON', () => {
  const s = new Survival(MOON);
  s.health = 13.25; s.hunger = 7; s.saturation = 2.5;
  s.oxygen = 41.5; s.burning = 1.75; s.exertion = 3.5; s.regen = 1.25;
  const wire = JSON.parse(JSON.stringify(s.serialize()));
  const back = new Survival(MOON, wire);
  assert.deepEqual(back.serialize(), s.serialize());

  const restored = new Survival(MOON).restore(s.serialize());
  assert.deepEqual(restored.serialize(), s.serialize());
});

test('a corrupt or ancient save loads instead of exploding', () => {
  const s = new Survival(EARTH, { health: 'nine', oxygen: 999, hunger: -4 });
  assert.equal(s.health, MAX_HEALTH);
  assert.equal(s.oxygen, MAX_OXYGEN);
  assert.equal(s.hunger, 0);
  assert.equal(s.alive, true);
  assert.deepEqual(new Survival(EARTH, null).serialize(), new Survival(EARTH).serialize());
});

test('a dead save stays dead', () => {
  const s = new Survival(EARTH);
  s.damage(100, 'fall');
  const back = new Survival(EARTH, s.serialize());
  assert.equal(back.alive, false);
  assert.deepEqual(back.update(1, ctx({ liquidKey: 'lava' })), []);
});

// --- creative ---------------------------------------------------------------
test('creative never damages and pins the bars full', () => {
  const s = new Survival(MOON);
  s.health = 3; s.hunger = 0; s.saturation = 0; s.oxygen = 0; s.burning = 4;
  const ev = run(s, 5, {
    planet: MOON, creative: true, liquidKey: 'lava', submerged: true,
    sprinting: true, moved: 40,
  });
  assert.deepEqual(ev, []);
  assert.equal(s.health, MAX_HEALTH);
  assert.equal(s.hunger, MAX_HUNGER);
  assert.equal(s.oxygen, MAX_OXYGEN);
  assert.equal(s.burning, 0);

  // Fall damage and direct damage arrive between updates; the remembered mode
  // is what keeps them harmless too.
  assert.deepEqual(s.onLand(80), []);
  assert.deepEqual(s.damage(50, 'fall'), []);
  assert.equal(s.health, MAX_HEALTH);
});

test('creative revives a body that died in survival', () => {
  const s = new Survival(EARTH);
  s.damage(100, 'fall');
  s.update(0.1, ctx({ creative: true }));
  assert.equal(s.alive, true);
  assert.equal(s.health, MAX_HEALTH);
});

// --- frame-rate independence ------------------------------------------------
// The model is stepped by whatever frame time the renderer had, so anything that
// costs "n per second" has to cost the same over a second at 24 fps and at 144.
test('a 4 s burn costs exactly 4 damage at any frame rate', () => {
  const burnTotal = (fps) => {
    const dt = 1 / fps;
    const s = new Survival(EARTH);
    s.hunger = 10; s.saturation = 0;   // clear of both regen (>=18) and starvation (0)
    s.burning = 4;
    let total = 0;
    for (let i = 0; i < Math.ceil(6 / dt); i++) {
      for (const e of s.update(dt, ctx())) {
        if (e.type === 'damage' && e.cause === 'burning') total += e.amount;
      }
    }
    return total;
  };
  // Billing a whole dt for the last partial tick used to make this 4.042 at 24 fps.
  for (const fps of [24, 30, 60, 90, 144, 240]) near(burnTotal(fps), 4, 1e-9);
});

test('lava, drowning and starvation all cost the same per second at any dt', () => {
  const after = (dt) => {
    const s = new Survival(EARTH);
    s.hunger = 0; s.saturation = 0;
    run(s, 2, { liquidKey: 'lava', submerged: true }, dt);
    return { hp: s.health, ox: s.oxygen };
  };
  const slow = after(1 / 24), fast = after(1 / 144);
  near(slow.hp, fast.hp, 1e-9);
  near(slow.ox, fast.ox, 1e-9);
});

// --- hostile inputs ---------------------------------------------------------
test('a blown-up physics frame cannot kill you or emit a null amount', () => {
  const s = new Survival(EARTH);
  assert.deepEqual(s.onLand(Infinity), []);      // used to deal Infinity -> JSON null
  assert.deepEqual(s.onLand(NaN), []);
  assert.deepEqual(s.damage(Infinity, 'void'), []);
  assert.deepEqual(s.damage(NaN, 'void'), []);
  assert.equal(s.health, MAX_HEALTH);
  assert.equal(s.alive, true);
});

test('every emitted amount survives a JSON round trip', () => {
  const s = new Survival(MOON);
  s.health = 6; s.hunger = 20; s.oxygen = 0.2; s.saturation = 0;
  const ev = run(s, 6, { planet: MOON, liquidKey: 'lava', moved: 3, sprinting: true }, 1 / 60);
  assert.ok(ev.length > 0);
  for (const e of ev) {
    if (!('amount' in e)) continue;
    assert.ok(Number.isFinite(e.amount), `${e.type}/${e.cause} amount ${e.amount}`);
    assert.equal(JSON.parse(JSON.stringify(e)).amount, e.amount);
  }
});

test('update survives a caller that forgets the ctx', () => {
  const s = new Survival(EARTH);
  assert.deepEqual(s.update(0.1), []);
  assert.deepEqual(s.update(0.1, null), []);
  assert.equal(s.health, MAX_HEALTH);
});

// --- warning hysteresis -----------------------------------------------------
test('walking the edge of a life support radius does not re-beep every second', () => {
  // One frame inside the radius (+14/s) against 56 frames outside (-0.25/s) is
  // a net zero that saws the tank straight across the 25 line, which is exactly
  // what standing at the edge of stations.nearLifeSupport(pos, 9) feels like.
  const s = new Survival(MOON);
  s.oxygen = 24.9;
  const ev = [];
  for (let c = 0; c < 30; c++) {
    ev.push(...s.update(1 / 60, ctx({ planet: MOON, nearLifeSupport: true })));
    for (let i = 0; i < 56; i++) ev.push(...s.update(1 / 60, ctx({ planet: MOON })));
  }
  assert.equal(count(ev, 'oxygen-low'), 1);       // was 30, one per crossing
});

test('the alarm re-arms only after a real recovery, not a sip of oxygen', () => {
  const s = new Survival(MOON);
  s.oxygen = OXYGEN_LOW + 0.2;
  assert.equal(count(run(s, 10, { planet: MOON }, 0.1), 'oxygen-low'), 1);
  s.refillOxygen(3);                              // back over the line, still low
  assert.equal(count(run(s, 20, { planet: MOON }, 0.1), 'oxygen-low'), 0);
  s.refillOxygen(MAX_OXYGEN);                     // a full tank does re-arm it
  assert.equal(count(run(s, 400, { planet: MOON }, 1), 'oxygen-low'), 1);
});

// --- save integrity ---------------------------------------------------------
test('a save claiming to be alive at 0 health loads dead', () => {
  // Otherwise the death screen never opens and the player is stuck on an empty
  // bar that nothing can take further.
  const s = new Survival(EARTH, { health: 0, hunger: 10, oxygen: 50, alive: true });
  assert.equal(s.alive, false);
  assert.deepEqual(s.update(1, ctx({ liquidKey: 'lava' })), []);
  s.reset();
  assert.equal(s.alive, true);
});

test('serialize is a plain JSON object with no live references', () => {
  const s = new Survival(MOON);
  const wire = s.serialize();
  assert.equal(Object.getPrototypeOf(wire), Object.prototype);
  assert.ok(!('planet' in wire));                 // never drag the planet into the save
  for (const [k, v] of Object.entries(wire)) {
    assert.ok(typeof v === 'number' || typeof v === 'boolean', `${k} is ${typeof v}`);
    if (typeof v === 'number') assert.ok(Number.isFinite(v), `${k} is ${v}`);
  }
});

// --- armour -------------------------------------------------------------
// "Armour protects you from suffocation" is exactly the kind of claim that
// passes a casual review and ruins the survival model, so the three exempt
// causes get their own explicit test rather than living only inside _mitigate.
test('a full tier-3 suit (18 points) reduces generic damage to 28%', () => {
  const s = new Survival(EARTH);
  s.setArmour({ points: 18 });
  const ev = s.damage(10, 'generic');
  near(ev[0].amount, 2.8, 1e-9);
  near(ev[0].raw, 10, 1e-9);
  near(ev[0].absorbed, 7.2, 1e-9);
  near(s.health, MAX_HEALTH - 2.8, 1e-9);
});

test('the reduction curve applies to lava too, not just generic hits', () => {
  const s = new Survival(EARTH);
  s.setArmour({ points: 18 });          // damageReduction(18) = 0.72
  const ev = run(s, 1, { liquidKey: 'lava', inLiquid: true });
  const dmg = ev.filter((e) => e.type === 'damage' && e.cause === 'lava');
  assert.ok(dmg.length > 0);
  for (const e of dmg) near(e.amount, e.raw * 0.28, 1e-9);
});

test('fallReduce applies before the armour points curve, not after', () => {
  const s = new Survival(EARTH);
  s.setArmour({ points: 18, fallReduce: 0.4 });   // void-crystal boots
  const ev = s.onLand(30);                        // raw fall damage: 9
  // 9 * (1 - 0.4) * (1 - 0.72) = 9 * 0.6 * 0.28 = 1.512
  near(ev[0].amount, 1.512, 1e-9);
  near(ev[0].raw, 9, 1e-9);
});

test('asphyxiation, starvation and void ignore armour entirely', () => {
  const full = { points: 20, o2Save: 0.75, fallReduce: 0.6 };

  const suffocating = new Survival(MOON);
  suffocating.setArmour(full);
  suffocating.oxygen = 0;
  const ox = suffocating.update(1, ctx({ planet: MOON }));
  near(suffocating.health, MAX_HEALTH - 1.6, 1e-9);   // ASPHYXIA_DPS, see survival.js
  assert.ok(ox.some((e) => e.type === 'damage' && e.cause === 'asphyxiation' && e.absorbed === 0));

  const starving = new Survival(EARTH);
  starving.setArmour(full);
  starving.hunger = 0; starving.saturation = 0;
  const hu = starving.update(1, ctx());
  near(starving.health, MAX_HEALTH - 0.5, 1e-9);
  assert.ok(hu.some((e) => e.type === 'damage' && e.cause === 'starvation' && e.absorbed === 0));

  const voided = new Survival(EARTH);
  voided.setArmour(full);
  const v = voided.damage(999, 'void');
  assert.equal(v[0].amount, 999);
  assert.equal(v[0].absorbed, 0);
  assert.equal(voided.alive, false);
});

test('setArmour clamps out-of-range and non-finite input', () => {
  const s = new Survival(EARTH);
  s.setArmour({ points: 999, o2Save: 5, fallReduce: -3 });
  assert.equal(s.armourPoints, 20);
  assert.equal(s.armourO2, 0.75);
  assert.equal(s.armourFall, 0);
  s.setArmour({ points: NaN, o2Save: undefined, fallReduce: 'x' });
  assert.equal(s.armourPoints, 0);
  assert.equal(s.armourO2, 0);
  assert.equal(s.armourFall, 0);
  s.setArmour();
  assert.equal(s.armourPoints, 0);
});

test('a helmet halves the vacuum suit drain over a stepped second', () => {
  const s = new Survival(MOON);           // suitDrain 0.25/s
  s.setArmour({ o2Save: 0.5 });
  s.update(1, ctx({ planet: MOON }));
  near(s.oxygen, 100 - 0.25 * 0.5, 1e-9);
});

test('a sealed visor halves the drowning rate, scaled by o2Save', () => {
  const s = new Survival(EARTH);
  s.setArmour({ o2Save: 0.5 });           // half of half = 25% off DROWN_RATE
  const under = { submerged: true, inLiquid: true, liquidKey: 'water' };
  s.update(1, ctx(under));
  near(s.oxygen, 100 - 7 * (1 - 0.5 * 0.5), 1e-9);
});

test('serialize/restore never carries an armour bonus across a save', () => {
  // The multipliers are derived state, recomputed every frame from the
  // container - a save must never resurrect a stale bonus on its own.
  const s = new Survival(EARTH);
  s.setArmour({ points: 18, o2Save: 0.6, fallReduce: 0.3 });
  const wire = s.serialize();
  assert.ok(!('armourPoints' in wire) && !('armourO2' in wire) && !('armourFall' in wire));
  const restored = new Survival(EARTH, wire);
  assert.equal(restored.armourPoints, 0);
  assert.equal(restored.armourO2, 0);
  assert.equal(restored.armourFall, 0);
});

// --- summary ----------------------------------------------------------------
for (const f of failures) {
  console.error(`FAIL  ${f.name}\n      ${f.err.message.split('\n')[0]}`);
}
const total = passed + failures.length;
console.log(`\nsurvival: ${passed}/${total} passed${failures.length ? `, ${failures.length} FAILED` : ''}`);
process.exit(failures.length ? 1 : 0);
