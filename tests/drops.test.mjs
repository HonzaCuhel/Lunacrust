// drops: the physics and the bookkeeping, without a GPU.
//
// Two things here are worth more than the assertion count. First, the cube's UVs
// are not compared against numbers typed out by hand - they are compared against
// the output of the real mesher for the same block, so "a dropped stone looks
// like the stone it came from" is checked rather than hoped for. Second, the
// only DOM in the module is itemSprite(), so a four-method canvas shim lets the
// real app/js/itemart.js run here instead of a stub that could drift from it.
//
// What still cannot be checked in node: whether the picture is legible. Nothing
// is rasterised, so face shading, atlas alignment and sprite art are geometry
// and arithmetic here, not pixels.

import assert from 'node:assert/strict';

// ------------------------------------------------------------- canvas shim
// Every 2d-context call in icons.js/itemart.js is a command, never a query, so
// a no-op proxy is a faithful stand-in for everything except the pixels.
const ctx2d = new Proxy({}, {
  get: (t, k) => (k in t ? t[k] : (t[k] = () => {})),
  set: (t, k, v) => { t[k] = v; return true; },
});
globalThis.document = {
  createElement: (tag) => {
    assert.equal(tag, 'canvas', 'the module only ever asks for canvases');
    return { width: 0, height: 0, getContext: () => ctx2d };
  },
};
globalThis.ImageData = class { constructor(data, w, h) { this.data = data; this.width = w; this.height = h; } };

const THREE = await import('../app/vendor/three.module.js');
const { DropEntities } = await import('../app/js/drops.js');
const { BLOCKS, BY_KEY, AIR } = await import('../app/js/blocks.js');
const { itemIdOf, maxStack } = await import('../app/js/items.js');
const { itemSprite } = await import('../app/js/itemart.js');
const { meshChunk, pIndex, PAD, PX, PZ } = await import('../app/js/mesher.js');
const { WORLD_H } = await import('../app/js/worldgen.js');

const STONE = BY_KEY.get('stone').id;
const DIRT = BY_KEY.get('dirt').id;
const GLASS = BY_KEY.get('glass').id;
const LAMP = BY_KEY.get('lamp').id;
const GRASS = BY_KEY.get('grass').id;
const STICK = itemIdOf('stick');
const DRILL = itemIdOf('hand_drill');

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) < eps, `${msg}: ${a} vs ${b}`);

function scene() {
  return { kids: [], add(o) { this.kids.push(o); }, remove(o) { const i = this.kids.indexOf(o); if (i >= 0) this.kids.splice(i, 1); } };
}
const atlas = () => new THREE.Texture();
// half-space floor: everything under y=8 is stone
const halfSpace = { getBlock: (x, y, z) => (y < 8 ? STONE : AIR) };
// one block thick floor at y=8
const thinFloor = { getBlock: (x, y, z) => (y === 8 ? STONE : AIR) };
const empty = { getBlock: () => AIR };
const still = (d, e) => { e.vx = e.vy = e.vz = 0; return e; };
// update() clamps a frame to 0.1s of simulation, so seconds have to be ticked out
const tick = (d, ctx, seconds) => { for (let t = 0; t < seconds - 1e-9; t += 0.1) d.update(0.1, ctx); };

// ---------------------------------------------------------------- rendering
check('block drop builds one shared geometry per block id', () => {
  const s = scene(), d = new DropEntities(s, atlas());
  const a = d.spawn(0.5, 10, 0.5, STONE, 1);
  const b = d.spawn(0.5, 10, 0.5, STONE, 1);
  const c = d.spawn(0.5, 10, 0.5, DIRT, 1);
  assert.equal(a.obj.geometry, b.obj.geometry);
  assert.notEqual(a.obj.geometry, c.obj.geometry);
  assert.equal(d.blockGeom.size, 2);
  assert.equal(a.obj.material, c.obj.material, 'one shared block material');
  const pos = a.obj.geometry.attributes.position.array;
  assert.equal(pos.length, 72);
  assert.equal(a.obj.geometry.index.count, 36);
  for (const v of pos) near(Math.abs(v), 0.16, 1e-6, 'cube half extent');
  const uv = a.obj.geometry.attributes.uv.array;
  for (const v of uv) assert.ok(v >= 0 && v <= 1, 'uv inside atlas');
  d.dispose();
});

