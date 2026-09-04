import assert from 'node:assert/strict';
import * as THREE from '../app/vendor/three.module.js';
import { RemoteAvatars } from '../app/js/net/avatars.js';

const oldDocument = globalThis.document;
globalThis.document = {
  createElement: () => ({ getContext: () => ({ clearRect() {}, fillRect() {}, fillText() {} }) }),
};
try {
  const scene = new THREE.Scene();
  const view = new RemoteAvatars(scene);
  const players = new Map([[1, { name: 'Explorer', buf: [{ t: 0, x: 1, y: 10, z: 2, yaw: 0, pitch: 0, f: 0 }] }]]);
  view.sync(players);
  view.update(0.05, 100, players, new THREE.Vector3());
  const rig = view._avatars.get(1).rig;
  const visor = rig.head.children[0];
  assert.ok(Math.abs(visor.position.y) < 0.25, 'visor stays on its head rather than floating above it');
  assert.equal(rig.group.position.y, 10, 'avatar feet follow the received position');
  view.sync(new Map());
  assert.equal(view._avatars.size, 0, 'departed players remove their rig');
  view.dispose();
} finally { globalThis.document = oldDocument; }
console.log('Avatar helmet placement, received position and peer removal verified');
