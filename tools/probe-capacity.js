// One packaged game host and seven headless NetSessions over real TCP.
// Tests admission and synchronization; does not simulate eight rendering PCs.
import { _electron as electron } from 'playwright';
import net from 'node:net';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { FrameReader, encodeFrame } from '../electron/net/framing.js';
import { NetSession } from '../app/js/net/session.js';
import { EditLog } from '../app/js/editlog.js';
import { contentHash, PROTOCOL } from '../app/js/net/protocol.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = resolve(process.argv[2] ?? 'dist/mac-arm64/Lunacrust.app');
const executable = target.endsWith('.app') ? join(target, 'Contents/MacOS/Lunacrust') : target;
const archive = target.endsWith('.app') ? join(target, 'Contents/Resources/app.asar') : join(dirname(target), 'resources/app.asar');
const output = join(root, 'output/capacity');
const profile = await mkdtemp(join(tmpdir(), 'lunacrust-capacity-'));
const env = { ...process.env, LUNACRUST_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (/^SPACEMC_(PROBE|SMOKE)/.test(key)) delete env[key];
const checks = [], errors = [], peers = [];
let app, movement;
const report = { checkedAt: new Date().toISOString(), target, checks, errors,
  scope: 'One packaged renderer plus seven headless game sessions, real loopback TCP. Not eight physical or rendering clients.' };
function check(name, ok) {
  checks.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) throw new Error(name);
}
async function until(fn, description, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await delay(50); }
  throw new Error(`Timed out: ${description}`);
}
async function connect(port, name) {
  const peer = { log: new EditLog(), chats: [], welcome: null, reason: null, errors: [] };
  peers.push(peer);
  peer.socket = net.createConnection({ host: '127.0.0.1', port });
  peer.closed = new Promise(r => peer.socket.once('close', r));
  peer.socket.on('error', e => peer.errors.push(e.message));
  peer.session = new NetSession({ role: 'client', link: {
    send: (_to, message) => { if (!peer.socket.destroyed) peer.socket.write(encodeFrame(message)); },
    close: () => peer.socket.end(),
  }, hooks: {
    onWelcome: w => { peer.log.load(w.edits); peer.welcome = w; },
    onResync: w => peer.log.load(w.edits),
    applyEdit: (x, y, z, id) => peer.log.set(x, y, z, id),
    digest: () => peer.log.digest,
    onChat: (_id, message) => peer.chats.push(message),
    onDisconnect: reason => { peer.reason = reason; },
  } });
  const reader = new FrameReader();
  peer.socket.on('data', bytes => {
    try { for (const message of reader.push(bytes)) peer.session.handle(0, message); }
    catch (error) { peer.errors.push(error.message); peer.socket.destroy(); }
  });
  await once(peer.socket, 'connect');
  peer.socket.write(encodeFrame({ t: 'hello', proto: PROTOCOL, hash: contentHash(), name, code: null }));
  await until(() => peer.welcome || peer.reason || peer.socket.destroyed, `admission for ${name}`);
  return peer;
}

