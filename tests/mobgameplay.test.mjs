import assert from 'node:assert/strict';
import { Mobs, STATE, SIM_DT, mulberry32 } from '../app/js/mobs.js';
import { MOB, MOB_TYPES } from '../app/js/mobtypes.js';
import { PLANETS } from '../app/js/planets.js';
import { BY_KEY } from '../app/js/blocks.js';

const stone = BY_KEY.get('stone').id;
const flat = { getBlock: (_x, y) => y <= 10 ? stone : 0, isLoaded: () => true };
let passed = 0;
const failures = [];
function test(name, fn) { try { fn(); passed++; } catch (err) { failures.push({name, err}); } }
function fixture(planet = PLANETS[0], extra = {}) {
  const hurt = [], drops = [];
  const mobs = new Mobs(planet, { rng: mulberry32(52) });
  const ctx = { world: flat, planet, gravity: planet.gravity * 3.2,
    mode: 'survival', dead: false, enabled: false, daylight: 0,
    playerPos: { x: .5, y: 11, z: .5 }, playerH: 1.8,
    hurtPlayer: (...args) => hurt.push(args), pushPlayer() {},
    spawnDrop: (...args) => drops.push(args), setBlocks() {}, ...extra };
  return { mobs, ctx, hurt, drops };
}
const tick = (f, n = 1) => { for (let i = 0; i < n; i++) f.mobs.update(SIM_DT, f.ctx); };

for (const planet of PLANETS) test(`${planet.id}: real planet supports a natural nighttime encounter`, () => {
  const f = fixture(planet, { enabled: true });
  tick(f, 41);
  assert.ok(f.mobs.count > 0, `${planet.id} must spawn without debug injection`);
});

test('mining noise keeps its destination through the next wander think', () => {
  const f = fixture(undefined, { mode: 'creative' });
  const m = f.mobs.byId(f.mobs.spawnAt('crawler', 8.5, 11, .5));
  f.mobs.noise(1.5, 11, .5);
  tick(f, 4);
  assert.equal(m.goal.x, 1.5);
  assert.equal(m.goal.z, .5);
  assert.ok(m.heading.x < 0, 'noise investigation should approach the noise');
});

test('melee knockback persists into physics instead of being overwritten by chase steering', () => {
  const f = fixture();
  const m = f.mobs.byId(f.mobs.spawnAt('crawler', 5.5, 11, .5));
  m.state = STATE.CHASE; m.heading.x = -1;
  const before = m.pos.x;
  f.mobs.hit(m.id, 1, 1, 0, f.ctx);
  tick(f);
  assert.ok(m.pos.x > before, 'a struck approaching creature must actually move away');
});

for (const condition of ['wall', 'above', 'dead', 'creative']) test(`a telegraphed slam cannot hit ${condition}`, () => {
  const f = fixture();
  const m = f.mobs.byId(f.mobs.spawnAt('warden', 2.5, 11, .5));
  m.state = STATE.WINDUP; m.yaw = m.wantYaw = Math.PI / 2;
  if (condition === 'wall') f.ctx.world = {
    ...flat, getBlock: (x, y) => x === 1 && y >= 11 && y <= 15 ? stone : flat.getBlock(x, y),
  };
  if (condition === 'above') f.ctx.playerPos.y = 21;
  if (condition === 'dead') f.ctx.dead = true;
  if (condition === 'creative') f.ctx.mode = 'creative';
  tick(f, 12);
  assert.equal(f.hurt.length, 0, `slam hit a player protected by ${condition}`);
});

test('an acquired close target is faced before the first telegraphed slam', () => {
  const f = fixture();
  f.mobs.spawnAt('warden', .5, 11, -1.5);
  tick(f, 22);
  assert.equal(f.hurt.length, 1, 'first visible windup should face and hit a stationary nearby target');
});

test('switching to creative cancels an armed fuse and pursuit', () => {
  const f = fixture();
  const m = f.mobs.byId(f.mobs.spawnAt('crawler', 2.5, 11, .5));
  m.state = STATE.FUSE; m.fuse = 1.49;
  f.ctx.mode = 'creative';
  tick(f);
  assert.equal(m.state, STATE.WANDER);
  assert.equal(m.fuse, 0);
});

test('director does not create enemies while the player is dead', () => {
  const f = fixture(undefined, { enabled: true, dead: true });
  tick(f, 41);
  assert.equal(f.mobs.count, 0);
});

test('an armoured creature reduces weak-tool damage and yields loot once when killed', () => {
  const f = fixture(undefined, { heldToolTier: 0 });
  const m = f.mobs.byId(f.mobs.spawnAt('warden', 2.5, 11, .5));
  f.mobs.hit(m.id, 4, 1, 0, f.ctx);
  assert.equal(m.health, MOB_TYPES[MOB.WARDEN].health - 2);
  m.invuln = 0;
  f.mobs.hit(m.id, 100, 1, 0, f.ctx);
  assert.equal(m.state, STATE.DEAD);
  const count = f.drops.length;
  assert.ok(count > 0, 'survival kill must drop resources');
  f.mobs.kill(m, f.ctx, true);
  assert.equal(f.drops.length, count);
  tick(f, 6);
  assert.equal(f.mobs.byId(m.id), null, 'death animation must release its pool slot');
});

test('host creature acquires a nearby guest even when the host is far away', () => {
  const f = fixture();
  const guestHits = [];
  const host = { id: 'host', pos: {x: 90, y: 11, z: .5}, h: 1.8, dead: false,
    hurt: f.ctx.hurtPlayer, push: f.ctx.pushPlayer };
  const guest = { id: 'guest', pos: {x: .5, y: 11, z: .5}, h: 1.8, dead: false,
    hurt: (...args) => guestHits.push(args), push() {} };
  f.ctx.playerPos = host.pos;
  f.ctx.players = [host, guest];
  const id = f.mobs.spawnAt('warden', 2.5, 11, .5);
  tick(f, 22);
  assert.ok(f.mobs.byId(id), 'host distance must not despawn a creature fighting a guest');
  assert.equal(guestHits.length, 1);
  assert.equal(f.hurt.length, 0);
  assert.equal(f.ctx.playerPos, host.pos, 'target selection must not mutate the caller context');
});

test('an explosion damages every nearby live LAN player once', () => {
  const f = fixture();
  const hits = [[], [], []];
  f.ctx.players = hits.map((rec, i) => ({id: `player${i}`, pos: {x: .5, y: 11, z: i + .5},
    h: 1.8, dead: i === 2, hurt: (...args) => rec.push(args), push() {} }));
  const m = f.mobs.byId(f.mobs.spawnAt('crawler', 2.5, 11, .5));
  f.mobs.blast(m, f.ctx);
  assert.equal(hits[0].length, 1);
  assert.equal(hits[1].length, 1);
  assert.equal(hits[2].length, 0);
  assert.equal(f.hurt.length, 0, 'legacy single-player callback must not double-apply LAN damage');
});

for (const {name, err} of failures) console.error(`FAIL ${name}: ${err.message}`);
console.log(`mob gameplay: ${passed}/${passed + failures.length} passed`);
process.exit(failures.length ? 1 : 0);
