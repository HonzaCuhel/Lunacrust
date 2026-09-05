// The one AABB solver. Moved out of player.js verbatim (same epsilons, same
// axis-resolution order, same groundedLastFrame and step-up rules) so mobs and
// the player can never drift into two different ideas of "solid ground".
//
// A body is the duck type { pos:{x,y,z}, vel:{x,y,z}, w, h, onGround,
// groundedLastFrame, stepOffset, flying }. player.js's Player satisfies it by
// construction; mobs.js's entity objects are built to satisfy it too.

import { BLOCKS } from './blocks.js';

// Minecraft-ish feel: Earth's 9.81 maps to ~31 blocks/s^2, which gives the
// familiar 1.25-block jump and a fall that reaches terminal speed quickly.
export const G_SCALE = 3.2;
export const TERMINAL = 78;

// A substep can never be allowed to cross a whole block, or a fast fall could
// tunnel a one-block-thick floor. 0.5 leaves headroom under 1 with margin to
// spare: TERMINAL(78) * SIM_DT(0.05) / MAX_SUBSTEPS(8) = 0.4875 < 0.5.
export const MAX_STEP = 0.5;
export const MAX_SUBSTEPS = 8;

export const SOLID = Uint8Array.from(BLOCKS.map((b) => (b.solid ? 1 : 0)));
export const LIQUID = Uint8Array.from(BLOCKS.map((b) => (b.liquid ? 1 : 0)));

/** Push a box out of any solid voxel it overlaps. Returns true if it had to. */
export function resolveBox(world, b, dx, dy, dz) {
  const p = b.pos;
  const hw = b.w / 2;
  const minX = Math.floor(p.x - hw), maxX = Math.floor(p.x + hw);
  const minY = Math.floor(p.y), maxY = Math.floor(p.y + b.h - 0.001);
  const minZ = Math.floor(p.z - hw), maxZ = Math.floor(p.z + hw);

  let collided = false;
  for (let y = minY; y <= maxY; y++) {
    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        if (!SOLID[world.getBlock(x, y, z)]) continue;
        collided = true;
        if (dy > 0) p.y = y - b.h - 0.0001;
        else if (dy < 0) p.y = y + 1 + 0.0001;
        else if (dx > 0) p.x = x - hw - 0.0001;
        else if (dx < 0) p.x = x + 1 + hw + 0.0001;
        else if (dz > 0) p.z = z - hw - 0.0001;
        else if (dz < 0) p.z = z + 1 + hw + 0.0001;
        else return true;
      }
    }
  }
  return collided;
}

/** One axis of movement, with the 1.02 auto step-up and the groundedLastFrame rule. */
export function moveAxis(world, b, dx, dy, dz) {
  const p = b.pos;
  p.x += dx; p.y += dy; p.z += dz;
  const hit = resolveBox(world, b, dx, dy, dz);
  if (!hit) return;

  if (dy !== 0) {
    b.vel.y = 0;
    if (dy < 0) b.onGround = true;
  } else if ((b.onGround || b.groundedLastFrame) && !b.flying) {
    // Auto step-up: try lifting a block and re-testing, so one-block ledges
    // don't require a jump. Without this, voxel terrain feels like a maze.
    const savedY = p.y;
    p.y += 1.02;
    if (!resolveBox(world, b, dx, 0, dz)) {
      b.stepOffset = Math.min(1.02, b.stepOffset + 1.02);
      return;
    }
    p.y = savedY;
    if (dx !== 0) b.vel.x = 0;
    if (dz !== 0) b.vel.z = 0;
  } else {
    if (dx !== 0) b.vel.x = 0;
    if (dz !== 0) b.vel.z = 0;
  }
}

/** True if the box would overlap solid ground at its current position. */
export function boxOverlapsSolid(world, b) {
  return resolveBox(world, b, 0, 0, 0);
}

export function liquidAt(world, x, y, z) {
  return LIQUID[world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z))] === 1;
}

/**
 * Full integrate: substep so a fast fall cannot tunnel a one-block floor, then
 * X, Y, Z passes. Sets b.onGround / b.impactSpeed / b.justLanded.
 *
 * Gravity is NOT applied here - the caller integrates b.vel first (mobs.js does
 * this once per sim tick, the same way Player.update does), and stepBody only
 * turns the resulting velocity into position across however many substeps a
 * fast fall needs.
 */
export function stepBody(world, b, dt) {
  const v = b.vel;
  let dx = v.x * dt, dy = v.y * dt, dz = v.z * dt;
  const maxD = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
  const n = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(maxD / MAX_STEP)));
  dx /= n; dy /= n; dz /= n;

  const wasFalling = v.y;
  const wasGround = b.onGround;

  for (let i = 0; i < n; i++) {
    // Every substep repeats the per-frame ritual moveAxis relies on: onGround
    // from the end of the previous substep becomes groundedLastFrame for this
    // one. Skipping this across substeps - using only the tick's starting
    // value - would reopen the exact X-axis ledge bug groundedLastFrame exists
    // to close, just at a finer grain, on any tick that needs more than one
    // substep.
    b.groundedLastFrame = b.onGround;
    b.onGround = false;
    moveAxis(world, b, dx, 0, 0);
    moveAxis(world, b, 0, dy, 0);
    moveAxis(world, b, 0, 0, dz);
  }

  b.justLanded = !wasGround && b.onGround;
  if (b.justLanded) b.impactSpeed = Math.max(0, -wasFalling);
}
