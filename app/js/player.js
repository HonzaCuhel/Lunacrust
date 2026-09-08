// Player physics. Gravity is the whole point of this game, so it is a per-planet
// number rather than a constant - and the same jump impulse that lifts you 1.2
// blocks on Earth throws you seven blocks up on Europa.

import { WORLD_H } from './worldgen.js';
import {
  G_SCALE, TERMINAL, LIQUID, resolveBox, moveAxis as bodyMoveAxis, boxOverlapsSolid,
} from './body.js';

export const PLAYER_W = 0.62;
export const PLAYER_H = 1.8;
export const EYE_H = 1.62;

// Flight bounds. Below y=1 there is nothing but the underside of the world -
// getBlock returns air under y=0, so you end up in a void looking up at the
// bottom of the terrain, which reads as a broken game rather than a limit.
// Above the build limit there is a little headroom so you can still look down
// at what you built from the top.
export const FLIGHT_FLOOR = 1.0;
export const FLIGHT_CEIL = WORLD_H + 8;

export { G_SCALE };

const BASE_JUMP = 8.9;

export class Player {
  constructor(planet) {
    this.planet = planet;
    this.pos = { x: 0.5, y: 80, z: 0.5 };
    this.vel = { x: 0, y: 0, z: 0 };
    this.w = PLAYER_W; this.h = PLAYER_H;   // body.js's duck type reads w/h, not the module constants
    this.yaw = 0;
    this.pitch = 0;
    this.onGround = false;
    this.inLiquid = false;
    this.flying = false;
    this.sprinting = false;
    this.landImpact = 0;      // drives the landing camera dip
    this.stepOffset = 0;      // camera catch-up after an auto step-up
    this.impactSpeed = 0;     // |vy| at the moment of the last landing, for fall damage
    this.jumped = false;      // one-shot: a jump left the ground (consumer clears it)
    this.justLanded = false;  // one-shot: touched down this frame (consumer clears it)
    this.distance = 0;        // metres walked this frame, for hunger exertion
    this.hitLimit = null;     // 'floor' | 'ceiling' while flight is being clamped
    this.bob = 0;
    this.gravity = planet.gravity * G_SCALE;
    // A suit servo guarantees you can always clear one block, even on Jupiter.
    this.jumpImpulse = Math.max(BASE_JUMP, Math.sqrt(2 * this.gravity * 1.18));
    this.walkSpeed = 4.6;
    this.lastJumpTap = -1;
  }

  get eyeY() { return this.pos.y + EYE_H; }

  jumpHeight() { return (this.jumpImpulse * this.jumpImpulse) / (2 * this.gravity); }

  setPosition(p) {
    this.pos.x = p.x; this.pos.y = p.y; this.pos.z = p.z;
    this.vel.x = this.vel.y = this.vel.z = 0;
  }

  look(dx, dy, sensitivity = 0.0022) {
    this.yaw -= dx * sensitivity;
    this.pitch -= dy * sensitivity;
    const lim = Math.PI / 2 - 0.001;
    if (this.pitch > lim) this.pitch = lim;
    if (this.pitch < -lim) this.pitch = -lim;
  }

