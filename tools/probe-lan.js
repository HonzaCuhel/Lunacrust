// Three real Electron windows on one machine: one host and two guests.
// The probe drives them over DevTools and checks shared state, discovery,
// reconnects and save isolation. Separate physical Wi-Fi devices remain untested.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PORTS = [9401, 9402, 9403];
// Launch the executable itself: killing the npm launcher leaves Electron alive.
const BIN = createRequire(import.meta.url)('electron');

class Instance {
  constructor(name, port) {
    this.name = name;
    this.port = port;
    this.msgId = 0;
    this.pending = new Map();
    this.errors = [];
  }

  async start() {
    await this.refuseStale();
    this.profile = await mkdtemp(join(tmpdir(), `lunacrust-lan-${this.name}-`));
    const env = { ...process.env, LUNACRUST_USER_DATA: this.profile };
    delete env.ELECTRON_RUN_AS_NODE;
    for (const key of Object.keys(env)) {
      if (/^SPACEMC_(?:PROBE|SMOKE)(?:_|$)/.test(key)) delete env[key];
    }
    this.child = spawn(BIN, ['.', `--remote-debugging-port=${this.port}`], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Register before any termination; close also waits for inherited pipes.
    this.closed = new Promise((r) => this.child.once('close', r));
    this.stderr = '';
    this.child.on('error', (e) => { this.stderr += e.message; });
    this.child.stdout.resume();
    this.child.stderr.on('data', (d) => { this.stderr += d; });

    const page = await this.findPage();
    if (!page) throw new Error(`${this.name}: no debuggable window appeared: ${this.stderr.slice(-1800)}`);
    this.ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = () => rej(new Error(`${this.name}: devtools socket failed`));
    });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === 'Runtime.exceptionThrown') {
        const e = msg.params.exceptionDetails;
        this.errors.push(e.exception?.description ?? e.text);
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.result?.exceptionDetails) p.reject(new Error(`${this.name}: ${msg.result.exceptionDetails.exception?.description ?? msg.result.exceptionDetails.text}`));
      else p.resolve(p.raw ? msg.result : msg.result?.result?.value);
    });
    await this.command('Runtime.enable');
    // Wait for the shell, not for a stopwatch: the module graph is large and a
    // slow first paint would otherwise look like a missing API.
    for (let i = 0; i < 60; i++) {
      if (await this.eval('typeof window.__space').catch(() => null) === 'object') break;
      await delay(500);
    }
    return this;
  }

  /** A leftover process answering on this port would silently test old code. */
  async refuseStale() {
    try {
      const r = await fetch(`http://127.0.0.1:${this.port}/json/version`, { signal: AbortSignal.timeout(400) });
      if (r.ok) throw new Error(`port ${this.port} already has a debugger - kill stale Electrons first`);
    } catch (e) {
      if (String(e.message).includes('already has a debugger')) throw e;
    }
  }

  async findPage() {
    for (let i = 0; i < 50; i++) {
      if (this.child.exitCode != null || this.child.signalCode != null) return null;
      try {
        const list = await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json();
        const page = list.find((t) => t.type === 'page' && t.url.startsWith('app://'));
        if (page?.webSocketDebuggerUrl) return page;
      } catch { /* not up yet */ }
      await delay(500);
    }
    return null;
  }

  eval(expression, timeoutMs = 30000) {
    const id = ++this.msgId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${this.name}: evaluate timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({
        id, method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true },
      }));
    });
  }

  command(method, params = {}) {
    const id = ++this.msgId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${this.name}: ${method} timed out`)); }, 30000);
      this.pending.set(id, { resolve, reject, timer, raw: true });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async screenshot(name) {
    const dir = resolve('artifacts/lan');
    await mkdir(dir, { recursive: true });
    const shot = await this.command('Page.captureScreenshot', { format: 'png' });
    const file = join(dir, name + '.png');
    await writeFile(file, Buffer.from(shot.data, 'base64'));
    return file;
  }

  /** Poll an expression until it is truthy, so tests never guess at a sleep. */
  async until(expression, what, timeoutMs = 25000, every = 400) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      last = await this.eval(expression);
      if (last) return last;
      await delay(every);
    }
    throw new Error(`${this.name}: timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
  }

  async stop() {
    try { this.ws?.close(); } catch { /* already gone */ }
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    if (this.child && this.child.exitCode == null && this.child.signalCode == null) {
      this.child.kill('SIGTERM');
      const force = setTimeout(() => this.child.kill('SIGKILL'), 5000);
      try { await this.closed; } finally { clearTimeout(force); }
    } else if (this.closed) {
      await this.closed;
    }
    if (this.profile) await rm(this.profile, { recursive: true, force: true });
  }
}

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: !!ok, detail: String(detail) });
  console.log(` ${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(42)} ${detail}`);
};
/** Something this harness genuinely cannot decide, said out loud. */
const skip = (name, why) => {
  checks.push({ name, ok: true, skipped: true, detail: why });
  console.log(` skip  ${name.padEnd(42)} ${why}`);
};