/** corner (0/1 per axis) -> [u,v] inside the tile, for one face of one cube. */
function faceMap(geom, normal, corner) {
  const pos = geom.attributes.position.array;
  const nrm = geom.attributes.normal.array;
  const uvs = geom.attributes.uv.array;
  const picked = [];
  for (let v = 0; v * 3 < pos.length; v++) {
    if (nrm[v * 3] !== normal[0] || nrm[v * 3 + 1] !== normal[1] || nrm[v * 3 + 2] !== normal[2]) continue;
    picked.push([corner(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]), [uvs[v * 2], uvs[v * 2 + 1]]]);
  }
  assert.equal(picked.length, 4, `four corners on face ${normal}`);
  // Normalising by the face's own tile origin makes the comparison independent
  // of which tile index either mesh happened to pick.
  const u0 = Math.min(...picked.map((p) => p[1][0]));
  const v0 = Math.min(...picked.map((p) => p[1][1]));
  const du = Math.max(...picked.map((p) => p[1][0])) - u0;
  const dv = Math.max(...picked.map((p) => p[1][1])) - v0;
  assert.ok(du > 0 && dv > 0, 'the face spans a whole tile');
  const out = {};
  for (const [c, [u, v]] of picked) {
    out[c.join('')] = [Math.round((u - u0) / du), Math.round((v - v0) / dv)];
  }
  return out;
}

check('the dropped cube is textured exactly like the world block (vs. the real mesher)', () => {
  const d = new DropEntities(scene(), atlas());
  // one block floating in a padded chunk volume, so the mesher emits all six faces
  const bx = 8, by = 40, bz = 8;
  const pad = new Uint8Array(PX * PZ * WORLD_H);
  pad[pIndex(bx, by, bz)] = GRASS;   // distinct top / side / bottom tiles
  const mesh = meshChunk(pad, {}).opaque;
  const world = new THREE.BufferGeometry();
  world.setAttribute('position', new THREE.BufferAttribute(mesh.pos, 3));
  world.setAttribute('normal', new THREE.BufferAttribute(mesh.norm, 3));
  world.setAttribute('uv', new THREE.BufferAttribute(mesh.uv, 2));

  const drop = d.blockGeometry(GRASS);
  const worldCorner = (x, y, z) => [x - (bx - PAD), y - by, z - (bz - PAD)];
  const dropCorner = (x, y, z) => [Math.round(x / 0.32 + 0.5), Math.round(y / 0.32 + 0.5), Math.round(z / 0.32 + 0.5)];

  for (const n of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    assert.deepEqual(faceMap(drop, n, dropCorner), faceMap(world, n, worldCorner),
      `face ${n} maps corners to tile uv like the mesher does`);
  }
  d.dispose();
});

check('cube faces wind outward, so nothing is inside-out under FrontSide', () => {
  const d = new DropEntities(scene(), atlas());
  const g = d.blockGeometry(STONE);
  const p = g.attributes.position.array, n = g.attributes.normal.array, ix = g.index.array;
  for (let t = 0; t < ix.length; t += 3) {
    const [a, b, c] = [ix[t], ix[t + 1], ix[t + 2]];
    const e1 = [p[b * 3] - p[a * 3], p[b * 3 + 1] - p[a * 3 + 1], p[b * 3 + 2] - p[a * 3 + 2]];
    const e2 = [p[c * 3] - p[a * 3], p[c * 3 + 1] - p[a * 3 + 1], p[c * 3 + 2] - p[a * 3 + 2]];
    const cross = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const dot = cross[0] * n[a * 3] + cross[1] * n[a * 3 + 1] + cross[2] * n[a * 3 + 2];
    assert.ok(dot > 0, `triangle ${t / 3} faces its own normal`);
  }
  assert.ok(g.boundingSphere && g.boundingSphere.radius > 0, 'bounding sphere for frustum culling');
  d.dispose();
});

