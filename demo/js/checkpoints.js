// Named positions have their own save IDs. The existing backend supplies atomic
// desktop writes/backups and browser localStorage without touching planet saves.
import { saveWorld, loadWorld, listWorlds, deleteWorld } from './storage.js';

const PREFIX = 'checkpoint-';
const LIMIT = 50;
const MAX_NAME = 80;
const MAX_BYTES = 32 * 1024 * 1024;
const slug = value => typeof value === 'string' && /^[a-z0-9_-]{1,64}$/i.test(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
let pending = Promise.resolve();
let sequence = 0;

// Every create/rename/delete shares one queue, including the limit check. A
// rejected write must not prevent subsequent attempts or cleanup.
function mutate(operation) {
  const next = pending.catch(() => {}).then(operation);
  pending = next;
  return next;
}

function checkpointId(id) {
  if (typeof id !== 'string' || !/^checkpoint-[a-z0-9_-]{1,53}$/i.test(id)) {
    throw new Error('Invalid checkpoint ID');
  }
  return id;
}

function checkpointName(name) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > MAX_NAME || /[\u0000-\u001f\u007f]/.test(name.trim())) {
    throw new Error(`Checkpoint name must contain 1–${MAX_NAME} characters`);
  }
  return name.trim();
}

function validateWorld(snapshot) {
  if (!record(snapshot) || !slug(snapshot.planetId) || !['survival', 'creative'].includes(snapshot.mode) ||
      !Number.isFinite(snapshot.seed) || !record(snapshot.player) || !record(snapshot.player.pos) ||
      !['x', 'y', 'z'].every(axis => Number.isFinite(snapshot.player.pos[axis])) || !record(snapshot.edits)) {
    throw new Error('Invalid world snapshot');
  }
}

function validateSnapshot(snapshot) {
  if (snapshot?.kind === 'campaign') {
    if (snapshot.version !== 1 || !record(snapshot.campaign) || !slug(snapshot.campaign.activePlanet) ||
        !record(snapshot.worlds) || !Object.hasOwn(snapshot.worlds, snapshot.campaign.activePlanet)) {
      throw new Error('Invalid campaign snapshot');
    }
    for (const [planetId, world] of Object.entries(snapshot.worlds)) {
      validateWorld(world);
      if (planetId !== world.planetId || world.mode !== 'survival') throw new Error('Invalid campaign world snapshot');
    }
  } else {
    validateWorld(snapshot);
  }
}

function cloneSnapshot(snapshot) {
  validateSnapshot(snapshot);
  let json, copy;
  try {
    json = JSON.stringify(snapshot);
    copy = JSON.parse(json);
  } catch {
    throw new Error('Invalid checkpoint snapshot: payload must be serializable');
  }
  // Match the desktop save ceiling in the browser as well. Leave room for the
  // small checkpoint envelope, which the desktop backend counts too.
  if (new TextEncoder().encode(json).length > MAX_BYTES - 2048) throw new Error('Checkpoint snapshot payload is too large');
  validateSnapshot(copy);
  return copy;
}

function metadata(entry) {
  const campaign = entry.snapshot.kind === 'campaign';
  return {
    id: entry.id,
    name: entry.name,
    planetId: campaign ? entry.snapshot.campaign.activePlanet : entry.snapshot.planetId,
    mode: campaign ? 'campaign' : entry.snapshot.mode,
    savedAt: entry.savedAt,
  };
}

async function readEntry(id) {
  let entry;
  try { entry = await loadWorld(id); }
  catch (error) { throw new Error(`Checkpoint ${id} is unreadable: ${error.message}`, { cause: error }); }
  if (entry === null) {
    // The desktop backend returns null for an unreadable primary AND backup.
    if ((await listWorlds()).includes(id)) throw new Error(`Checkpoint ${id} is corrupt or unreadable`);
    return null;
  }
  try {
    if (!record(entry) || entry.kind !== 'checkpoint' || entry.version !== 1 || entry.id !== id ||
        checkpointName(entry.name) !== entry.name || !Number.isFinite(entry.savedAt) || entry.savedAt < 0) {
      throw new Error('Invalid checkpoint metadata');
    }
    return { ...entry, snapshot: cloneSnapshot(entry.snapshot) };
  } catch (error) {
    throw new Error(`Checkpoint ${id} is corrupt: ${error.message}`, { cause: error });
  }
}

function newId(existing) {
  for (let attempt = 0; attempt < 16; attempt++) {
    const random = globalThis.crypto?.randomUUID?.().replaceAll('-', '').slice(0, 16) ??
      Math.random().toString(36).slice(2, 18);
    const id = `${PREFIX}${Date.now().toString(36)}-${(++sequence).toString(36).padStart(6, '0')}-${random}`;
    if (!existing.has(id)) return checkpointId(id);
  }
  throw new Error('Unable to allocate a unique checkpoint ID');
}

/** Create an independent position, even when another checkpoint has this name. */
export async function saveCheckpoint(name, snapshot) {
  name = checkpointName(name);
  // Capture at invocation, before waiting for earlier disk operations.
  const copy = cloneSnapshot(snapshot);
  return mutate(async () => {
    const existing = new Set(await listWorlds());
    if ([...existing].filter(id => id.startsWith(PREFIX)).length >= LIMIT) {
      throw new Error(`Checkpoint limit (${LIMIT}) reached. Delete a checkpoint before saving another.`);
    }
    const entry = { kind: 'checkpoint', version: 1, id: newId(existing), name, savedAt: Date.now(), snapshot: copy };
    if (await saveWorld(entry.id, entry) === false) throw new Error('Could not save checkpoint');
    return metadata(entry);
  });
}

/** Corrupt entries remain on disk; healthy checkpoints stay accessible. */
export async function listCheckpoints() {
  await pending.catch(() => {});
  const entries = [];
  for (const id of (await listWorlds()).filter(id => id.startsWith(PREFIX))) {
    try {
      checkpointId(id);
      const entry = await readEntry(id);
      if (entry) entries.push(metadata(entry));
    } catch (error) {
      console.warn(`[checkpoints] Ignoring ${id}: ${error.message}`);
    }
  }
  return entries.sort((a, b) => b.savedAt - a.savedAt || b.id.localeCompare(a.id));
}

/** Missing positions return null; unreadable positions throw a diagnostic. */
export async function loadCheckpoint(id) {
  checkpointId(id);
  await pending.catch(() => {});
  const entry = await readEntry(id);
  return entry ? { id: entry.id, name: entry.name, savedAt: entry.savedAt, snapshot: entry.snapshot } : null;
}

/** Change only the selected position's label, retaining its snapshot and time. */
export async function renameCheckpoint(id, name) {
  checkpointId(id);
  name = checkpointName(name);
  return mutate(async () => {
    const entry = await readEntry(id);
    if (!entry) throw new Error('Checkpoint not found');
    entry.name = name;
    if (await saveWorld(id, entry) === false) throw new Error('Could not rename checkpoint');
    return metadata(entry);
  });
}

/** Delete only a selected checkpoint, including its desktop backup. */
export async function deleteCheckpoint(id) {
  checkpointId(id);
  return mutate(async () => {
    if (await deleteWorld(id) === false) throw new Error('Could not delete checkpoint');
    return true;
  });
}
