// Shell: menu -> loading -> play -> pause, plus everything the DOM needs to know
// about the running game. The game itself never touches the DOM; it just calls
// the hooks handed to it here.

import { PLANETS } from './planets.js';
import { Game } from './game.js';
import { Audio } from './audio.js';
import { blockIcon } from './icons.js';
import { itemSprite } from './itemart.js';
import { drawPlanetOrb, drawStarfield } from './planetart.js';
import { BLOCKS } from './blocks.js';
import { ITEMS } from './items.js';
import { GameScreens } from './screens.js';
import { Music } from './music.js';
import { LanMenu, Roster } from './net/lanmenu.js';
import { lanAvailable } from './net/link.js';
import { PROTOCOL, contentHash } from './net/protocol.js';
import { PLANET_BY_ID } from './planets.js';
import * as store from './storage.js';
import { normalizeSettings, DEFAULT_SETTINGS } from './settings.js';

const el = (id) => document.getElementById(id);
const panels = {
  menu: el('screen-menu'),
  loading: el('screen-loading'),
  pause: el('screen-pause'),
  blocks: el('screen-blocks'),
};

const audio = new Audio();
const state = {
  screen: 'menu',
  selected: null,
  saves: new Set(),
  mode: 'survival',
  settings: normalizeSettings(store.loadSettings()),
};
state.mode = state.settings.mode === 'creative' ? 'creative' : 'survival';

const music = new Music({ audio });
music.setVolume(state.settings.musicVolume ?? 0.55);

const game = new Game(el('game'), {
  audio,
  onHud: (h) => queueHud(h),
  onHotbar: (bar, slot) => renderHotbar(bar, slot),
  onProgress: (p) => { el('loading-bar').style.width = Math.round(p * 100) + '%'; },
  onReady: () => onWorldReady(),
  onPointerLost: () => pause(),
  onFly: (on) => toast(on ? 'Suit thrusters engaged' : 'Thrusters off'),
  onLamp: (on) => toast(on ? 'Helmet lamp on' : 'Helmet lamp off'),
  onDebug: (on) => el('debug').classList.toggle('hidden', !on),
  onInventory: () => (game.mode === 'survival' ? game.openInventoryScreen() : openPalette()),
  onOpenScreen: (kind, data) => { screens.open(kind, data); music.duck(true); },
  onTick: (dt, situation) => music.update(dt, situation),
  onCloseScreen: () => closeGameScreen(),
  onScreenRefresh: () => screens.render(),
  onDamage: (e) => flashDamage(e),
  onDeath: (cause) => showDeath(cause),
  onWarning: (kind) => warn(kind),
  onArmourHit: () => flashVisorHit(),
  onPeer: (kind, who) => { toast(kind === 'join' ? `${who} joined` : `${who} left`, 2600); paintRoster(); },
  onChat: (id, text) => { paintRoster(); roster?.addChatLine?.(id, text); },
  onNetDisconnect: (reason) => { void leaveSession(reason ?? 'Host closed the game'); },
});

// ---------------------------------------------------------------------- LAN
let lanMenu = null;
let roster = null;
let hostConnectionInfo = null;

/** The lobby list under the planet grid, and the direct-connect field. */
function buildLanMenu() {
  if (lanMenu || !lanAvailable()) return;
  const host = document.createElement('div');
  host.id = 'lan-browser';
  host.className = 'lan-browser hidden';
  const title = document.createElement('h3');
  title.textContent = 'Games on your network';
  host.appendChild(title);
  const listHost = document.createElement('div');
  host.appendChild(listHost);
  el('screen-menu').insertBefore(host, el('launch-bar'));
  lanMenu = new LanMenu(listHost, globalThis.spaceAPI?.net, {
    toast: (m) => toast(m),
    onJoin: (info) => joinLan(info),
  });
}

/** Open the world you are already playing to the network. */
async function hostLan() {
  if (!lanAvailable()) return toast('LAN play needs the desktop build');
  // Stop listening for other people's games while we run one: a host cannot join
  // itself, and on one machine two browsers bound to the same UDP port fight
  // over every beacon - the kernel hands each datagram to exactly one of them.
  globalThis.spaceAPI?.net?.discover(false);
  const info = await game.hostLan(state.settings.playerName ?? 'Explorer');
  if (!info || info.ok === false) {
    globalThis.spaceAPI?.net?.discover(true);
    return toast(`Could not open to LAN: ${info?.error ?? 'unknown'}`);
  }
  toast(`Open to LAN on port ${info.port} — friends can join from their menu`, 5200);
  hostConnectionInfo = info;
  paintRoster();
  return info;
}

