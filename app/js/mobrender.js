// Original procedural Lunacrust fauna. Instanced parts share eight geometries:
// the six-legged Flux Skitter and the mineral tripod Basalt Resonator.
// Read-only render consumer; legacy kind IDs remain stable in mobtypes.js.

import * as THREE from '../vendor/three.module.js';
import { buildMobAtlas, mobTileUV, TILE_INDEX, FLASH_BOOST, mobPalette } from './mobart.js';

import { MOB, MOB_TYPES } from './mobtypes.js';
const CRAWLER = MOB.CRAWLER, WARDEN = MOB.WARDEN;
const MAX_CRAWLER = MOB_TYPES[CRAWLER].cap;
const MAX_WARDEN = MOB_TYPES[WARDEN].cap;
const CULL_DIST = 64;                 // spec §0 "matrix-compose cull"
const CULL_DIST_SQ = CULL_DIST * CULL_DIST;

const HURT_FLASH_TIME = 0.18;         // spec §8 "hurtT counts down 0.18s"
const DEATH_TIME = 0.25;              // spec §8 "scale to zero over 0.25s"
const FUSE_TIME = MOB_TYPES[CRAWLER].fuse.time;                // spec §2 mobtypes.js: crawler fuse.time
const FUSE_SCALE_MAX = 1.32;          // spec §8 "uniform scale 1.0 -> 1.32"
const WARDEN_RAISE = MOB_TYPES[WARDEN].attack.windup;            // spec §4.5/§8: 0.45s raising the arms
const WARDEN_SWING = MOB_TYPES[WARDEN].attack.swing;            // ...then forward in 0.12s
const WARDEN_ARM_ANGLE = 2.1;         // spec §8 "arms to -2.1 rad"

const LEG_SWING_AMP = 0.55;
const WARDEN_LEG_AMP = 0.32;

const UP = new THREE.Vector3(0, 1, 0);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Shortest-path angle lerp, so a mob turning through +-pi does not spin the long way. */
function lerpAngle(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

// ---------------------------------------------------------- box geometry

const FACES = [
  { n: [1, 0, 0], v: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]] },
  { n: [-1, 0, 0], v: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] },
  { n: [0, 1, 0], v: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },
  { n: [0, -1, 0], v: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  { n: [0, 0, 1], v: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
  { n: [0, 0, -1], v: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]] },   // index 5: local -Z, "front" (yaw 0 looks down -Z, matching player.js)
];
const UV_CORNER = [[0, 0], [1, 0], [1, 1], [0, 1]];
// Same per-face brightness ramp mesher.js and drops.js already use, in the
// same +X -X +Y -Y +Z -Z order, so a mob is lit like the blocks around it.
const FACE_SHADE = [0.72, 0.72, 1.0, 0.46, 0.86, 0.86];
const FRONT_FACE = 5;

/**
 * A w x h x d box, pivoted at its own top (y=0 down to y=-h) so rotating the
 * geometry about its own origin swings it like a real hanging limb - used
 * directly for legs and arms. boxGeometryCentered() below re-pivots the same
 * shape to its centre for parts that never swing (head, body, torso).
 * The front (-Z) face samples `frontTile`; the other five sample `tile`.
 */
