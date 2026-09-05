// World: owns the loaded chunk mirror, talks to the worker, turns mesh payloads
// into THREE meshes, and answers block queries for physics and ray-picking.

import * as THREE from '../vendor/three.module.js';
import { buildAtlas } from './textures.js';
import { CHUNK_SX, CHUNK_SZ, WORLD_H, vIndex, WorldGen } from './worldgen.js';
import { AIR } from './blocks.js';
import { EditLog } from './editlog.js';

export const chunkKey = (cx, cz) => cx + ',' + cz;

let sharedAtlas = null;
function atlasTexture() {
  if (sharedAtlas) return sharedAtlas;
  const { data, width, height } = buildAtlas();
  const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  tex.magFilter = THREE.NearestFilter;   // crisp pixels up close
  tex.minFilter = THREE.LinearFilter;    // no mipmaps: they bleed across atlas tiles
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  sharedAtlas = tex;
  return tex;
}

export class World {
  constructor(scene, planet, seed) {
    this.scene = scene;
    this.planet = planet;
    this.seed = seed;
    this.gen = new WorldGen(planet, seed);
    this.chunks = new Map();          // key -> { voxels, opaque, transparent, ready }
    // The log owns the running digest two machines compare over the network;
    // `edits` stays readable as the same nested map every caller already walks.
    this._log = new EditLog();
    this.pending = new Set();
    this.renderDistance = 7;
    this.stats = { chunks: 0, tris: 0 };

    const map = atlasTexture();
    this.matOpaque = new THREE.MeshLambertMaterial({
      map, vertexColors: true, alphaTest: 0.5, side: THREE.FrontSide,
    });
    this.matTransparent = new THREE.MeshLambertMaterial({
      map, vertexColors: true, transparent: true, opacity: 0.86,
      side: THREE.DoubleSide, depthWrite: false,
    });

    this.group = new THREE.Group();
    scene.add(this.group);

    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this.onWorkerMessage(e.data);
  }

  /** Kick off the worker. Call after loadEdits() so saved builds survive. */
  start() {
    const tint = new THREE.Color(this.planet.sky.fog).lerp(new THREE.Color(0xffffff), 0.72);
    this.worker.postMessage({
      type: 'init', planet: this.planet, seed: this.seed,
      tint: [tint.r, tint.g, tint.b],
      skyFade: this.planet.terrain.mode === 'floating' ? 0.02 : 0.032,
      edits: this.serializeEdits(),
    });
  }

  /** "cx,cz" -> Map(voxelIndex -> blockId), the shape callers already iterate. */
  get edits() { return this._log.map; }

  /** Order-independent hash of every edit, for spotting a diverged peer. */
  editDigest() { return this._log.digest; }

  /** The shared block atlas, so dropped items can be textured from it too. */
  get atlas() { return this.matOpaque.map; }

  // ------------------------------------------------------------ block access
  getBlock(x, y, z) {
    if (y < 0 || y >= WORLD_H) return AIR;
    const cx = x >> 4, cz = z >> 4;
    const c = this.chunks.get(chunkKey(cx, cz));
    if (!c || !c.voxels) return AIR;
    return c.voxels[vIndex(x - (cx << 4), y, z - (cz << 4))];
  }

  isLoaded(x, z) {
    const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
    return !!(c && c.voxels);
  }

  /**
   * Local player edit. Keeps its old contract - refuses a chunk that is not
   * streamed in, and refuses a no-op - because callers use the return value to
   * decide whether to spend an item or play a sound.
   */
  setBlock(x, y, z, id) {
    if (y < 1 || y >= WORLD_H) return false;
    const cx = x >> 4, cz = z >> 4;
    const c = this.chunks.get(chunkKey(cx, cz));
    if (!c || !c.voxels) return false;
    if (c.voxels[vIndex(x - (cx << 4), y, z - (cz << 4))] === id) return false;
    return this.applyEdit(x, y, z, id);
  }

  /**
   * Every change that is not the local player pressing a button: a network echo,
   * a smelter lighting up, an explosion. The log is written unconditionally and
   * the voxel mirror only when the chunk happens to be resident - a friend's
   * edit 150 blocks away must not be dropped just because you streamed that
   * chunk out. onWorkerMessage replays the log onto arriving voxels, so the
   * mirror heals itself the moment the chunk comes back.
   */
  applyEdit(x, y, z, id) {
    if (y < 1 || y >= WORLD_H) return false;
    const cx = x >> 4, cz = z >> 4;
    const key = chunkKey(cx, cz);
    const i = vIndex(x - (cx << 4), y, z - (cz << 4));
    this._log.set(x, y, z, id);
    const c = this.chunks.get(key);
    if (c?.voxels) c.voxels[i] = id;
    this.worker.postMessage({ type: 'edit', x, y, z, id });
    return true;
  }

  /** The logged value at a position, or null if the player never changed it. */
  loggedBlock(x, y, z) {
    if (y < 1 || y >= WORLD_H) return null;
    return this._log.get(x, y, z);
  }