/** Join a discovered (or hand-typed) host. Bypasses planet selection. */
async function joinLan(target) {
  if (!lanAvailable()) return toast('LAN play needs the desktop build');
  toast(`Connecting to ${target.address}:${target.port}…`, 3000);
  game.guestWorld = true;
  const session = game.startGuestSession(async (w) => {
    const planet = PLANET_BY_ID.get(w.planetId) ?? PLANETS[0];
    const away = await store.loadGuest(w.worldUid ?? `${w.planetId}-${w.seed >>> 0}`);
    show('loading');
    game.applySettings(state.settings);
    audio.resume();
    audio.setVolume(state.settings.volume);
    el('loading-title').textContent = `Joining ${w.hostName ?? 'a game'} on ${planet.name}`;
    await game.enter(planet, {
      seed: w.seed, mode: w.mode, time: w.time, edits: w.edits,
      stations: w.stations, drops: w.drops, worldUid: w.worldUid,
      player: away?.player, inventory: away?.inventory, survival: away?.survival,
      armour: away?.armour, hotbar: away?.hotbar,
    }, { keepNet: true });
    music.start();
    paintRoster();
  });
  // lan.js sends this frame the instant the socket opens, and the host answers
  // with `welcome` - which is what resolves the join.
  const res = await globalThis.spaceAPI.net.join({
    address: target.address ?? target.host ?? '127.0.0.1',
    port: target.port,
    hello: {
      t: 'hello',
      proto: PROTOCOL,
      hash: contentHash(),
      name: state.settings.playerName ?? 'Explorer',
      code: target.code ?? null,
    },
  });
  if (!res?.ok) {
    game.stopLan();
    toast(`Join failed: ${res?.error ?? 'no answer'} — broadcast is often blocked on guest wifi, try Direct connect`, 6000);
  }
  return session;
}

/** The player list inside the pause panel. */
function paintRoster() {
  const box = el('pause-roster');
  if (!box) return;
  const address = el('lan-addresses');
  const hosting = game.net?.role === 'host';
  address.classList.toggle('hidden', !hosting);
  if (hosting && hostConnectionInfo) address.textContent = 'Direct connect: ' + (hostConnectionInfo.addresses?.length ? hostConnectionInfo.addresses : ['127.0.0.1']).map(a => `${a}:${hostConnectionInfo.port}`).join('  ·  ');
  el('btn-lan').disabled = !!game.net;
  el('btn-lan').textContent = hosting ? 'Hosting on LAN' : game.net ? 'Connected to LAN' : 'Open to LAN';
  box.classList.toggle('hidden', !game.net);
  if (!game.net) { roster = null; return; }
  if (!roster) {
    roster = new Roster(box, {
      hostName: game.net.role === 'host' ? 'you' : 'host',
      selfId: game.net.selfId,
      isHost: game.net.role === 'host',
    }, {
      onDisconnect: () => { void leaveSession('You left the session'); },
      onChat: (text) => game.net?.sendChat?.(text),
    });
  }
  roster.update?.(game.net.players, game.net.selfId);
}

const screens = new GameScreens({
  audio,
  onChange: () => { game.recomputeCraft(); },
  onClose: () => closeGameScreen(),
  onCraftTake: () => game.onCraftTaken(),
  onQuickCraft: (recipe) => { game.quickCraft(recipe); screens.render(); },
});

function closeGameScreen() {
  if (!screens.isOpen()) return;
  music.duck(false);
  screens.close();
  game.closeScreen();
  if (state.screen === 'play') game.requestPointerLock();
}

// --------------------------------------------------------------------- menu
function gravityRatio(p) { return p.gravity / 9.81; }

function buildMenu() {
  const grid = el('planet-grid');
  grid.innerHTML = '';
  for (const planet of PLANETS) {
    const card = document.createElement('button');
    card.type = 'button';
    card.setAttribute('aria-label', `Explore ${planet.name}`);
    card.className = 'card';
    card.style.setProperty('--planet-glow', planet.orb.glow + '55');
    card.dataset.id = planet.id;

    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 150;
    canvas.style.width = canvas.style.height = '76px';
    canvas.setAttribute('aria-hidden', 'true');
    card.appendChild(canvas);

    const ratio = gravityRatio(planet);
    card.insertAdjacentHTML('beforeend', `
      <h3>${planet.name}</h3>
      <p class="sub">${planet.subtitle}</p>
      <div class="g-row">
        <span>${ratio.toFixed(2)}g</span>
        <span class="g-bar"><i style="width:${Math.min(100, (planet.gravity / 24.79) * 100).toFixed(0)}%"></i></span>
        <span>${planet.temperature}</span>
      </div>
    `);
    if (state.saves.has(planet.id)) {
      card.insertAdjacentHTML('beforeend', '<span class="badge-save">SAVED</span>');
    }

    card.addEventListener('click', () => selectPlanet(planet.id));
    // Double-click is a shortcut for the button the player would have pressed:
    // Continue when there is a save, Land when there is not.
    card.addEventListener('dblclick', () => land(state.saves.has(planet.id)));
    grid.appendChild(card);
    card._canvas = canvas;
    card._planet = planet;
  }
}

function selectPlanet(id) {
  state.selected = PLANETS.find((p) => p.id === id);
  audio.resume();
  audio.ui(true);
  for (const c of document.querySelectorAll('.card')) { c.classList.toggle('selected', c.dataset.id === id); c.setAttribute('aria-pressed', String(c.dataset.id === id)); }
  const p = state.selected;
  el('launch-name').textContent = p.name;
  el('launch-sub').textContent = p.subtitle;
  el('launch-stats').innerHTML = `
    <span class="stat">gravity <b>${p.gravity.toFixed(2)} m/s²</b> · ${gravityRatio(p).toFixed(2)}g</span>
    <span class="stat">jump <b>${jumpPreview(p).toFixed(1)} blocks</b></span>
    <span class="stat">day <b>${Math.round(p.dayLength / 60)} min</b></span>
    <span class="stat">surface <b>${p.temperature}</b></span>
    <span class="stat warn">${p.hazard}</span>`;
  el('btn-land').disabled = false;
  el('btn-continue').hidden = !state.saves.has(p.id);
  drawPlanetOrb(el('launch-orb').getContext('2d'), p, 480, menuT);
}