function boxGeometry(w, h, d, tile, frontTile = tile) {
  const y0 = -h, y1 = 0;
  const pos = new Float32Array(24 * 3);
  const norm = new Float32Array(24 * 3);
  const uv = new Float32Array(24 * 2);
  const col = new Float32Array(24 * 3);
  const idx = new Uint16Array(36);
  let v = 0, i = 0;

  for (let f = 0; f < 6; f++) {
    const face = FACES[f];
    const rect = mobTileUV(f === FRONT_FACE ? frontTile : tile);
    const lum = FACE_SHADE[f];
    const base = v;
    for (let c = 0; c < 4; c++) {
      const p = face.v[c];
      const o3 = v * 3, o2 = v * 2;
      pos[o3] = (p[0] - 0.5) * w;
      pos[o3 + 1] = y0 + p[1] * (y1 - y0);
      pos[o3 + 2] = (p[2] - 0.5) * d;
      norm[o3] = face.n[0]; norm[o3 + 1] = face.n[1]; norm[o3 + 2] = face.n[2];
      col[o3] = col[o3 + 1] = col[o3 + 2] = lum;
      const uvp = UV_CORNER[c];
      uv[o2] = rect[0] + uvp[0] * rect[2];
      uv[o2 + 1] = rect[1] + uvp[1] * rect[3];
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
  return g;
}
/** Same box, re-pivoted to its own centre - for parts that only ever yaw. */
function boxGeometryCentered(w, h, d, tile, frontTile = tile) {
  const g = boxGeometry(w, h, d, tile, frontTile);
  g.translate(0, h / 2, 0);
  return g;
}

function crystalGeometry(w, h, d, tile) {
  const g = new THREE.OctahedronGeometry(1, 0);
  g.scale(w / 2, h / 2, d / 2);
  const uv = g.getAttribute('uv');
  const rect = mobTileUV(tile);
  for (let i = 0; i < uv.count; i++) uv.setXY(i, rect[0] + clamp01(uv.getX(i)) * rect[2], clamp01(uv.getY(i)));
  const normals = g.getAttribute('normal');
  const colors = new Float32Array(normals.count * 3);
  for (let i = 0; i < normals.count; i++) {
    const shade = .72 + normals.getY(i) * .22;
    colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = shade;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.computeBoundingSphere();
  return g;
}

const T = TILE_INDEX;
const CRAWLER_HIP = .57;
const CRAWLER_LAYOUT = {
  head: { offset: [0, .84, -.34] },
  body: { offset: [0, .82, .02] },
  legSlots: [
    { offset: [.22, CRAWLER_HIP, -.24], phase: 0, roll: .4 },
    { offset: [-.22, CRAWLER_HIP, -.24], phase: Math.PI, roll: -.4 },
    { offset: [.22, CRAWLER_HIP, 0], phase: Math.PI, roll: .4 },
    { offset: [-.22, CRAWLER_HIP, 0], phase: 0, roll: -.4 },
    { offset: [.22, CRAWLER_HIP, .24], phase: 0, roll: .4 },
    { offset: [-.22, CRAWLER_HIP, .24], phase: Math.PI, roll: -.4 },
  ],
};
const WARDEN_HIP = .81;
const WARDEN_LAYOUT = {
  crownSlots: [[-.22, 2.10, 0], [.22, 2.10, 0], [0, 2.22, .12]],
  torso: { offset: [0, 1.28, 0] },
  core: { offset: [0, 1.40, -.30] },
  armSlots: [
    { offset: [.45, 1.52, -.14], roll: .22 },
    { offset: [-.45, 1.52, -.14], roll: -.22 },
    { offset: [0, 1.52, .43], roll: 0 },
  ],
  legSlots: [
    { offset: [.33, WARDEN_HIP, -.16], phase: 0, roll: .12 },
    { offset: [-.33, WARDEN_HIP, -.16], phase: Math.PI * 2 / 3, roll: -.12 },
    { offset: [0, WARDEN_HIP, .30], phase: Math.PI * 4 / 3, roll: 0 },
  ],
};

const MESH_DEFS = [
  { name: 'crawlerHead', max: MAX_CRAWLER, mat: 'crawler', geom: () => boxGeometryCentered(.5, .2, .18, T.get('crawler_skin'), T.get('crawler_face')) },
  { name: 'crawlerBody', max: MAX_CRAWLER, mat: 'crawler', geom: () => crystalGeometry(.76, .88, .78, T.get('crawler_fuse')) },
  { name: 'crawlerLeg', max: MAX_CRAWLER * 6, mat: 'crawler', geom: () => boxGeometry(.10, .53, .10, T.get('crawler_leg')) },
  { name: 'wardenHead', max: MAX_WARDEN * 3, mat: 'warden', geom: () => crystalGeometry(.22, .58, .22, T.get('warden_face')) },
  { name: 'wardenTorso', max: MAX_WARDEN, mat: 'warden', geom: () => crystalGeometry(.94, 1.48, .88, T.get('warden_core')) },
  { name: 'wardenArm', max: MAX_WARDEN * 3, mat: 'warden', geom: () => boxGeometry(.17, .72, .24, T.get('warden_body')) },
  { name: 'wardenGlow', max: MAX_WARDEN, mat: 'glow', geom: () => crystalGeometry(.32, .48, .30, T.get('warden_core')) },
  { name: 'wardenLeg', max: MAX_WARDEN * 3, mat: 'warden', geom: () => boxGeometry(.20, WARDEN_HIP, .22, T.get('warden_limb')) },
];

export class MobRender {
  /**
   * @param {THREE.Object3D} scene
   * @param {object} planet - same planet record World/Sky/Weather already take
   */
  constructor(scene, planet) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false;
    scene.add(this.group);

    const { data, width, height } = buildMobAtlas(planet);
    const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    this.atlasTexture = tex;

    this.crawlerMat = new THREE.MeshLambertMaterial({ map: tex, vertexColors: true, side: THREE.FrontSide, emissive: 0x172139, emissiveIntensity: .3 });
    this.wardenMat = new THREE.MeshLambertMaterial({ map: tex, vertexColors: true, side: THREE.FrontSide, emissive: 0x172139, emissiveIntensity: .3 });

    const accent = mobPalette(planet).accent;
    this.glowMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(...accent).lerp(new THREE.Color(0xffffff), .4) });
    this.meshes = {};
    this.geoms = [];
    for (const def of MESH_DEFS) {
      const geom = def.geom();
      this.geoms.push(geom);
      const mat = def.mat === 'glow' ? this.glowMat : def.mat === 'crawler' ? this.crawlerMat : this.wardenMat;
      const mesh = new THREE.InstancedMesh(geom, mat, def.max);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(def.max * 3).fill(1), 3);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = false;   // an InstancedMesh's own bounding sphere is meaningless here; we cull per-mob instead
      this.group.add(mesh);
      this.meshes[def.name] = mesh;
    }
    // A plain array to iterate every frame - Object.values() would allocate.
    this._meshList = MESH_DEFS.map((def) => this.meshes[def.name]);

    // Module-scope-equivalent scratch: one instance per renderer, reused every
    // write this frame and every frame after. Nothing below ever allocates.
    this._pos = new THREE.Vector3();
    this._offset = new THREE.Vector3();
    this._worldPos = new THREE.Vector3();
    this._yawQuat = new THREE.Quaternion();
    this._partQuat = new THREE.Quaternion();
    this._euler = new THREE.Euler();
    this._quat = new THREE.Quaternion();
    this._scale = new THREE.Vector3(1, 1, 1);
    this._mat = new THREE.Matrix4();
    this._color = new THREE.Color();

    // Per-frame cursor state for _visitMob, read/written as instance fields
    // rather than closured locals. _visitMob itself is bound exactly once,
    // here, so update() never allocates a new callback on the hot path - see
    // _visitMob's own comment.
    this._alpha = 1;
    this._camX = 0; this._camY = 0; this._camZ = 0;
    this._nc = 0; this._nw = 0;
    this._visitMob = this._visitMob.bind(this);
  }

  /**
   * @param {{forEachLive:(fn:(mob:object)=>void)=>void, alpha:number}} mobs
   * @param {number} dt - unused today (kept so a future per-part idle jitter
   *   does not need a signature change), present because every other
   *   .update(dt, ...) in this codebase takes it.
   * @param {THREE.Vector3} cameraPos
   */
  update(mobs, dt, cameraPos) {
    for (let k = 0; k < this._meshList.length; k++) this._meshList[k].count = 0;
    if (!mobs) return;

    // Stash this frame's inputs on `this` instead of closing over them, so
    // the mobs.forEachLive(fn) callback below can be the same bound function
    // every frame - a fresh arrow function here would allocate on every one
    // of up to 120 calls/second, which is exactly the render-path allocation
    // the budget in spec §11 is zero for.
    this._alpha = clamp01(mobs.alpha ?? 1);
    this._camX = cameraPos.x; this._camY = cameraPos.y; this._camZ = cameraPos.z;
    this._nc = 0; this._nw = 0;

    mobs.forEachLive(this._visitMob);

    this.meshes.crawlerHead.count = this._nc;
    this.meshes.crawlerBody.count = this._nc;
    this.meshes.crawlerLeg.count = this._nc * 6;
    this.meshes.wardenHead.count = this._nw * 3;
    this.meshes.wardenTorso.count = this._nw;
    this.meshes.wardenGlow.count = this._nw;
    this.meshes.wardenArm.count = this._nw * 3;
    this.meshes.wardenLeg.count = this._nw * 3;
    for (let k = 0; k < this._meshList.length; k++) {
      const mesh = this._meshList[k];
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  /** One live mob, called through mobs.forEachLive - see the note in update(). */
  _visitMob(m) {
    if (m.kind === CRAWLER && this._nc >= MAX_CRAWLER) return;
    if (m.kind === WARDEN && this._nw >= MAX_WARDEN) return;
    if (m.kind !== CRAWLER && m.kind !== WARDEN) return;

    const dx = m.pos.x - this._camX, dy = m.pos.y - this._camY, dz = m.pos.z - this._camZ;
    if (dx * dx + dy * dy + dz * dz > CULL_DIST_SQ) return;

    const deathT = m.deathT ?? 0;
    const deathScale = m.alive === false ? Math.max(0, 1 - deathT / DEATH_TIME) : 1;
    if (deathScale <= 0) return;

    const alpha = this._alpha;
    const ix = m.prev.x + (m.pos.x - m.prev.x) * alpha;
    const iy = m.prev.y + (m.pos.y - m.prev.y) * alpha;
    const iz = m.prev.z + (m.pos.z - m.prev.z) * alpha;
    const yaw = lerpAngle(m.prevYaw ?? m.yaw, m.yaw ?? 0, alpha);
    this._pos.set(ix, iy, iz);
    this._yawQuat.setFromAxisAngle(UP, yaw);

    const hurtT = Math.max(0, m.hurtT ?? 0);
    const flashDamage = clamp01(hurtT / HURT_FLASH_TIME);

    if (m.kind === CRAWLER) {
      const fuse = Math.max(0, m.fuse ?? 0);
      const fuseGlow = fuse > 0 ? .35 + .65 * (Math.sin(fuse * fuse * 34) * .5 + .5) : 0;
      const fuseScale = 1 + (FUSE_SCALE_MAX - 1) * Math.min(1, fuse / FUSE_TIME);
      const glow = Math.max(flashDamage, fuseGlow);
      const boost = 1 + glow * (FLASH_BOOST - 1);
      const scale = fuseScale * deathScale;

      const nc = this._nc;
      this._writeRigid(this.meshes.crawlerHead, nc, CRAWLER_LAYOUT.head.offset, scale, boost);
      this._writeRigid(this.meshes.crawlerBody, nc, CRAWLER_LAYOUT.body.offset, scale, boost);
      const gait = m.gait ?? 0;
      const slots = CRAWLER_LAYOUT.legSlots;
      for (let k = 0; k < slots.length; k++) {
        const swing = Math.sin(gait + slots[k].phase) * LEG_SWING_AMP;
        this._writeLimb(this.meshes.crawlerLeg, nc * 6 + k, slots[k].offset, swing, scale, boost, slots[k].roll);
      }
      this._nc = nc + 1;
    } else {
      const boost = 1 + flashDamage * (FLASH_BOOST - 1);
      const scale = deathScale;

      const nw = this._nw;
      for (let k = 0; k < 3; k++) {
        this._writeRigid(this.meshes.wardenHead, nw * 3 + k, WARDEN_LAYOUT.crownSlots[k], scale, boost);
      }
      this._writeRigid(this.meshes.wardenTorso, nw, WARDEN_LAYOUT.torso.offset, scale, boost);
      this._writeRigid(this.meshes.wardenGlow, nw, WARDEN_LAYOUT.core.offset, scale, boost);

      // Windup is read as elapsed seconds since the swing began: 0..0.45
      // raises the arms, 0.45..0.57 swings them through. See the report for
      // why this mapping (rather than the field's exact semantics) is the
      // one unverified assumption in this file.
      const w = Math.max(0, m.windup ?? 0);
      let armAngle = 0;
      if (w > 0) {
        armAngle = w <= WARDEN_RAISE
          ? -WARDEN_ARM_ANGLE * (w / WARDEN_RAISE)
          : -WARDEN_ARM_ANGLE * Math.max(0, 1 - (w - WARDEN_RAISE) / WARDEN_SWING);
      }
      const armSlots = WARDEN_LAYOUT.armSlots;
      for (let k = 0; k < 3; k++) {
        this._writeLimb(this.meshes.wardenArm, nw * 3 + k, armSlots[k].offset, armAngle, scale, boost, armSlots[k].roll);
      }
      const gait = m.gait ?? 0;
      const legSlots = WARDEN_LAYOUT.legSlots;
      for (let k = 0; k < 3; k++) {
        const swing = Math.sin(gait + legSlots[k].phase) * WARDEN_LEG_AMP;
        this._writeLimb(this.meshes.wardenLeg, nw * 3 + k, legSlots[k].offset, swing, scale, boost, legSlots[k].roll);
      }
      this._nw = nw + 1;
    }
  }

  /** A part with no swing of its own (head, body, torso): yaw only. */
  _writeRigid(mesh, i, offset, scale, boost) {
    this._offset.set(offset[0], offset[1], offset[2]).applyQuaternion(this._yawQuat).multiplyScalar(scale);
    this._worldPos.copy(this._pos).add(this._offset);
    this._mat.compose(this._worldPos, this._yawQuat, this._scale.setScalar(scale));
    mesh.setMatrixAt(i, this._mat);
    this._color.setScalar(boost);
    mesh.setColorAt(i, this._color);
  }

  /** A hanging part (leg, arm): swings about its own pivot in local X, then yaws with the mob. */
  _writeLimb(mesh, i, offset, swingRad, scale, boost, roll = 0) {
    this._offset.set(offset[0], offset[1], offset[2]).applyQuaternion(this._yawQuat).multiplyScalar(scale);
    this._worldPos.copy(this._pos).add(this._offset);
    this._partQuat.setFromEuler(this._euler.set(swingRad, 0, roll));
    this._quat.copy(this._yawQuat).multiply(this._partQuat);
    this._mat.compose(this._worldPos, this._quat, this._scale.setScalar(scale));
    mesh.setMatrixAt(i, this._mat);
    this._color.setScalar(boost);
    mesh.setColorAt(i, this._color);
  }

  dispose() {
    this.group.parent?.remove(this.group);
    // InstancedMesh owns instanceMatrix/instanceColor itself (they are not
    // geometry attributes), so geometry.dispose() alone leaves the renderer's
    // WebGLAttributes cache holding two GPU buffers per mesh. Every planet
    // re-enter constructs a fresh MobRender (spec §9), so skipping this leaks
    // 7 buffers per visit.
    for (const mesh of this._meshList) mesh.dispose();
    for (const g of this.geoms) g.dispose();
    this.crawlerMat.dispose();
    this.wardenMat.dispose();
    this.glowMat.dispose();
    this.atlasTexture.dispose();
    this.meshes = {};
    this.geoms = [];
    this._meshList = [];
  }
}
