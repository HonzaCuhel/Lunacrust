// Block-break debris. One pooled Points cloud with a tiny custom shader, so each
// particle can fade and shrink on its own without 300 draw calls.

import * as THREE from '../vendor/three.module.js';

const MAX = 420;

export class Bursts {
  constructor(scene) {
    this.scene = scene;
    this.pos = new Float32Array(MAX * 3);
    this.vel = new Float32Array(MAX * 3);
    this.col = new Float32Array(MAX * 3);
    this.life = new Float32Array(MAX);
    this.maxLife = new Float32Array(MAX);
    this.size = new Float32Array(MAX);
    this.alpha = new Float32Array(MAX);
    this.next = 0;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    this.geo = geo;

    this.points = new THREE.Points(geo, new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      vertexShader: `
        attribute vec3 aColor;
        attribute float aSize;
        attribute float aAlpha;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = aColor;
          vAlpha = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * (260.0 / max(1.0, -mv.z));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          if (vAlpha <= 0.01) discard;
          gl_FragColor = vec4(vColor, vAlpha);
        }`,
    }));
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  spawn(x, y, z, color, count = 14, spread = 3.4) {
    for (let i = 0; i < count; i++) {
      const k = this.next;
      this.next = (this.next + 1) % MAX;
      const k3 = k * 3;
      this.pos[k3] = x + Math.random() * 0.8 - 0.4;
      this.pos[k3 + 1] = y + Math.random() * 0.8 - 0.4;
      this.pos[k3 + 2] = z + Math.random() * 0.8 - 0.4;
      this.vel[k3] = (Math.random() - 0.5) * spread;
      this.vel[k3 + 1] = Math.random() * spread * 0.8 + 0.6;
      this.vel[k3 + 2] = (Math.random() - 0.5) * spread;
      const v = 0.75 + Math.random() * 0.45;
      this.col[k3] = color[0] * v;
      this.col[k3 + 1] = color[1] * v;
      this.col[k3 + 2] = color[2] * v;
      this.maxLife[k] = this.life[k] = 0.55 + Math.random() * 0.5;
      this.size[k] = 1.6 + Math.random() * 2.2;
      this.alpha[k] = 1;
    }
  }

  update(dt, gravity = 24) {
    let any = false;
    for (let k = 0; k < MAX; k++) {
      if (this.life[k] <= 0) continue;
      any = true;
      const k3 = k * 3;
      this.life[k] -= dt;
      this.vel[k3 + 1] -= gravity * dt;
      this.pos[k3] += this.vel[k3] * dt;
      this.pos[k3 + 1] += this.vel[k3 + 1] * dt;
      this.pos[k3 + 2] += this.vel[k3 + 2] * dt;
      const t = Math.max(0, this.life[k] / this.maxLife[k]);
      this.alpha[k] = t * t;
      if (this.life[k] <= 0) this.alpha[k] = 0;
    }
    if (any) {
      this.geo.attributes.position.needsUpdate = true;
      this.geo.attributes.aColor.needsUpdate = true;
      this.geo.attributes.aSize.needsUpdate = true;
      this.geo.attributes.aAlpha.needsUpdate = true;
    }
  }

  dispose() {
    this.scene.remove(this.points);
    this.geo.dispose();
    this.points.material.dispose();
  }
}