  /**
   * Many edits, one worker message. An explosion is ~80 blocks; posting 80
   * separate messages would have the worker remesh the same four chunks over and
   * over. `flat` is [x, y, z, id, ...] and `n` is the number of quads.
   */
  setBlocks(flat, n) {
    let changed = 0;
    for (let k = 0; k < n; k++) {
      const o = k * 4;
      const x = flat[o], y = flat[o + 1], z = flat[o + 2], id = flat[o + 3];
      if (y < 1 || y >= WORLD_H) continue;
      const cx = x >> 4, cz = z >> 4;
      const key = chunkKey(cx, cz);
      const i = vIndex(x - (cx << 4), y, z - (cz << 4));
      this._log.set(x, y, z, id);
      const c = this.chunks.get(key);
      if (c?.voxels) c.voxels[i] = id;
      changed++;
    }
    if (changed) {
      // Transfer when we were handed a typed array; copy when we were not.
      const payload = ArrayBuffer.isView(flat)
        ? flat.slice(0, n * 4)
        : Int32Array.from(flat.slice(0, n * 4));
      this.worker.postMessage({ type: 'editBatch', edits: payload }, [payload.buffer]);
    }
    return changed;
  }

  // ------------------------------------------------------------ chunk stream
  update(px, pz) {
    const pcx = Math.floor(px / CHUNK_SX), pcz = Math.floor(pz / CHUNK_SZ);
    if (this._lastCx === pcx && this._lastCz === pcz && this._primed) return;
    this._lastCx = pcx; this._lastCz = pcz; this._primed = true;

    const R = this.renderDistance;
    const want = [];
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        if (dx * dx + dz * dz > (R + 0.5) * (R + 0.5)) continue;
        const cx = pcx + dx, cz = pcz + dz;
        const key = chunkKey(cx, cz);
        if (this.chunks.has(key) || this.pending.has(key)) continue;
        want.push([cx, cz]);
        this.pending.add(key);
      }
    }
    if (want.length) {
      want.sort((a, b) => (a[0] - pcx) ** 2 + (a[1] - pcz) ** 2 - ((b[0] - pcx) ** 2 + (b[1] - pcz) ** 2));
      this.worker.postMessage({ type: 'request', chunks: want, cx: pcx, cz: pcz, radius: R });
    }

    // release anything well outside the ring
    const drop = [];
    const limit = (R + 2) * (R + 2);
    for (const [key, c] of this.chunks) {
      const [cx, cz] = key.split(',').map(Number);
      if ((cx - pcx) ** 2 + (cz - pcz) ** 2 > limit) {
        this.disposeChunk(key, c);
        drop.push([cx, cz]);
      }
    }
    if (drop.length) this.worker.postMessage({ type: 'drop', chunks: drop });
  }

  onWorkerMessage(m) {
    if (m.type === 'ready') { this.ready = true; return; }
    if (m.type !== 'chunk') return;
    const key = chunkKey(m.cx, m.cz);
    const wasPending = this.pending.delete(key);
    let c = this.chunks.get(key);
    if (!c) {
      // A remesh can arrive for a chunk we already unloaded - drop it instead of
      // resurrecting a chunk with no voxel mirror behind it.
      if (!wasPending) return;
      c = { voxels: null, opaque: null, transparent: null };
      this.chunks.set(key, c);
    }
    if (m.voxels) {
      c.voxels = m.voxels;
      // The worker replays edits too, but the mirror the player's physics and
      // ray-picking read must never be a frame behind on a reloaded chunk.
      const log = this.edits.get(key);
      if (log) for (const [i, id] of log) c.voxels[i] = id;
    }

    this.swapMesh(c, 'opaque', m.opaque, m.cx, m.cz, this.matOpaque);
    this.swapMesh(c, 'transparent', m.transparent, m.cx, m.cz, this.matTransparent);
    this.recount();
  }

  swapMesh(c, slot, data, cx, cz, material) {
    if (c[slot]) {
      this.group.remove(c[slot]);
      c[slot].geometry.dispose();
      c[slot] = null;
    }
    if (!data) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(data.pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(data.norm, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(data.uv, 2));
    g.setAttribute('color', new THREE.BufferAttribute(data.col, 3));
    g.setIndex(new THREE.BufferAttribute(data.idx, 1));
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, material);
    mesh.position.set(cx * CHUNK_SX, 0, cz * CHUNK_SZ);
    mesh.renderOrder = slot === 'transparent' ? 10 : 0;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.group.add(mesh);
    c[slot] = mesh;
  }

  disposeChunk(key, c) {
    for (const slot of ['opaque', 'transparent']) {
      if (c[slot]) { this.group.remove(c[slot]); c[slot].geometry.dispose(); }
    }
    this.chunks.delete(key);
  }

  recount() {
    let tris = 0;
    for (const c of this.chunks.values()) {
      if (c.opaque) tris += c.opaque.geometry.index.count / 3;
      if (c.transparent) tris += c.transparent.geometry.index.count / 3;
    }
    this.stats.chunks = this.chunks.size;
    this.stats.tris = tris;
  }

  setRenderDistance(r) {
    this.renderDistance = r;
    this._primed = false;
  }

  // ------------------------------------------------------------------ saving
  serializeEdits() { return this._log.serialize(); }

  loadEdits(obj) { this._log.load(obj ?? {}); }

  dispose() {
    this.worker.terminate();
    for (const [key, c] of [...this.chunks]) this.disposeChunk(key, c);
    this.scene.remove(this.group);
    this.matOpaque.dispose();
    this.matTransparent.dispose();
  }
}