check('emissive blocks get a brighter vertex colour', () => {
  const d = new DropEntities(scene(), atlas());
  const dark = d.blockGeometry(STONE).attributes.color.array[0];
  const lit = d.blockGeometry(LAMP).attributes.color.array[0];
  assert.ok(lit > dark, `${lit} > ${dark}`);
  assert.ok(lit <= 1.35 + 1e-6, 'clamped like the mesher clamps it');   // float32 storage
  d.dispose();
});

check('glass survives the alpha test used for cutouts', () => {
  const d = new DropEntities(scene(), atlas());
  assert.ok(d.blockMat.alphaTest > 0 && d.blockMat.alphaTest < 0.18, 'alphaTest keeps glass (a=46/255)');
  assert.equal(d.blockMat.map, d.blockMat.map, 'textured from the atlas it was handed');
  d.spawn(0, 10, 0, GLASS, 1);
  d.dispose();
});

check('non-block items render as a camera-facing sprite, one material per item', () => {
  const d = new DropEntities(scene(), atlas());
  const a = d.spawn(0, 10, 0, STICK, 3);
  const b = d.spawn(1, 10, 0, STICK, 3);
  assert.ok(a.obj.isSprite, 'sprite');
  assert.equal(a.obj.material, b.obj.material, 'shared sprite material');
  assert.equal(d.spriteMat.size, 1);
  // itemSprite hands out a fresh canvas per call, so identity proves nothing;
  // the size does - canvas(size) is what sets these, and the spec asks for 64
  const art = itemSprite(STICK, 64);
  assert.equal(a.obj.material.map.image.width, art.width, 'wraps itemSprite(id, 64)');
  assert.equal(a.obj.material.map.image.height, art.height);
  assert.ok(a.obj.material.map.isCanvasTexture, 'a CanvasTexture, not a raw canvas');
  near(a.obj.scale.x, 0.34, 1e-9, 'sprite scale');
  d.dispose();
});

// ------------------------------------------------------------------ physics
check('a drop falls, bounces small, and comes to rest on top of the block', () => {
  const d = new DropEntities(scene(), atlas());
  const e = still(d, d.spawn(4.5, 12, 4.5, STONE, 1));
  for (let i = 0; i < 600; i++) d.update(1 / 60, { gravity: 31, world: halfSpace });
  near(e.y, 8 + 0.16, 1e-6, 'rest height = block top + half cube');
  assert.equal(e.vy, 0);
  assert.ok(e.rest);
  assert.equal(d.count, 1);
});

check('the resting height is the same at 144, 60, 30 and 10 fps', () => {
  for (const fps of [144, 60, 30, 10]) {
    const d = new DropEntities(scene(), atlas());
    const e = still(d, d.spawn(4.5, 12, 4.5, STONE, 1));
    for (let i = 0; i < fps * 12; i++) d.update(1 / fps, { gravity: 79.3, world: halfSpace });
    near(e.y, 8.16, 1e-9, `settled at ${fps} fps`);
    // and it stays put: a frame of jupiter gravity must not walk it anywhere
    const y0 = e.y;
    for (let i = 0; i < fps; i++) { d.update(1 / fps, { gravity: 79.3, world: halfSpace }); near(e.y, y0, 1e-9, 'no creep'); }
  }
});

check('a long fall does not tunnel through a one-block floor', () => {
  const d = new DropEntities(scene(), atlas());
  const e = still(d, d.spawn(4.5, 120, 4.5, STONE, 1));
  for (let i = 0; i < 2000; i++) d.update(1 / 60, { gravity: 31, world: thinFloor });
  near(e.y, 9 + 0.16, 1e-6, 'landed on the slab');
  assert.equal(d.count, 1);
});

check('a big frame step still cannot tunnel', () => {
  const d = new DropEntities(scene(), atlas());
  const e = still(d, d.spawn(4.5, 60, 4.5, STONE, 1));
  for (let i = 0; i < 400; i++) d.update(0.5, { gravity: 31, world: thinFloor });
  near(e.y, 9 + 0.16, 1e-6, 'landed even with dt clamped from 0.5');
});

