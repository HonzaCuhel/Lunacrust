// The Last Signal: survival progression independent of rendering and save I/O.
// The caller owns creative mode and persistence. Transitions return new state;
// only a successful relay repair mutates the supplied inventory.

import { Container } from './inventory.js';
import { ITEMS, ingredientItems, matchesIngredient } from './items.js';

const CAMPAIGN_KEY = 'the-last-signal';

export const CAMPAIGN_STAGES = Object.freeze([
  {
    planetId: 'earth',
    title: '01 · A Light at Home',
    story: 'The solar storm silenced every relay. At your Earth landing site, a broken receiver still repeats one fragment: "We are here." Rebuild its ground circuit to locate the voice.',
    objective: 'Gather stone and mine iron ore with a stone pickaxe. Repair the Earth relay to recover the Moon route.',
    cost: [{ spec: '#rock', count: 12 }, { spec: 'raw_iron', count: 4 }],
    completionText: 'The receiver lights up. A lunar emergency station has been forwarding the same fragment for weeks. Its coordinates are now in your navigation chart.',
  },
  {
    planetId: 'luna',
    title: '02 · Voices in the Dust',
    story: 'Earth hangs above the silent lunar plains. The emergency station survived the storm, but its coolant escaped. One damaged log mentions a convoy last heard near Mars.',
    objective: 'Mine lunar rock, iron ore and ice ore. Restore the relay coolant and follow the convoy toward Mars.',
    cost: [{ spec: '#rock', count: 16 }, { spec: 'raw_iron', count: 6 }, { spec: 'volatiles', count: 4 }],
    completionText: 'The station warms to life. The convoy did not vanish: it diverted to a Martian transmitter when the network failed. You receive its next heading.',
  },
  {
    planetId: 'mars',
    title: '03 · The Rusted Archive',
    story: 'Dust has filled the Martian transmitter, but its archive still holds the convoy manifest. Families and engineers were traveling together. Their final message was routed through Venus.',
    objective: 'Build a furnace and smelt iron. Reinforce the Mars relay to retrieve the archived Venus coordinates.',
    cost: [{ spec: '#rock', count: 20 }, { spec: 'iron_ingot', count: 6 }],
    completionText: 'Names scroll across the restored archive. The convoy was carrying parts for a distant refuge. A Venus weather station recorded its last clear transmission.',
  },
  {
    planetId: 'venus',
    title: '04 · Through the Furnace',
    story: 'The Venus station is buried beneath static and heat. Its antenna remembers a message too weak for ordinary circuits: the convoy reached the outer system, but the refuge could not answer.',
    objective: 'Smelt iron and gold for heat-resistant contacts. Repair the Venus relay to isolate the Europa signal.',
    cost: [{ spec: 'iron_ingot', count: 8 }, { spec: 'gold_ingot', count: 2 }],
    completionText: 'The noise resolves into a human voice: "We made it past Europa. Keep the return channel open." The signal is older than you hoped, but it is real.',
  },
  {
    planetId: 'europa',
    title: '05 · Beneath the Silence',
    story: 'Europa reflects a pale blue light. The convoy used this relay to synchronize its refuge beacon. Ice has shifted the receiver out of alignment; void crystals can focus it again.',
    objective: 'Use an iron pickaxe to gather crystals, then supply iron and volatiles. Align the Europa relay to reach Io.',
    cost: [{ spec: 'iron_ingot', count: 10 }, { spec: 'crystal_shard', count: 4 }, { spec: 'volatiles', count: 8 }],
    completionText: 'The crystal array catches a second fragment: "The beacon needs power." A maintenance log points to an emergency generator on Io.',
  },
  {
    planetId: 'io',
    title: '06 · Borrowed Fire',
    story: 'Io shakes beneath your boots. Its generator still feeds the network, but the storm fused its control circuit. Repairing this relay will carry power to the refuge receiver.',
    objective: 'Forge iron and gold contacts and add crystal regulators. Restart the Io relay to recover the Titan frequency.',
    cost: [{ spec: 'iron_ingot', count: 12 }, { spec: 'gold_ingot', count: 4 }, { spec: 'crystal_shard', count: 4 }],
    completionText: 'Power flows through the network for the first time since the storm. Titan holds the backup frequency key; without it, Jupiter cannot distinguish the refuge from the static.',
  },
  {
    planetId: 'titan',
    title: '07 · A Name in the Haze',
    story: 'Under Titan’s orange sky, the backup recorder finally reveals the refuge name: Dawn. Its people have been transmitting a call home. Only Jupiter’s central relay can carry an answer.',
    objective: 'Prepare gold, crystals and volatiles. Restore the Titan relay to decode the final approach to Jupiter.',
    cost: [{ spec: 'gold_ingot', count: 6 }, { spec: 'crystal_shard', count: 6 }, { spec: 'volatiles', count: 12 }],
    completionText: 'The frequency key unlocks. "This is Dawn. If anyone hears us, please answer." Jupiter’s route appears. Your last repair can turn their call into a conversation.',
  },
  {
    planetId: 'jupiter',
    title: '08 · The Answer',
    story: 'Jupiter’s storms surround the central relay. Seven restored stations are waiting behind you. Fit the final circuit and the long chain from Earth to Dawn will carry a voice again.',
    objective: 'Supply the final iron, gold, crystals and volatiles. Restore the Jupiter relay and answer the last signal.',
    cost: [{ spec: 'iron_ingot', count: 16 }, { spec: 'gold_ingot', count: 8 },
      { spec: 'crystal_shard', count: 8 }, { spec: 'volatiles', count: 16 }],
    completionText: 'Across eight worlds, the relays shine. Earth answers: "Dawn, we hear you. You are coming home." You restored the network and found the missing convoy. The Last Signal is complete. Every world remains open for your next adventure.',
  },
].map((stage) => Object.freeze({
  ...stage,
  cost: Object.freeze(stage.cost.map((row) => Object.freeze(row))),
})));