try {
  await mkdir(output, { recursive: true });
  report.asarSha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
  app = await electron.launch({ executablePath: executable, cwd: root, env, args: [], chromiumSandbox: true, timeout: 90000 });
  const page = await app.firstWindow();
  page.on('pageerror', e => errors.push(e.message));
  await page.waitForFunction(() => window.__space?.game);
  await page.evaluate(() => {
    const S = window.__space;
    S.game.hooks.onPointerLost = () => {};
    S.state.settings.renderDistance = 3;
    S.game.applySettings({ renderDistance: 3 });
    S.state.mode = 'creative'; S.selectPlanet('mars');
    document.getElementById('seed-input').value = '777';
    document.getElementById('btn-land').click();
  });
  await page.waitForFunction(() => window.__space.game.spawned, {}, { timeout: 60000 });
  const host = await page.evaluate(() => window.__space.hostLan());
  check('packaged host listens', host?.ok && Number.isInteger(host.port));
  const guests = [];
  for (let i = 0; i < 7; i++) guests.push(await connect(host.port, `Capacity ${i + 1}`));
  check('seven guests admitted with unique identities', guests.every(p => p.welcome) && new Set(guests.map(p => p.session.selfId)).size === 7);
  check('host records eight players including itself', await page.evaluate(() => window.__space.game.net.players.size === 7));
  const rejected = await connect(host.port, 'Ninth player');
  check('ninth player refused as full', rejected.reason === 'full' && !rejected.welcome);
  const pos = await page.evaluate(() => {
    const p = window.__space.game.player.pos;
    return { x: p.x, y: p.y, z: p.z };
  });
  let moves = 0;
  movement = setInterval(() => {
    moves++;
    guests.forEach((p, i) => p.session.sendMove({ pos: { x: pos.x + i + Math.sin(moves / 12), y: pos.y, z: pos.z + 3 }, yaw: moves / 100, pitch: 0 }, 1));
  }, 65);
  guests.forEach((p, i) => p.session.sendChat(`capacity-check-${i}`));
  await until(() => guests.every(p => new Set(p.chats.filter(s => s.startsWith('capacity-check-'))).size === 7), 'all chat messages arrive');
  check('chat broadcasts to all seven guests', true);
  const spots = guests.map((_, i) => [Math.floor(pos.x) + i, Math.floor(pos.y) + 8, Math.floor(pos.z) + 4, 47]);
  for (let round = 0; round < 10; round++) {
    guests.forEach((p, i) => {
      const [x, y, z] = spots[i], value = round % 2 ? 47 : 0;
      p.log.set(x, y, z, value); p.session.sendEdit(x, y, z, value, 0);
    });
    await delay(150);
  }
  await until(() => guests.every(p => spots.every(([x, y, z, id]) => p.log.get(x, y, z) === id)), 'all edits converge');
  check('final block states converge after 70 edit requests', true);
  check('host world agrees with final edits', await page.evaluate(points => points.every(([x, y, z, id]) => window.__space.game.world.getBlock(x, y, z) === id), spots));
  await until(() => guests.every(p => p.session.players.size === 7), 'all player positions arrive');
  check('every guest receives the other seven player states', true);
  await until(() => moves >= 130, 'sustained movement traffic');
  clearInterval(movement); movement = null;
  report.movementRounds = moves;
  check('all eight players remain connected during traffic', guests.every(p => !p.reason && !p.socket.destroyed) && await page.evaluate(() => window.__space.game.net.players.size === 7));
  const digest = await page.evaluate(() => window.__space.game.net.hooks.digest());
  await until(() => guests.every(p => p.log.digest === digest), 'edit digests agree');
  check('host and all guest edit digests agree', true);
  guests[0].socket.end(); await guests[0].closed;
  await until(() => page.evaluate(() => window.__space.game.net.players.size === 6), 'freed player slot');
  const replacement = await connect(host.port, 'Replacement');
  check('freed slot accepts a replacement player', !!replacement.welcome && replacement.welcome.i !== guests[0].welcome.i);
  check('replacement inherits the full edited world', spots.every(([x, y, z, id]) => replacement.log.get(x, y, z) === id));
  check('no renderer or TCP client errors', errors.length === 0 && peers.every(p => p.errors.length === 0));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__space.state.screen === 'pause');
  await page.screenshot({ path: join(output, 'eight-player-roster.png') });
} catch (error) {
  errors.push(error.stack || error.message); process.exitCode = 1; console.error(error.message);
} finally {
  if (movement) clearInterval(movement);
  for (const p of peers) p.socket.destroy();
  await Promise.all(peers.map(p => p.closed));
  if (app) {
    let closeTimer;
    try { await Promise.race([app.close(), new Promise((_, reject) => { closeTimer = setTimeout(() => reject(new Error('Close timeout')), 10000).unref(); })]); }
    catch {
      const process = app.process();
      if (process.exitCode == null && process.signalCode == null) {
        const closed = once(process, 'close');
        process.kill('SIGKILL'); await closed.catch(() => {});
      }
    }
    finally { clearTimeout(closeTimer); }
  }
  await rm(profile, { recursive: true, force: true });
  report.profileRemoved = true;
  await writeFile(join(output, 'checks.json'), JSON.stringify(report, null, 2) + '\n');
}