check('the first bounce is upward and loses energy', () => {
  const d = new DropEntities(scene(), atlas());
  const e = still(d, d.spawn(4.5, 12, 4.5, STONE, 1));
  let sawBounce = false, impact = 0;
  for (let i = 0; i < 200; i++) {
    const before = e.vy;
    d.update(1 / 60, { gravity: 31, world: halfSpace });
    if (before < -2 && e.vy > 0) {
      sawBounce = true;
      impact = -before + 31 / 60;   // gravity is applied before the contact test
      assert.ok(e.vy <= impact * 0.35 + 1e-6, `bounce ${e.vy} <= 0.35 x ${impact}`);
      assert.ok(e.vy > impact * 0.3, 'and it is a real bounce, not a stop');
      break;
    }
  }
  assert.ok(sawBounce, 'observed a bounce');
});

check('a fall from orbit does not launch the drop back into the sky', () => {
  const d = new DropEntities(scene(), atlas());
  const e = still(d, d.spawn(4.5, 120, 4.5, STONE, 1));
  let peak = 0;
  for (let i = 0; i < 400; i++) { d.update(1 / 60, { gravity: 31, world: halfSpace }); peak = Math.max(peak, e.vy); }
  assert.ok(peak <= 6 + 1e-9, `rebound capped at 6 blocks/s, saw ${peak}`);
});

check('a rising drop is stopped by a ceiling', () => {
  const d = new DropEntities(scene(), atlas());
  const ceiling = { getBlock: (x, y, z) => (y === 12 ? STONE : AIR) };
  const e = still(d, d.spawn(4.5, 10, 4.5, STONE, 1));
  e.vy = 20;
  for (let i = 0; i < 10; i++) d.update(1 / 60, { gravity: 0, world: ceiling });
  assert.ok(e.y + 0.16 <= 12, `top ${e.y + 0.16} stays under the block`);
  assert.ok(e.vy < 0, 'bounced back down');
});

check('horizontal motion is blocked by a wall instead of entering it', () => {
  const d = new DropEntities(scene(), atlas());
  const wall = { getBlock: (x, y, z) => (x === 6 ? STONE : AIR) };
  const e = still(d, d.spawn(5.5, 10, 4.5, STONE, 1));
  e.vx = 6;
  for (let i = 0; i < 40; i++) d.update(1 / 60, { gravity: 0, world: wall });
  assert.ok(e.x + 0.16 <= 6.0001, `${e.x} stopped before the wall`);
});

check('drag bleeds horizontal speed off, then snaps to a dead stop', () => {
  const d = new DropEntities(scene(), atlas());
  const e = still(d, d.spawn(4.5, 10, 4.5, STONE, 1));
  e.vx = 4;
  for (let i = 0; i < 10; i++) d.update(0.1, { gravity: 0, world: empty });
  near(e.vx, 4 * Math.exp(-0.8), 1e-6, 'exp drag of 0.8/s');
  const f = still(d, d.spawn(4.5, 10, 4.5, STONE, 1));
  f.vx = 4;
  d.update(1, { gravity: 0, world: empty });
  near(f.vx, 4 * Math.exp(-0.08), 1e-6, 'one frame is clamped to 0.1s of simulation');
  // exponential decay never reaches zero on its own; an idle drop must not go on
  // paying for grid probes for the rest of its 300 seconds
  for (let i = 0; i < 200; i++) d.update(0.1, { gravity: 0, world: empty });
  assert.equal(e.vx, 0, 'settled to exactly zero');
  assert.equal(e.vz, 0);
});

check('a settled drop costs a constant, tiny number of getBlock probes', () => {
  const d = new DropEntities(scene(), atlas());
  let calls = 0;
  const counted = { getBlock: (x, y, z) => { calls++; return y < 8 ? STONE : AIR; } };
  d.spawn(4.5, 8.5, 4.5, STONE, 1);
  for (let i = 0; i < 600; i++) d.update(1 / 60, { gravity: 31, world: counted });
  calls = 0;
  for (let i = 0; i < 60; i++) d.update(1 / 60, { gravity: 31, world: counted });
  assert.ok(calls <= 3 * 60, `one settled drop, one second: ${calls} probes`);
});