const ROUTE = CAMPAIGN_STAGES.map((stage) => stage.planetId);
const STAGE_BY_PLANET = new Map(CAMPAIGN_STAGES.map((stage) => [stage.planetId, stage]));

/** Fresh identity prevents one survival expedition overwriting another. */
export function createCampaign() {
  return {
    version: 1,
    id: globalThis.crypto.randomUUID(),
    campaignKey: CAMPAIGN_KEY,
    activePlanet: 'earth',
    visited: ['earth'],
    repaired: [],
    completed: false,
  };
}

/**
 * Only retain a consecutive, ordered visit/repair history. A completed flag,
 * a later destination, or a repair without a visit cannot unlock earlier gaps.
 * Revisits change activePlanet, never the first-arrival order in visited.
 */
export function normalizeCampaign(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || raw.version !== 1 || raw.campaignKey !== CAMPAIGN_KEY) return createCampaign();

  const recordedVisits = Array.isArray(raw.visited) ? raw.visited : [];
  const recordedRepairs = Array.isArray(raw.repaired) ? raw.repaired : [];
  const visited = ['earth'], repaired = [];
  for (let index = 0; index < ROUTE.length; index++) {
    const planetId = ROUTE[index];
    if (recordedVisits[index] !== planetId) break;
    if (index > 0) visited.push(planetId);
    if (recordedRepairs[index] !== planetId) break;
    repaired.push(planetId);
  }

  return {
    version: 1,
    id: typeof raw.id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(raw.id)
      ? raw.id : globalThis.crypto.randomUUID(),
    campaignKey: CAMPAIGN_KEY,
    activePlanet: visited.includes(raw.activePlanet) ? raw.activePlanet : visited[visited.length - 1],
    visited,
    repaired,
    completed: repaired.length === ROUTE.length,
  };
}

export function stageFor(planetId) {
  return STAGE_BY_PLANET.get(planetId) ?? null;
}

/** The first unvisited world is reachable only after its predecessor's repair. */
export function canVisit(campaign, planetId) {
  if (!stageFor(planetId)) return false;
  const state = normalizeCampaign(campaign);
  return state.visited.includes(planetId)
    || (ROUTE[state.visited.length] === planetId && state.repaired.length === state.visited.length);
}

export function arrive(campaign, planetId) {
  const state = normalizeCampaign(campaign);
  if (!canVisit(state, planetId)) throw new Error('That destination is locked. Repair the preceding relay first.');
  if (!state.visited.includes(planetId)) state.visited.push(planetId);
  state.activePlanet = planetId;
  return state;
}

function labelFor(spec) {
  if (spec === '#rock') return 'Any rock';
  return ITEMS[ingredientItems(spec)[0]]?.name ?? spec;
}

/** Live inventory totals for mission UI; no mutation or cached item counts. */
export function requirementsFor(campaign, planetId, inventory) {
  const stage = stageFor(planetId);
  if (!stage || normalizeCampaign(campaign).repaired.includes(planetId)) return [];
  return stage.cost.map(({ spec, count }) => ({
    spec,
    label: labelFor(spec),
    count,
    have: (inventory?.slots ?? []).reduce((sum, stack) => sum
      + (stack && Number.isInteger(stack.count) && stack.count > 0
        && matchesIngredient(stack.item, spec) ? stack.count : 0), 0),
  }));
}

/**
 * Plan all removals on copied stacks first. This also prevents one matching
 * stack from paying twice if a future chapter contains overlapping specs.
 */
export function repairRelay(campaign, planetId, inventory) {
  const state = normalizeCampaign(campaign);
  const stage = stageFor(planetId);
  if (!stage || !canVisit(state, planetId) || !state.visited.includes(planetId)) {
    throw new Error('That relay is locked. Visit its world after restoring the preceding relay.');
  }
  if (state.activePlanet !== planetId) throw new Error('Repair the relay on your active world.');
  if (state.repaired.includes(planetId)) throw new Error('This relay is already repaired.');
  if (ROUTE[state.repaired.length] !== planetId) throw new Error('Repair the preceding relay first.');
  if (!(inventory instanceof Container)) throw new Error('Inventory is unavailable.');

  const planned = inventory.slots.map((stack) => stack ? { ...stack } : null);
  for (const { spec, count } of stage.cost) {
    let remaining = count;
    for (let index = 0; index < planned.length && remaining > 0; index++) {
      const stack = planned[index];
      if (!stack || !Number.isInteger(stack.count) || stack.count <= 0
        || !matchesIngredient(stack.item, spec)) continue;
      const take = Math.min(stack.count, remaining);
      stack.count -= take;
      remaining -= take;
      if (stack.count === 0) planned[index] = null;
    }
    if (remaining > 0) throw new Error(`Missing resources: ${labelFor(spec)}.`);
  }

  for (let index = 0; index < planned.length; index++) inventory.set(index, planned[index]);
  state.repaired.push(planetId);
  state.completed = state.repaired.length === ROUTE.length;
  return state;
}

/** Next newly unlocked destination, or null until the current relay is repaired. */
export function nextDestination(campaign) {
  const state = normalizeCampaign(campaign);
  return state.repaired.length === state.visited.length ? ROUTE[state.visited.length] ?? null : null;
}