/** Same maths the player uses, so the menu never promises a jump it can't do. */
function jumpPreview(planet) {
  const g = planet.gravity * 3.2;
  const impulse = Math.max(8.9, Math.sqrt(2 * g * 1.18));
  return (impulse * impulse) / (2 * g);
}

/** Creative / survival switch, built here so index.html stays layout-only. */
function buildModeToggle() {
  const host = document.querySelector('.launch-actions');
  if (!host || document.getElementById('mode-toggle')) return;
  const wrap = document.createElement('div');
  wrap.id = 'mode-toggle';
  wrap.className = 'mode-toggle';
  wrap.innerHTML = `
    <button type="button" data-mode="survival" title="Health, hunger, oxygen, crafting and tool wear">Survival</button>
    <button type="button" data-mode="creative" title="Infinite blocks, no damage, fly freely">Creative</button>`;
  wrap.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    state.mode = btn.dataset.mode;
    state.settings.mode = state.mode;
    store.saveSettings(state.settings);
    audio.ui(true);
    paintModeToggle();
  });
  host.prepend(wrap);
  paintModeToggle();
}

/** A Settings button on the menu itself, next to the build badge. */
function buildSettingsButton() {
  const host = document.querySelector('.menu-meta');
  if (!host || document.getElementById('btn-settings')) return;
  const b = document.createElement('button');
  b.id = 'btn-settings';
  b.type = 'button';
  b.className = 'btn ghost small';
  b.textContent = 'Settings';
  b.addEventListener('click', () => { audio.resume(); audio.ui(true); openSettings(); });
  host.prepend(b);
}

function paintModeToggle() {
  el('mode-description').textContent = state.mode === 'creative' ? 'Creative · unlimited materials. Build without limits.' : 'Survival · craft, build and keep your suit alive.';
  for (const b of document.querySelectorAll('#mode-toggle button')) {
    b.classList.toggle('on', b.dataset.mode === state.mode);
    b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode));
  }
}

let menuT = 0;
let menuRaf = null;
function menuLoop() {
  menuRaf = requestAnimationFrame(menuLoop);
  menuT += state.settings.reducedMotion ? 0 : 0.016;
  const stars = el('stars');
  if (stars.width !== window.innerWidth || stars.height !== window.innerHeight) {
    stars.width = window.innerWidth;
    stars.height = window.innerHeight;
  }
  drawStarfield(stars.getContext('2d'), stars.width, stars.height, menuT);
  if (Math.floor(menuT * 60) % 3 === 0) {
    for (const card of document.querySelectorAll('.card')) {
      drawPlanetOrb(card._canvas.getContext('2d'), card._planet, 150, menuT * 0.35);
    }
    if (state.selected) drawPlanetOrb(el('launch-orb').getContext('2d'), state.selected, 480, menuT * 0.35);
  }
}

// ------------------------------------------------------------------ loading
const TIPS = {
  creative: [
    'Double-tap Space to fly. Hold Ctrl to move fast.',
    'Middle-click a block to copy it into your hand.',
    'Press E for the full block palette.',
    'Low gravity means long jumps - and long falls.',
    'F3 shows coordinates, chunk count and frame time.',
  ],
  survival: [
    'Press E to craft. Place the Fabricator for the 3x3 grid.',
    'Your suit is the clock: refill from canisters or a Life Support Unit.',
    'Frozen volatiles smelt into food and oxygen. They exist on every world.',
    'A pickaxe you cannot afford yet: mine rock with the hand drill first.',
    'Falls hurt by impact speed, so low gravity really is safer.',
    'Smelters need fuel - coal burns longest, planks and sulfur will do.',
  ],
};

let launchInProgress = false;
async function land(useSave, replaceConfirmed = false) {
  const planet = state.selected;
  if (!planet || state.screen === 'loading' || launchInProgress) return;
  if (!useSave && state.saves.has(planet.id) && !replaceConfirmed) {
    el('new-world-warning').textContent = `This replaces your saved expedition on ${planet.name}. Choose Continue to keep exploring it.`;
    el('new-world-dialog').showModal();
    el('btn-cancel-new').focus();
    return;
  }
  launchInProgress = true;
  game.guestWorld = false;
  audio.resume();
  audio.ui(true);
  music.start();

  let save;
  try { save = useSave ? await store.loadWorld(planet.id) : null; }
  catch { launchInProgress = false; toast('Could not read this save. Your file has been kept.'); return; }
  const seedText = el('seed-input').value.trim();
  const seed = save?.seed ?? (seedText ? hashSeed(seedText) : (Math.random() * 2 ** 31) | 0);
  // A saved world keeps the mode it was created in; a fresh landing uses the
  // switch. Saves from before survival existed have no `mode` and are creative -
  // reading the toggle here would convert them and the next autosave would
  // overwrite the original.
  const mode = save ? (save.mode ?? 'creative') : state.mode;

  show('loading');
  el('loading-title').textContent = `Descending to ${planet.name}`;
  el('loading-bar').style.width = '2%';
  const tips = TIPS[mode] ?? TIPS.creative;
  el('loading-fact').textContent = `${planet.facts[Math.floor(Math.random() * planet.facts.length)]} · ${tips[Math.floor(Math.random() * tips.length)]}`;
  drawPlanetOrb(el('loading-orb').getContext('2d'), planet, 180, 0);

  game.applySettings(state.settings);
  audio.setVolume(state.settings.volume);
  try {
    await game.enter(planet, save ? { ...save, mode } : { seed, mode });
    audio.ambience(planet);
  } catch (error) {
    game.dispose(false); show('menu');
    toast(`Expedition could not start: ${error.message}`, 6000);
  } finally { launchInProgress = false; }
}