check('loot buried by a placed block climbs out', () => {
  const d = new DropEntities(scene(), atlas());
  const solidAll = { getBlock: () => STONE };
  const e = still(d, d.spawn(4.5, 10.5, 4.5, STONE, 1));
  const y0 = e.y;
  for (let i = 0; i < 30; i++) d.update(1 / 60, { gravity: 31, world: solidAll });
  assert.ok(e.y > y0, `${e.y} rose from ${y0}`);
});

check('a drop over an unloaded chunk hangs instead of falling out of the world', () => {
  const d = new DropEntities(scene(), atlas());
  const unloaded = { getBlock: () => AIR, isLoaded: () => false };
  const e = still(d, d.spawn(4.5, 20, 4.5, STONE, 1));
  for (let i = 0; i < 120; i++) d.update(1 / 60, { gravity: 31, world: unloaded });
  assert.equal(e.y, 20);
  assert.equal(d.count, 1);
});

check('a drop that leaves the bottom of the world despawns', () => {
  const d = new DropEntities(scene(), atlas());
  const e = still(d, d.spawn(4.5, 6, 4.5, STONE, 1));
  for (let i = 0; i < 200; i++) d.update(1 / 30, { gravity: 31, world: empty });
  assert.equal(d.count, 0);
});

check('a nonsense gravity does not turn the entity into NaN', () => {
  const d = new DropEntities(scene(), atlas());
  const e = still(d, d.spawn(4.5, 12, 4.5, STONE, 1));
  for (let i = 0; i < 600; i++) d.update(1 / 60, { gravity: NaN, world: halfSpace });
  near(e.y, 8.16, 1e-6, 'fell under the default gravity instead');
  assert.ok(Number.isFinite(e.obj.position.y));
});

check('idle motion: spin and a bob that never sinks below the body', () => {
  const d = new DropEntities(scene(), atlas());
  const e = still(d, d.spawn(4.5, 12, 4.5, STONE, 1));
  const seen = [];
  for (let i = 0; i < 240; i++) {
    d.update(1 / 60, { gravity: 31, world: halfSpace });
    seen.push(e.obj.position.y - e.y);
  }
  assert.ok(Math.min(...seen) >= -1e-9, 'bob never negative');
  assert.ok(Math.max(...seen) > 0.05, 'bob is visible');
  near(e.obj.rotation.y - e.phase, 240 / 60 * 1.2, 1e-6, 'spin 1.2 rad/s');
});

// ------------------------------------------------------------------- pickup
check('no pickup during the 0.35s spawn delay, then it is absorbed', () => {
  const d = new DropEntities(scene(), atlas());
  const seen = [];
  const ctx = {
    gravity: 0, world: empty, playerPos: { x: 4.5, y: 9.1, z: 4.5 },
    pickup: (item, count, dur) => { seen.push([item, count, dur]); return 0; },
  };
  still(d, d.spawn(4.5, 10, 4.5, STONE, 5));
  d.update(0.1, ctx); d.update(0.1, ctx); d.update(0.1, ctx);
  assert.equal(seen.length, 0, 'still invisible at 0.3s');
  d.update(0.1, ctx);
  assert.deepEqual(seen, [[STONE, 5, null]]);
  assert.equal(d.count, 0, 'fully absorbed drops are removed');
});

check('pickup range is measured to the player mid-body', () => {
  const d = new DropEntities(scene(), atlas());
  let calls = 0;
  const ctx = { gravity: 0, world: empty, magnet: false, pickup: () => { calls++; return 0; } };
  // 1.3 above the feet is only 0.4 from the chest -> in range
  still(d, d.spawn(0, 1.3, 0, STONE, 1));
  tick(d, { ...ctx, playerPos: { x: 0, y: 0, z: 0 } }, 0.4);
  assert.equal(calls, 1);
  // 2.4 above the feet is 1.5 from the chest -> out of range
  still(d, d.spawn(0, 2.4, 0, STONE, 1));
  tick(d, { ...ctx, playerPos: { x: 0, y: 0, z: 0 } }, 0.4);
  assert.equal(calls, 1);
  assert.equal(d.count, 1);
});

