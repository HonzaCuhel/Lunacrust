// The explosion. Pure: reads world.getBlock, writes nothing, never touches
// Math.random. computeBlast() only ever fills caller-owned scratch arrays, so
// a crawler detonating costs one allocation-free pass instead of 171 setBlock
// calls each dirtying its own chunk.

import { AIR, BLOCKS } from './blocks.js';
import { dropFor, itemIdOf } from './items.js';
import { raycastVoxel } from './raycast.js';

export const BLAST_R = 3.4;
export const BLAST_POWER = 5.5;
export const BLAST_MAX_R = 5;
export const MAX_BLAST_BLOCKS = 560;   // sphereOffsets(BLAST_MAX_R) is 515 candidates
export const BLAST_DAMAGE = 22;
export const BLAST_DROP_CHANCE = 0.25;
export const BLAST_DROP_CAP = 24;
// "Harvests like a stone tool" - the drill everyone lands with, so a blast
// never drops anything a landing-day player couldn't have mined by hand.
export const BLAST_TOOL = itemIdOf('hand_drill');

const offsetCache = new Map();   // radius -> Int16Array, built once and reused

/** Cached, sorted near-to-far, built once per radius. Int16Array of [dx,dy,dz,...]. */
export function sphereOffsets(r) {
  const cached = offsetCache.get(r);
  if (cached) return cached;

  const R = Math.ceil(r), r2 = r * r;
  const pts = [];
  for (let dx = -R; dx <= R; dx++) {
    for (let dy = -R; dy <= R; dy++) {
      for (let dz = -R; dz <= R; dz++) {
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 <= r2 + 1e-9) pts.push([dx, dy, dz, d2]);
      }
    }
  }
  // Near-to-far so the destruction rule can early-exit; ties broken y, z, x so
  // two runs with the same seed and centre destroy blocks in the same order,
  // which is what makes the loot roll (and a future multiplayer client)
  // reproducible.
  pts.sort((a, b) => a[3] - b[3] || a[1] - b[1] || a[2] - b[2] || a[0] - b[0]);

  const out = new Int16Array(pts.length * 3);
  for (let i = 0; i < pts.length; i++) {
    out[i * 3] = pts[i][0]; out[i * 3 + 1] = pts[i][1]; out[i * 3 + 2] = pts[i][2];
  }
  offsetCache.set(r, out);
  return out;
}

/** A fresh, reusable scratch buffer for computeBlast, sized for BLAST_MAX_R. */
export function createBlastScratch(maxBlocks = MAX_BLAST_BLOCKS, maxDrops = BLAST_DROP_CAP) {
  return {
    edits: new Int32Array(maxBlocks * 4),   // [x, y, z, id, ...]
    old: new Int32Array(maxBlocks),         // id destroyed at edits[i*4..], parallel to it
    n: 0,
    drops: new Int32Array(maxDrops * 5),    // [x, y, z, item, count, ...]
    dn: 0,
  };
}

/**
 * Fill `out` with the blocks this blast destroys. Pure: reads world.getBlock,
 * writes nothing, touches no Math.random, allocates nothing after the first
 * sphereOffsets(r) call for a given radius.
 * @param {{getBlock:Function}} world
 * @param {()=>number} rng   seeded; used only for the loot roll
 * @param {{edits:Int32Array, old:Int32Array, n:number,
 *          drops:Int32Array, dn:number}} out   reusable scratch
 */
export function computeBlast(world, ox, oy, oz, r, power, rng, out) {
  const rr = Math.min(r, BLAST_MAX_R);
  const offsets = sphereOffsets(rr);
  const cx = Math.floor(ox), cy = Math.floor(oy), cz = Math.floor(oz);
  const editCap = Math.min(out.edits.length / 4, MAX_BLAST_BLOCKS);
  const dropCap = Math.min(out.drops.length / 5, BLAST_DROP_CAP);

  let n = 0, dn = 0;
  for (let i = 0; i < offsets.length && n < editCap; i += 3) {
    const dx = offsets[i], dy = offsets[i + 1], dz = offsets[i + 2];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const threshold = power * (1 - d / rr);
    // Offsets are sorted near-to-far and hardness is always positive, so once
    // the threshold reaches zero nothing farther out can ever qualify either.
    if (threshold <= 0) break;

    const x = cx + dx, y = cy + dy, z = cz + dz;
    const id = world.getBlock(x, y, z);
    if (id === AIR) continue;
    const block = BLOCKS[id];
    if (block.liquid) continue;              // the game has no fluid flow - never remove liquids
    if (!(block.hardness < threshold)) continue;

    const ei = n * 4;
    out.edits[ei] = x; out.edits[ei + 1] = y; out.edits[ei + 2] = z; out.edits[ei + 3] = AIR;
    out.old[n] = id;
    n++;

    if (dn < dropCap && rng() < BLAST_DROP_CHANCE) {
      const got = dropFor(id, BLAST_TOOL, rng());
      if (got) {
        const di = dn * 5;
        out.drops[di] = x; out.drops[di + 1] = y; out.drops[di + 2] = z;
        out.drops[di + 3] = got.item; out.drops[di + 4] = got.count;
        dn++;
      }
    }
  }
  out.n = n;
  out.dn = dn;
  return out;
}

/** Blast damage on a point, 0 outside 2r. Halved if a solid block is in the way. */
export function blastDamageAt(world, ox, oy, oz, r, tx, ty, tz) {
  const dx = tx - ox, dy = ty - oy, dz = tz - oz;
  const d = Math.hypot(dx, dy, dz);
  const t = 1 - d / (2 * r);
  if (t <= 0) return 0;
  let dmg = BLAST_DAMAGE * t * t;
  if (d > 1e-6) {
    // raycastVoxel marches P(t) = O + t*D and compares t directly against
    // maxDist in WORLD units, so D must be a UNIT vector - see its other
    // caller, game.js's block-targeting raycast, which always normalizes.
    // The raw (tx-ox, ...) delta has magnitude d, not 1: passed straight
    // through, the march travels up to d times too far past the real target
    // and can find "cover" from a block nowhere near the actual line between
    // blast and target.
    const blocked = raycastVoxel(world, ox, oy, oz, dx / d, dy / d, dz / d, d,
      (id) => id !== AIR && BLOCKS[id].solid && !BLOCKS[id].liquid);
    if (blocked) dmg *= 0.5;
  }
  return dmg;
}
