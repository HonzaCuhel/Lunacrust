import assert from 'node:assert/strict';
import { Game } from '../app/js/game.js';
import { Player } from '../app/js/player.js';
import { Survival } from '../app/js/survival.js';
import { PLANETS } from '../app/js/planets.js';
import { BY_KEY } from '../app/js/blocks.js';

const EARTH = PLANETS[0];
const FLOOR = BY_KEY.get('stone').id;
const WORLD = { getBlock: (_x, y) => y < 10 ? FLOOR : 0 };
const DT = 1 / 60;
const PHYSICS_DONE = Symbol('physics done');
let passed = 0;
const failures = [];
function test(name, fn) {
  const oldDocument = globalThis.document, oldWindow = globalThis.window;
  globalThis.document = new EventTarget();
  globalThis.window = new EventTarget();
  try { fn(); passed++; }
  catch (err) { failures.push({ name, err }); }
  finally { globalThis.document = oldDocument; globalThis.window = oldWindow; }
}

function makeGame({ flying = false } = {}) {
  const game = Object.create(Game.prototype);
  const player = new Player(EARTH);
  player.setPosition({ x: 0.5, y: flying ? 60 : 10, z: 0.5 });
  player.onGround = !flying;
  player.flying = flying;
  Object.assign(game, {
    player, planet: EARTH, world: WORLD, spawned: true, running: true,
    paused: false, dead: false, pointerLocked: true, inventoryOpen: false,
    mode: flying ? 'creative' : 'survival', keys: new Set(),
    mouse: { left: false, right: false }, hooks: {}, canvas: new EventTarget(),
    clock: { getDelta: () => DT }, survival: new Survival(EARTH),
    stations: { nearLifeSupport: () => false }, refreshArmour() {}, updateStations() {},
  });
  // Exercise Game's actual key-to-input translation and real Player physics.
  // Stop before rendering/world streaming, which require WebGL and a full scene.
  player.update = function (dt, input, world) {
    game.lastInput = input;
    Player.prototype.update.call(this, dt, input, world);
    throw PHYSICS_DONE;
  };
  game.bindInput();
  return game;
}

function frame(game, count = 1) {
  for (let i = 0; i < count; i++) {
    try { game.step(DT); }
    catch (err) { if (err !== PHYSICS_DONE) throw err; }
    game.updateSurvival(DT);
  }
}
function key(game, code, type = 'keydown') {
  const event = new Event(type, { cancelable: true });
  Object.defineProperty(event, 'code', { value: code });
  // Use the bound handlers to avoid sending one game's input to another fixture.
  (type === 'keydown' ? game._onKeyDown : game._onKeyUp)(event);
  return event;
}
function travel(codes, { flying = false } = {}) {
  const game = makeGame({ flying });
  for (const code of codes) key(game, code);
  frame(game, 120);
  return { game, distance: Math.hypot(game.player.pos.x - 0.5, game.player.pos.z - 0.5) };
}
function beginSprint() {
  const game = makeGame();
  key(game, 'KeyW'); key(game, 'ControlLeft');
  frame(game, 30);
  assert.equal(game.player.sprinting, true);
  return game;
}

for (const modifier of ['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight']) {
  test(`${modifier} makes forward ground travel 62% faster`, () => {
    const walk = travel(['KeyW']);
    const sprint = travel(['KeyW', modifier]);
    assert.equal(sprint.game.player.sprinting, true);
    assert.ok(Math.abs(sprint.distance / walk.distance - 1.62) < 0.001);
    assert.equal(key(sprint.game, modifier).defaultPrevented, true);
  });
}

test('Shift sprint spends more survival exertion through the real game integration', () => {
  const walk = travel(['KeyW']).game;
  const sprint = travel(['KeyW', 'ShiftLeft']).game;
  assert.ok(sprint.survival.exertion > walk.survival.exertion * 6);
});

test('C sneaks on ground and overrides either sprint shortcut', () => {
  const walk = travel(['KeyW']);
  for (const modifier of [null, 'ShiftLeft', 'ControlLeft']) {
    const sneak = travel(['KeyW', 'KeyC', ...(modifier ? [modifier] : [])]);
    assert.equal(sneak.game.player.sprinting, false);
    assert.ok(Math.abs(sneak.distance / walk.distance - 0.36) < 0.001);
  }
});

test('the player model independently prevents sprint while sneaking', () => {
  const player = new Player(EARTH);
  player.setPosition({ x: 0.5, y: 10, z: 0.5 }); player.onGround = true;
  player.update(DT, { forward: true, sprint: true, sneak: true }, WORLD);
  assert.equal(player.sprinting, false);
});

