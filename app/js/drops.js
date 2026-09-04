// Dropped items: the little tumbling cubes that pop out of a block you mine and
// get vacuumed into your pockets.
//
// Each drop is its own entity, but everything expensive is shared: one cube
// BufferGeometry per block id (built the first time that block is ever dropped)
// and one sprite material per non-block item. Two hundred drops on the ground
// therefore cost two hundred tiny draw calls and almost no memory - which is the
// only reason a per-entity Mesh is affordable at all here.

import * as THREE from '../vendor/three.module.js';
import { BLOCKS } from './blocks.js';
import { TILE_INDEX, tileUV } from './textures.js';
import { ITEMS, isBlockItem, maxStack } from './items.js';
import { itemSprite } from './itemart.js';

const SIZE = 0.32;             // cube edge, in blocks
const HALF = SIZE / 2;
const SPRITE_SIZE = 0.34;

const MAX_ENTITIES = 220;      // hard cap; the oldest drop is sacrificed first
const DESPAWN = 300;           // seconds before loot rots away
const SPAWN_DELAY = 0.35;      // no pickup until the drop has been on screen
const PICKUP_RANGE = 1.35;
const PLAYER_MID = 0.9;        // pickup is measured to the chest, not the feet
const PICKUP_RETRY = 0.4;      // full inventory: back off instead of asking every frame
const MAGNET_RANGE = 2.6;
const MAGNET_ACCEL = 14;

const BOUNCE = 0.35;
const MAX_BOUNCE = 6;          // a drop off a cliff hits at 80 blocks/s; do not launch it back up
const SETTLE = 0.9;            // bounce slower than this and the drop just stops
const DRAG = 0.8;              // horizontal e-folding rate per second, in air
const GROUND_DRAG = 6;         // and once it is lying on something
const STOP = 0.01;             // slower than this horizontally and it is standing still
const SPIN = 1.2;              // rad/s
const BOB = 0.07;              // peak hover height, always >= 0 so it never sinks
const MERGE_RANGE = 0.6;
const MERGE_MIN_AGE = 1;
const MERGE_INTERVAL = 0.25;   // merging is O(n^2); 4 Hz is plenty for the eye

const SOLID = Uint8Array.from(BLOCKS.map((b) => (b.solid ? 1 : 0)));

// Same order and same numbers as the mesher's FACE_SHADE, so a dropped cube is
// lit like the block it came out of. +X -X +Y -Y +Z -Z.
const FACE_SHADE = [0.72, 0.72, 1.0, 0.46, 0.86, 0.86];

// `tex` indexes block.tex: 0 top, 1 side, 2 bottom. Corners are wound CCW seen
// from outside; `uv` is the tile corner each one samples. Those uv pairs are not
// free-chosen - they reproduce mesher.js's mapping exactly (side faces read
// u=x/z and v=y, the horizontal faces read v=1-z), so a dropped cube shows the
// same pixels in the same orientation as the block still standing in the world.
const CUBE_FACES = [
  { tex: 1, n: [1, 0, 0], v: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]], uv: [[0, 0], [1, 0], [1, 1], [0, 1]] },
  { tex: 1, n: [-1, 0, 0], v: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], uv: [[0, 0], [1, 0], [1, 1], [0, 1]] },
  { tex: 0, n: [0, 1, 0], v: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], uv: [[0, 0], [1, 0], [1, 1], [0, 1]] },
  { tex: 2, n: [0, -1, 0], v: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], uv: [[0, 1], [1, 1], [1, 0], [0, 0]] },
  { tex: 1, n: [0, 0, 1], v: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], uv: [[0, 0], [1, 0], [1, 1], [0, 1]] },
  { tex: 1, n: [0, 0, -1], v: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]], uv: [[0, 0], [1, 0], [1, 1], [0, 1]] },
];

const round3 = (v) => Math.round(v * 1000) / 1000;

export class DropEntities {
  /**
   * @param {THREE.Object3D} scene
   * @param {THREE.Texture} atlasTexture the world's block atlas - borrowed, never disposed here
   */
  constructor(scene, atlasTexture) {
    this.scene = scene;
    this.list = [];               // spawn order, so list[0] is always the oldest
    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false;   // nothing ever moves the group itself
    scene.add(this.group);

    this.blockGeom = new Map();   // block id -> BufferGeometry
    this.spriteMat = new Map();   // item id  -> SpriteMaterial (+ its CanvasTexture)
    // alphaTest is low rather than the world's 0.5: leaf holes are alpha 0, but
    // glass is alpha 46 and a dropped pane should not vanish.
    this.blockMat = new THREE.MeshLambertMaterial({
      map: atlasTexture, vertexColors: true, alphaTest: 0.1, side: THREE.FrontSide,
    });

    this._mergeT = 0;
    this._env = { dt: 0, g: 0, damp: 1, ground: 1, world: null, pp: null, magnet: true };
  }

