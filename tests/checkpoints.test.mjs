import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSaveStore } from '../electron/saves.js';
import * as storage from '../app/js/storage.js';

function memoryStorage() {
  const entries = {};
  Object.defineProperties(entries, {
    getItem: { value: key => Object.hasOwn(entries, key) ? entries[key] : null },
    setItem: { value: (key, value) => { entries[key] = String(value); }, writable: true },
    removeItem: { value: key => { delete entries[key]; } },
  });
  return entries;
}

globalThis.localStorage = memoryStorage();
await storage.saveWorld('mars', { original: true });
await storage.saveWorld('checkpoint-example', { checkpoint: true });
await storage.saveWorld('campaign-current', { campaign: true });
await storage.saveGuest('visited', { guest: true });
assert.deepEqual(await storage.listOwnWorlds(), ['mars'], 'only own planet saves belong in the original world menu');

const checkpoints = await import('../app/js/checkpoints.js').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
for (const name of ['saveCheckpoint', 'listCheckpoints', 'loadCheckpoint', 'renameCheckpoint', 'deleteCheckpoint']) {
  assert.equal(typeof checkpoints[name], 'function', `${name} must be exported`);
}
const { saveCheckpoint, listCheckpoints, loadCheckpoint, renameCheckpoint, deleteCheckpoint } = checkpoints;

const world = (planetId = 'mars', mode = 'survival') => ({
  version: 2, planetId, mode, seed: 17, worldUid: 'local-world', savedAt: 100,
  player: { pos: { x: 10, y: 40, z: -3 }, yaw: .5, pitch: 0, flying: false },
  edits: { '0,0': [[12, 4]] }, inventory: { stacks: [['stone', 12]] },
  survival: { hp: 17, oxygen: 63 }, armour: [['helmet', 1, 42]],
  carried: { craft: [['iron', 2]], cursor: ['copper', 3, null] },
  stations: { '1,40,2': { furnace: { fuel: 7, input: ['iron_ore', 4] } } },
  drops: [{ item: 'stone', count: 2, pos: { x: 8, y: 40, z: 0 } }],
});
const campaign = () => ({
  kind: 'campaign', version: 1, savedAt: 120,
  campaign: { activePlanet: 'mars', completed: ['moon'], progress: { moon: { launch: true } } },
  worlds: { moon: world('moon'), mars: world('mars') },
});

