// Boot the real development or packaged Electron app in a disposable profile.
import { _electron as electron } from 'playwright';
import { mkdtemp, rm, access, readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { listPackage, extractFile } from '@electron/asar';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = process.argv[2] ?? 'dev';
const profile = await mkdtemp(join(tmpdir(), 'lunacrust-bundle-'));
const env = { ...process.env, LUNACRUST_USER_DATA: profile, APPIMAGE_EXTRACT_AND_RUN:'1' };
delete env.ELECTRON_RUN_AS_NODE; delete env.SPACEMC_PROBE; delete env.SPACEMC_SMOKE;
const options = { cwd:root, env, chromiumSandbox:true, timeout:90000, args:[] };
if (target === 'dev') options.args.push(root);
else {
  options.executablePath = target.endsWith('.app') ? join(resolve(target),'Contents','MacOS','Lunacrust') : resolve(target);
  await access(options.executablePath);
}
if (process.env.LUNACRUST_SOFTWARE_RENDERING === '1') options.args.push('--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader');
let app, passed = 0;
function check(name, ok, detail='') {
  if (!ok) throw new Error(`${name}: ${detail}`);
  console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); passed++;
}
try {
  app = await electron.launch(options);
  const page = await app.firstWindow();
  page.on('pageerror', error => console.error('Renderer error:', error.message));
  await page.waitForFunction(() => window.__space?.game && document.querySelectorAll('.card').length === 8);
  check('private application origin', page.url() === 'app://space/index.html', page.url());
  const security = await app.evaluate(({ BrowserWindow, app }) => {
    const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return {sandbox:prefs.sandbox, isolation:prefs.contextIsolation, node:prefs.nodeIntegration, userData:app.getPath('userData'), sandboxDisabled:app.commandLine.hasSwitch('no-sandbox'), version:process.versions.electron, name:app.name, packaged:app.isPackaged, appPath:app.getAppPath(), resourcesPath:process.resourcesPath};
  });
  check('Lunacrust application identity', security.name === 'Lunacrust');
  if (target !== 'dev') {
    check('running the packaged ASAR', security.packaged && security.appPath.endsWith('app.asar'));
    const entries=listPackage(security.appPath).map(path=>path.replaceAll('\\','/'));
    check('prototype audio and developer hooks excluded', !entries.some(path=>/\.mp3$/i.test(path)||/electron\/(probe[^/]*|smoke)\.js$/.test(path)));
    for (const file of ['app/vendor/LICENSE','app/fonts/OFL.txt']) {
      check(`bundled notice: ${file}`, extractFile(security.appPath,join(...file.split('/'))).length>0);
    }
    for (const file of ['LICENSE','THIRD_PARTY_NOTICES.md','electron-LICENSE','LICENSES.chromium.html','three-LICENSE']) {
      check(`runtime notice: ${file}`, (await readFile(join(security.resourcesPath,'licenses',file))).length>0);
    }
  }
  check('sandbox and context isolation', security.sandbox && security.isolation && !security.node && !security.sandboxDisabled);
  check('disposable save profile', security.userData === profile);
  check('current Electron runtime', security.version === '44.2.0', security.version);
  check('renderer has no Node globals', await page.evaluate(() => typeof require === 'undefined' && typeof process === 'undefined'));
  const gpu = await page.evaluate(() => {
    const g=window.__space.game;
    return {webgl2:g.renderer.capabilities.isWebGL2, renderer:g.renderer.getContext().getParameter(0x1F01)};
  });
  check('WebGL2 context', gpu.webgl2, gpu.renderer);
  const resources = await page.evaluate(async () => {
    const output=[];
    for (const name of ['classic','dark-cave','explore']) {
      const audio=new Audio(`./audio/${name}.wav`);
      const duration=await new Promise(resolve => {
        const timeout=setTimeout(() => resolve(0),10000);
        audio.onloadedmetadata=()=>{clearTimeout(timeout);resolve(audio.duration);};
        audio.onerror=()=>{clearTimeout(timeout);resolve(0);};
      });
      output.push([name,Math.round(duration)]);
    }
    return output;
  });
  check('all bundled soundtracks decode', resources.every(([,duration])=>Number.isFinite(duration)&&duration>0), JSON.stringify(resources));
  await page.evaluate(async () => {
    const api=window.spaceAPI;
    await api.saveWorld('release-probe',{version:1,probe:true});
    if (!(await api.loadWorld('release-probe'))?.probe) throw new Error('save/load failed');
    await api.saveWorld('release-probe',{version:2,probe:true});
    await api.deleteWorld('release-probe');
    if (await api.loadWorld('release-probe') !== null) throw new Error('deleted save resurrected');
  });
  check('save, load and delete IPC', true);
  await page.evaluate(() => {
    const S=window.__space; S.game.hooks.onPointerLost=()=>{};
    S.state.mode='survival'; S.selectPlanet('mars'); document.getElementById('btn-land').click();
  });
  await page.waitForFunction(() => window.__space.game.spawned && window.__space.game.world.chunks.size>=25,{},{timeout:60000});
  const world=await page.evaluate(() => ({chunks:window.__space.game.world.chunks.size,kit:window.__space.game.inventory.count(54)}));
  check('worker streams a playable world', world.chunks>=25, `${world.chunks} chunks`);
  check('survival starter kit', world.kit>=1);
  if (process.env.LUNACRUST_SCREENSHOT) await page.screenshot({path:resolve(process.env.LUNACRUST_SCREENSHOT)});
  console.log(`${target==='dev'?'DEVELOPMENT':'PACKAGED'} BUILD: ${passed} checks passed`);
} catch (error) {
  console.error(error.stack || error.message); process.exitCode=1;
} finally {
  if (app) {
    try { await Promise.race([app.close(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('close timed out')),10000).unref())]); }
    catch { app.process().kill('SIGKILL'); }
  }
  await rm(profile,{recursive:true,force:true});
}
