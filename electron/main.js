// Lunacrust desktop shell. Assets use a private, local-only app:// origin.
import { app, BrowserWindow, protocol, ipcMain, session } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, isAbsolute } from 'node:path';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { attachNet, stopAll } from './net/lan.js';
import { APP_URL, trustWebContents, isAppDocument, isTrustedSender, assertTrustedSender, resolveAsset } from './security.js';
import { createSaveStore, migrateLegacySaves } from './saves.js';

app.setName('Lunacrust');
const isolatedProfile = process.env.LUNACRUST_USER_DATA;
if (isolatedProfile && !isAbsolute(isolatedProfile)) throw new Error('LUNACRUST_USER_DATA must be an absolute path');
const userData = isolatedProfile || join(app.getPath('appData'), 'Lunacrust');
mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);
const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(__dirname, '..', 'app');
const saves = createSaveStore(join(userData, 'saves'));
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8', '.png':'image/png', '.svg':'image/svg+xml', '.woff2':'font/woff2', '.ttf':'font/ttf', '.ogg':'audio/ogg', '.wav':'audio/wav', '.mp3':'audio/mpeg' };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
protocol.registerSchemesAsPrivileged([{ scheme:'app', privileges:{ standard:true, secure:true, supportFetchAPI:true, stream:true } }]);
let win = null;
let quitRequested = false;
const closeReady = new WeakSet(), closeAllowed = new WeakSet(), closePending = new WeakSet();
function createWindow() {
  win = new BrowserWindow({
    width:1440, height:900, minWidth:960, minHeight:600, backgroundColor:'#05060f',
    title:'Lunacrust', show:false, titleBarStyle:process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences:{ preload:join(__dirname, 'preload.cjs'), contextIsolation:true, nodeIntegration:false,
      sandbox:true, webSecurity:true, webviewTag:false, backgroundThrottling:false },
  });
  const current = win;
  trustWebContents(current.webContents);
  current.webContents.setWindowOpenHandler(() => ({ action:'deny' }));
  current.webContents.on('will-navigate', (event, url) => { if (!isAppDocument(url)) event.preventDefault(); });
  current.webContents.on('will-frame-navigate', (event) => { if (!event.isMainFrame || !isAppDocument(event.url)) event.preventDefault(); });
  current.webContents.on('will-attach-webview', event => event.preventDefault());
  current.once('ready-to-show', () => current.show());
  // Developer hooks are excluded from the bundle and require an isolated profile.
  if (!app.isPackaged && isolatedProfile) {
    const hook = (mod, attach) => import(mod).then(attach).catch(err => { console.error(err); app.exit(1); });
    if (process.env.SPACEMC_SMOKE) hook('./smoke.js', m => m.attach(current, process.env.SPACEMC_SMOKE));
    if (process.env.SPACEMC_PROBE === 'survival') hook('./probe-survival.js', m => m.attach(current));
    else if (process.env.SPACEMC_PROBE) hook('./probe.js', m => m.attach(current));
  }
  current.loadURL(APP_URL);
  current.on('close', event => {
    if (closeReady.has(current.webContents) && !closeAllowed.has(current)) {
      event.preventDefault();
      if (!closePending.has(current)) {
        closePending.add(current);
        current.webContents.send('app:before-close');
      }
      return;
    }
    stopAll();
  });
  current.webContents.on('render-process-gone', () => {
    closeAllowed.add(current);
    if (closePending.has(current)) { closePending.delete(current); current.close(); }
  });
  current.on('closed', () => { if (win === current) win = null; });
  current.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') { current.setFullScreen(!current.isFullScreen()); event.preventDefault(); }
    if (input.key === 'F12' || (input.key.toUpperCase() === 'I' && input.control && input.shift)) {
      current.webContents.toggleDevTools(); event.preventDefault();
    }
  });
}
for (const [channel, method] of [['save:write','write'], ['save:read','read'], ['save:list','list'], ['save:delete','delete']]) {
  ipcMain.handle(channel, (event, ...args) => { assertTrustedSender(event); return saves[method](...args); });
}
ipcMain.on('app:close-ready', event => { if (isTrustedSender(event)) closeReady.add(event.sender); });
ipcMain.handle('app:confirm-close', async (event, ok) => {
  assertTrustedSender(event);
  const current = BrowserWindow.fromWebContents(event.sender);
  if (!current || !closePending.has(current)) return false;
  closePending.delete(current);
  if (ok !== true) { quitRequested = false; return false; }
  await saves.flush();
  closeAllowed.add(current);
  if (quitRequested) app.quit(); else current.close();
  return true;
});
app.on('before-quit', () => { quitRequested = true; });
app.on('will-quit', () => stopAll());
app.whenReady().then(async () => {
  // Only the normal profile migrates saves. Probes cannot read or modify real games.
  if (!isolatedProfile) {
    try { await migrateLegacySaves(join(app.getPath('appData'), 'Space Minecraft', 'saves'), join(userData, 'saves')); }
    catch (err) { console.error('Legacy saves could not be copied; originals remain intact:', err.message); }
  }
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(contents === win?.webContents && isAppDocument(contents.getURL()) && permission === 'pointerLock');
  });
  session.defaultSession.setPermissionCheckHandler((contents, permission) =>
    contents === win?.webContents && isAppDocument(contents.getURL()) && permission === 'pointerLock');
  attachNet();
  protocol.handle('app', async request => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status:405 });
    const file = resolveAsset(APP_ROOT, request.url);
    if (!file) return new Response('Forbidden', { status:403 });
    try {
      const body = await readFile(file);
      return new Response(request.method === 'HEAD' ? null : body, { status:200, headers:{
        'content-type':MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'content-length':String(body.byteLength), 'cache-control':'no-store', 'content-security-policy':CSP, 'x-content-type-options':'nosniff',
      } });
    } catch { return new Response('Not found', { status:404 }); }
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}).catch(err => { console.error(err); app.exit(1); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