function hashSeed(text) {
  if (/^-?\d+$/.test(text)) return Number(text) | 0;
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h | 0;
}

function onWorldReady() {
  show('play');
  el('hud').classList.remove('hidden');
  el('loading-bar').style.width = '100%';
  document.activeElement?.blur?.();
  game.requestPointerLock();
  setTimeout(() => {
    if (!game.pointerLocked) toast('Click anywhere to look around');
  }, 350);
  toastPlanet();
  startAutosave();
}

function toastPlanet() {
  const p = game.planet;
  const air = p.atmosphere?.breathable ? 'breathable air' : `suit only · ${p.atmosphere?.label ?? 'no air'}`;
  toast(game.mode === 'survival'
    ? `${p.name} · ${p.gravity.toFixed(2)} m/s² · ${air}`
    : `${p.name} · ${p.gravity.toFixed(2)} m/s² · jump ${game.player.jumpHeight().toFixed(1)} blocks`, 3800);
}

// --------------------------------------------------------------------- hud
let hudPending = null;
let hudLast = 0;
function queueHud(h) {
  hudPending = h;
  const now = performance.now();
  if (now - hudLast < 90) return;
  hudLast = now;
  paintHud(hudPending);
}

/** The sun's altitude, not the raw clock, decides what to call the time. */
function timeLabel(t) {
  const alt = Math.sin(t * Math.PI * 2);
  const rising = Math.cos(t * Math.PI * 2) > 0;
  if (alt > 0.35) return 'day';
  if (alt > 0.04) return rising ? 'dawn' : 'dusk';
  if (alt > -0.12) return 'twilight';
  return 'night';
}

/** Suit vitals / energy / oxygen. Built once, then only the fills change. */
function buildVitals() {
  if (document.getElementById('vitals')) return;
  const box = document.createElement('div');
  box.id = 'vitals';
  box.className = 'hidden';
  box.innerHTML = `
    <div class="pips" id="v-health"></div>
    <div class="pips" id="v-hunger"></div>
    <div class="ox" id="v-oxygen"><i></i><span></span></div>`;
  box.insertAdjacentHTML('afterbegin', '<div class="pips" id="v-armour"></div>');
  for (let i = 0; i < 10; i++) {
    box.querySelector('#v-armour').insertAdjacentHTML('beforeend', '<span class="pip shield"></span>');
    box.querySelector('#v-health').insertAdjacentHTML('beforeend', '<span class="pip heart"></span>');
    box.querySelector('#v-hunger').insertAdjacentHTML('beforeend', '<span class="pip food"></span>');
  }
  el('hud').appendChild(box);
}

/** The helmet you are wearing, seen from inside it. */
function buildVisor() {
  if (document.getElementById('visor')) return;
  const v = document.createElement('div');
  v.id = 'visor';
  v.className = 'hidden';
  for (const cls of ['visor-fog', 'visor-frost', 'visor-hit']) {
    const i = document.createElement('i');
    i.className = cls;
    v.appendChild(i);
  }
  // First child, not last: the crosshair and toasts must paint over the glass.
  el('hud').insertBefore(v, el('hud').firstChild);
}

function paintVisor(h) {
  const v = document.getElementById('visor');
  if (!v) return;
  v.classList.toggle('hidden', !h.helmetTier);
  v.classList.remove('tier-1', 'tier-2', 'tier-3');
  if (h.helmetTier) v.classList.add('tier-' + h.helmetTier);
  v.classList.toggle('fog', h.oxygen < 25 || h.health < 6);
  v.classList.toggle('frost', !!h.cold);
}

let visorHitTimer = null;
function flashVisorHit() {
  const v = document.getElementById('visor');
  if (!v || v.classList.contains('hidden')) return;
  v.classList.add('hit');
  clearTimeout(visorHitTimer);
  visorHitTimer = setTimeout(() => v.classList.remove('hit'), 140);
}

function paintPips(row, value) {
  // Value is 0..20; each telemetry segment covers two points.
  const pips = row.children;
  for (let i = 0; i < pips.length; i++) {
    const fill = Math.max(0, Math.min(1, value / 2 - i));
    pips[i].style.setProperty('--fill', `${fill * 100}%`);
  }
}

function paintVitals(h) {
  const box = document.getElementById('vitals');
  if (!box) return;
  const on = h.mode === 'survival';
  box.classList.toggle('hidden', !on);
  if (!on) return;
  const armourRow = el('v-armour');
  armourRow.classList.toggle('hidden', !h.armour);
  armourRow.classList.toggle('worn', h.armourMinWear < 0.2);
  if (h.armour) paintPips(armourRow, h.armour);
  paintPips(el('v-health'), h.health);
  paintPips(el('v-hunger'), h.hunger);
  const ox = el('v-oxygen');
  const pct = Math.max(0, Math.min(100, h.oxygen));
  ox.classList.toggle('hidden', h.breathable && pct >= 100);
  ox.classList.toggle('low', pct < 25);
  ox.firstElementChild.style.width = pct + '%';
  ox.lastElementChild.textContent = `O₂ ${Math.round(pct)}%`;
}

