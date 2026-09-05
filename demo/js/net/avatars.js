// Remote player avatars: a blocky body, a name, and interpolated movement for
// everyone else in `session.players`. Written in the register of drops.js -
// shared geometry, per-player group, nothing allocated per frame.
//
// `sampleAt` and `advanceGait` are the pure half (no THREE, no DOM) and get a
// node test; `RemoteAvatars` is the THREE half that positions a rig from them
// every render frame. Nothing here decides *whether* someone is a remote
// player - that is session.players, built and maintained by session.js.

import * as THREE from '../../vendor/three.module.js';
import { F, SNAP_DIST, INTERP_DELAY_MS } from './protocol.js';

// --------------------------------------------------------------- pure half

/** atan2(sin(b-a), cos(b-a)) - the short way around the circle, in radians. */
function shortAngle(delta) {
  return Math.atan2(Math.sin(delta), Math.cos(delta));
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * `buf` is the 8-sample ring session.js appends to, oldest first, each entry
 * `{t, x, y, z, yaw, pitch, f}` stamped with *local arrival time* - there is no
 * clock-offset estimation, because LAN jitter is under 2 ms and the stream is
 * what matters, not absolute time. Render at `t = now - INTERP_DELAY_MS`.
 *
 * Past the newest sample this holds rather than extrapolating: a frozen
 * friend reads better than one sliding into a wall. Bracketing samples more
 * than SNAP_DIST apart hard-snap to the newer one, because that gap is a
 * respawn or a teleport, not motion a body should be dragged through terrain
 * to catch up with.
 *
 * `out`, if given, is written in place and returned instead of allocating a
 * fresh object - RemoteAvatars.update() runs this once per avatar every
 * render frame, and a reused scratch object is what keeps that path
 * allocation-free (the same pattern drops.js's update() uses its shared
 * `_env`  for). Omit `out` for the pure, plain-return use the tests exercise.
 *
 * @returns {object|null} a sample-shaped object, or null with an empty buffer
 */
export function sampleAt(buf, t, out) {
  if (!buf || buf.length === 0) return null;
  const first = buf[0];
  if (buf.length === 1 || t <= first.t) return copySample(first, out);
  const last = buf[buf.length - 1];
  if (t >= last.t) return copySample(last, out);   // hold: never extrapolate past what we know

  for (let i = 0; i < buf.length - 1; i++) {
    const a = buf[i], b = buf[i + 1];
    if (t < a.t || t > b.t) continue;
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    if (dx * dx + dy * dy + dz * dz > SNAP_DIST * SNAP_DIST) return copySample(b, out);
    const span = b.t - a.t;
    const frac = span > 0 ? (t - a.t) / span : 1;
    const dst = out ?? {};
    dst.t = t;
    dst.x = a.x + dx * frac; dst.y = a.y + dy * frac; dst.z = a.z + dz * frac;
    dst.yaw = a.yaw + shortAngle(b.yaw - a.yaw) * frac;
    dst.pitch = a.pitch + (b.pitch - a.pitch) * frac;
    dst.f = frac < 0.5 ? a.f : b.f;
    return dst;
  }
  return copySample(last, out);
}

/** Copy a ring sample's fields into `out`, or allocate a fresh plain object if `out` is omitted. */
function copySample(sample, out) {
  if (!out) return { ...sample };
  out.t = sample.t; out.x = sample.x; out.y = sample.y; out.z = sample.z;
  out.yaw = sample.yaw; out.pitch = sample.pitch; out.f = sample.f;
  return out;
}

const GAIT_STEP = 1.9;    // rad of phase per metre walked
const GAIT_DAMP = 6;      // 1/s decay toward standing still

/** phase += horizontalDistance * 1.9; damps toward 0 when the stream shows no motion. */
export function advanceGait(phase, dist, dt) {
  if (dist > 1e-4) return phase + dist * GAIT_STEP;
  const damped = phase * Math.exp(-GAIT_DAMP * Math.max(0, dt));
  return Math.abs(damped) < 1e-3 ? 0 : damped;
}

// --------------------------------------------------------------- THREE half

const NAME_CAP = 16;
const FADE_START = 48, FADE_END = 64;   // metres from the camera

let sharedGeo = null;
function rigGeometry() {
  if (sharedGeo) return sharedGeo;
  sharedGeo = {
    head: new THREE.BoxGeometry(0.5, 0.5, 0.5),
    visor: new THREE.BoxGeometry(0.42, 0.16, 0.05),
    torso: new THREE.BoxGeometry(0.55, 0.7, 0.3),
    arm: new THREE.BoxGeometry(0.22, 0.68, 0.22),
    leg: new THREE.BoxGeometry(0.24, 0.8, 0.24),
  };
  return sharedGeo;
}

function buildRig(color) {
  const geo = rigGeometry();
  const skin = new THREE.MeshLambertMaterial({ color });
  const visorMat = new THREE.MeshLambertMaterial({ color: 0x14161c });

  const group = new THREE.Group();
  const torso = new THREE.Mesh(geo.torso, skin);
  torso.position.y = 0.9;
  group.add(torso);

  const head = new THREE.Mesh(geo.head, skin);
  head.position.y = 1.5;
  group.add(head);

  const visor = new THREE.Mesh(geo.visor, visorMat);
  visor.position.set(0, 0.03, -0.255);
  head.add(visor);

  const armL = new THREE.Mesh(geo.arm, skin); armL.position.set(0.38, 0.92, 0);
  const armR = new THREE.Mesh(geo.arm, skin); armR.position.set(-0.38, 0.92, 0);
  const legL = new THREE.Mesh(geo.leg, skin); legL.position.set(0.15, 0.4, 0);
  const legR = new THREE.Mesh(geo.leg, skin); legR.position.set(-0.15, 0.4, 0);
  // Boxes pivot at their own centre, so a limb has to be re-parented under a
  // pivot group placed at its joint before rotation.x reads as a swing at the
  // hip/shoulder instead of a spin about the limb's own midpoint.
  const hinge = (mesh, jointY) => {
    const pivot = new THREE.Group();
    pivot.position.y = jointY;
    mesh.position.y -= jointY;
    pivot.add(mesh);
    group.add(pivot);
    return pivot;
  };
  const pArmL = hinge(armL, 1.26);
  const pArmR = hinge(armR, 1.26);
  const pLegL = hinge(legL, 0.8);
  const pLegR = hinge(legR, 0.8);

  return { group, head, torso, armL: pArmL, armR: pArmR, legL: pLegL, legR: pLegR, skin, visorMat };
}

function buildNameplate() {
  const canvas = document.createElement('canvas');
  canvas.width = 160; canvas.height = 40;
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  const material = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(1.6, 0.4, 1);
  sprite.renderOrder = 20;
  return { canvas, ctx, texture, sprite, material, name: null };
}

/** Text only ever reaches the canvas through fillText - peer names are attacker-controlled. */
function paintNameplate(np, name) {
  const { ctx, canvas } = np;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(10,10,14,0.6)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#f4f4f0';
  ctx.font = 'bold 22px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(name, canvas.width / 2, canvas.height / 2);
  np.texture.needsUpdate = true;
  np.name = name;
}

export class RemoteAvatars {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    /** @type {Map<number, object>} id -> avatar record */
    this._avatars = new Map();
  }

  /** Create/destroy rigs to match session.players. Cheap: only runs on join/leave. */
  sync(players) {
    for (const id of [...this._avatars.keys()]) {
      if (!players.has(id)) this._destroy(id);
    }
    for (const [id, rec] of players) {
      if (this._avatars.has(id)) continue;
      const color = new THREE.Color().setHSL((id * 0.61803398875) % 1, 0.55, 0.55);
      const rig = buildRig(color);
      const nameplate = buildNameplate();
      this.group.add(rig.group);
      this.group.add(nameplate.sprite);
      // `sample` is a scratch object reused by sampleAt() every frame below -
      // allocated once here, at join time, not on the render path.
      const sample = { t: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, f: 0 };
      this._avatars.set(id, { rig, nameplate, phase: 0, lastX: null, lastZ: null, name: rec.name, sample });
    }
  }

  _destroy(id) {
    const av = this._avatars.get(id);
    if (!av) return;
    this.group.remove(av.rig.group);
    this.group.remove(av.nameplate.sprite);
    av.rig.skin.dispose();
    av.rig.visorMat.dispose();
    av.nameplate.material.dispose();
    av.nameplate.texture.dispose();
    this._avatars.delete(id);
  }

  /** Render-rate update: interpolate, advance gait, pose the rig, paint the nameplate. */
  update(dt, now, players, cameraPos) {
    const renderAt = now - INTERP_DELAY_MS;
    for (const [id, av] of this._avatars) {
      const rec = players.get(id);
      if (!rec) continue;   // sync() will drop it next call
      const s = sampleAt(rec.buf, renderAt, av.sample);
      if (!s) continue;

      const dist = av.lastX == null ? 0 : Math.hypot(s.x - av.lastX, s.z - av.lastZ);
      av.lastX = s.x; av.lastZ = s.z;

      const f = s.f ?? 0;
      const dead = !!(f & F.DEAD);
      const flying = !!(f & F.FLYING);
      const sneaking = !!(f & F.SNEAK);
      av.phase = dead ? 0 : advanceGait(av.phase, dist, dt);

      const g = av.rig.group;
      g.position.set(s.x, s.y - (sneaking && !dead ? 0.18 : 0), s.z);
      g.rotation.set(dead ? Math.PI / 2 : 0, s.yaw, 0);
      av.rig.head.rotation.x = clamp(s.pitch, -1.2, 1.2);
      av.rig.torso.rotation.x = sneaking && !dead ? 0.25 : 0;

      if (flying) {
        av.rig.legL.rotation.x = 0; av.rig.legR.rotation.x = 0;
        av.rig.armL.rotation.x = -0.9; av.rig.armR.rotation.x = -0.9;
      } else {
        const swing = Math.sin(av.phase) * 0.7;
        av.rig.legL.rotation.x = swing; av.rig.legR.rotation.x = -swing;
        av.rig.armL.rotation.x = -swing * (0.55 / 0.7); av.rig.armR.rotation.x = swing * (0.55 / 0.7);
      }

      if (av.nameplate.name !== rec.name) paintNameplate(av.nameplate, (rec.name || '').slice(0, NAME_CAP));
      av.nameplate.sprite.position.set(s.x, s.y + 2.05, s.z);
      const camDist = cameraPos ? g.position.distanceTo(cameraPos) : 0;
      const fade = 1 - clamp((camDist - FADE_START) / (FADE_END - FADE_START), 0, 1);
      av.nameplate.material.opacity = fade;
      av.nameplate.sprite.visible = fade > 0.01;
    }
  }

  dispose() {
    for (const id of [...this._avatars.keys()]) this._destroy(id);
    this.scene.remove(this.group);
  }
}