const dir = await mkdtemp(join(tmpdir(), 'lunacrust-checkpoints-'));
try {
  for (const backend of ['browser', 'desktop']) {
    globalThis.localStorage = memoryStorage();
    const disk = backend === 'desktop' ? createSaveStore(dir) : null;
    globalThis.window = disk ? { spaceAPI: {
      isDesktop: true,
      saveWorld: (id, payload) => disk.write(id, payload),
      loadWorld: id => disk.read(id),
      listWorlds: () => disk.list(),
      deleteWorld: id => disk.delete(id),
    } } : {};
    const original = world();
    await storage.saveWorld('mars', original);
    await storage.saveGuest('friends-world', world('earth'));
    await storage.saveWorld('campaign-current', campaign());

    const source = world();
    const saving = saveCheckpoint('  Before launch  ', source);
    source.player.pos.x = 999;
    const first = await saving;
    assert.match(first.id, /^checkpoint-[a-z0-9_-]+$/i);
    assert.ok(first.id.length <= 64);
    assert.equal(first.name, 'Before launch');
    assert.equal(first.planetId, 'mars');
    assert.equal(first.mode, 'survival');
    assert.ok(Number.isFinite(first.savedAt));
    assert.equal((await loadCheckpoint(first.id)).snapshot.player.pos.x, 10, `${backend}: captures input before queued writes`);
    assert.deepEqual((await loadCheckpoint(first.id)).snapshot, world(), 'every snapshot field survives the roundtrip');
    const duplicate = await saveCheckpoint('Before launch', world('venus', 'creative'));
    assert.notEqual(first.id, duplicate.id, 'repeated names create separate immutable save positions');
    const run = campaign();
    const runMeta = await saveCheckpoint('Campaign launch', run);
    run.worlds.moon.player.pos.y = 888;
    assert.equal(runMeta.mode, 'campaign');
    assert.equal(runMeta.planetId, 'mars');
    assert.equal((await loadCheckpoint(runMeta.id)).snapshot.worlds.moon.player.pos.y, 40);
    const listed = await listCheckpoints();
    assert.equal(listed.length, 3);
    assert.ok(listed.every((item, i) => !i || listed[i - 1].savedAt >= item.savedAt), 'newest checkpoints first');
    assert.ok(listed.every(item => !Object.hasOwn(item, 'snapshot')), 'listing returns metadata without heavy worlds');
    listed[0].name = 'mutated listing';
    const loaded = await loadCheckpoint(first.id);
    loaded.snapshot.edits['0,0'][0][1] = 99;
    assert.equal((await loadCheckpoint(first.id)).snapshot.edits['0,0'][0][1], 4, 'loaded data has no shared mutable references');

    const beforeRename = await loadCheckpoint(first.id);
    const renamed = await renameCheckpoint(first.id, '  Launch base  ');
    assert.equal(renamed.name, 'Launch base');
    assert.equal(renamed.savedAt, first.savedAt);
    assert.deepEqual((await loadCheckpoint(first.id)).snapshot, beforeRename.snapshot, 'rename preserves the exact position');
    assert.equal((await loadCheckpoint(duplicate.id)).name, 'Before launch');
    if (disk) {
      assert.equal(JSON.parse(await readFile(join(dir, `${first.id}.bak.json`), 'utf8')).name, 'Before launch');
      await writeFile(join(dir, `${first.id}.json`), '{');
      assert.deepEqual((await loadCheckpoint(first.id)).snapshot, beforeRename.snapshot, 'desktop backup recovers the saved position');
    }

    for (const name of ['', ' \n ', null, 123, 'x'.repeat(81)]) {
      await assert.rejects(saveCheckpoint(name, world()), /name/i);
      await assert.rejects(renameCheckpoint(first.id, name), /name/i);
    }
    const cyclic = world(); cyclic.loop = cyclic;
    for (const payload of [null, [], {}, { ...world(), mode: 'wrong' }, { ...world(), seed: Infinity },
      { ...world(), planetId: '../mars' }, { ...world(), player: {} }, cyclic,
      { ...campaign(), version: 99 }, { ...campaign(), worlds: {} },
      { ...campaign(), worlds: { mars: world('venus') } }]) {
      await assert.rejects(saveCheckpoint('Invalid', payload), /snapshot|payload|campaign/i);
    }
    for (const id of ['mars', 'campaign-current', 'guest-friends-world', 'checkpoint-../mars', 'checkpoint-', 'checkpoint-' + 'x'.repeat(54), null]) {
      await assert.rejects(loadCheckpoint(id), /ID/i);
      await assert.rejects(renameCheckpoint(id, 'Bad target'), /ID/i);
      await assert.rejects(deleteCheckpoint(id), /ID/i);
    }
    assert.equal(await loadCheckpoint('checkpoint-missing'), null);
    await assert.rejects(renameCheckpoint('checkpoint-missing', 'Missing'), /not found/i);

    const corruptId = 'checkpoint-corrupt';
    if (disk) await writeFile(join(dir, `${corruptId}.json`), '{');
    else localStorage.setItem(`spacemc:save:${corruptId}`, '{');
    await storage.saveWorld('checkpoint-malformed', { name: 'No snapshot' });
    const warnings = [];
    const warn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      assert.equal((await listCheckpoints()).length, 3, 'corruption cannot hide healthy checkpoints');
    } finally { console.warn = warn; }
    assert.ok(warnings.some(message => message.includes(corruptId)));
    assert.ok(warnings.some(message => message.includes('checkpoint-malformed')));
    assert.ok((await storage.listWorlds()).includes(corruptId), 'listing never silently deletes corrupt data');
    await assert.rejects(loadCheckpoint(corruptId), /corrupt|unreadable/i);
    await assert.rejects(renameCheckpoint('checkpoint-malformed', 'Rename broken'), /corrupt|invalid/i);
    await deleteCheckpoint(corruptId);
    await deleteCheckpoint('checkpoint-malformed');

    await Promise.all([renameCheckpoint(first.id, 'Queued name'), deleteCheckpoint(first.id)]);
    assert.equal(await loadCheckpoint(first.id), null, 'queued rename/delete does not resurrect a checkpoint');
    if (disk) assert.ok(!(await readdir(dir)).some(file => file.startsWith(first.id)), 'delete removes primary and backup');
    assert.equal((await listCheckpoints()).length, 2);
    assert.deepEqual(await storage.listOwnWorlds(), ['mars']);
    assert.deepEqual(await storage.listGuests(), ['guest-friends-world']);
    assert.deepEqual(await storage.loadWorld('mars'), original);
    assert.deepEqual(await storage.loadGuest('friends-world'), world('earth'));
    assert.deepEqual(await storage.loadWorld('campaign-current'), campaign());

    const failingTarget = disk ? window.spaceAPI : localStorage;
    const method = disk ? 'saveWorld' : 'setItem';
    const originalWrite = failingTarget[method];
    failingTarget[method] = () => { throw new Error('Storage full'); };
    try {
      await assert.rejects(saveCheckpoint('Failed save', world()), /Storage full/);
      await assert.rejects(renameCheckpoint(duplicate.id, 'Failed rename'), /Storage full/);
    } finally { failingTarget[method] = originalWrite; }
    assert.equal((await loadCheckpoint(duplicate.id)).name, 'Before launch', 'failed rename retains the saved entry');
    assert.equal((await listCheckpoints()).length, 2, 'failed create cannot silently displace a checkpoint');

    await deleteCheckpoint(duplicate.id);
    await deleteCheckpoint(runMeta.id);
    const attempts = await Promise.allSettled(Array.from({ length: 51 }, (_, index) => saveCheckpoint(`Position ${index}`, world())));
    assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 50, 'serialized creates enforce the cap');
    assert.match(attempts.find(result => result.status === 'rejected').reason.message, /50|limit/i);
    const capped = await listCheckpoints();
    assert.equal(capped.length, 50);
    await deleteCheckpoint(capped[0].id);
    const replacement = await saveCheckpoint('Freed slot', world());
    assert.equal((await listCheckpoints()).length, 50, 'failed mutation does not poison the queue');
    assert.ok(!capped.some(item => item.id === replacement.id));
    if (disk) await writeFile(join(dir, `${replacement.id}.json`), '{');
    else localStorage.setItem(`spacemc:save:${replacement.id}`, '{');
    await assert.rejects(saveCheckpoint('Cannot evict corrupt position', world()), /50|limit/i);
    assert.ok((await storage.listWorlds()).includes(replacement.id), 'corrupt checkpoints count toward the cap and are not auto-evicted');
    await deleteCheckpoint(replacement.id);
    for (const item of await listCheckpoints()) await deleteCheckpoint(item.id);
    if (disk) await disk.flush();
  }
} finally {
  delete globalThis.window;
  delete globalThis.localStorage;
  await rm(dir, { recursive: true, force: true });
}
console.log('checkpoints: browser/desktop positions, campaign, isolation, cloning, corruption, queue/cap and backups passed');