  get count() { return this.list.length; }

  // ----------------------------------------------------------------- spawning
  /**
   * Pop an item into the world. Returns the entity so a caller can override the
   * throw (the save loader does exactly that).
   */
  spawn(x, y, z, itemId, count = 1, dur = null) {
    // A single NaN here would poison the entity's matrix for the rest of its
    // life (and every bounding sphere the renderer computes from it), so bad
    // input is dropped at the door rather than left to surface as a blank cube.
    if (!Number.isInteger(itemId) || itemId <= 0 || !ITEMS[itemId]) return null;
    const n = Math.floor(count);
    if (!(n > 0)) return null;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    if (this.list.length >= MAX_ENTITIES) this.remove(0);

    const e = {
      item: itemId,
      count: n,
      dur: Number.isFinite(dur) ? dur : null,
      x, y, z,
      // a small upward toss so the drop clears the block it came from
      vx: (Math.random() - 0.5) * 1.7,
      vy: 1.7 + Math.random() * 0.6,
      vz: (Math.random() - 0.5) * 1.7,
      age: 0,
      phase: Math.random() * Math.PI * 2,
      cd: 0,
      rest: false,
      obj: null,
    };
    e.obj = this.makeObject(itemId);
    e.obj.position.set(x, y, z);
    this.group.add(e.obj);
    this.list.push(e);
    return e;
  }

  makeObject(itemId) {
    if (isBlockItem(itemId)) return new THREE.Mesh(this.blockGeometry(itemId), this.blockMat);
    const s = new THREE.Sprite(this.spriteMaterial(itemId));
    s.scale.set(SPRITE_SIZE, SPRITE_SIZE, SPRITE_SIZE);
    return s;
  }

  /** A 0.32 cube cut from the world atlas. Built once per block id, then shared. */
  blockGeometry(itemId) {
    const hit = this.blockGeom.get(itemId);
    if (hit) return hit;

    const block = BLOCKS[itemId] ?? BLOCKS[0];
    const pos = new Float32Array(24 * 3);
    const norm = new Float32Array(24 * 3);
    const col = new Float32Array(24 * 3);
    const uv = new Float32Array(24 * 2);
    const idx = new Uint16Array(36);
    let v = 0, i = 0;

    for (let f = 0; f < 6; f++) {
      const face = CUBE_FACES[f];
      const rect = tileUV(TILE_INDEX.get(block.tex[face.tex]) ?? 0);
      const lum = Math.min(1.35, FACE_SHADE[f] + block.light * 1.1);
      const base = v;
      for (let c = 0; c < 4; c++) {
        const p = face.v[c];
        const o3 = v * 3, o2 = v * 2;
        pos[o3] = (p[0] - 0.5) * SIZE;
        pos[o3 + 1] = (p[1] - 0.5) * SIZE;
        pos[o3 + 2] = (p[2] - 0.5) * SIZE;
        norm[o3] = face.n[0]; norm[o3 + 1] = face.n[1]; norm[o3 + 2] = face.n[2];
        col[o3] = col[o3 + 1] = col[o3 + 2] = lum;
        uv[o2] = rect[0] + face.uv[c][0] * rect[2];
        uv[o2 + 1] = rect[1] + face.uv[c][1] * rect[3];
        v++;
      }
      idx[i++] = base; idx[i++] = base + 1; idx[i++] = base + 2;
      idx[i++] = base; idx[i++] = base + 2; idx[i++] = base + 3;
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(norm, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    this.blockGeom.set(itemId, g);
    return g;
  }

  /** Camera-facing art for anything that is not a block. One material per item. */
  spriteMaterial(itemId) {
    const hit = this.spriteMat.get(itemId);
    if (hit) return hit;
    const tex = new THREE.CanvasTexture(itemSprite(itemId, 64));
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.SpriteMaterial({ map: tex, transparent: true, alphaTest: 0.35 });
    this.spriteMat.set(itemId, m);
    return m;
  }

  // ------------------------------------------------------------------- update
  /**
   * @param {number} dt
   * @param {{gravity:number, world:{getBlock:Function, isLoaded?:Function},
   *          playerPos:{x:number,y:number,z:number},
   *          pickup:(item:number,count:number,dur:number|null)=>number,
   *          magnet?:boolean}} ctx
   */
  update(dt, ctx = {}) {
    const step = Math.min(dt, 0.1);   // a stalled tab must not teleport loot through the floor
    if (!(step > 0) || this.list.length === 0) return;

    const env = this._env;
    env.dt = step;
    env.g = Number.isFinite(ctx.gravity) ? ctx.gravity : 31;
    env.damp = Math.exp(-DRAG * step);
    env.ground = Math.exp(-GROUND_DRAG * step);
    env.world = ctx.world ?? null;
    env.pp = ctx.playerPos ?? null;
    env.magnet = ctx.magnet !== false;
    const pickup = ctx.pickup;
    const pp = env.pp;

    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i];
      e.age += step;
      if (e.cd > 0) e.cd -= step;
      if (e.age > DESPAWN || e.y < -4) { this.remove(i); continue; }

      // Chunks stream: a drop standing over terrain that has not arrived yet must
      // hang in place instead of falling through the hole and despawning.
      const loaded = !env.world || !env.world.isLoaded
        || env.world.isLoaded(Math.floor(e.x), Math.floor(e.z));
      if (loaded) this.integrate(e, env);

      if (pp && pickup && e.age >= SPAWN_DELAY && e.cd <= 0) {
        const dx = e.x - pp.x, dy = e.y - (pp.y + PLAYER_MID), dz = e.z - pp.z;
        if (dx * dx + dy * dy + dz * dz <= PICKUP_RANGE * PICKUP_RANGE) {
          const left = Math.min(e.count, pickup(e.item, e.count, e.dur) ?? 0);
          if (left <= 0) { this.remove(i); continue; }
          if (left < e.count) e.count = left;
          else e.cd = PICKUP_RETRY;
        }
      }

      const obj = e.obj;
      obj.position.set(e.x, e.y + (Math.sin(e.age * 2.4 + e.phase) * 0.5 + 0.5) * BOB, e.z);
      if (obj.isMesh) obj.rotation.y = e.phase + e.age * SPIN;
    }

    this._mergeT += step;
    if (this._mergeT >= MERGE_INTERVAL) { this._mergeT = 0; this.mergePass(); }
  }