test('sprint never boosts standing, backward, sideways or cancelled forward input', () => {
  for (const codes of [[], ['KeyS'], ['KeyD'], ['KeyW', 'KeyS']]) {
    const walk = travel(codes);
    const sprint = travel([...codes, 'ShiftLeft']);
    assert.equal(sprint.game.player.sprinting, false);
    assert.ok(Math.abs(sprint.distance - walk.distance) < 1e-9);
  }
});

test('diagonal sprint covers the same distance as straight sprint', () => {
  const straight = travel(['KeyW', 'ShiftLeft']);
  const diagonal = travel(['KeyW', 'KeyD', 'ShiftLeft']);
  assert.ok(Math.abs(straight.distance - diagonal.distance) < 1e-9);
});

test('releasing sprint or forward input ends sprint on the next physics frame', () => {
  for (const code of ['ControlLeft', 'KeyW']) {
    const game = beginSprint();
    key(game, code, 'keyup'); frame(game);
    assert.equal(game.player.sprinting, false);
  }
});

test('pausing clears sprint immediately and resume never resurrects held keys', () => {
  const game = beginSprint();
  game.setPaused(true);
  assert.equal(game.player.sprinting, false);
  assert.equal(game.keys.size, 0);
  key(game, 'ShiftLeft'); key(game, 'KeyW');
  game.setPaused(false); frame(game);
  assert.equal(game.player.sprinting, false);
  assert.equal(game.lastInput.forward, false);
});

test('window blur clears sprint and keys even before pointer-lock loss arrives', () => {
  const game = beginSprint();
  window.dispatchEvent(new Event('blur'));
  assert.equal(game.player.sprinting, false);
  assert.equal(game.keys.size, 0);
  frame(game);
  assert.equal(game.lastInput.forward, false);
});

test('pointer-lock loss clears sprint immediately', () => {
  const game = beginSprint();
  document.pointerLockElement = null;
  document.dispatchEvent(new Event('pointerlockchange'));
  assert.equal(game.player.sprinting, false);
  assert.equal(game.keys.size, 0);
});

test('death clears sprint immediately and ignores subsequent movement presses', () => {
  const game = beginSprint();
  game.applyEvents([{ type: 'death', cause: 'fall' }]);
  assert.equal(game.player.sprinting, false);
  assert.equal(game.keys.size, 0);
  key(game, 'KeyW'); key(game, 'ShiftLeft'); frame(game);
  assert.equal(game.keys.size, 0);
  assert.equal(game.player.sprinting, false);
  assert.equal(game.lastInput.sprint, false);
  assert.equal(game.lastInput.sneak, false);
});

test('creative Shift descends at normal speed while Ctrl preserves forward flight boost', () => {
  const normal = travel(['KeyW'], { flying: true });
  const down = travel(['KeyW', 'ShiftLeft'], { flying: true });
  const boost = travel(['KeyW', 'ControlLeft', 'ShiftLeft'], { flying: true });
  assert.equal(down.game.player.sprinting, false);
  assert.ok(down.game.player.pos.y < 45);
  assert.ok(Math.abs(down.distance - normal.distance) < 1e-9);
  assert.equal(boost.game.player.sprinting, true);
  assert.ok(Math.abs(boost.distance / normal.distance - 26 / 11) < 0.001);
  assert.ok(boost.game.player.pos.y < down.game.player.pos.y);
});

test('ground Shift allows item use while C keeps the force-place shortcut', () => {
  for (const [code, expectedUses] of [['ShiftLeft', 1], ['KeyC', 0]]) {
    const game = makeGame(); let uses = 0;
    game.useHeldItem = () => { uses++; return true; };
    key(game, code);
    game._onMouseDown({ button: 2 });
    assert.equal(uses, expectedUses);
    assert.equal(game.mouse.right, expectedUses === 0);
  }
});

test('HUD reports current sprint state', () => {
  const game = beginSprint(); let hud;
  game.hooks.onHud = (value) => { hud = value; };
  game.world = { ...WORLD, stats: { chunks: 1, tris: 0 } };
  game.sky = { time: 0 };
  game.updateHud(); assert.equal(hud.sprinting, true);
  game.setPaused(true);
  game.updateHud(); assert.equal(hud.sprinting, false);
});

for (const { name, err } of failures) console.error(`FAIL ${name}\n${err.stack}`);
console.log(`sprint: ${passed}/${passed + failures.length} passed`);
process.exitCode = failures.length ? 1 : 0;
