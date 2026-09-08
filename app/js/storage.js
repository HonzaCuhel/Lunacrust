// Saves go to the Electron userData folder when running as a desktop app, and
// fall back to localStorage when the same build is opened in a browser.

const KEY = (id) => 'spacemc:save:' + id;
const api = () => (typeof window !== 'undefined' ? window.spaceAPI : null);

export const isDesktop = () => !!api()?.isDesktop;

export async function saveWorld(id, payload) {
  const a = api();
  if (a) return a.saveWorld(id, payload);
  localStorage.setItem(KEY(id), JSON.stringify(payload));
  return true;
}

export async function loadWorld(id) {
  const a = api();
  if (a) return a.loadWorld(id);
  const raw = localStorage.getItem(KEY(id));
  return raw ? JSON.parse(raw) : null;
}

export async function listWorlds() {
  const a = api();
  if (a) return a.listWorlds();
  return Object.keys(localStorage)
    .filter((k) => k.startsWith('spacemc:save:'))
    .map((k) => k.slice('spacemc:save:'.length));
}

export async function deleteWorld(id) {
  const a = api();
  if (a) return a.deleteWorld(id);
  localStorage.removeItem(KEY(id));
  return true;
}

// --------------------------------------------------------------------- guests
// A world you joined over the LAN is somebody else's. It is stored under its own
// namespace so a guest session can never flatten your own mars.json - the path
// from "joined a game" to "overwrote my singleplayer world" simply does not
// exist, because the session layer only ever calls these.
const guestId = (worldUid) => `guest-${String(worldUid).replace(/[^a-z0-9_-]/gi, '').slice(0, 48)}`;

export const saveGuest = (worldUid, payload) => saveWorld(guestId(worldUid), payload);
export const loadGuest = (worldUid) => loadWorld(guestId(worldUid));

export async function listGuests() {
  return (await listWorlds()).filter((id) => id.startsWith('guest-'));
}

/** Planet saves only - the menu must not light up a card for a visited world. */
export async function listOwnWorlds() {
  return (await listWorlds()).filter((id) =>
    !id.startsWith('guest-') && !id.startsWith('checkpoint-') && id !== 'campaign-current');
}

const SETTINGS = 'spacemc:settings';
export function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS)) ?? {}; } catch { return {}; }
}
export function saveSettings(s) {
  localStorage.setItem(SETTINGS, JSON.stringify(s));
}
