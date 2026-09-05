// Survival model: health, hunger, oxygen, and the several ways a planet kills you.
//
// Pure logic on purpose - no THREE, no DOM, no clock of its own. The HUD reads
// the public fields, the game turns the returned events into sounds and screen
// flashes, and a test can step the whole thing at a fixed dt.
//
// Everything is kept in floating point and only rounded for display: a 1.6/s
// asphyxiation tick at 60 fps has to be able to shave 0.027 of a heart, and
// hunger has to be able to leak away over minutes rather than snapping.

import { ITEMS } from './items.js';

export const MAX_HEALTH = 20;   // 10 hearts
export const MAX_HUNGER = 20;   // 10 drumsticks
export const MAX_OXYGEN = 100;

// Warning thresholds. Exported because the HUD wants to tint the same bars at
// the same moment the warning event fires - two numbers drifting apart is how
// you get a red bar with no beep.
export const OXYGEN_LOW = 25;
export const HUNGER_LOW = 6;

// Re-arm band for the oxygen warning. Without it, a player standing on the edge
// of a life support radius re-crosses 25 twice a second (refill 14/s in, drain
// 0.25/s out) and gets a warning beep every time. The bar is still tinted below
// 30; only the one-shot event waits for real recovery.
const OXYGEN_REARM = OXYGEN_LOW + 5;

// Exertion the game charges for discrete actions. Exported so game.js does not
// have to carry its own copy of the tuning.
export const JUMP_EXERTION = 0.2;
export const MINE_EXERTION = 0.06;

// --- tuning -----------------------------------------------------------------
const FALL_SAFE_SPEED = 13;      // m/s you may hit the ground at for free
const FALL_DAMAGE_PER_MS = 0.55; // per m/s over the free allowance
const LAVA_DPS = 4;
const BURN_SECONDS = 4;
const BURN_DPS = 1;
const DROWN_RATE = 7;            // oxygen/s with your head under a liquid
const LIFE_SUPPORT_RATE = 14;    // oxygen/s standing at a life support unit
const ASPHYXIA_DPS = 1.6;
const STARVE_DPS = 0.5;
const EXERTION_PER_POINT = 4.0;  // exertion that buys one saturation or hunger
const WALK_COST = 0.012;         // exertion per metre walked
const SPRINT_COST = 0.055;       // per metre sprinted
const REGEN_HUNGER = 18;         // you only heal on a nearly full stomach
const REGEN_PERIOD = 3.5;        // seconds per healed point
const REGEN_EXERTION = 0.8;      // healing burns food
const RESPAWN_HUNGER = 12;

