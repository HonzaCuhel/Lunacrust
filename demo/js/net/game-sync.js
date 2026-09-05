// Game-side adapters for host-owned entities. The session owns messages;
// these functions translate them into the existing game systems.
import { ITEMS } from '../items.js';
import { MOB_TYPES } from '../mobtypes.js';
import { WORLD_H, vIndex } from '../worldgen.js';

export function authoritativeBlock(g, x, y, z) {
  if (y < 0 || y >= WORLD_H) return 0;
  if (g.world.isLoaded(x, z)) return g.world.getBlock(x, y, z);
  const logged = g.world.loggedBlock(x, y, z);
  if (logged != null) return logged;
  if (g._netTerrainWorld !== g.world) { g._netTerrainWorld = g.world; g._netTerrain = new Map(); }
  const cx = x >> 4, cz = z >> 4, key = `${cx},${cz}`;
  let voxels = g._netTerrain.get(key);
  if (!voxels) {
    voxels = g.world.gen.generate(cx, cz);
    if (g._netTerrain.size >= 32) g._netTerrain.delete(g._netTerrain.keys().next().value);
    g._netTerrain.set(key, voxels);
  }
  return voxels[vIndex(x - (cx << 4), y, z - (cz << 4))];
}

export function authoritativeWorld(g) {
  return { getBlock: (x, y, z) => authoritativeBlock(g, x, y, z), isLoaded: () => true };
}