  /** @param {{getBlock:(x:number,y:number,z:number)=>number}} world */
  update(dt, input, world) {
    const p = this.pos, v = this.vel;

    // --- what am I standing in?
    this.inLiquid = LIQUID[world.getBlock(Math.floor(p.x), Math.floor(p.y + 0.9), Math.floor(p.z))] === 1;
    const submerged = LIQUID[world.getBlock(Math.floor(p.x), Math.floor(p.y + EYE_H), Math.floor(p.z))] === 1;
    this.submerged = submerged;

    // --- desired horizontal velocity from input, in view space
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    let mf = (input.forward ? 1 : 0) - (input.back ? 1 : 0);
    let ms = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    const len = Math.hypot(mf, ms);
    if (len > 0) { mf /= len; ms /= len; }

    this.sprinting = !!input.sprint && mf > 0 && (this.flying || !input.sneak);
    let speed = this.walkSpeed * (this.sprinting ? 1.62 : 1) * (input.sneak && this.onGround && !this.flying ? 0.36 : 1);
    if (this.flying) speed = this.sprinting ? 26 : 11;
    else if (this.inLiquid) speed *= 0.62;

    // yaw 0 looks down -Z
    const wantX = (-sin * mf + cos * ms) * speed;
    const wantZ = (-cos * mf - sin * ms) * speed;

    const control = this.flying ? 9 : this.onGround ? 12 : this.inLiquid ? 4 : 2.4;
    v.x += (wantX - v.x) * Math.min(1, control * dt);
    v.z += (wantZ - v.z) * Math.min(1, control * dt);

    // --- vertical
    if (this.flying) {
      const wantY = ((input.jump ? 1 : 0) - (input.sneak ? 1 : 0)) * speed;
      v.y += (wantY - v.y) * Math.min(1, 9 * dt);
    } else if (this.inLiquid) {
      v.y -= this.gravity * 0.28 * dt;
      if (input.jump) {
        v.y += this.gravity * 0.55 * dt + 2.2 * dt;
        // Enough of a kick to clear the surface and land on the bank: without it
        // a lava lake on Venus is a five-second death sentence.
        if (v.y < 3.4) v.y = 3.4;
      }
      v.y *= Math.pow(0.02, dt);           // heavy drag
      if (v.y < -6) v.y = -6;
    } else {
      v.y -= this.gravity * dt;
      if (v.y < -TERMINAL) v.y = -TERMINAL;
      if (input.jump && this.onGround) {
        v.y = this.jumpImpulse;
        this.onGround = false;
        this.jumped = true;
      }
    }

    // --- integrate with per-axis resolution
    const wasFalling = v.y;
    const wasGround = this.onGround;
    const px = p.x, pz = p.z;
    // moveAxis runs X, then Y, then Z, and onGround is only restored by the Y
    // pass - so the X pass has to consult the flag from the previous frame or
    // one-block ledges become walls in the east/west direction only.
    this.groundedLastFrame = wasGround;
    this.onGround = false;
    this.moveAxis(world, v.x * dt, 0, 0, input);
    this.moveAxis(world, 0, v.y * dt, 0, input);
    this.moveAxis(world, 0, 0, v.z * dt, input);

    this.distance = Math.hypot(p.x - px, p.z - pz);

    if (!wasGround && this.onGround) {
      // Fall damage keys off impact SPEED rather than distance, which is why a
      // drop that would kill you on Earth is a gentle hop on Europa.
      this.impactSpeed = Math.max(0, -wasFalling - this.gravity * dt);
      this.justLanded = true;
      if (wasFalling < -12) this.landImpact = Math.min(1, (-wasFalling - 12) / 40);
    }
    this.landImpact *= Math.pow(0.02, dt);

    // Flight is clamped to the world; falling is not, because dropping off
    // Jupiter's cloud decks into the void is a deliberate hazard there.
    // The flag stays set while you are resting against the limit, not just on
    // the frame you hit it, so the HUD can hold the indicator up.
    this.hitLimit = null;
    if (this.flying) {
      if (p.y <= FLIGHT_FLOOR + 1e-4) {
        p.y = FLIGHT_FLOOR;
        if (v.y < 0) v.y = 0;
        this.hitLimit = 'floor';
      } else if (p.y >= FLIGHT_CEIL - 1e-4) {
        p.y = FLIGHT_CEIL;
        if (v.y > 0) v.y = 0;
        this.hitLimit = 'ceiling';
      }
    }

    this.stepOffset *= Math.pow(0.00002, dt);

    // head bob while walking
    const hsp = Math.hypot(v.x, v.z);
    if (this.onGround && hsp > 0.6) this.bob += dt * hsp * 1.5;
    return { speed: hsp };
  }

  // Delegated to body.js so mobs and the player share one AABB solver and
  // cannot drift apart. Player.update itself is NOT rewritten onto stepBody -
  // it keeps its own bespoke input, liquid, flight and jump logic below;
  // only the per-axis voxel resolution moved out.
  moveAxis(world, dx, dy, dz) { bodyMoveAxis(world, this, dx, dy, dz); }

  /** Push the box out of any solid voxel it overlaps; returns true if it had to. */
  resolve(world, dx, dy, dz) { return resolveBox(world, this, dx, dy, dz); }

  /** True if the player's box would overlap solid ground at the current spot. */
  stuck(world) { return boxOverlapsSolid(world, this); }

  toggleFly() {
    this.flying = !this.flying;
    if (this.flying) this.vel.y = 0;
    return this.flying;
  }

  serialize() {
    return { pos: { ...this.pos }, yaw: this.yaw, pitch: this.pitch, flying: this.flying };
  }
  restore(s) {
    if (!s) return;
    this.setPosition(s.pos);
    this.yaw = s.yaw ?? 0;
    this.pitch = s.pitch ?? 0;
    this.flying = !!s.flying;
  }
}