// Kept as a local constant rather than an import from armour.js, so this
// module's only outside dependency stays items.js: Survival works entirely off
// the plain numbers setArmour() hands it, never the container or its curve.
// Must match armour.js's ARMOUR_PER_POINT/ARMOUR_CAP.
const ARMOUR_PER_POINT = 0.04;
const ARMOUR_CAP = 20;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export class Survival {
  /**
   * @param {any} planet   planet record; only `.atmosphere` is read
   * @param {any} [saved]  serialize() output from a previous session
   */
  constructor(planet, saved = null) {
    this.planet = planet ?? null;
    this.health = MAX_HEALTH;
    this.hunger = MAX_HUNGER;
    this.saturation = 5;     // you land fed, so the first sprint is free
    this.oxygen = MAX_OXYGEN;
    this.alive = true;
    this.burning = 0;        // seconds of fire left on you
    this.exertion = 0;       // accumulates until it buys a hunger point
    this.regen = 0;          // seconds toward the next regenerated heart-half
    // The mode lives in ctx, but direct damage()/onLand() calls arrive between
    // updates - remembering the last flag keeps creative genuinely harmless.
    this.creative = false;
    // A snapshot of the worn suit, refreshed every frame by the caller via
    // setArmour() - never serialized, see setArmour()'s own note.
    this.armourPoints = 0;
    this.armourO2 = 0;
    this.armourFall = 0;
    this._clearWarnings();
    if (saved) this.restore(saved);
  }

  _clearWarnings() {
    this._oxWarned = false;
    this._hungerWarned = false;
    this._starveWarned = false;
  }

  // ------------------------------------------------------------------ damage
  /**
   * Suit snapshot. Never a container reference - the caller (game.js's
   * refreshArmour()) recomputes this from the equipped pieces every frame, so
   * a craft, a click or a load can never leave a stale bonus in effect, and
   * this class never has to know what a Container or an item is.
   * @param {{points?:number, o2Save?:number, fallReduce?:number}} [snapshot]
   */
  setArmour({ points = 0, o2Save = 0, fallReduce = 0 } = {}) {
    const n = (v) => (Number.isFinite(v) ? v : 0);
    this.armourPoints = clamp(n(points), 0, ARMOUR_CAP);
    this.armourO2 = clamp(n(o2Save), 0, 0.75);
    this.armourFall = clamp(n(fallReduce), 0, 0.6);
  }

  /**
   * Every armour discount funnels through here, and only here - which is what
   * guarantees nothing gets forgotten as new damage causes are added.
   */
  _mitigate(amount, cause) {
    // A suit does not feed you, does not breathe for you, and does not catch
    // you when the world runs out underneath - those three stay at full price.
    if (cause === 'asphyxiation' || cause === 'starvation' || cause === 'void') return amount;
    if (cause === 'fall') amount *= 1 - this.armourFall;
    return amount * (1 - this.armourPoints * ARMOUR_PER_POINT);
  }

  /** Internal: apply damage, push the event, and settle death in one place. */
  _hurt(amount, cause, events) {
    // Non-finite damage is a broken caller, not a lethal event: an Infinity here
    // would empty the bar AND serialize into the event as `null` (JSON has no
    // Infinity), so the HUD would read "took null damage" off a physics glitch.
    if (!this.alive || this.creative || !(amount > 0) || !Number.isFinite(amount)) return;
    const raw = amount;
    amount = this._mitigate(amount, cause);
    this.health = Math.max(0, this.health - amount);
    events.push({ type: 'damage', amount, cause, raw, absorbed: raw - amount });
    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
      this.burning = 0;
      events.push({ type: 'death', cause });
    }
  }

  /** @returns {Array<any>} events */
  damage(amount, cause = 'generic') {
    const events = [];
    this._hurt(amount, cause, events);
    return events;
  }

  /** @returns {number} health actually restored */
  heal(amount) {
    if (!this.alive || !(amount > 0)) return 0;
    const before = this.health;
    this.health = Math.min(MAX_HEALTH, this.health + amount);
    return this.health - before;
  }

  /**
   * Landing damage from impact SPEED rather than fall height. That single choice
   * is what makes low-gravity worlds gentle for free: the same 130 m drop hits
   * at 50 m/s on Earth and 20 m/s on the Moon, and the model needs no per-planet
   * fudge factor to notice.
   * @param {number} impactSpeed m/s, sign ignored so callers can pass vel.y
   * @returns {Array<any>} events
   */
  onLand(impactSpeed) {
    // A NaN or Infinity impact speed means the integrator blew up this frame;
    // that is a bug to survive, not a fall to die from.
    const speed = Math.abs(impactSpeed ?? 0);
    if (!Number.isFinite(speed)) return [];
    // You can never hurt yourself with your own jump. On Jupiter the suit servos
    // have to throw you at 13.7 m/s just to clear one block, which is above the
    // flat threshold - so the floor rises with whatever the legs can do.
    const safe = Math.max(FALL_SAFE_SPEED, this.safeImpact ?? 0);
    if (!this.alive || this.creative || !(speed > safe)) return [];
    const amount = Math.round((speed - safe) * FALL_DAMAGE_PER_MS);
    if (amount <= 0) return [];
    return this.damage(amount, 'fall');
  }

  // ----------------------------------------------------------------- hunger
  /** Mining, jumping and walking all pay into the same pool. */
  exert(amount) {
    if (!(amount > 0) || !Number.isFinite(amount)) return;
    this.exertion += amount;
  }

  _spendExertion() {
    // Stop as soon as there is nothing left to burn, otherwise a huge exert()
    // would spin forever against an empty stomach.
    while (this.exertion >= EXERTION_PER_POINT && (this.saturation > 0 || this.hunger > 0)) {
      this.exertion -= EXERTION_PER_POINT;
      if (this.saturation > 0) this.saturation = Math.max(0, this.saturation - 1);
      else this.hunger = Math.max(0, this.hunger - 1);
    }
    // Keep the accumulator bounded: a starving player should not build up a debt
    // that swallows the first meal they find whole.
    if (this.exertion >= EXERTION_PER_POINT) this.exertion %= EXERTION_PER_POINT;
  }

  // -------------------------------------------------------------------- use
  /**
   * Eat an item. Refuses when it would do nothing at all.
   * @returns {{ok: boolean, events: Array<any>}}
   */
  eat(itemId) {
    const events = [];
    const food = ITEMS[itemId]?.food;
    if (!this.alive || !food) return { ok: false, events };
    const heals = (food.heal ?? 0) > 0 && this.health < MAX_HEALTH;
    if (this.hunger >= MAX_HUNGER && !heals) return { ok: false, events };

    this.hunger = Math.min(MAX_HUNGER, this.hunger + (food.hunger ?? 0));
    this.saturation = Math.min(MAX_HUNGER, this.saturation + (food.hunger ?? 0) * 0.4);
    if (food.heal) {
      const got = this.heal(food.heal);
      if (got > 0) events.push({ type: 'heal', amount: got });
    }
    if (this.hunger > HUNGER_LOW) this._hungerWarned = false;
    if (this.hunger > 0) this._starveWarned = false;
    return { ok: true, events };
  }

  /**
   * Consume an oxygen canister / medkit. Same refusal rule as eat(): a full
   * tank should not swallow a canister you will want in ten minutes.
   * @returns {{ok: boolean, events: Array<any>}}
   */
  applyUse(itemId) {
    const events = [];
    const use = ITEMS[itemId]?.use;
    if (!this.alive || !use) return { ok: false, events };
    const wantsO2 = (use.oxygen ?? 0) > 0 && this.oxygen < MAX_OXYGEN;
    const wantsHp = (use.health ?? 0) > 0 && this.health < MAX_HEALTH;
    if (!wantsO2 && !wantsHp) return { ok: false, events };

    if (use.oxygen) this.refillOxygen(use.oxygen);
    if (use.health) {
      const got = this.heal(use.health);
      if (got > 0) events.push({ type: 'heal', amount: got });
    }
    return { ok: true, events };
  }

  refillOxygen(amount) {
    if (!(amount > 0)) return 0;
    const before = this.oxygen;
    this.oxygen = Math.min(MAX_OXYGEN, this.oxygen + amount);
    if (this.oxygen >= OXYGEN_REARM) this._oxWarned = false;
    return this.oxygen - before;
  }

  // ------------------------------------------------------------------ update
  /**
   * @param {number} dt seconds
   * @param {{planet?:any, inLiquid?:boolean, submerged?:boolean,
   *          liquidKey?:('water'|'lava'|'methane'|null), sprinting?:boolean,
   *          onGround?:boolean, moved?:number, nearLifeSupport?:boolean,
   *          creative?:boolean}} ctx
   *   `liquidKey` is what the body is standing in and is the authority for
   *   hazards; `submerged` (head under) is what drowns you. `inLiquid` is
   *   accepted for symmetry with the player but nothing here needs it.
   * @returns {Array<any>} events
   */
  update(dt, ctx = {}) {
    const events = [];
    // NaN/negative dt is neutralised, but dt is deliberately NOT capped here:
    // the model is specified in units per second and the tests step it a whole
    // second at a time. Callers clamp their frame time (game.js uses 0.05).
    const step = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    if (!ctx) ctx = {};
    this.creative = !!ctx.creative;

    if (this.creative) {
      // Creative is not "survival with cheats on" - it is the bars pinned full,
      // including reviving a body that died before the mode was switched.
      this.health = MAX_HEALTH;
      this.hunger = MAX_HUNGER;
      this.saturation = MAX_HUNGER;
      this.oxygen = MAX_OXYGEN;
      this.burning = 0;
      this.exertion = 0;
      this.regen = 0;
      this.alive = true;
      this._clearWarnings();
      return events;
    }
    if (!this.alive) return events;   // dead is dead until reset()

    const planet = ctx.planet ?? this.planet;
    this._stepOxygen(step, ctx, planet, events);
    if (!this.alive) return events;
    this._stepHazards(step, ctx, events);
    if (!this.alive) return events;
    this._stepFood(step, ctx, events);
    return events;
  }

  _stepOxygen(dt, ctx, planet, events) {
    const breathable = planet?.atmosphere?.breathable ?? true;
    if (ctx.nearLifeSupport) {
      // Life support always wins, even inside a vacuum sprint - it is the one
      // place on a hostile world where the player can stop watching the bar.
      this.oxygen = Math.min(MAX_OXYGEN, this.oxygen + LIFE_SUPPORT_RATE * dt);
    } else if (breathable) {
      // Breathable sky means lungs, not tank: the only way to run out is to
      // hold your head under something. A sealed visor still helps here - half
      // as much as it does against vacuum, since it is fighting water, not air.
      if (ctx.submerged) this.oxygen = Math.max(0, this.oxygen - DROWN_RATE * (1 - this.armourO2 * 0.5) * dt);
      else this.oxygen = MAX_OXYGEN;
    } else {
      // The suit is sealed, so submersion costs nothing extra out here; effort
      // does, which is what makes sprinting across Venus a real decision. A
      // helmet's o2Save cuts this same drain - the felt reason to want one.
      const drain = (planet?.atmosphere?.suitDrain ?? 0) * (ctx.sprinting ? 2 : 1) * (1 - this.armourO2);
      this.oxygen = Math.max(0, this.oxygen - drain * dt);
    }

    if (this.oxygen < OXYGEN_LOW) {
      if (!this._oxWarned) { this._oxWarned = true; events.push({ type: 'oxygen-low' }); }
    } else if (this.oxygen >= OXYGEN_REARM) {
      this._oxWarned = false;
    }
    if (this.oxygen <= 0) this._hurt(ASPHYXIA_DPS * dt, 'asphyxiation', events);
  }

  _stepHazards(dt, ctx, events) {
    const key = ctx.liquidKey ?? null;
    if (key === 'lava') {
      this.burning = BURN_SECONDS;
      // The 4/s already covers being on fire; adding the burn tick on top would
      // silently make lava 5/s and nobody would know which number was wrong.
      this._hurt(LAVA_DPS * dt, 'lava', events);
      return;
    }
    if (key === 'water' || key === 'methane') this.burning = 0;  // cryogenic counts
    if (this.burning > 0) {
      // Bill only the burn time actually consumed. Charging a whole dt on the
      // last, partial tick made a 4 s burn cost 4.04 at 24 fps and 4.00 at 144 -
      // small, but it is the frame rate leaking into the damage model.
      const burned = Math.min(this.burning, dt);
      this.burning -= burned;
      this._hurt(BURN_DPS * burned, 'burning', events);
    }
  }

  _stepFood(dt, ctx, events) {
    const moved = ctx.moved ?? 0;
    if (moved > 0) this.exert(moved * (ctx.sprinting ? SPRINT_COST : WALK_COST));
    this._spendExertion();

    if (this.hunger <= HUNGER_LOW) {
      if (!this._hungerWarned) { this._hungerWarned = true; events.push({ type: 'hunger-low' }); }
    } else {
      this._hungerWarned = false;
    }

    if (this.hunger === 0) {
      if (!this._starveWarned) { this._starveWarned = true; events.push({ type: 'starving' }); }
      this._hurt(STARVE_DPS * dt, 'starvation', events);
      if (!this.alive) return;
    } else {
      this._starveWarned = false;
    }

    if (this.hunger >= REGEN_HUNGER && this.health < MAX_HEALTH) {
      this.regen += dt;
      while (this.regen >= REGEN_PERIOD && this.health < MAX_HEALTH) {
        this.regen -= REGEN_PERIOD;
        const got = this.heal(1);
        if (got > 0) {
          events.push({ type: 'heal', amount: got });
          this.exert(REGEN_EXERTION);   // healing is paid for out of dinner
        }
      }
    } else {
      this.regen = 0;
    }
  }

  // ------------------------------------------------------------------- state
  /** After respawn: patched up, hungry, tank topped off. */
  reset() {
    this.health = MAX_HEALTH;
    this.hunger = RESPAWN_HUNGER;
    this.saturation = 0;
    this.oxygen = MAX_OXYGEN;
    this.alive = true;
    this.burning = 0;
    this.exertion = 0;
    this.regen = 0;
    this._clearWarnings();
    return this;
  }

  serialize() {
    return {
      health: this.health,
      hunger: this.hunger,
      saturation: this.saturation,
      oxygen: this.oxygen,
      alive: this.alive,
      burning: this.burning,
      exertion: this.exertion,
      regen: this.regen,
    };
  }

  /** Tolerant of missing or corrupt fields - an old save must still load. */
  restore(data) {
    if (!data) return this;
    const num = (v, fallback, lo, hi) => (Number.isFinite(v) ? clamp(v, lo, hi) : fallback);
    this.health = num(data.health, MAX_HEALTH, 0, MAX_HEALTH);
    this.hunger = num(data.hunger, MAX_HUNGER, 0, MAX_HUNGER);
    this.saturation = num(data.saturation, 0, 0, MAX_HUNGER);
    this.oxygen = num(data.oxygen, MAX_OXYGEN, 0, MAX_OXYGEN);
    this.burning = num(data.burning, 0, 0, BURN_SECONDS);
    this.exertion = num(data.exertion, 0, 0, EXERTION_PER_POINT);
    this.regen = num(data.regen, 0, 0, REGEN_PERIOD);
    this.alive = data.alive === undefined ? this.health > 0 : !!data.alive;
    // An empty health bar outranks the flag: a save claiming alive at 0 health
    // would otherwise load a body nothing can kill and the death screen never
    // shows, leaving the player stuck at zero hearts.
    if (this.health <= 0) this.alive = false;
    this._clearWarnings();
    return this;
  }
}
