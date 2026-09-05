// Boot the real development or packaged Electron app in a disposable profile.
import { _electron as electron } from 'playwright';
import { mkdtemp, rm, access, readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { listPackage, extractFile } from '@electron/asar';
import { spawnSync } from 'node:child_process';
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
let app, closed, passed = 0, stderr = '';
const rendererErrors = [];
async function bounded(promise, milliseconds, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer=setTimeout(() => reject(new Error(message)),milliseconds); })]); }
  finally { clearTimeout(timer); }
}
function check(name, ok, detail='') {
  if (!ok) throw new Error(`${name}: ${detail}`);
  console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); passed++;
}
try {
  app = await electron.launch(options);
  const child = app.process();
  closed = new Promise(resolve => child.once('close', (code, signal) => resolve({code, signal})));
  child.stdout?.resume();
  child.stderr?.on('data', data => { stderr=(stderr+data).slice(-12000); });
  const page = await app.firstWindow();
  if (process.env.LUNACRUST_SOFTWARE_RENDERING === '1') await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960,600));
  page.on('pageerror', error => { rendererErrors.push(error.message); console.error('Renderer error:', error.message); });
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
  await page.evaluate(software => {
    const S=window.__space; S.game.hooks.onPointerLost=()=>{};
    // Keep the virtual CPU renderer's workload bounded; the same real world,
    // worker and survival startup still have to produce at least 25 chunks.
    if (software) {
      Object.assign(S.state.settings,{renderDistance:3,renderScale:0.75});
      S.game.applySettings({renderDistance:3,renderScale:0.75});
    }
    S.state.mode='survival'; S.selectPlanet('earth'); document.getElementById('btn-land').click();
  }, process.env.LUNACRUST_SOFTWARE_RENDERING === '1');
  await page.waitForFunction(() => window.__space.state.screen === 'play' && window.__space.game.spawned && window.__space.game.world.chunks.size>=25,{},{timeout:60000});
  const world=await page.evaluate(() => ({chunks:window.__space.game.world.chunks.size,kit:window.__space.game.inventory.count(54)}));
  check('worker streams a playable world', world.chunks>=25, `${world.chunks} chunks`);
  check('survival starter kit', world.kit>=1);
  check('survival campaign begins on Earth', await page.evaluate(() => window.__space.campaignActive && window.__space.campaignRun.campaign.activePlanet === 'earth' && window.__space.campaignRun.campaign.visited.length === 1));
  await page.evaluate(async () => {
    const {saveCheckpoint,loadCheckpoint,deleteCheckpoint,listCheckpoints}=await import('./js/checkpoints.js');
    const S=window.__space; S.game.setPaused(true); S.show('pause');
    await S.saveNow(true);
    const saved=await saveCheckpoint('Installer verification',S.campaignRun);
    const loaded=await loadCheckpoint(saved.id);
    if (loaded.snapshot.campaign.id !== S.campaignRun.campaign.id || (await listCheckpoints()).length !== 1) throw new Error('Checkpoint round trip failed');
    await deleteCheckpoint(saved.id);
    if ((await listCheckpoints()).length) throw new Error('Checkpoint deletion failed');
  });
  check('campaign and named checkpoint desktop persistence', true);
  if (process.env.LUNACRUST_SCREENSHOT) await page.screenshot({path:resolve(process.env.LUNACRUST_SCREENSHOT)});
  if (rendererErrors.length) throw new Error(`Renderer errors: ${rendererErrors.join('; ')}`);
} catch (error) {
  console.error(error.stack || error.message); process.exitCode=1;
  if (stderr) console.error('Electron diagnostics:',stderr);
} finally {
  if (app) {
    const child=app.process();
    try {
      await bounded(app.close(),30000,'Application did not close gracefully within 30 seconds');
      const result=await bounded(closed,15000,'Application process did not exit');
      if (result.code !== 0) throw new Error(`Application exited with code ${result.code}, signal ${result.signal}`);
      console.log('PASS graceful application shutdown');
    } catch (error) {
      console.error(error.message); process.exitCode=1;
      if (child.exitCode == null && child.signalCode == null) {
        if (process.platform === 'win32') spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{timeout:10000,stdio:'ignore'});
        else child.kill('SIGKILL');
      }
      await bounded(closed,10000,'Forced application shutdown timed out').catch(error => console.error(error.message));
    }
  }
  // Windows can retain Chromium database handles briefly after process exit.
  // Retry only transient filesystem errors; a persistent lock remains a failure.
  try { await rm(profile,{recursive:true,force:true,maxRetries:8,retryDelay:250}); }
  catch (error) { console.error('Temporary profile cleanup failed:',error.message); process.exitCode=1; }
}
if (!process.exitCode) console.log(`${target==='dev'?'DEVELOPMENT':'PACKAGED'} BUILD: ${passed} checks passed; process exited and temporary profile removed`);