export function sharedHooks(g) {
  return {
    inventoryRoomFor: (stack) => g.inventory.roomFor(stack),
    drops: () => ({
      get list() {
        for (const d of g.drops.list) if (!Number.isInteger(d.id)) d.id = g._nextDropId = (g._nextDropId ?? 0) + 1;
        return g.drops.list;
      },
      netFrame(centre, known) {
        const visible = this.list.filter((d) => Math.hypot(d.x - centre.x, d.y - centre.y, d.z - centre.z) < 64);
        const ids = new Set(visible.map((d) => d.id));
        const r = [...known].filter((id) => !ids.has(id));
        known.clear();
        for (const id of ids) known.add(id);
        // Refresh the complete visible set. A dropped low-priority transport
        // frame is repaired on the next tick without losing a delta forever.
        return { a: visible.map(({ id, x, y, z, item, count, dur, age }) => ({ id, x, y, z, item, count, dur, age })), r, all: [...ids] };
      },
    }),
    onDrops: (frame) => {
      const ids = new Set(frame.all ?? frame.a.map((d) => d.id));
      for (let i = g.drops.list.length - 1; i >= 0; i--) {
        if (!ids.has(g.drops.list[i].id)) g.drops.remove(i);
      }
      for (const d of frame.a) {
        if (!Number.isInteger(d.id) || !ITEMS[d.item] || ![d.x, d.y, d.z, d.count].every(Number.isFinite)) continue;
        let local = g.drops.list.find((entry) => entry.id === d.id);
        if (local && local.item !== d.item) { g.drops.remove(g.drops.list.indexOf(local)); local = null; }
        if (!local) local = g.drops.spawn(d.x, d.y, d.z, d.item, d.count, d.dur);
        if (local) { Object.assign(local, d); local.obj.position.set(d.x, d.y, d.z); }
      }
    },
    onGrant: (grant) => {
      const index = g.drops.list.findIndex((d) => d.id === grant.id);
      if (index >= 0) g.drops.remove(index);
      if (g.net?.role !== 'client') return;
      const left = g.inventory.addItem(grant.item, grant.count, grant.dur ?? undefined);
      if (left) g.dropAtPlayer({ item: grant.item, count: left, dur: grant.dur });
      g.pushHotbar();
      g.hooks.audio?.pickup?.();
      if (g.openScreenKind) g.hooks.onScreenRefresh?.();
    },
    onTime: (time) => { if (Number.isFinite(time)) g.sky.time = time; },
    onFurnaceBusy: () => { g._waitingFurnace = null; g.hooks.onWarning?.('furnace-busy'); },
    onFurnaceState: (state) => {
      const [x, y, z] = state.at.split(',').map(Number);
      const rec = g.stations.furnaceAt(x, y, z, true);
      Object.assign(rec, { burn: state.burn, burnMax: state.burnMax, progress: state.progress, lit: state.lit });
      if (state.stacks) Object.assign(rec, state.stacks);
      if (g._waitingFurnace === state.at) {
        g._waitingFurnace = null;
        g.furnace = rec;
        g.openScreen('furnace');
      }
      if (g.openScreenKind === 'furnace') g.hooks.onScreenRefresh?.();
    },
    onResyncNeeded: async (snap) => {
      const own = g.snapshot();
      g.net?.closeFurnace();
      if (g.openScreenKind) g.hooks.onCloseScreen?.();
      await g.enter(g.planet, { ...own, ...snap }, { keepNet: true });
    },
    mobState: () => {
      const list = [];
      g.mobs?.forEachLive((m) => list.push({
        id: m.id, kind: m.kind, pos: { ...m.pos }, yaw: m.yaw, state: m.state,
        health: m.health, alive: m.alive, deathT: m.deathT, hurtT: m.hurtT,
        gait: m.gait, fuse: m.fuse, windup: m.windup,
      }));
      return list;
    },
    onMobState: (list) => {
      const live = new Set(list.map((m) => m.id));
      for (let i = g.mobs.liveN - 1; i >= 0; i--) if (!live.has(g.mobs.live[i].id)) g.mobs._despawn(i);
      for (const entry of list) {
        if (!Number.isInteger(entry.id) || !MOB_TYPES[entry.kind] || ![entry.pos?.x, entry.pos?.y, entry.pos?.z].every(Number.isFinite)) continue;
        const m = g.mobs.byId(entry.id) ?? g.mobs._spawnInternal(entry.kind, entry.pos.x, entry.pos.y, entry.pos.z);
        if (!m) continue;
        Object.assign(m, entry, { pos: { ...entry.pos }, prev: { ...entry.pos }, prevYaw: entry.yaw });
      }
    },
    onMobHit: (id, tool, position, dx, dz) => {
      const mob = g.mobs.byId(id);
      if (!mob || Math.hypot(mob.pos.x - position.x, mob.pos.y - position.y, mob.pos.z - position.z) > 5) return;
      const t = ITEMS[tool]?.tool;
      g.mobs.hit(id, t ? 1 + t.tier + (t.type === 'axe' ? 1 : 0) : 1, dx, dz,
        { ...g.mobContext(), heldToolTier: t?.type === 'pickaxe' ? t.tier : 0 });
    },
    onHurt: (msg) => {
      if (Number.isFinite(msg.amount) && msg.amount > 0) g.applyEvents(g.survival.damage(msg.amount, msg.cause));
      if ([msg.vx, msg.vy, msg.vz].every(Number.isFinite)) {
        g.player.vel.x += msg.vx; g.player.vel.y = Math.max(g.player.vel.y, msg.vy); g.player.vel.z += msg.vz;
      }
    },
  };
}

export function updateGuestDrops(g, dt) {
  for (const d of g.drops.list) {
    d.age += dt;
    d.obj.position.set(d.x, d.y + Math.sin(d.age * 2.4) * 0.04, d.z);
    if (d.obj.isMesh) d.obj.rotation.y += dt * 0.8;
    d.cd = Math.max(0, (d.cd ?? 0) - dt);
    if (!g.dead && g.mode === 'survival' && d.age >= 0.5 && !d.cd
      && Math.hypot(d.x - g.player.pos.x, d.y - g.player.pos.y - 0.9, d.z - g.player.pos.z) < 1.35) {
      g.net.sendGrab(d.id); d.cd = 0.5;
    }
  }
}
