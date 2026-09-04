import assert from 'node:assert/strict';
import * as THREE from '../app/vendor/three.module.js';
import { MobRender } from '../app/js/mobrender.js';
import { Mobs } from '../app/js/mobs.js';
import { PLANETS } from '../app/js/planets.js';
const scene = new THREE.Scene();
const render = new MobRender(scene, PLANETS[0]);
const mobs = new Mobs(PLANETS[0]);
mobs.spawnAt('crawler', -2, 0, 0);
mobs.spawnAt('warden', 2, 0, 0);
render.update(mobs, .05, new THREE.Vector3(0,2,5));
assert.equal(render.meshes.crawlerLeg.count, 6, 'Flux Skitter has six legs');
assert.equal(render.meshes.wardenLeg.count, 3, 'Basalt Resonator has three support legs');
assert.equal(render.meshes.wardenHead.count, 3, 'Resonator has a split crystal crown');
for (const mesh of render._meshList) {
  for (const n of mesh.instanceMatrix.array) assert.ok(Number.isFinite(n));
}
render.update(mobs, .05, new THREE.Vector3(500,2,5));
assert.equal(render._meshList.reduce((n, mesh) => n + mesh.count, 0), 0, 'far creatures are culled');
render.dispose();
assert.equal(scene.children.length, 0);
console.log('mob render: original silhouettes, finite transforms, culling and disposal passed');
