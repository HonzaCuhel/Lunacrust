// The block-break overlay: one cube mesh, redrawn per mining stage, that sits
// a hair outside the block being mined.
//
// Three independent defences keep it from z-fighting the block's own faces:
// polygonOffset biases it toward the camera in depth space (resolution- and
// distance-independent, unlike a positional nudge), a 1.5 mm scale shell is
// belt-and-braces for drivers where that offset is weak, and depthWrite:false
// plus a renderOrder after the opaque pass keep it from polluting depth for
// water/glass behind it. The selection box uses 1.002 for the same shell
// trick; this one is tighter because it is a filled surface, not lines.

import * as THREE from '../vendor/three.module.js';
import { TILE_INDEX, tileUV } from './textures.js';
import { CRACK_STAGES, crackTileName } from './crack.js';

const SHELL = 1.0015;

// `tex` indexes are irrelevant here (every face samples the same crack tile),
// but the corner winding and the per-corner uv table are copied verbatim from
// drops.js's CUBE_FACES so a crack samples the atlas exactly like a block
// face does - note the bottom face's uv order is deliberately different from
// the other five, which is drops.js's mapping, not a typo.
const CUBE_FACES = [
  { v: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]], uv: [[0, 0], [1, 0], [1, 1], [0, 1]] },
  { v: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], uv: [[0, 0], [1, 0], [1, 1], [0, 1]] },
  { v: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], uv: [[0, 0], [1, 0], [1, 1], [0, 1]] },
  { v: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], uv: [[0, 1], [1, 1], [1, 0], [0, 0]] },
  { v: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], uv: [[0, 0], [1, 0], [1, 1], [0, 1]] },
  { v: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]], uv: [[0, 0], [1, 0], [1, 1], [0, 1]] },
];

export class CrackOverlay {
  /**
   * @param {THREE.Object3D} scene
   * @param {THREE.Texture} atlasTexture the world's block atlas - borrowed, never disposed here
   */
  constructor(scene, atlasTexture) {
    this.scene = scene;

    // 24 positions (six quads, four verts each, CCW from outside), built once.
    const pos = new Float32Array(24 * 3);
    const idx = new Uint16Array(36);
    let v = 0, i = 0;
    for (let f = 0; f < 6; f++) {
      const base = v;
      for (let c = 0; c < 4; c++) {
        const p = CUBE_FACES[f].v[c];
        pos[v * 3] = p[0] - 0.5;
        pos[v * 3 + 1] = p[1] - 0.5;
        pos[v * 3 + 2] = p[2] - 0.5;
        v++;
      }
      idx[i++] = base; idx[i++] = base + 1; idx[i++] = base + 2;
      idx[i++] = base; idx[i++] = base + 2; idx[i++] = base + 3;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(48), 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    this.geometry = geo;
    this.uvAttr = geo.attributes.uv;

    // One UV set per stage, precomputed so show() only ever does a 48-float
    // array copy instead of rebuilding geometry ten times per block broken.
    this.uvSets = [];
    for (let s = 0; s < CRACK_STAGES; s++) {
      const rect = tileUV(TILE_INDEX.get(crackTileName(s)));
      const set = new Float32Array(48);
      let o = 0;
      for (let f = 0; f < 6; f++) {
        for (let c = 0; c < 4; c++) {
          set[o++] = rect[0] + CUBE_FACES[f].uv[c][0] * rect[2];
          set[o++] = rect[1] + CUBE_FACES[f].uv[c][1] * rect[3];
        }
      }
      this.uvSets.push(set);
    }

    this.material = new THREE.MeshBasicMaterial({
      map: atlasTexture,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      side: THREE.FrontSide,
      toneMapped: false,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.scale.setScalar(SHELL);
    this.mesh.renderOrder = 5; // after opaque chunks (0), before water/glass (10)
    this.mesh.visible = false;
    scene.add(this.mesh);

    this._stage = -1;
  }

  /** stage 0..CRACK_STAGES-1. Block-local coordinates (the block's lower corner). */
  show(x, y, z, stage) {
    stage = Math.max(0, Math.min(CRACK_STAGES - 1, stage | 0));
    this.mesh.position.set(x + 0.5, y + 0.5, z + 0.5);
    this.mesh.visible = true;
    if (stage !== this._stage) {
      this.uvAttr.array.set(this.uvSets[stage]);
      this.uvAttr.needsUpdate = true;
      this._stage = stage;
    }
  }

  hide() {
    this.mesh.visible = false;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose(); // material.map is the world atlas - not ours to dispose
    this.mesh = null;
    this.geometry = null;
    this.material = null;
  }
}