check('a partial pickup keeps the remainder, a full inventory backs off', () => {
  const d = new DropEntities(scene(), atlas());
  let leave = 3, calls = 0;
  const ctx = {
    gravity: 0, world: empty, magnet: false, playerPos: { x: 0, y: 0, z: 0 },
    pickup: () => { calls++; return leave; },
  };
  const e = still(d, d.spawn(0, 0.9, 0, STONE, 10));
  tick(d, ctx, 0.4);
  assert.equal(e.count, 3, 'remainder kept');
  assert.equal(d.count, 1);
  d.update(0.05, ctx);              // nothing fits now -> cooldown
  assert.equal(calls, 2);
  d.update(0.05, ctx);
  assert.equal(calls, 2, 'no re-ask while cooling down');
  leave = 0;
  tick(d, ctx, 0.5);
  assert.equal(calls, 3);
  assert.equal(d.count, 0);
});

check('a full inventory is asked at a fixed rate, not once per frame', () => {
  const d = new DropEntities(scene(), atlas());
  let calls = 0;
  const ctx = {
    gravity: 0, world: empty, magnet: false, playerPos: { x: 0, y: 0, z: 0 },
    pickup: (item, count) => { calls++; return count; },     // creative mode: takes nothing
  };
  still(d, d.spawn(0, 0.9, 0, STONE, 4));
  for (let i = 0; i < 600; i++) d.update(1 / 60, ctx);       // ten seconds at 60 fps
  assert.ok(calls <= 30, `asked ${calls} times in 10s, not 600`);
  assert.equal(d.count, 1, 'and the drop is still lying there');
});

check('magnet pulls from 2.6 blocks and can be switched off', () => {
  const d = new DropEntities(scene(), atlas());
  const pp = { x: 0, y: 0, z: 0 };
  const e = still(d, d.spawn(2, 0.9, 0, STONE, 1));
  d.update(0.1, { gravity: 0, world: empty, playerPos: pp });
  assert.ok(e.vx < 0, 'accelerates toward the player');
  near(e.vx, -14 * 0.1 * Math.exp(-0.8 * 0.1), 0.02, '14 blocks/s^2');
  const far = still(d, d.spawn(4, 0.9, 0, STONE, 1));
  d.update(0.1, { gravity: 0, world: empty, playerPos: pp });
  assert.equal(far.vx, 0, 'outside 2.6 blocks nothing happens');
  const off = still(d, d.spawn(2, 0.9, 0, STONE, 1));
  d.update(0.1, { gravity: 0, world: empty, playerPos: pp, magnet: false });
  assert.equal(off.vx, 0, 'magnet:false');
});

// ------------------------------------------------------------------ merging
check('same-item drops within 0.6 merge once both are older than 1s', () => {
  const d = new DropEntities(scene(), atlas());
  const a = still(d, d.spawn(0, 5, 0, STONE, 1));
  const b = still(d, d.spawn(0.3, 5, 0, STONE, 1));
  tick(d, { gravity: 0, world: empty }, 0.9);
  assert.equal(d.count, 2, 'too young to merge');
  tick(d, { gravity: 0, world: empty }, 0.5);
  assert.equal(d.count, 1);
  assert.equal(d.list[0], a, 'the older drop survives');
  assert.equal(a.count, 2);
  assert.equal(b.count, 0);
});

check('merging respects maxStack and leaves the overflow behind', () => {
  const d = new DropEntities(scene(), atlas());
  const cap = maxStack(STONE);
  assert.equal(cap, 64);
  const a = still(d, d.spawn(0, 5, 0, STONE, 40));
  const b = still(d, d.spawn(0.2, 5, 0, STONE, 40));
  tick(d, { gravity: 0, world: empty }, 1.5);
  assert.equal(d.count, 2);
  assert.equal(a.count, 64);
  assert.equal(b.count, 16);
});

check('drops further apart than 0.6 stay separate', () => {
  const d = new DropEntities(scene(), atlas());
  still(d, d.spawn(0, 5, 0, STONE, 1));
  still(d, d.spawn(0.8, 5, 0, STONE, 1));
  tick(d, { gravity: 0, world: empty }, 1.5);
  assert.equal(d.count, 2);
});

