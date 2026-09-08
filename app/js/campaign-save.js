// Campaign persistence is separate from Game: worlds keep their terrain and
// landing positions, while the active explorer's possessions travel with them.
import { CAMPAIGN_STAGES, normalizeCampaign, canVisit, arrive } from './campaign.js';
import { MAX_OXYGEN } from './survival.js';

const PLANETS = new Set(CAMPAIGN_STAGES.map(stage => stage.planetId));
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);

function clone(value) {
  try { return JSON.parse(JSON.stringify(value)); }
  catch { throw new Error('Invalid campaign save: data must be serializable.'); }
}

function validateWorld(world, planetId) {
  if (!record(world) || world.version !== 2 || world.mode !== 'survival'
    || !PLANETS.has(planetId) || world.planetId !== planetId
    || !Number.isSafeInteger(world.seed) || !finite(world.time)
    || typeof world.worldUid !== 'string' || !world.worldUid
    || !record(world.player) || !record(world.player.pos)
    || !['x', 'y', 'z'].every(axis => finite(world.player.pos[axis]))
    || !['yaw', 'pitch'].every(axis => world.player[axis] === undefined || finite(world.player[axis]))
    || !record(world.edits) || !Array.isArray(world.inventory) || !Array.isArray(world.armour)
    || !record(world.survival)
    || !['health', 'hunger', 'saturation', 'oxygen', 'burning', 'exertion', 'regen']
      .every(field => finite(world.survival[field]))
    || typeof world.survival.alive !== 'boolean') {
    throw new Error(`Invalid campaign world snapshot: ${planetId}.`);
  }
}

function envelope(raw, allowMissingActive = false) {
  if (!record(raw) || raw.kind !== 'campaign' || raw.version !== 1
    || !finite(raw.savedAt) || raw.savedAt < 0 || !record(raw.worlds)
    || !record(raw.campaign) || raw.campaign.version !== 1
    || raw.campaign.campaignKey !== 'the-last-signal'
    || typeof raw.campaign.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(raw.campaign.id)) {
    throw new Error('Invalid campaign save version or identity.');
  }
  if (!PLANETS.has(raw.campaign.activePlanet)
    || ['visited', 'repaired'].some(field => Array.isArray(raw.campaign[field])
      && raw.campaign[field].some(planetId => !PLANETS.has(planetId)))) {
    throw new Error('Invalid campaign planet.');
  }
  for (const [planetId, world] of Object.entries(raw.worlds)) validateWorld(world, planetId);
  const result = clone(raw);
  result.campaign = normalizeCampaign(result.campaign);
  for (const planetId of result.campaign.visited) {
    if (allowMissingActive && planetId === result.campaign.activePlanet) continue;
    if (!Object.hasOwn(result.worlds, planetId)) {
      throw new Error(`Missing visited campaign world: ${planetId}.`);
    }
  }
  return result;
}

/** Reject unusable persisted worlds; normalize only the campaign's unlock flags. */
export function validateCampaignSave(raw) {
  return envelope(raw);
}

/** The active world may be absent only until its first completed spawn snapshot. */
export function captureCampaign(run, snapshot) {
  const result = envelope(run, true);
  const planetId = result.campaign.activePlanet;
  if (snapshot?.planetId !== planetId) throw new Error('Snapshot does not match the active campaign planet.');
  validateWorld(snapshot, planetId);
  result.worlds[planetId] = clone(snapshot);
  result.savedAt = Date.now();
  return result;
}

function destinationSeed(seed, destination) {
  let mixed = seed | 0;
  for (const char of destination) mixed = Math.imul(mixed ^ char.charCodeAt(0), 16777619);
  return mixed | 0;
}

/**
 * Supply Game.enter with destination terrain plus current portable state.
 * A new world's position is deliberately absent until Game chooses its spawn;
 * captureCampaign must run after that spawn before this envelope is persisted.
 */
export function travelSave(run, destination) {
  const result = validateCampaignSave(run);
  if (!canVisit(result.campaign, destination)) {
    throw new Error('That destination is locked. Repair the preceding relay first.');
  }
  const active = result.worlds[result.campaign.activePlanet];
  const previous = result.worlds[destination];
  const save = previous ? clone(previous) : {
    version: 2,
    planetId: destination,
    seed: destinationSeed(active.seed, destination),
    worldUid: `${destination}-${globalThis.crypto.randomUUID()}`,
    time: 0,
    edits: {},
    stations: { furnaces: [], life: [] },
    drops: [],
  };
  save.mode = 'survival';
  save.inventory = clone(active.inventory);
  save.armour = clone(active.armour);
  save.survival = { ...active.survival, oxygen: MAX_OXYGEN, burning: 0 };
  // Missing carried state is meaningful: an older destination cursor must not
  // resurrect resources the explorer has already used elsewhere.
  delete save.carried;
  if (active.carried !== undefined) save.carried = clone(active.carried);
  save.savedAt = Date.now();
  result.campaign = arrive(result.campaign, destination);
  result.savedAt = save.savedAt;
  if (previous) result.worlds[destination] = clone(save);
  return { run: result, save };
}