let flashTimer = null;
function flashDamage(e) {
  let f = document.getElementById('damage-flash');
  if (!f) {
    f = document.createElement('div');
    f.id = 'damage-flash';
    el('hud').appendChild(f);
  }
  f.style.opacity = String(Math.min(0.75, 0.25 + (e.amount ?? 1) * 0.08));
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { f.style.opacity = '0'; }, 130);
}

const WARNINGS = {
  'furnace-busy': 'This smelter is in use by another explorer. Try again when they close it.',
  'oxygen-low': 'Oxygen low — use a canister or get to life support',
  'hunger-low': 'Hunger low — eat something',
  starving: 'Starving',
  'tool-broke': 'Your tool broke',
  'life-support': 'Life support online — oxygen refills nearby',
  'limit-floor': 'Bedrock level — nothing below this but the underside of the world',
  'limit-ceiling': 'Altitude ceiling — this is as high as the suit will take you',
  'armour-broke': 'A piece of your suit broke',
  'void-caught': 'Caught you — there is nothing below the world',
  'build-limit': 'Build limit — you can build from y 1 to y 127',
};
function warn(kind) {
  const msg = WARNINGS[kind];
  if (msg) toast(msg, 2600);
}

let respawnAction = null;
function showDeath(cause) {
  screens.close();
  respawnAction = () => {
    respawnAction = null;
    screens.hideDeath();
    game.reviveSurvival();
    show('play');
    game.setPaused(false);
    game.requestPointerLock();
  };
  screens.showDeath({
    planet: game.planet,
    cause,
    onRespawn: () => respawnAction?.(),
  });
  document.exitPointerLock();
  game.inventoryOpen = true;      // stop the pointer-lock loss from also pausing
  game.setPaused(true);
}

/** The world going black as you fall out of it. */
function paintVoidHaze(h) {
  let v = document.getElementById('void-vignette');
  if (!v) {
    v = document.createElement('div');
    v.id = 'void-vignette';
    el('hud').appendChild(v);
  }
  v.style.opacity = String(h.voidHaze ?? 0);
}

function paintHud(h) {
  paintVitals(h);
  paintVisor(h);
  paintVoidHaze(h);
  const pills = el('status-pills');
  const clock = timeLabel(h.time);
  pills.innerHTML = `
    <span class="pill"><b>${game.planet.name}</b> · ${h.gravity.toFixed(2)} m/s²</span>
    <span class="pill">jump <b>${h.jump.toFixed(1)}</b> blocks · ${clock}</span>
    ${h.flying ? '<span class="pill hot">FLIGHT</span>' : ''}
    ${h.lamp ? '<span class="pill hot">LAMP</span>' : ''}
    ${h.inLiquid ? '<span class="pill hot">SUBMERGED</span>' : ''}
    ${h.limit ? `<span class="pill hot">${h.limit === 'floor' ? 'BEDROCK LEVEL' : 'ALTITUDE CEILING'}</span>` : ''}
    ${h.helmetTier ? `<span class="pill">visor · O₂ −${Math.round((h.armourO2 ?? 0) * 100)}%</span>` : ''}
    ${h.mode === 'survival' && !h.breathable
      ? `<span class="pill ${h.oxygen < 25 ? 'bad' : ''}">suit · ${game.planet.atmosphere?.label ?? 'no air'}</span>`
      : ''}`;

  if (game.debug) {
    el('debug').innerHTML =
      `<b>${h.fps}</b> fps\n` +
      `xyz  ${h.x.toFixed(1)} / ${h.y.toFixed(1)} / ${h.z.toFixed(1)}\n` +
      `vel  ${h.speed.toFixed(2)} m/s  vy ${h.vy.toFixed(2)}\n` +
      `chunks <b>${h.chunks}</b>  tris <b>${(h.tris / 1000).toFixed(0)}k</b>\n` +
      `time ${(h.time * 24).toFixed(1)}h  seed ${game.seed}\n` +
      `mode ${h.mode}  drops ${h.drops}\n` +
      `hp ${h.health.toFixed(1)}  food ${h.hunger.toFixed(1)}  o2 ${Math.round(h.oxygen)}\n` +
      `look ${h.target ?? '-'}`;
  }
}