check('tools never merge - durability is per item', () => {
  const d = new DropEntities(scene(), atlas());
  still(d, d.spawn(0, 5, 0, DRILL, 1, 160));
  still(d, d.spawn(0.1, 5, 0, DRILL, 1, 22));
  tick(d, { gravity: 0, world: empty }, 1.5);
  assert.equal(d.count, 2);
  assert.equal(d.list[0].dur, 160);
  assert.equal(d.list[1].dur, 22);
  // even with the durability stripped, a stack-of-one item cannot pile up
  const e = new DropEntities(scene(), atlas());
  still(e, e.spawn(0, 5, 0, DRILL, 1));
  still(e, e.spawn(0.1, 5, 0, DRILL, 1));
  tick(e, { gravity: 0, world: empty }, 1.5);
  assert.equal(e.count, 2, 'maxStack(tool) is 1');
});

// -------------------------------------------------------------------- limits
check('220 live entities max, oldest first out', () => {
  const s = scene(), d = new DropEntities(s, atlas());
  const first = d.spawn(0, 5, 0, STONE, 1);
  for (let i = 1; i < 230; i++) d.spawn(i * 0.001, 5, 0, STONE, 1);
  assert.equal(d.count, 220);
  assert.ok(!d.list.includes(first), 'the oldest was culled');
  assert.equal(d.group.children.length, 220, 'scene graph matches');
  d.dispose();
});

check('drops despawn after 300 seconds', () => {
  const d = new DropEntities(scene(), atlas());
  const e = still(d, d.spawn(0, 5, 0, STONE, 1));
  e.age = 299.85;
  d.update(0.1, { gravity: 0, world: empty });
  assert.equal(d.count, 1);
  d.update(0.1, { gravity: 0, world: empty });
  assert.equal(d.count, 0);
});

// --------------------------------------------------------------- persistence
check('serialize / restore keeps the loot lying around', () => {
  const s1 = scene(), a = new DropEntities(s1, atlas());
  const e = still(a, a.spawn(12.25, 40.5, -3.75, STONE, 7));
  e.age = 12;
  a.spawn(1, 2, 3, STICK, 4);
  a.spawn(4, 5, 6, DRILL, 1, 91);
  const saved = JSON.parse(JSON.stringify(a.serialize()));
  assert.equal(saved.length, 3);
  assert.deepEqual(saved[0], { x: 12.25, y: 40.5, z: -3.75, item: STONE, count: 7, age: 12 });
  assert.equal(saved[2].dur, 91);
  assert.ok(!('dur' in saved[0]), 'blocks carry no durability');

  const s2 = scene(), b = new DropEntities(s2, atlas());
  b.spawn(0, 0, 0, DIRT, 1);
  b.restore(saved);
  assert.equal(b.count, 3, 'restore replaces whatever was there');
  assert.deepEqual(b.serialize(), saved);
  for (const x of b.list) assert.equal(x.vx + x.vy + x.vz, 0, 'restored loot does not leap');
  b.restore(null);
  assert.equal(b.count, 0, 'a missing save is not a crash');
  a.dispose(); b.dispose();
});

check('an almost-broken tool keeps its last point of durability through a save', () => {
  const d = new DropEntities(scene(), atlas());
  d.spawn(0, 5, 0, DRILL, 1, 1);
  d.spawn(1, 5, 0, DRILL, 1, 0);
  const saved = JSON.parse(JSON.stringify(d.serialize()));
  assert.equal(saved[0].dur, 1);
  assert.equal(saved[1].dur, 0, 'dur 0 is not the same as no dur');
  d.restore(saved);
  assert.equal(d.list[0].dur, 1);
  assert.equal(d.list[1].dur, 0);
  d.dispose();
});

