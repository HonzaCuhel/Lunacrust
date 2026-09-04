// The two limit planes: a ceiling and a flight floor, drawn as a faint grid
// that fades in only once you are close. Flying into the world's bounds used
// to be silent (creative) or a flat teleport (survival) - nothing told you
// *why* the sky suddenly looked wrong. This is the fix: fly toward either
// bound and a grid rises out of the haze before you hit it, so a limit reads
// as a limit rather than a bug.
//
// Both planes are one flat 160x160 quad each, recentred under the player in
// X/Z every frame (never Y - they stay pinned to FLIGHT_CEIL / FLIGHT_FLOOR),
// so a plane this size always covers the visible span without needing to be
// literally infinite.

import * as THREE from '../vendor/three.module.js';
import { FLIGHT_FLOOR, FLIGHT_CEIL } from './player.js';

const SPAN = 160;
const FADE = 7.0; // blocks of vertical distance over which the plane fades in

const VERTEX = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// fwidth-antialiased grid lines, faded by vertical distance from the player.
// The grid mask and the distance fade are multiplied together into one alpha
// rather than kept separate, because there is nothing to see at a grid line
// the player is nowhere near - discarding early is also the cheap path.
const FRAGMENT = `
uniform vec3 uColor;
uniform float uPlaneY;
uniform float uPlayerY;
varying vec2 vUv;
void main() {
  vec2 g = vUv * ${SPAN.toFixed(1)};
  vec2 cell = min(fract(g), 1.0 - fract(g));
  vec2 aa = fwidth(g) * 1.5 + 0.0005; // epsilon keeps smoothstep well-defined overhead
  vec2 lineMask = 1.0 - smoothstep(vec2(0.0), aa, cell);
  float grid = max(lineMask.x, lineMask.y);
  float near = smoothstep(${FADE.toFixed(1)}, 0.0, abs(uPlayerY - uPlaneY));
  float alpha = grid * near * 0.55;
  if (alpha <= 0.003) discard;
  gl_FragColor = vec4(uColor, alpha);
}`;

function makePlane(color, y) {
  const geo = new THREE.PlaneGeometry(SPAN, SPAN);
  geo.rotateX(-Math.PI / 2); // lie flat; DoubleSide makes it read from above and below
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
    extensions: { derivatives: true }, // fwidth() on a WebGL1 fallback context
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uPlaneY: { value: y },
      uPlayerY: { value: y },
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 8; // after opaque chunks (0), before water/glass (10)
  mesh.frustumCulled = false; // it is repositioned under the camera every frame anyway
  mesh.position.y = y;
  return mesh;
}

export class LimitView {
  constructor(scene) {
    this.scene = scene;
    this.ceiling = makePlane('#7fd4ff', FLIGHT_CEIL);
    this.floor = makePlane('#ff8a5c', FLIGHT_FLOOR);
    scene.add(this.ceiling, this.floor);
  }

  /** @param {{x:number,y:number,z:number}} playerPos */
  update(playerPos) {
    this.ceiling.position.set(playerPos.x, FLIGHT_CEIL, playerPos.z);
    this.floor.position.set(playerPos.x, FLIGHT_FLOOR, playerPos.z);
    this.ceiling.material.uniforms.uPlayerY.value = playerPos.y;
    this.floor.material.uniforms.uPlayerY.value = playerPos.y;
  }

  dispose() {
    this.scene.remove(this.ceiling, this.floor);
    for (const mesh of [this.ceiling, this.floor]) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
  }
}
