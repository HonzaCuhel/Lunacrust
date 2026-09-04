// Weather is a single Points cloud that follows the camera inside a wrap-around
// box, so 1 500 particles look like an endless dust storm without ever leaving
// a 40-block cube.

import * as THREE from '../vendor/three.module.js';

const PRESETS = {
  dust: { count: 1400, size: 0.14, fall: 1.2, wind: [7, 0, 2.5], opacity: 0.5, swirl: 1.2 },
  snow: { count: 1100, size: 0.2, fall: 1.6, wind: [1.2, 0, 0.6], opacity: 0.75, swirl: 0.9 },
  ash: { count: 900, size: 0.17, fall: 2.0, wind: [2.5, 0, 1.0], opacity: 0.55, swirl: 0.7 },
  rain: { count: 1500, size: 0.11, fall: 11, wind: [1.5, 0, 0.5], opacity: 0.5, swirl: 0.15 },
  storm: { count: 1600, size: 0.22, fall: 3.2, wind: [16, 0, 5], opacity: 0.45, swirl: 1.8 },
};

const BOX = 46;

export class Weather {
  constructor(scene, planet) {
    this.scene = scene;
    const w = planet.weather ?? { type: 'none' };
    this.cfg = PRESETS[w.type];
    if (!this.cfg) return;
    const n = Math.round(this.cfg.count * (w.density ?? 1));
    const pos = new Float32Array(n * 3);
    const phase = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() - 0.5) * BOX;
      pos[i * 3 + 1] = Math.random() * BOX;
      pos[i * 3 + 2] = (Math.random() - 0.5) * BOX;
      phase[i] = Math.random() * Math.PI * 2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.geo = geo;
    this.phase = phase;
    this.n = n;

    this.points = new THREE.Points(geo, new THREE.PointsMaterial({
      color: new THREE.Color(w.color ?? '#ffffff'),
      size: this.cfg.size * (w.type === 'rain' ? 2.4 : 1),
      transparent: true,
      opacity: this.cfg.opacity,
      depthWrite: false,
      fog: true,
      sizeAttenuation: true,
    }));
    this.points.frustumCulled = false;
    scene.add(this.points);
    this.t = 0;
  }

  update(dt, cam) {
    if (!this.cfg) return;
    this.t += dt;
    const p = this.geo.attributes.position.array;
    const c = this.cfg;
    const halfB = BOX / 2;
    for (let i = 0; i < this.n; i++) {
      const i3 = i * 3;
      const sw = Math.sin(this.t * 1.7 + this.phase[i]) * c.swirl;
      p[i3] += (c.wind[0] + sw) * dt;
      p[i3 + 1] -= c.fall * dt;
      p[i3 + 2] += (c.wind[2] + sw * 0.6) * dt;

      // wrap relative to the camera so the field is effectively infinite
      const dx = p[i3] + this.points.position.x - cam.x;
      const dz = p[i3 + 2] + this.points.position.z - cam.z;
      if (dx > halfB) p[i3] -= BOX; else if (dx < -halfB) p[i3] += BOX;
      if (dz > halfB) p[i3 + 2] -= BOX; else if (dz < -halfB) p[i3 + 2] += BOX;
      const dy = p[i3 + 1] + this.points.position.y - cam.y;
      if (dy < -halfB) p[i3 + 1] += BOX; else if (dy > halfB) p[i3 + 1] -= BOX;

      // A point sprite sitting on the near plane covers half the screen, so keep
      // a small no-fly bubble around the camera.
      if (dx * dx + dy * dy + dz * dz < 2.25) p[i3] += dx >= 0 ? 4 : -4;
    }
    this.geo.attributes.position.needsUpdate = true;
  }

  dispose() {
    if (!this.cfg) return;
    this.scene.remove(this.points);
    this.geo.dispose();
    this.points.material.dispose();
  }
}