check('a corrupt save costs one drop, never the world load', () => {
  const d = new DropEntities(scene(), atlas());
  const saved = [
    null,
    'nonsense',
    { x: 1, y: 2, z: 3, item: STONE, count: 2 },              // good
    { item: STONE, count: 1 },                                // no position
    { x: NaN, y: 2, z: 3, item: STONE, count: 1 },
    { x: 1, y: 2, z: 3, item: STONE, count: 0 },
    { x: 1, y: 2, z: 3, item: STONE, count: -5 },
    { x: 1, y: 2, z: 3, item: 'stone', count: 1 },            // key, not id
    { x: 1, y: 2, z: 3, item: 9999, count: 1 },               // id from a newer build
    { x: 4, y: 5, z: 6, item: DRILL, count: 1, dur: 12, age: 'soon' },
  ];
  const before = JSON.stringify(saved);
  d.restore(saved, { world: empty });
  assert.equal(d.count, 2, 'exactly the two salvageable entries');
  assert.equal(JSON.stringify(saved), before, 'the caller\'s array is not touched');
  for (const e of d.list) {
    assert.ok(Number.isFinite(e.x) && Number.isFinite(e.y) && Number.isFinite(e.z));
    assert.ok(Number.isFinite(e.age) && e.age >= 0);
  }
  assert.deepEqual(d.serialize()[1], { x: 4, y: 5, z: 6, item: DRILL, count: 1, age: 1, dur: 12 });
  d.dispose();
});

check('restore never exceeds the entity cap', () => {
  const d = new DropEntities(scene(), atlas());
  d.restore(Array.from({ length: 400 }, (_, i) => ({ x: i * 0.01, y: 5, z: 0, item: STONE, count: 1 })));
  assert.equal(d.count, 220);
  d.dispose();
});

// ---------------------------------------------------------------- lifecycle
check('clear empties the scene graph but keeps the shared caches', () => {
  const s = scene(), d = new DropEntities(s, atlas());
  d.spawn(0, 5, 0, STONE, 1);
  d.spawn(0, 5, 0, STICK, 1);
  d.clear();
  assert.equal(d.count, 0);
  assert.equal(d.group.children.length, 0);
  assert.equal(d.blockGeom.size, 1);
  d.dispose();
});

check('dispose releases everything it owns and nothing it borrows', () => {
  const s = scene(), tex = atlas();
  let atlasDisposed = 0;
  tex.addEventListener('dispose', () => atlasDisposed++);
  const d = new DropEntities(s, tex);
  d.spawn(0, 5, 0, STONE, 1);
  d.spawn(0, 5, 0, DIRT, 1);
  d.spawn(0, 5, 0, STICK, 1);
  const geos = [...d.blockGeom.values()];
  const mats = [...d.spriteMat.values()];
  let disposed = 0;
  for (const g of geos) g.addEventListener('dispose', () => disposed++);
  for (const m of mats) { m.addEventListener('dispose', () => disposed++); m.map.addEventListener('dispose', () => disposed++); }
  d.blockMat.addEventListener('dispose', () => disposed++);
  d.dispose();
  assert.equal(disposed, 2 + 1 + 1 + 1, 'two geometries, sprite material, canvas texture, block material');
  assert.equal(atlasDisposed, 0, 'the world atlas is borrowed, never disposed');
  assert.equal(s.kids.length, 0, 'group removed from the scene');
});

check('rubbish input is ignored rather than fatal', () => {
  const d = new DropEntities(scene(), atlas());
  assert.equal(d.spawn(0, 5, 0, 0, 1), null);
  assert.equal(d.spawn(0, 5, 0, STONE, 0), null);
  assert.equal(d.spawn(0, 5, 0, STONE, -3), null);
  assert.equal(d.spawn(NaN, 5, 0, STONE, 1), null, 'a NaN position would poison the matrix');
  assert.equal(d.spawn(0, 5, 0, 'stone', 1), null);
  assert.equal(d.spawn(0, 5, 0, STONE, NaN), null);
  assert.equal(d.spawn(0, 5, 0, 9999, 1), null, 'an item id this build does not have');
  d.update(0.016, {});                       // no world, no player, no pickup
  d.update(0, { gravity: 31, world: empty });
  d.update(NaN, { gravity: 31, world: empty });
  assert.equal(d.count, 0);
  d.dispose();
});

check('every block in the registry can be dropped', () => {
  const d = new DropEntities(scene(), atlas());
  for (const b of BLOCKS) {
    if (b.id === AIR) continue;
    const e = d.spawn(0.5, 5, 0.5, b.id, 1);
    assert.ok(e, `spawned ${b.key}`);
    assert.ok(e.obj.geometry.attributes.uv.array.every(Number.isFinite), `${b.key} uv`);
  }
  d.update(1 / 60, { gravity: 31, world: halfSpace });
  d.dispose();
});

console.log(`\n${pass} checks passed`);