  /** Cheap AABB against the voxel grid - no sweeping, so keep dt small. */
  integrate(e, env) {
    const dt = env.dt, world = env.world;

    if (env.magnet && env.pp) {
      const dx = env.pp.x - e.x, dy = env.pp.y + PLAYER_MID - e.y, dz = env.pp.z - e.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < MAGNET_RANGE * MAGNET_RANGE && d2 > 1e-6) {
        const k = (MAGNET_ACCEL * dt) / Math.sqrt(d2);
        e.vx += dx * k; e.vy += dy * k; e.vz += dz * k;
        e.rest = false;
      }
    }

    e.vy -= env.g * dt;
    const drag = e.rest ? env.ground : env.damp;
    e.vx *= drag;
    e.vz *= drag;
    // Exponential drag only ever approaches zero, and a drop with 1e-9 of speed
    // left still pays for eight getBlock probes every frame, forever. Snap it.
    if (e.vx < STOP && e.vx > -STOP) e.vx = 0;
    if (e.vz < STOP && e.vz > -STOP) e.vz = 0;

    // Horizontal first: a drop that slides into a wall should still land flat.
    if (e.vx !== 0) {
      const nx = e.x + e.vx * dt;
      if (this.hits(world, nx + Math.sign(e.vx) * HALF, e.y, e.z, 0)) e.vx = 0;
      else e.x = nx;
    }
    if (e.vz !== 0) {
      const nz = e.z + e.vz * dt;
      if (this.hits(world, e.x, e.y, nz + Math.sign(e.vz) * HALF, 2)) e.vz = 0;
      else e.z = nz;
    }

    // Nothing here is swept, so a single frame may never cross a whole block:
    // otherwise a long fall punches straight through a one-block floor.
    const dy = e.vy * dt;
    const ny = e.y + (dy > 0.95 ? 0.95 : dy < -0.95 ? -0.95 : dy);
    if (e.vy <= 0) {
      const foot = ny - HALF;
      if (this.hits(world, e.x, foot, e.z, 1)) {
        e.y = Math.floor(foot) + 1 + HALF;
        e.vy = Math.min(-e.vy * BOUNCE, MAX_BOUNCE);
        if (e.vy < SETTLE) { e.vy = 0; e.rest = true; }
      } else {
        e.y = ny;
        e.rest = false;
      }
    } else {
      const head = ny + HALF;
      if (this.hits(world, e.x, head, e.z, 1)) {
        e.y = Math.floor(head) - HALF - 1e-3;
        e.vy = Math.max(-e.vy * BOUNCE, -MAX_BOUNCE);
      } else {
        e.y = ny;
      }
    }