function renderHotbar(stacks, slot) {
  const box = el('hotbar');
  if (box.childElementCount !== 9) {
    box.innerHTML = '';
    for (let i = 0; i < 9; i++) {
      const d = document.createElement('div');
      d.className = 'slot';
      d.innerHTML = `<span class="num">${i + 1}</span><span class="icon"></span>` +
        '<span class="count"></span><span class="wear"><i></i></span>';
      d.addEventListener('click', () => game.selectSlot(i));
      box.appendChild(d);
    }
  }

  for (let i = 0; i < 9; i++) {
    const d = box.children[i];
    const st = stacks[i] ?? null;
    const icon = d.querySelector('.icon');
    const want = st?.item ?? 0;
    // Only rebuild the canvas when the item actually changes - swapping DOM every
    // frame would throw away the icon cache and stutter.
    if (Number(icon.dataset.item ?? 0) !== want) {
      icon.textContent = '';
      if (want) icon.appendChild(itemSprite(want, 44));
      icon.dataset.item = String(want);
    }
    d.querySelector('.count').textContent = st && st.count > 1 ? String(st.count) : '';

    const wear = d.querySelector('.wear');
    const max = st ? (ITEMS[st.item]?.tool?.durability ?? 0) : 0;
    if (st && max && st.dur != null && st.dur < max) {
      const f = Math.max(0, st.dur / max);
      wear.classList.add('show');
      wear.firstElementChild.style.width = `${Math.round(f * 100)}%`;
      wear.firstElementChild.style.background = f > 0.4 ? '#5fd97a' : f > 0.15 ? '#e8c34a' : '#ff5f5f';
    } else {
      wear.classList.remove('show');
    }
    d.classList.toggle('active', i === slot);
  }

  const name = el('block-name');
  const held = stacks[slot];
  name.textContent = held ? (ITEMS[held.item]?.name ?? '') : '';
  name.classList.toggle('show', !!held);
  clearTimeout(name._t);
  if (held) name._t = setTimeout(() => name.classList.remove('show'), 1400);
}

