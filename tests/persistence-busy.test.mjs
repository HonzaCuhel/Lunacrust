import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from '../app/vendor/three.module.js';
import { Game } from '../app/js/game.js';
import { Player } from '../app/js/player.js';
import { Survival } from '../app/js/survival.js';
import { PlayerInventory, ArmourContainer } from '../app/js/inventory.js';
import { DropEntities } from '../app/js/drops.js';
import { PLANET_BY_ID } from '../app/js/planets.js';
import { itemIdOf } from '../app/js/items.js';

// Game's loop is an instance arrow field initialized beside WebGLRenderer.
// Execute that exact field body on the headless fixture, without constructing GL.
const source = readFileSync(new URL('../app/js/game.js', import.meta.url), 'utf8');
const start = source.indexOf('loop = () => {') + 'loop = () => {'.length;
const loop = new Function(source.slice(start, source.indexOf('\n  };', start)));
globalThis.requestAnimationFrame = () => 1;
globalThis.document = new EventTarget();
globalThis.window = new EventTarget();
const EARTH = PLANET_BY_ID.get('earth');
const noop = () => {};

function fixture({ host = true, hazardous = false } = {}) {
  const game = Object.create(Game.prototype);
  const player = new Player(EARTH);
  player.setPosition({ x: 0.5, y: 10, z: 0.5 }); player.onGround = true;
  const survival = new Survival(EARTH);
  survival.health = hazardous ? 0.001 : 13;
  survival.hunger = 10;
  survival.burning = hazardous ? 2 : 0;
  const scene = new THREE.Scene(), drops = new DropEntities(scene, new THREE.Texture());
  if (!hazardous) {
    const drop = drops.spawn(0.5, 10.9, 0.5, itemIdOf('cobble'), 5);
    drop.age = 1;
  }
  const counters = { renders: 0, stations: 0, mobs: 0 };
  Object.assign(game, {
    player, survival, drops, scene, planet: EARTH,
    world: { getBlock: (_x, y) => y < 10 ? 1 : 0, isLoaded: () => true, update: noop },
    inventory: new PlayerInventory(), armourInv: new ArmourContainer(), mode: 'survival',
    net: host ? { role: 'host', sendMove: noop } : null,
    spawned: true, running: true, paused: true, persistenceBusy: true, dead: false,
    keys: new Set(), mouse: { left: false, right: false }, hooks: {},
    pointerLocked: true, canvas: new EventTarget(), settings: { sensitivity: 1 }, hotbar: [1], slot: 0,
    clock: { getDelta: () => 0.05 }, _frames: 0, _fpsT: 0,
    renderer: { render: () => counters.renders++ }, camera: { position: new THREE.Vector3() },
    stations: { update: () => { counters.stations++; return []; }, nearLifeSupport: () => false },
    sky: { time: 0, update: noop }, weather: { update: noop }, bursts: { update: noop },
    limitView: { update: noop }, mobs: { update: () => counters.mobs++ }, mobRender: { update: noop },
    updateCamera: noop, applyVoidFog: noop, updateLights: noop, updateTargeting: noop,
    updateHud: noop, pushHotbar: noop, musicSituation: () => ({}), mobContext: () => ({}),
  });
  game.loop = loop.bind(game);
  game.bindInput();
  return { game, counters };
}

let checks = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); checks++; }
  catch (error) { failures.push({ name, error }); }
}

for (const rejects of [false, true]) {
  await test(`paused host waits for ${rejects ? 'failed' : 'successful'} persistence without pickups or death`, async () => {
    const { game, counters } = fixture();
    const hazard = fixture({ hazardous: true });
    const before = game.survival.serialize(), beforeHazard = hazard.game.survival.serialize();
    let settle;
    const write = new Promise((resolve, reject) => { settle = () => rejects ? reject(new Error('disk full')) : resolve(); });
    const pending = write.catch(() => {}).finally(() => {
      game.persistenceBusy = false; hazard.game.persistenceBusy = false;
    });
    for (let i = 0; i < 10; i++) {
      game.loop(); game.step(0.05);
      hazard.game.loop(); hazard.game.step(0.05);
    }
    assert.equal(game.inventory.count(itemIdOf('cobble')), 0);
    assert.equal(game.drops.count, 1);
    assert.deepEqual(game.survival.serialize(), before);
    assert.deepEqual(hazard.game.survival.serialize(), beforeHazard);
    assert.equal(hazard.game.dead, false);
    assert.deepEqual(counters, { renders: 10, stations: 0, mobs: 0 });
    settle(); await pending;
    game.loop(); hazard.game.loop();
    assert.equal(game.inventory.count(itemIdOf('cobble')), 5);
    assert.equal(game.drops.count, 0);
    assert.equal(hazard.game.dead, true, 'survival resumes after persistence settles');
    assert.equal(counters.stations, 1); assert.equal(counters.mobs, 1);
    game.drops.dispose(); hazard.game.drops.dispose();
  });
}

await test('single-player smelters also wait during a persistence transaction', () => {
  const { game, counters } = fixture({ host: false });
  game.loop(); assert.equal(counters.stations, 0);
  game.persistenceBusy = false;
  game.loop(); assert.equal(counters.stations, 1);
  game.drops.dispose();
});

await test('busy input cannot open inventory, use held items, move the camera or switch slots', () => {
  const { game } = fixture(); game.paused = false;
  let inventoryOpens = 0, uses = 0, selections = 0;
  game.hooks.onInventory = () => inventoryOpens++;
  game.useHeldItem = () => { uses++; return true; };
  game.selectSlot = () => selections++;
  const key = code => ({ code, preventDefault: noop, stopImmediatePropagation: noop });
  game._onKeyDown(key('KeyE')); game._onKeyDown(key('KeyW')); game._onKeyDown(key('Digit2'));
  game._onMouseDown({ button: 0 }); game._onMouseDown({ button: 2 });
  game._onMouseMove({ movementX: 100, movementY: 100 }); game._onWheel({ deltaY: 1 });
  assert.equal(inventoryOpens, 0); assert.equal(uses, 0); assert.equal(selections, 0);
  assert.equal(game.keys.size, 0); assert.equal(game.mouse.left, false);
  assert.equal(game.player.yaw, 0); assert.equal(game.player.pitch, 0);
  game.keys.add('ControlLeft'); game._onKeyUp(key('ControlLeft'));
  assert.equal(game.keys.size, 0, 'release events must still clear preexisting keys');
  game.persistenceBusy = false;
  game._onKeyDown(key('KeyE')); assert.equal(inventoryOpens, 1);
  game.drops.dispose();
});

for (const { name, error } of failures) console.error(`FAIL ${name}\n${error.stack}`);
console.log(`persistence busy: ${checks}/${checks + failures.length} checks passed`);
process.exitCode = failures.length ? 1 : 0;