    // Loot buried by a placed block crawls out rather than being lost forever.
    if (this.solidAt(world, e.x, e.y, e.z)) {
      e.y += Math.min(2.5 * dt, 0.1);
      e.vy = 0;
      e.rest = false;
    }
  }

  solidAt(world, x, y, z) {
    if (!world) return false;
    return SOLID[world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z))] === 1;
  }

  /**
   * Solid test over a face of the drop's box. `axis` is the face normal's axis,
   * so the two remaining axes get probed at both corners - four getBlock calls
   * instead of one keeps a drop from falling off the edge of the block it landed
   * on, and is still nothing next to a chunk remesh.
   */
  hits(world, x, y, z, axis) {
    if (!world) return false;
    const r = HALF - 0.02;
    const ax = axis === 0 ? 0 : r;
    const ay = axis === 1 ? 0 : r;
    const az = axis === 2 ? 0 : r;
    // two probe offsets per free axis; for a Y face that is the four bottom corners
    if (axis === 1) {
      return this.solidAt(world, x - ax, y, z - az) || this.solidAt(world, x + ax, y, z - az)
        || this.solidAt(world, x - ax, y, z + az) || this.solidAt(world, x + ax, y, z + az);
    }
    return this.solidAt(world, x - ax, y - ay, z - az) || this.solidAt(world, x + ax, y - ay, z + az)
      || this.solidAt(world, x - ax, y + ay, z - az) || this.solidAt(world, x + ax, y + ay, z + az);
  }

  /**
   * Fold nearby piles together so a felled tree does not leave forty entities.
   * The younger drop feeds the older one, and tools (anything carrying `dur`)
   * are never merged - their durability is per-item and would be lost.
   */
  mergePass() {
    const list = this.list;
    for (let i = list.length - 1; i > 0; i--) {
      const a = list[i];
      if (a.dur != null || a.age < MERGE_MIN_AGE) continue;
      const cap = maxStack(a.item);
      for (let j = 0; j < i; j++) {
        const b = list[j];
        if (b.item !== a.item || b.dur != null || b.age < MERGE_MIN_AGE || b.count >= cap) continue;
        const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
        if (dx * dx + dy * dy + dz * dz > MERGE_RANGE * MERGE_RANGE) continue;
        const move = Math.min(a.count, cap - b.count);
        b.count += move;
        a.count -= move;
        if (a.count <= 0) { this.remove(i); break; }
      }
    }
  }

  // ---------------------------------------------------------------- lifecycle
  /** Splice, not swap-remove: spawn order is what makes list[0] the oldest. */
  remove(i) {
    const e = this.list[i];
    if (!e) return;
    this.group.remove(e.obj);
    this.list.splice(i, 1);
  }

  clear() {
    for (const e of this.list) this.group.remove(e.obj);
    this.list.length = 0;
  }

  dispose() {
    this.clear();
    this.scene.remove(this.group);
    for (const g of this.blockGeom.values()) g.dispose();
    this.blockGeom.clear();
    for (const m of this.spriteMat.values()) { m.map?.dispose(); m.dispose(); }
    this.spriteMat.clear();
    this.blockMat.dispose();   // its map belongs to the world; leave it alone
  }

  // ------------------------------------------------------------------- saving
  serialize() {
    return this.list.map((e) => {
      const o = { x: round3(e.x), y: round3(e.y), z: round3(e.z), item: e.item, count: e.count, age: Math.round(e.age) };
      if (e.dur != null) o.dur = e.dur;
      return o;
    });
  }

  /** `ctx` is accepted (and ignored) so a caller can pass what it hands update(). */
  restore(data, ctx) {
    this.clear();
    if (!Array.isArray(data)) return;
    // Loot is the least important thing in a save file: a truncated or hand-
    // edited entry has to cost that one drop, never the whole world load.
    for (let i = 0; i < data.length && this.list.length < MAX_ENTITIES; i++) {
      const d = data[i];
      if (!d || typeof d !== 'object') continue;
      const e = this.spawn(d.x, d.y, d.z, d.item, d.count ?? 1, d.dur ?? null);
      if (!e) continue;
      e.vx = e.vy = e.vz = 0;   // reloaded loot settles where it lay, it does not leap
      const age = Number(d.age);
      e.age = Number.isFinite(age) && age >= 0 ? Math.min(age, DESPAWN) : MERGE_MIN_AGE;
    }
  }
}