let toastTimer = null;
function toast(msg, ms = 2200) {
  const t = el('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// ----------------------------------------------------------------- palette
let paletteBuilt = false;
function buildPalette() {
  if (paletteBuilt) return;
  paletteBuilt = true;
  const grid = el('palette-grid');
  // Everything, not just blocks: creative had no way to reach a helmet at all,
  // because armour is not placeable and creative never opens the pack screen.
  const groups = [
    ['Armour', (it) => !!it.armour],
    ['Tools', (it) => it.kind === 'tool'],
    ['Supplies', (it) => it.kind === 'food' || it.kind === 'use' || it.kind === 'material'],
    ['Blocks', (it) => it.kind === 'block'],
  ];
  for (const [title, match] of groups) {
    const items = ITEMS.filter((it) => it && it.id !== 0 && match(it));
    if (!items.length) continue;
    const head = document.createElement('h4');
    head.className = 'palette-group';
    head.textContent = title;
    grid.appendChild(head);
    for (const it of items) {
      const cell = document.createElement('div');
      cell.className = 'palette-item';
      cell.appendChild(itemSprite(it.id, 46));
      const label = document.createElement('span');
      label.textContent = it.name;
      cell.appendChild(label);
      cell.addEventListener('click', () => {
        if (it.armour) {
          const slot = game.equipArmour(it.id);
          toast(slot ? `${it.name} equipped` : `${it.name} does not fit`);
        } else {
          game.setSlotBlock(game.slot, it.id);
          audio.ui(true);
        }
        closePalette();
      });
      grid.appendChild(cell);
    }
  }
}

function openPalette() {
  if (state.screen !== 'play' || game.mode !== 'creative') return;
  buildPalette();
  el('palette-slot').textContent = String(game.slot + 1);
  game.inventoryOpen = true;
  game.setPaused(true);
  document.exitPointerLock();
  show('blocks');
}

function closePalette() {
  if (state.screen !== 'blocks') return;
  game.inventoryOpen = false;
  show('play');
  game.setPaused(false);
  game.requestPointerLock();
}

// ------------------------------------------------------------------- pause
let settingsOnly = false;

/** The same settings panel, reachable before you have landed anywhere. */
function openSettings() {
  settingsOnly = true;
  el('screen-pause').classList.add('settings-only');
  el('pause-title').textContent = 'Settings';
  el('pause-sub').textContent = 'These apply to every world.';
  el('btn-resume').textContent = 'Back';
  show('pause');
  el('btn-resume').focus();
}

function closeSettings() {
  settingsOnly = false;
  el('screen-pause').classList.remove('settings-only');
  el('btn-resume').textContent = 'Resume';
  show('menu');
  el('btn-settings')?.focus();
}

function pause() {
  if (state.screen !== 'play') return;
  settingsOnly = false;
  el('screen-pause').classList.remove('settings-only');
  el('btn-resume').textContent = 'Resume';
  music.duck(true);
  game.setPaused(true);
  document.exitPointerLock?.();
  show('pause');
  el('pause-title').textContent = game.planet.name;
  el('pause-sub').textContent = `${game.planet.subtitle} · seed ${game.seed}`;
}

function resume() {
  music.duck(false);
  show('play');
  game.setPaused(false);
  game.requestPointerLock();
}

async function toOrbit() {
  try { await saveNow(); }
  catch { toast('Save failed. Free disk space and try again; your expedition is still open.', 6500); return; }
  const planetId = game.planet?.id;
  music.stop(); audio.stopAmbience(); stopAutosave();
  game.dispose(false);
  state.saves = new Set(await store.listOwnWorlds());
  buildMenu();
  if (planetId) selectPlanet(planetId);
  show('menu'); paintRoster();
  if (lanAvailable()) globalThis.spaceAPI.net.discover(true);
}

let leaving = false;
async function leaveSession(reason) {
  if (leaving) return;
  leaving = true;
  try { await toOrbit(); toast(reason, 5000); }
  finally { leaving = false; }
}

// ------------------------------------------------------------------ saving
let autosaveTimer = null;
function startAutosave() {
  stopAutosave();
  autosaveTimer = setInterval(() => { if (game.running) saveNow(true).catch(() => toast('Autosave failed. Check free disk space.', 6000)); }, 30000);
}
function stopAutosave() { if (autosaveTimer) clearInterval(autosaveTimer); autosaveTimer = null; }

async function saveNow(quiet = false) {
  const snap = game.snapshot();
  if (!snap) return;
  if (game.net?.role === 'client' || game.guestWorld) {
    // Somebody else's world: keep only this character, under its own key.
    await store.saveGuest(snap.worldUid, {
      version: 3, kind: 'guest', worldUid: snap.worldUid, planetId: snap.planetId,
      seed: snap.seed, mode: snap.mode, player: snap.player, survival: snap.survival,
      inventory: snap.inventory, armour: snap.armour, hotbar: snap.hotbar,
      savedAt: snap.savedAt,
    });
    if (!quiet) toast('Character saved');
    return;
  }
  await store.saveWorld(snap.planetId, snap);
  state.saves.add(snap.planetId);
  if (!quiet) toast('World saved');
}

// ------------------------------------------------------------------ screens
function show(name) {
  state.screen = name;
  for (const [k, node] of Object.entries(panels)) node.classList.toggle('hidden', k !== name);
  el('hud').classList.toggle('hidden', name === 'menu' || name === 'loading');
  if (name === 'menu') {
    if (!menuRaf) menuLoop();
  } else if (menuRaf) {
    cancelAnimationFrame(menuRaf);
    menuRaf = null;
  }
}

// ----------------------------------------------------------------- wiring
el('btn-land').addEventListener('click', () => land(false));
el('btn-cancel-new').addEventListener('click', () => el('new-world-dialog').close());
el('btn-confirm-new').addEventListener('click', () => { el('new-world-dialog').close(); void land(false, true); });
el('btn-continue').addEventListener('click', () => land(true));
el('btn-resume').addEventListener('click', () => (settingsOnly ? closeSettings() : resume()));
el('btn-orbit').addEventListener('click', toOrbit);
el('btn-lan').addEventListener('click', () => hostLan());
el('game').addEventListener('click', () => {
  if (state.screen === 'play' && !game.pointerLocked) game.requestPointerLock();
});

document.addEventListener('keydown', (e) => {
  if (el('new-world-dialog').open) return;
  if (e.code === 'Escape') {
    // The death card has no other way out: without this you cannot pause, save
    // or leave until you click Respawn.
    if (respawnAction) { e.preventDefault(); respawnAction(); return; }
    if (screens.isOpen()) { e.preventDefault(); closeGameScreen(); }
    else if (state.screen === 'blocks') { e.preventDefault(); closePalette(); }
    else if (state.screen === 'pause') { e.preventDefault(); settingsOnly ? closeSettings() : resume(); }
    // Escape used to reach the pause menu only by way of losing pointer lock,
    // so it did nothing at all if the mouse was never captured.
    else if (state.screen === 'play') { e.preventDefault(); pause(); }
    return;
  }
  if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  if (e.code === 'KeyE') {
    if (screens.isOpen()) { e.preventDefault(); closeGameScreen(); return; }
    if (state.screen === 'blocks') { e.preventDefault(); closePalette(); return; }
  }
  if (e.target.closest?.('input, textarea, select, button, [contenteditable]')) return;
  if (state.screen === 'menu') {
    if (e.code === 'Enter' && state.selected) land(state.saves.has(state.selected.id));
    if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
      const i = PLANETS.findIndex((p) => p === state.selected);
      const n = (i + (e.code === 'ArrowRight' ? 1 : PLANETS.length - 1) + PLANETS.length) % PLANETS.length;
      selectPlanet(PLANETS[Number.isFinite(i) && i >= 0 ? n : 0].id);
    }
  }
});

// Settings are normalized on load, reset and persist. Every control applies live.
const rangeBindings = [];
const bindRange = (id, out, key, fmt, apply) => {
  const input = el(id), output = el(out);
  const sync = () => { input.value = state.settings[key]; output.textContent = fmt(state.settings[key]); };
  rangeBindings.push(sync); sync();
  input.addEventListener('input', () => {
    state.settings = normalizeSettings({ ...state.settings, [key]: Number(input.value) });
    output.textContent = fmt(state.settings[key]); apply(state.settings[key]); persistSettings();
  });
};
function persistSettings() {
  try { store.saveSettings(state.settings); }
  catch { toast('Settings could not be saved. Check free disk space.', 5000); }
}
function applyAllSettings() {
  game.applySettings(state.settings);
  audio.setVolume(state.settings.volume); music.setVolume(state.settings.musicVolume);
  document.documentElement.classList.toggle('reduced-motion', state.settings.reducedMotion);
  el('set-name').value = state.settings.playerName;
  el('set-invert').checked = state.settings.invertY;
  el('set-motion').checked = state.settings.reducedMotion;
  for (const sync of rangeBindings) sync();
}
bindRange('set-rd', 'out-rd', 'renderDistance', v => `${v} chunks`, v => game.applySettings({ renderDistance: v }));
bindRange('set-fov', 'out-fov', 'fov', v => `${v}°`, v => game.applySettings({ fov: v }));
bindRange('set-sens', 'out-sens', 'sensitivity', v => `${v.toFixed(1)}×`, v => game.applySettings({ sensitivity: v }));
bindRange('set-scale', 'out-scale', 'renderScale', v => `${v.toFixed(2)}×`, v => game.applySettings({ renderScale: v }));
bindRange('set-vol', 'out-vol', 'volume', v => `${Math.round(v * 100)}%`, v => { audio.resume(); audio.setVolume(v); audio.ui(true); });
bindRange('set-music', 'out-music', 'musicVolume', v => `${Math.round(v * 100)}%`, v => { audio.resume(); music.setVolume(v); if(v > 0) music.start(); });
for (const [id, key] of [['set-invert', 'invertY'], ['set-motion', 'reducedMotion']]) {
  el(id).addEventListener('change', () => { state.settings[key] = el(id).checked; applyAllSettings(); persistSettings(); });
}
el('set-name').addEventListener('change', () => {
  state.settings = normalizeSettings({ ...state.settings, playerName: el('set-name').value });
  el('set-name').value = state.settings.playerName; persistSettings();
});
el('btn-reset-settings').addEventListener('click', () => {
  state.settings = { ...DEFAULT_SETTINGS }; state.mode = state.settings.mode;
  applyAllSettings(); persistSettings(); paintModeToggle(); toast('Default settings restored');
});
for (const tab of document.querySelectorAll('[data-settings-tab]')) tab.addEventListener('click', () => {
  for (const b of document.querySelectorAll('[data-settings-tab]')) { b.classList.toggle('active', b === tab); b.setAttribute('aria-pressed', String(b === tab)); }
  for (const p of document.querySelectorAll('[data-settings-panel]')) p.classList.toggle('hidden', p.dataset.settingsPanel !== tab.dataset.settingsTab);
});
el('btn-fullscreen').addEventListener('click', async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); }
  catch { toast('Fullscreen unavailable. Try F11 in the desktop app.'); }
});
function selectMenuTab(network) {
  el('mission-stage').classList.toggle('hidden', network);
  el('launch-bar').classList.toggle('hidden', network);
  el('network-intro').classList.toggle('hidden', !network);
  el('lan-browser')?.classList.toggle('hidden', !network);
  el('btn-network').classList.toggle('active', network);
  el('btn-expedition').classList.toggle('active', !network);
  if (network && !lanAvailable()) el('network-platform-note').textContent = 'LAN play is available in the desktop app for macOS, Windows and Linux. The browser preview is single-player.';
}
el('btn-network').addEventListener('click', () => selectMenuTab(true));
el('btn-expedition').addEventListener('click', () => selectMenuTab(false));
document.querySelector('.brand').addEventListener('click', e => { e.preventDefault(); selectMenuTab(false); });