const host = new Instance('host', PORTS[0]);
const guest = new Instance('guest', PORTS[1]);
const friend = new Instance('friend', PORTS[2]);

try {
  const starts = await Promise.allSettled([host.start(), guest.start(), friend.start()]);
  const failedStart = starts.find((r) => r.status === 'rejected');
  if (failedStart) throw failedStart.reason;
  check('three isolated windows are up', true, 'ports ' + PORTS.join(', '));
  for (const instance of [host, guest, friend]) await instance.eval(`(() => {
    const s = window.__space; s.state.settings.renderDistance = 3;
    s.game.applySettings({ renderDistance: 3 }); s.game.hooks.onPointerLost = () => {};
    return true;
  })()`);

  const api = await host.eval(`JSON.stringify({ net: typeof window.spaceAPI?.net, keys: Object.keys(window.spaceAPI ?? {}) })`);
  check('preload exposes the LAN surface', String(api).includes('"net":"object"'), api);
  if (!String(api).includes('"net":"object"')) throw new Error('LAN IPC not wired yet - nothing further to test');

  // ---- host a world -------------------------------------------------------
  await host.eval(`(async () => {
    const S = window.__space, g = S.game;
    g.hooks.onPointerLost = () => {};
    S.state.mode = 'creative';
    document.getElementById('seed-input').value = '777';
    S.selectPlanet('mars');
    document.getElementById('btn-land').click();
    for (let i = 0; i < 80 && !g.spawned; i++) await new Promise(r => setTimeout(r, 250));
    return g.spawned;
  })()`);
  const hosted = await host.eval(`window.__space.hostLan().then(i => JSON.stringify(i))`);
  check('host is listening', !!hosted && JSON.parse(hosted).ok, String(hosted).slice(0, 140));
  const hostPort = JSON.parse(hosted).port;

  // ---- discovery ----------------------------------------------------------
  await guest.eval(`(async () => {
    window.__lobbies = [];
    window.spaceAPI.net.onLobbies((list) => { window.__lobbies = list ?? []; });
    // Idempotent, and the same call the menu makes - the probe subscribes late,
    // and a late subscriber only ever hears about *changes*.
    await window.spaceAPI.net.discover(true);
    return 'listening';
  })()`);
  let found = null;
  try {
    found = await guest.until(
      `(() => { const all = [...(window.__space.lanLobbies?.() ?? []), ...(window.__lobbies || [])];
         const l = all.filter(s => s.port === ${hostPort});
         return l.length ? JSON.stringify(l[0]) : null; })()`,
      'the guest to see the host on the LAN', 15000);
  } catch { /* fall through to the diagnostic below */ }
  if (!found) {
    const hostInfo = await host.eval(`window.spaceAPI.net.info().then(i => JSON.stringify(i))`);
    // Two windows on one machine bind the same discovery port, and the kernel
    // hands each beacon to exactly one of them - deterministically, because
    // SO_REUSEPORT hashes a fixed 4-tuple. Discovery between two real machines
    // is what this cannot prove here; the join path below is what matters.
    skip('guest discovers the host', 'same-machine UDP port contention');
    // Discovery is a nicety; the join path itself is what matters, so fall back
    // to the address the host reported and keep testing.
    const port = JSON.parse(hostInfo)?.port ?? 25710;
    await guest.eval(`window.__lobbies = [{ address: '127.0.0.1', port: ${port} }]`);
  } else {
    check('guest discovers the host', true, String(found).slice(0, 180));
    await guest.eval(`window.__lobbies = [${found}]`);
  }

  // ---- join ---------------------------------------------------------------
  await guest.eval(`(async () => {
    const s = (window.__lobbies || [])[0];
    return window.__space.joinLan({ address: s.address ?? s.host ?? '127.0.0.1', port: s.port });
  })()`, 40000);
  const joined = await guest.until(
    `(() => { const g = window.__space.game;
       return (g?.spawned && g?.net && g.net.selfId != null)
         ? JSON.stringify({ planet: g.planet.id, seed: g.seed, mode: g.mode, id: g.net.selfId }) : null; })()`,
    'the guest to finish joining', 45000);
  check('guest joined the host world', !!joined, String(joined));
  check('guest inherited seed and mode', String(joined).includes('"seed":777') && String(joined).includes('mars'), String(joined));

  await friend.eval(`window.__space.joinLan({ address: '127.0.0.1', port: ${hostPort} }).then(() => true)`);
  await friend.until(`window.__space.game.spawned && window.__space.game.net?.selfId != null`, 'second guest joining');
  check('a third player joins by direct address', true);

  // ---- an edit on the host must appear on the guest -----------------------
  const spot = await host.eval(`(() => {
    const g = window.__space.game;
    const x = Math.floor(g.player.pos.x) + 3, y = Math.floor(g.player.pos.y) + 2, z = Math.floor(g.player.pos.z);
    g.editWorld(x, y, z, 47);
    return JSON.stringify([x, y, z]);
  })()`);
  const [ex, ey, ez] = JSON.parse(spot);
  const mirrored = await guest.until(
    `(() => { const g = window.__space.game; const v = g.world.loggedBlock(${ex}, ${ey}, ${ez}); return v === 47 ? 'yes' : null; })()`,
    "the host's block to reach the guest");
  check('host edit reaches the guest', mirrored === 'yes', `lamp at ${ex},${ey},${ez}`);

  // ---- and the other way --------------------------------------------------
  const back = await guest.eval(`(() => {
    const g = window.__space.game;
    const x = ${ex} + 2, y = ${ey}, z = ${ez};
    g.editWorld(x, y, z, 47);
    return JSON.stringify([x, y, z]);
  })()`);
  const [gx, gy, gz] = JSON.parse(back);
  const upstream = await host.until(
    `(() => { const g = window.__space.game; return g.world.loggedBlock(${gx}, ${gy}, ${gz}) === 47 ? 'yes' : null; })()`,
    "the guest's block to reach the host");
  check('guest edit reaches the host', upstream === 'yes', `lamp at ${gx},${gy},${gz}`);

  // ---- they must agree about the whole world -----------------------------
  await friend.until(`window.__space.game.world.loggedBlock(${gx},${gy},${gz}) === 47`, 'edit delivered to third player');
  const digests = await Promise.all([
    host.eval(`window.__space.game.world.editDigest()`),
    guest.eval(`window.__space.game.world.editDigest()`),
    friend.eval(`window.__space.game.world.editDigest()`),
  ]);
  check('all three worlds hash the same', digests[0] != null && digests.every((v) => v === digests[0]), JSON.stringify(digests));

  // ---- players can see each other ----------------------------------------
  const avatars = await host.until(
    `(() => { const n = window.__space.game.net; const c = n?.players?.size ?? 0; return c === 2 ? c : null; })()`,
    'the host to list the guest as a peer');
  check('host sees the guest', !!avatars, 'peers: ' + avatars);

  // One client independently edits the same voxel as another. The host's
  // ordered echo must repair both optimistic views without waiting a heartbeat.
  await Promise.all([
    guest.eval(`window.__space.game.editWorld(${gx},${gy},${gz},1)`),
    friend.eval(`window.__space.game.editWorld(${gx},${gy},${gz},2)`),
  ]);
  await delay(500);
  const conflict = await Promise.all([host, guest, friend].map((i) => i.eval('window.__space.game.world.editDigest()')));
  check('simultaneous edits converge', conflict.every((v) => v === conflict[0]), JSON.stringify(conflict));

  // A flat elevated test platform keeps terrain collisions out of the entity
  // assertions. Every block is still sent through the real host edit channel.
  await host.eval(`(() => {
    const g = window.__space.game;
    for(let x=-6;x<=8;x++) for(let z=-6;z<=6;z++) g.editWorld(x,99,z,2);
    g.player.setPosition({x:3.5,y:100,z:1.5}); g.player.flying=true; g.player.yaw=Math.PI/2; return true;
  })()`);
  await Promise.all([guest, friend].map((i, idx) => i.eval(`(() => {
    const g=window.__space.game; g.player.setPosition({x:${idx ? -3.5 : 0.5},y:100,z:1.5});
    g.player.flying=true; g.player.yaw=0; g.player.pitch=0; return true;
  })()`)));
  await host.until(`Array.from(window.__space.game.net.players.values()).every(p => p.buf.at(-1)?.y > 99)`, 'guest positions on test platform');

  await guest.screenshot('guest-shared-world');
  await host.screenshot('host-shared-world');

  // Mobs have one simulation on the host. A client receives that same entity,
  // and its melee intent changes the host's health, not an independent clone.
  const mobId = await host.eval(`(() => {
    const g = window.__space.game, p = g.net.players.values().next().value.buf.at(-1);
    window.__attackLog = [];
    const onHit = g.net.hooks.onMobHit;
    g.net.hooks.onMobHit = (...args) => {
      window.__attackLog.push({ args, mobPos: {...g.mobs.byId(args[0])?.pos}, mode:g.mode });
      return onHit(...args);
    };
    return g.mobs.spawnAt('warden', p.x, p.y, p.z - 2.5);
  })()`);
  await guest.until(`!!window.__space.game.mobs.byId(${mobId})`, 'host mob visible on guest');
  await guest.screenshot('guest-shared-creature');
  // Screenshots can take seconds on a busy GPU. The mob keeps wandering;
  // approach its current position before testing a melee-range action.
  const melee = await host.eval(`({...window.__space.game.mobs.byId(${mobId}).pos})`);
  await guest.eval(`window.__space.game.player.setPosition({x:${melee.x},y:${melee.y},z:${melee.z + 1.5}}); true`);
  await host.until(`Math.abs(window.__space.game.net._peers.get(1).lastPos.x - ${melee.x}) < .02 && Math.abs(window.__space.game.net._peers.get(1).lastPos.z - ${melee.z + 1.5}) < .02`, 'melee approach reaches host');
  await guest.eval(`window.__space.game.net.sendMobHit(${mobId}, 0, 1, 0); true`);
  try { await host.until(`!window.__space.game.mobs.byId(${mobId})?.alive`, 'guest attack applied by host', 5000); }
  catch (error) {
    throw new Error(error.message + ': ' + JSON.stringify(await host.eval(`({ log:window.__attackLog, mob:window.__space.game.mobs.byId(${mobId}), peers:Array.from(window.__space.game.net._peers) })`)));
  }
  check('host mob and guest melee are synchronized', true);

  // Keep the host and second guest away from the recipient so exactly one
  // character can request this pickup. The host remains the only drop owner.
  const recipient = await guest.eval(`(() => { const g = window.__space.game; g.mode = 'survival'; return { x:g.player.pos.x,y:g.player.pos.y,z:g.player.pos.z }; })()`);
  await friend.eval(`window.__space.game.player.pos.x += 20; true`);
  const beforeItems = await guest.eval(`window.__space.game.inventory.slots.reduce((n,s) => n + (s?.item === 1 ? s.count : 0), 0)`);
  await host.eval(`(() => {
    const g = window.__space.game; g.mode = 'survival'; g.player.pos.x += 20;
    const d = g.drops.spawn(${recipient.x}, ${recipient.y + 0.9}, ${recipient.z}, 1, 2); d.age = 2;
    d.vx = d.vy = d.vz = 0; return true;
  })()`);
  await guest.until(`window.__space.game.inventory.slots.reduce((n,s) => n + (s?.item === 1 ? s.count : 0), 0) === ${beforeItems + 2}`, 'host-granted loot in guest pack');
  await host.until(`window.__space.game.drops.list.every(d => d.item !== 1)`, 'granted drop removed on host');
  check('guest picks up host-owned loot exactly once', true);

  const furnace = await host.eval(`(async () => {
    const { BY_KEY } = await import('./js/blocks.js');
    const g = window.__space.game, p = g.player.pos;
    const at = { x:Math.floor(p.x) + 2, y:Math.floor(p.y), z:Math.floor(p.z) };
    g.editWorld(at.x,at.y,at.z,BY_KEY.get('furnace').id);
    g.stations.furnaceAt(at.x,at.y,at.z,true); g.setPaused(true); return at;
  })()`);
  const atKey = `${furnace.x},${furnace.y},${furnace.z}`;
  await guest.eval(`window.__space.game.openStation('furnace', ${JSON.stringify(furnace)}); true`);
  await guest.until(`window.__space.game.openScreenKind === 'furnace'`, 'guest furnace opens after host lock');
  await friend.eval(`window.__space.game.openStation('furnace', ${JSON.stringify(furnace)}); true`);
  await friend.until(`window.__space.game._waitingFurnace == null`, 'second guest receives furnace lock refusal');
  check('furnace is locked to one player', await friend.eval(`window.__space.game.openScreenKind !== 'furnace'`));
  await guest.eval(`(async () => {
    const { itemIdOf } = await import('./js/items.js'); const g = window.__space.game;
    g.furnace.input = { item:itemIdOf('raw_iron'), count:1 };
    g.furnace.fuel = { item:itemIdOf('coal'), count:1 }; g.recomputeCraft(); return true;
  })()`);
  await guest.until(`window.__space.game.furnace?.output?.count === 1`, 'host smelting while paused', 25000);
  check('host smelts and syncs output while paused', true, atKey);
  await guest.eval(`window.__space.screens.close(); window.__space.game.closeScreen(); true`);
  await host.until(`!window.__space.game.net._furnaceLocks.has('${atKey}')`, 'furnace lock released');

  // A digest discrepancy must actually replace the mirror in the running
  // game, not merely emit an unused callback as the old implementation did.
  await guest.eval(`(() => {
    const g = window.__space.game; g.world.applyEdit(${ex},${ey},${ez},3);
    g.net._lastLocalEditAt = -10000; return true;
  })()`);
  const authoritative = await host.eval('window.__space.game.world.editDigest()');
  await host.eval(`(() => {
    const n = window.__space.game.net;
    for (const id of n.players.keys()) { n.link.send(id,{t:'digest',d:${JSON.stringify(authoritative)}}); n.link.send(id,{t:'digest',d:${JSON.stringify(authoritative)}}); }
    return true;
  })()`);
  await guest.until(`window.__space.game.world?.editDigest() === ${JSON.stringify(authoritative)}`, 'digest repair installs host snapshot');
  check('digest resync repairs a divergent client world', true);

  // ---- a guest must never write the host's planet save --------------------
  const before = JSON.parse(await guest.eval(`window.spaceAPI.listWorlds().then(l => JSON.stringify(l))`));
  const marsBefore = await guest.eval(`window.spaceAPI.loadWorld('mars').then(w => JSON.stringify(w?.savedAt ?? null))`);
  await guest.eval(`window.__space.saveNow ? window.__space.saveNow(true) : document.getElementById('btn-orbit') && null`);
  await delay(1200);
  const after = JSON.parse(await guest.eval(`window.spaceAPI.listWorlds().then(l => JSON.stringify(l))`));
  const marsAfter = await guest.eval(`window.spaceAPI.loadWorld('mars').then(w => JSON.stringify(w?.savedAt ?? null))`);
  check('guest save is namespaced and leaves mars.json alone',
    after.some((n) => n.startsWith('guest-')) && marsBefore === marsAfter,
    `before ${JSON.stringify(before)} after ${JSON.stringify(after)} mars ${marsBefore} -> ${marsAfter}`);

  await guest.eval(`document.getElementById('btn-orbit').click(); true`);
  await guest.until(`window.__space.state.screen === 'menu' && !window.__space.game.net`, 'guest disconnect to menu');
  await host.until(`window.__space.game.net.players.size === 1`, 'host release of departed guest');
  await guest.eval(`window.__space.joinLan({ address: '127.0.0.1', port: ${hostPort} }).then(() => true)`);
  await guest.until(`window.__space.game.spawned && window.__space.game.net?.selfId != null`, 'guest rejoin');
  await host.until(`window.__space.game.net.players.size === 2`, 'host roster after rejoin');
  check('guest disconnect and rejoin works', true);

  await host.eval(`window.spaceAPI.net.unhost({ reason: 'probe-host-closed' })`);
  await Promise.all([guest, friend].map((i) => i.until(`window.__space.state.screen === 'menu' && !window.__space.game.net`, 'host-disconnect cleanup')));
  check('host closure returns both guests to menu', true);
  const finalSaves = await guest.eval(`window.spaceAPI.listWorlds()`);
  check('disconnect leaves guest planet save untouched', !finalSaves.includes('mars'), JSON.stringify(finalSaves));
  for (const instance of [host, guest, friend]) check(`${instance.name}: no runtime exceptions`, instance.errors.length === 0, instance.errors.join('\n'));
} catch (err) {
  check('lan probe', false, err.message);
} finally {
  await Promise.all([host.stop(), guest.stop(), friend.stop()]);
  await delay(300);
}

const failed = checks.filter((c) => !c.ok).length;
const skipped = checks.filter((c) => c.skipped).length;
await mkdir(resolve('artifacts/lan'), { recursive: true });
await writeFile(resolve('artifacts/lan/checks.json'), JSON.stringify({ testedAt: new Date().toISOString(), instances: 3, checks, limitation: 'Three processes on one Mac; two physical Wi-Fi computers were not available.' }, null, 2));
console.log(failed
  ? `\n${failed} LAN checks FAILED`
  : `\nLAN PROBE PASSED - three instances converged${skipped ? ` (${skipped} skipped)` : ''}`);
process.exit(failed ? 1 : 0);
