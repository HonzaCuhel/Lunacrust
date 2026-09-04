import assert from 'node:assert/strict';
import * as THREE from '../app/vendor/three.module.js';
import { Game } from '../app/js/game.js';
import { DropEntities } from '../app/js/drops.js';
import { PlayerInventory } from '../app/js/inventory.js';
import { Stations } from '../app/js/stations.js';
import { Mobs } from '../app/js/mobs.js';
import { PLANETS } from '../app/js/planets.js';
import { authoritativeBlock } from '../app/js/net/game-sync.js';
import { WorldGen, vIndex } from '../app/js/worldgen.js';

const game = Object.create(Game.prototype);
Object.assign(game, {
  hooks: {}, mode: 'survival', dead: false,
  net: { role: 'host' },
  drops: new DropEntities(new THREE.Scene(), new THREE.Texture()),
  inventory: new PlayerInventory(), stations: new Stations(),
  mobs: new Mobs(PLANETS[0]),
});
const hooks = game.netHooks();
for (const hook of ['onDrops', 'onGrant', 'onTime', 'onFurnaceState', 'onResyncNeeded', 'onMobState', 'onMobHit']) {
  assert.equal(typeof hooks[hook], 'function', `${hook} is wired to the game`);
}
const d = game.drops.spawn(1, 2, 3, 1, 2);
const channel = hooks.drops();
assert.ok(Number.isInteger(channel.list[0].id), 'host drops have stable IDs');
const known = new Set();
assert.equal(channel.netFrame({ x: 0, y: 0, z: 0 }, known).a.length, 1);
hooks.onGrant({ id: d.id, item: d.item, count: d.count, by: 1 });
assert.equal(game.drops.count, 0, 'a grant removes the host drop once');
assert.deepEqual(channel.netFrame({ x: 0, y: 0, z: 0 }, known).r, [d.id]);
const gen = new WorldGen(PLANETS[0], 777);
const distant = { world: { gen, isLoaded: () => false, loggedBlock: () => null } };
const expected = gen.generate(30, -30);
assert.equal(authoritativeBlock(distant, 480, 20, -480), expected[vIndex(0, 20, 0)], 'host reads distant guest terrain without rendering that chunk');
distant.world.loggedBlock = () => 47;
assert.equal(authoritativeBlock(distant, 480, 20, -480), 47, 'authoritative terrain always includes prior edits');
game.drops.dispose();
console.log('LAN game hooks and host drop ownership verified');