// The native shell waits for this save before closing the window. Browser fallback
// is best effort, but it uses the same guest-safe path as autosave.
window.spaceAPI?.onBeforeClose?.(async () => {
  try { await saveNow(true); window.spaceAPI?.confirmClose?.(true); }
  catch { toast('Save failed. Free disk space before closing.', 6000); window.spaceAPI?.confirmClose?.(false); }
});
window.addEventListener('beforeunload', () => { if (game.running) void saveNow(true).catch(() => {}); });

// Handy for debugging from the devtools console (and for automated smoke tests).
window.__space = {
  game, state, audio, music, land, selectPlanet, show, screens,
  hostLan, joinLan, screensOpen: () => screens.isOpen(),
  lanLobbies: () => lanMenu?._lobbies ?? [],
  saveNow,
};

// ------------------------------------------------------------------- boot
(async function boot() {
  for (const id of await store.listOwnWorlds()) state.saves.add(id);
  buildMenu();
  buildModeToggle();
  buildSettingsButton();
  buildLanMenu();
  buildVitals();
  buildVisor();
  selectPlanet(PLANETS[0].id);
  applyAllSettings();
  el('build-badge').textContent = store.isDesktop() ? 'DESKTOP · 1.0.0' : 'BROWSER PREVIEW · 1.0.0';
  show('menu');
})();

// Compact observed state for game-driving tests. Coordinates: +Y up; X/Z ground.
window.render_game_to_text = () => JSON.stringify({
  screen: state.screen, mode: game.mode, planet: game.planet?.id, seed: game.seed,
  paused: game.paused, spawned: !!game.spawned, coordinateSystem: '+Y up, X/Z ground plane',
  player: game.player ? { ...game.player.pos, flying: game.player.flying, grounded: game.player.onGround } : null,
  survival: game.survival?.serialize(), selectedItem: game.heldItem?.(),
  mobs: (() => { const rows=[]; game.mobs?.forEachLive(m => rows.push({id:m.id,type:m.kind,state:m.state,x:m.pos.x,y:m.pos.y,z:m.pos.z,health:m.health})); return rows; })(),
  target: game.target, network: game.net ? { role: game.net.role, peers: game.net.players?.size } : null,
  settings: state.settings,
});
window.advanceTime = async ms => {
  if (!game.running || !game.scene) return;
  const steps = Math.min(600, Math.max(1, Math.round(ms / (1000 / 60))));
  for (let i = 0; i < steps; i++) { if (!game.paused) game.step(1/60); if (i % 30 === 0) await new Promise(r => setTimeout(r, 0)); }
  game.renderer.render(game.scene, game.camera);
};
