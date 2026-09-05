// Game: renderer, loop, input, and the glue that turns a planet definition into
// a place you can walk around in.

import * as THREE from '../vendor/three.module.js';
import { World } from './world.js';
import { Sky } from './sky.js';
import { Weather } from './weather.js';
import { Bursts } from './effects.js';
import { Player, EYE_H, PLAYER_W, PLAYER_H } from './player.js';
import { raycastVoxel } from './raycast.js';
import { BLOCKS, BY_KEY, AIR } from './blocks.js';
import { tileBaseColor } from './textures.js';
import { WORLD_H } from './worldgen.js';
import {
  ITEMS, LANDING_KIT, armourOf, blockOfItem, canHarvest, dropFor, isBlockItem,
  isTool, itemIdOf, miningTime,
} from './items.js';
import { ArmourContainer, Container, PlayerInventory } from './inventory.js';
import { ARMOUR_SLOTS, armourStats, wearArmour, wearCost } from './armour.js';
import { Survival } from './survival.js';
import { Stations } from './stations.js';
import { DropEntities } from './drops.js';
import { craftingResult, consumeGrid, layoutFor, matchRecipe } from './recipes.js';
import { canBuildAt, voidPhase } from './limits.js';
import { LimitView } from './limitview.js';
import { NetSession } from './net/session.js';
import { ipcLink, lanAvailable } from './net/link.js';
import { RemoteAvatars } from './net/avatars.js';
import { F, TICK_MS, contentHash } from './net/protocol.js';
import { sharedHooks, updateGuestDrops, authoritativeBlock, authoritativeWorld } from './net/game-sync.js';
import { Mobs } from './mobs.js';
import { MobRender } from './mobrender.js';
import { CrackOverlay } from './crackoverlay.js';
import { stageFor } from './crack.js';
import { matchesIngredient } from './items.js';

const REACH = 6.5;
const REPEAT_PLACE = 0.22;

export class Game {
  constructor(canvas, hooks = {}) {
    this.canvas = canvas;
    this.hooks = hooks;
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, powerPreference: 'high-performance', stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.camera = new THREE.PerspectiveCamera(74, 1, 0.08, 1200);
    this.clock = new THREE.Clock();
    this.running = false;
    this.paused = false;
    this.persistenceBusy = false;
    this.keys = new Set();
    this.mouse = { left: false, right: false };
    this.hotbar = [];
    this.slot = 0;
    this.mining = null;
    this.placeCooldown = 0;
    this.fps = 60;
    this._frames = 0;
    this._fpsT = 0;
    this.settings = { renderDistance: 7, fov: 74, sensitivity: 1, invertY: false };
    this.mode = 'creative';
    this.dead = false;
    this.openScreenKind = null;
    this.cursor = { stack: null };
    this.onResize = () => this.resize();
    window.addEventListener('resize', this.onResize);
    this.bindInput();
  }

  // ------------------------------------------------------------------- enter
  async enter(planet, save, { keepNet = false } = {}) {
    // A guest enters the host's world *because* it just joined; tearing the
    // session down inside dispose() would hang up the call that got us here.
    this._keepNet = keepNet;
    this.dispose(false);
    this._keepNet = false;
    this.planet = planet;
    this.seed = save?.seed ?? (Math.random() * 2 ** 31) | 0;
    this.worldUid = save?.worldUid ?? `${planet.id}-${crypto.randomUUID()}`;

    this.mode = save?.mode === 'survival' ? 'survival' : 'creative';
    this.dead = false;
    this.openScreenKind = null;
    this.cursor.stack = null;

    this.scene = new THREE.Scene();
    this.world = new World(this.scene, planet, this.seed);
    this.world.setRenderDistance(this.settings.renderDistance);
    if (save?.edits) this.world.loadEdits(save.edits);
    this.world.start();

    this.sky = new Sky(this.scene, planet);
    if (save?.time != null) this.sky.time = save.time;
    this.weather = new Weather(this.scene, planet);
    this.bursts = new Bursts(this.scene);

    this.player = new Player(planet);
    const landingSite = this.world.gen.findSpawn(0, 0);
    this.spawnPoint = { ...landingSite };
    this.player.setPosition(save?.player?.pos ?? landingSite);
    if (save?.player) this.player.restore(save.player);
    if (this.mode === 'survival') this.player.flying = false;

    // --- survival systems (created in both modes; inert in creative)
    this.survival = new Survival(planet, save?.survival ?? null);
    if (!this.survival.alive) this.survival.reset();
    // A jump must be survivable on every world, including the one where the suit
    // has to launch you at 13.7 m/s just to clear a single block.
    this.survival.safeImpact = this.player.jumpImpulse + 1.2;
    this.inventory = new PlayerInventory();
    if (save?.inventory) this.inventory.restore(save.inventory);
    else if (this.mode === 'survival') this.giveLandingKit();
    this.armourInv = new ArmourContainer();
    if (save?.armour) this.armourInv.restore(save.armour);
    this.stations = new Stations();
    if (save?.stations) this.stations.restore(save.stations);
    this.craftGrid = new Container(4, 'craft');
    this.craftResult = new Container(1, 'result');
    this.restoreCarried(save?.carried);
    this.drops = new DropEntities(this.scene, this.world.atlas);
    if (save?.drops) this.drops.restore(save.drops, { world: this.world });

    this.hotbar = (save?.hotbar ?? planet.hotbar.map((k) => BY_KEY.get(k).id)).slice(0, 9);
    this.slot = 0;
    this.inventory.selected = 0;
    this.pushHotbar();

    // Suit headlamp. Caves in a voxel world are genuinely pitch black, and a
    // helmet light is both the obvious fix and the thematically right one.
    this.suitLamp = new THREE.PointLight(0xffeccd, 1.15, 18, 1.7);
    this.suitLamp.visible = this.lampOn ?? true;
    this.lampOn = this.suitLamp.visible;
    this.scene.add(this.suitLamp);

    // Up to six placed light blocks near the player get a real point light, so
    // building a lit base actually looks lit.
    this.lightPool = Array.from({ length: 6 }, () => {
      const l = new THREE.PointLight(0xffd9a0, 0, 15, 1.6);
      this.scene.add(l);
      return l;
    });
    this.placedLights = [];
    this.restoreLights();

    // selection wireframe
    const box = new THREE.BoxGeometry(1.002, 1.002, 1.002);
    this.highlight = new THREE.LineSegments(
      new THREE.EdgesGeometry(box),
      new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.55, depthTest: true }),
    );
    this.highlight.visible = false;
    this.scene.add(this.highlight);
    box.dispose();

    if (this.net) this.avatars = new RemoteAvatars(this.scene);
    this.mobs = new Mobs(planet);
    this.mobRender = new MobRender(this.scene, planet);
    this.attackCd = 0;
    this.limitView = new LimitView(this.scene);
    this.crack = new CrackOverlay(this.scene, this.world.atlas);
    this._crackStage = -1;
    this._crackKey = null;

    this.camera.fov = this.settings.fov;
    this.resize();
    this.spawned = false;
    this.loadProgress = 0;
    this.world.update(this.player.pos.x, this.player.pos.z);
    this.running = true;
    this.paused = false;
    this.clock.start();
    this.loop();
  }

  // ------------------------------------------------------------------- input
  bindInput() {
    this._onKeyDown = (e) => {
      if (!this.running || this.paused || this.dead || this.persistenceBusy) return;
      const code = e.code;
      if (code === 'Escape') return;              // handled by the shell
      this.keys.add(code);
      if (code.startsWith('Digit')) {
        const n = Number(code.slice(5));
        if (n >= 1 && n <= 9) this.selectSlot(n - 1);
      }
      if (code === 'KeyF' && this.mode === 'creative') this.setFlying(this.player.toggleFly());
      if (code === 'F3') { this.debug = !this.debug; this.hooks.onDebug?.(this.debug); }
      if (code === 'Space' && this.mode === 'creative') {
        const t = performance.now();
        if (t - (this._lastSpace ?? 0) < 280) this.setFlying(this.player.toggleFly());
        this._lastSpace = t;
      }
      if (code === 'KeyR' && this.mode === 'creative') this.respawn();
      if (code === 'KeyL') this.toggleLamp();
      if (code === 'KeyE') {
        // Both the shell and the inventory UI listen for E on `document` to close
        // themselves. Without stopping the rest of this event's listeners, the
        // very keypress that opens a screen immediately closes it again.
        e.preventDefault();
        e.stopImmediatePropagation();
        this.hooks.onInventory?.();
      }
      if (['KeyW','KeyA','KeyS','KeyD','KeyC','ArrowUp','ArrowDown','ArrowLeft','ArrowRight',
        'Space','ShiftLeft','ShiftRight','ControlLeft','ControlRight','Tab'].includes(code)) e.preventDefault();
    };
    this._onKeyUp = (e) => this.keys.delete(e.code);
    this._onMouseDown = (e) => {
      if (!this.pointerLocked || this.dead || this.paused || this.persistenceBusy) return;
      if (e.button === 0) this.mouse.left = true;
      if (e.button === 2) {
        // Right-click is overloaded: open a station, eat/use what you're holding,
        // or fall through to placing a block. Sneak forces the place.
        const sneaking = this.player.flying
          ? this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')
          : this.keys.has('KeyC');
        if (!sneaking && this.mode === 'survival' && this.target && BLOCKS[this.target.id].interact) {
          this.openStation(BLOCKS[this.target.id].interact, this.target);
          return;
        }
        if (!sneaking && this.useHeldItem()) return;
        this.mouse.right = true;
        this.placeCooldown = 0;
      }
      if (e.button === 1) { this.pickBlock(); e.preventDefault(); }
    };
    this._onMouseUp = (e) => {
      if (e.button === 0) { this.mouse.left = false; this.mining = null; }
      if (e.button === 2) this.mouse.right = false;
    };
    this._onMouseMove = (e) => {
      if (!this.pointerLocked || this.paused || this.persistenceBusy) return;
      const s = 0.0022 * this.settings.sensitivity;
      this.player.look(e.movementX, (this.settings.invertY ? -1 : 1) * e.movementY, s);
    };
    this._onWheel = (e) => {
      if (!this.pointerLocked || this.paused || this.persistenceBusy) return;
      this.selectSlot((this.slot + (e.deltaY > 0 ? 1 : -1) + this.hotbar.length) % this.hotbar.length);
    };
    this._onPointerLock = () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
      if (!this.pointerLocked && this.running && !this.paused && !this.inventoryOpen) this.hooks.onPointerLost?.();
      if (!this.pointerLocked) this.clearInput();
    };
    this._onBlur = () => this.clearInput();

    document.addEventListener('keydown', this._onKeyDown);
    document.addEventListener('keyup', this._onKeyUp);
    document.addEventListener('mousedown', this._onMouseDown);
    document.addEventListener('mouseup', this._onMouseUp);
    document.addEventListener('mousemove', this._onMouseMove);
    document.addEventListener('wheel', this._onWheel, { passive: true });
    document.addEventListener('pointerlockchange', this._onPointerLock);
    window.addEventListener('blur', this._onBlur);
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  clearInput() {
    this.keys.clear();
    this.mouse.left = this.mouse.right = false;
    this.mining = null;
    if (this.player) this.player.sprinting = false;
  }

  requestPointerLock() {
    // Automatic entry can precede a user gesture in a browser; retry on click.
    try { this.canvas.requestPointerLock?.()?.catch?.(() => {}); } catch { /* click to retry */ }
  }

  /**
   * Put a piece of armour straight on. Creative has no inventory screen to drag
   * it into, so the palette needs a way to say "wear this".
   */
  equipArmour(itemId) {
    const a = armourOf(itemId);
    if (!a) return null;
    const index = ARMOUR_SLOTS.indexOf(a.slot);
    if (index < 0) return null;
    const tool = ITEMS[itemId]?.armour;
    this.armourInv.set(index, { item: itemId, count: 1, dur: tool?.durability });
    this.refreshArmour();
    this.hooks.audio?.ui(true);
    return a.slot;
  }

  /** Assign a block to a hotbar slot (creative block palette only). */
  setSlotBlock(slot, id) {
    this.hotbar[slot] = id;
    this.pushHotbar();
  }

  selectSlot(i) {
    if (i < 0 || i >= 9) return;
    if (i === this.slot) return;
    this.slot = i;
    this.inventory.selected = i;
    this.pushHotbar();
    this.hooks.audio?.ui(true);
  }

  /**
   * The hotbar the HUD draws. Creative hands out infinite blocks (count 0 means
   * "don't print a number"); survival mirrors the first nine inventory slots.
   */
  hotbarStacks() {
    if (this.mode === 'creative') return this.hotbar.map((id) => (id ? { item: id, count: 0 } : null));
    return this.inventory.hotbarStacks();
  }

  pushHotbar() {
    this.hooks.onHotbar?.(this.hotbarStacks(), this.slot);
  }

  /** Item id currently in hand, 0 for an empty hand. */
  heldItem() {
    if (this.mode === 'creative') return this.hotbar[this.slot] ?? 0;
    return this.inventory.held()?.item ?? 0;
  }

  /** Items that were mid-craft or on the cursor when the game was last closed. */
  restoreCarried(carried) {
    this._spillAfterSpawn = [];
    if (!carried) return;
    const back = (entry) => {
      if (!entry) return;
      const [item, count, dur] = entry;
      const left = this.inventory.addItem(item, count, dur ?? undefined);
      if (left > 0) this._spillAfterSpawn.push({ item, count: left, dur: dur ?? undefined });
    };
    for (const entry of carried.craft ?? []) back(entry);
    back(carried.cursor);
  }

  giveLandingKit() {
    for (const entry of LANDING_KIT) {
      const id = itemIdOf(entry.key);
      if (!id) continue;
      const tool = ITEMS[id].tool;
      this.inventory.addItem(id, entry.count, tool ? tool.durability : undefined);
    }
  }

  setFlying(on) {
    this.hooks.onFly?.(on);
    this.hooks.audio?.ui(on);
  }

  respawn() {
    this.player.setPosition(this.spawnPoint);
  }

  /** Saved worlds keep their lamps: walk the edit log and re-light glowing blocks. */
  restoreLights() {
    for (const [key, map] of this.world.edits) {
      const [cx, cz] = key.split(',').map(Number);
      for (const [i, id] of map) {
        const glow = BLOCKS[id]?.light ?? 0;
        if (glow <= 0) continue;
        const c = tileBaseColor(BLOCKS[id].tex[0]);
        this.placedLights.push({
          x: cx * 16 + (i % 16),
          y: Math.floor(i / 256),
          z: cz * 16 + (Math.floor(i / 16) % 16),
          power: 1.1 + glow * 1.4,
          color: (Math.round(c[0] * 255) << 16) | (Math.round(c[1] * 255) << 8) | Math.round(c[2] * 255),
        });
        if (this.placedLights.length > 64) return;
      }
    }
  }

  toggleLamp() {
    this.lampOn = !this.lampOn;
    this.suitLamp.visible = this.lampOn;
    this.hooks.audio?.ui(this.lampOn);
    this.hooks.onLamp?.(this.lampOn);
  }

  /** Track a placed glowing block so the light pool can find it. */
  registerLight(x, y, z, id) {
    const glow = BLOCKS[id]?.light ?? 0;
    if (glow <= 0) return;
    this.placedLights = this.placedLights.filter((light) => light.x !== x || light.y !== y || light.z !== z);
    const c = tileBaseColor(BLOCKS[id].tex[0]);
    this.placedLights.push({
      x, y, z, power: 1.1 + glow * 1.4,
      color: (Math.round(c[0] * 255) << 16) | (Math.round(c[1] * 255) << 8) | Math.round(c[2] * 255),
    });
    if (this.placedLights.length > 64) this.placedLights.shift();
  }

  /** Keep the six nearest placed light blocks lit, drop the rest. */
  updateLights() {
    const p = this.player.pos;
    this.suitLamp.position.copy(this.camera.position);
    if (this.placedLights.length === 0) {
      for (const l of this.lightPool) l.intensity = 0;
      return;
    }
    const near = this.placedLights
      .map((b) => ({ b, d: (b.x - p.x) ** 2 + (b.y - p.y) ** 2 + (b.z - p.z) ** 2 }))
      .filter((e) => e.d < 2500)
      .sort((a, b) => a.d - b.d)
      .slice(0, this.lightPool.length);
    this.lightPool.forEach((l, i) => {
      const e = near[i];
      if (!e) { l.intensity = 0; return; }
      l.position.set(e.b.x + 0.5, e.b.y + 0.5, e.b.z + 0.5);
      l.color.setHex(e.b.color);
      l.intensity = e.b.power;
      l.distance = 16;
    });
  }

  // -------------------------------------------------------------------- loop
  loop = () => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, this.clock.getDelta());
    this._frames++;
    this._fpsT += dt;
    if (this._fpsT > 0.5) {
      this.fps = Math.round(this._frames / this._fpsT);
      this._frames = 0; this._fpsT = 0;
    }
    // Commit/rollback needs stable local inventory and survival state even on
    // a LAN host, where an ordinary pause intentionally leaves the world running.
    if (this.persistenceBusy) {
      this.renderer.render(this.scene, this.camera);
      return;
    }
    if (this.paused && !this.net) {
      // A smelter has to keep burning while you watch it - the screen pauses the
      // player, not the world's machines.
      this.updateStations(dt);
      this.renderer.render(this.scene, this.camera);
      return;
    }
    this.step(dt);
    this.renderer.render(this.scene, this.camera);
  };

  step(dt) {
    if (this.persistenceBusy) return;
    const p = this.player;

    if (!this.spawned) {
      // Hold the player still until there is ground under the spawn point.
      const ready = this.world.isLoaded(Math.floor(p.pos.x), Math.floor(p.pos.z));
      this.loadProgress = Math.min(1, this.world.chunks.size / 24);
      this.hooks.onProgress?.(this.loadProgress, ready);
      if (ready) {
        // drop onto the surface, in case the save or spawn guess was off
        let y = Math.min(WORLD_H - 3, Math.max(2, Math.floor(p.pos.y)));
        while (y > 1 && this.world.getBlock(Math.floor(p.pos.x), y - 1, Math.floor(p.pos.z)) === AIR) y--;
        if (this.planet.terrain.mode !== 'floating' || y > 2) p.pos.y = Math.max(p.pos.y, y + 0.02);
        this.spawned = true;
        for (const st of this._spillAfterSpawn ?? []) this.dropAtPlayer(st);
        this._spillAfterSpawn = [];
        this.hooks.onReady?.();
      } else {
        this.world.update(p.pos.x, p.pos.z);
        this.sky.update(dt, this.camera.position);
        return;
      }
    }

    const input = {
      forward: this.keys.has('KeyW') || this.keys.has('ArrowUp'),
      back: this.keys.has('KeyS') || this.keys.has('ArrowDown'),
      left: this.keys.has('KeyA') || this.keys.has('ArrowLeft'),
      right: this.keys.has('KeyD') || this.keys.has('ArrowRight'),
      jump: this.keys.has('Space'),
      // Shift is the ground sprint shortcut; in creative flight it still descends.
      sneak: p.flying
        ? this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')
        : this.keys.has('KeyC'),
      sprint: this.keys.has('ControlLeft') || this.keys.has('ControlRight')
        || (!p.flying && (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight'))),
    };

    const before = p.onGround;
    if (this.dead || this.paused) {
      input.forward = input.back = input.left = input.right = input.jump = input.sneak = input.sprint = false;
    }
    p.update(dt, input, this.world);

    // Falling out of the world: a graded hazard rather than a silent teleport.
    const vp = voidPhase(p.pos.y);
    if (vp.fatal) {
      if (this.mode === 'survival' && !this.dead) {
        this.applyEvents(this.survival.damage(999, 'void'));
        this.respawn();
      } else {
        this.respawn();
        this.hooks.onWarning?.('void-caught');
      }
    } else if (vp.dps > 0 && this.mode === 'survival' && !this.dead) {
      this.applyEvents(this.survival.damage(vp.dps * dt, 'void'));
    }

    this.updateSurvival(dt);

    // The clamp only fires on the frames it actually corrects, and pressing
    // against the floor bounces in and out of that condition - so hold the
    // indicator for a moment rather than flickering it once per contact.
    if (p.hitLimit) {
      if (p.hitLimit !== this._lastLimit) {
        this.hooks.onWarning?.(p.hitLimit === 'floor' ? 'limit-floor' : 'limit-ceiling');
      }
      this._lastLimit = p.hitLimit;
      this._limitUntil = performance.now() + 1600;
    } else if (this._limitUntil && performance.now() > this._limitUntil) {
      this._lastLimit = null;
      this._limitUntil = 0;
    }

    // footsteps
    const speed = Math.hypot(p.vel.x, p.vel.z);
    if (p.onGround && speed > 1.2) {
      this._stepAccum = (this._stepAccum ?? 0) + speed * dt;
      if (this._stepAccum > 2.4) {
        this._stepAccum = 0;
        const under = this.world.getBlock(Math.floor(p.pos.x), Math.floor(p.pos.y - 0.2), Math.floor(p.pos.z));
        this.hooks.audio?.step(BLOCKS[under]?.sound ?? 'stone');
      }
    }
    if (!before && p.onGround && p.landImpact > 0.05) {
      const under = this.world.getBlock(Math.floor(p.pos.x), Math.floor(p.pos.y - 0.2), Math.floor(p.pos.z));
      this.hooks.audio?.step(BLOCKS[under]?.sound ?? 'stone');
    }

    this.updateCamera(dt);
    this.limitView.update(p.pos);
    this.world.update(p.pos.x, p.pos.z);
    this.sky.update(dt, this.camera.position);
    this.applyVoidFog(vp);
    this.weather.update(dt, this.camera.position);
    this.bursts.update(dt, p.gravity);
    if (this.net?.role === 'client') updateGuestDrops(this, dt);
    else this.drops.update(dt, {
      gravity: p.gravity,
      world: this.net?.role === 'host' ? authoritativeWorld(this) : this.world,
      playerPos: p.pos,
      pickup: (itemId, count, dur) => {
        if (this.mode !== 'survival' || this.dead) return count;
        const left = this.inventory.addItem(itemId, count, dur);
        if (left < count) {
          this.hooks.audio?.pickup?.();
          this.pushHotbar();
          if (this.openScreenKind) this.hooks.onScreenRefresh?.();
        }
        return left;
      },
    });
    if (this.net) {
      this.net.sendMove(this.player, this.netFlags());
      this.avatars?.sync(this.net.players);
      this.avatars?.update(dt, performance.now(), this.net.players, this.camera.position);
    }
    if (this.net?.role !== 'client') this.mobs.update(dt, this.mobContext());
    this.mobRender.update(this.mobs, dt, this.camera.position);
    this.updateLights();
    this.updateTargeting(dt);
    this.updateHud();
    this.hooks.onTick?.(dt, this.musicSituation());
  }

  /**
   * Smelters tick independently of the player: they run while a screen is open
   * (which pauses everything else) and while you are simply standing there.
   * Lit-state swaps that land in an unloaded chunk are retried until they stick.
   */
  updateStations(dt) {
    if (this.mode !== 'survival' || !this.stations || !this.world) return;
    if (this.net?.role === 'client') return;
    const pending = this._pendingLit ?? (this._pendingLit = new Map());
    for (const c of this.stations.update(dt)) pending.set(`${c.x},${c.y},${c.z}`, c);

    if (pending.size) {
      const furnace = BY_KEY.get('furnace').id;
      const lit = BY_KEY.get('furnace_lit').id;
      for (const [key, c] of [...pending]) {
        const at = this.world.getBlock(c.x, c.y, c.z);
        if (at !== furnace && at !== lit) {
          // not a smelter any more (broken, or its chunk has not streamed in yet)
          if (this.world.isLoaded(c.x, c.z)) pending.delete(key);
          continue;
        }
        const want = c.lit ? lit : furnace;
        if (at === want || this.editWorld(c.x, c.y, c.z, want)) pending.delete(key);
      }
    }
    if (this.openScreenKind === 'furnace') this.hooks.onScreenRefresh?.();
  }

  // ------------------------------------------------------------------- LAN
  /**
   * Every local block change goes through here so multiplayer sees it. In
   * singleplayer it is exactly world.setBlock; in a session it also tells the
   * host (guest) or queues the echo (host).
   */
  editWorld(x, y, z, id, tool) {
    if (!this.world.setBlock(x, y, z, id)) return false;
    this.net?.sendEdit(x, y, z, id, tool ?? this.heldItem());
    return true;
  }

  /** A block change that came off the wire. Never spends items, never sounds. */
  applyRemoteEdit(x, y, z, id, _by, _tool) {
    const previous = this.net?.role === 'host' ? authoritativeBlock(this, x, y, z) : this.world.getBlock(x, y, z);
    if (BLOCKS[id]?.interact !== 'furnace' && BLOCKS[previous]?.interact === 'furnace') {
      const rec = this.stations.removeFurnace(x, y, z);
      if (this.net?.role === 'host' && this.mode === 'survival') {
        for (const stack of [rec?.input, rec?.fuel, rec?.output]) {
          if (stack) this.drops.spawn(x + 0.5, y + 0.7, z + 0.5, stack.item, stack.count, stack.dur);
        }
      }
    }
    if (id === AIR && previous !== AIR && this.net?.role === 'host' && this.mode === 'survival') {
      const drop = dropFor(previous, _tool, Math.random());
      if (drop) this.drops.spawn(x + 0.5, y + 0.5, z + 0.5, drop.item, drop.count);
    }
    this.world.applyEdit(x, y, z, id);
    const block = BLOCKS[id];
    if (block?.interact === 'furnace') this.stations.furnaceAt(x, y, z, true);
    if (block?.interact === 'oxygen') this.stations.addLifeSupport(x, y, z);
    else if (BLOCKS[previous]?.interact === 'oxygen') this.stations.removeLifeSupport(x, y, z);
    if (block?.light > 0) this.registerLight(x, y, z, id);
    else if ((BLOCKS[previous]?.light ?? 0) > 0) {
      this.placedLights = this.placedLights.filter((l) => l.x !== x || l.y !== y || l.z !== z);
    }
  }

  /** Snapshot of this player for the 20 Hz move broadcast. */
  netFlags() {
    const p = this.player;
    return (p.onGround ? F.GROUND : 0) | (p.flying ? F.FLYING : 0)
      | (p.sprinting ? F.SPRINT : 0) | (p.inLiquid ? F.LIQUID : 0)
      | (this.dead ? F.DEAD : 0);
  }

  netHooks() {
    return {
      snapshot: () => ({
        seed: this.seed, mode: this.mode, time: this.sky.time, spawn: this.spawnPoint,
        edits: this.world.serializeEdits(), stations: this.stations.serialize(),
        drops: this.drops.serialize(),
      }),
      applyEdit: (x, y, z, id, by, tool) => this.applyRemoteEdit(x, y, z, id, by, tool),
      digest: () => this.world.editDigest(),
      heldTool: () => this.heldItem(),
      playerState: () => ({
        x: this.player.pos.x, y: this.player.pos.y, z: this.player.pos.z,
        yaw: this.player.yaw, pitch: this.player.pitch, f: this.netFlags(),
      }),
      drops: () => this.drops,
      stations: () => this.stations,
      onPeerJoin: (id, name) => this.hooks.onPeer?.('join', name ?? `player ${id}`),
      onPeerLeave: (id, reason) => this.hooks.onPeer?.('leave', reason ?? `player ${id}`),
      onSpillRequest: (sp) => this.drops.spawn(sp.x, sp.y, sp.z, sp.item, sp.count, sp.dur),
      onDisconnect: (reason) => this.hooks.onNetDisconnect?.(reason),
      onChat: (id, text) => this.hooks.onChat?.(id, text),
      ...sharedHooks(this),
    };
  }

  /** Open this running world to the LAN. Returns the beacon record. */
  async hostLan(name = 'Lunacrust expedition') {
    if (!lanAvailable() || this.net) return null;
    const link = ipcLink((from, msg) => this.net?.handle(from, msg),
      (ev) => { if (ev.kind === 'gone' || ev.kind === 'closed') this.net?.peerGone(ev.id, ev.reason); });
    this.net = new NetSession({
      role: 'host', link, now: () => performance.now(),
      worldUid: this.worldUid, hostName: name, planetId: this.planet.id,
      hooks: this.netHooks(),
    });
    if (!this.avatars) this.avatars = new RemoteAvatars(this.scene);
    const info = await globalThis.spaceAPI.net.host({
      name,
      beacon: {
        planetId: this.planet.id, mode: this.mode, seed: this.seed,
        hash: contentHash(), name,
      },
    });
    if (!info?.ok) { this.stopLan(); return info; }
    this._netTimer = setInterval(() => this.net?.tick(), TICK_MS);
    return info;
  }

  /** Attach a guest session to an already-open socket. */
  startGuestSession(onWelcome) {
    if (this.net) this.stopLan();
    const link = ipcLink((from, msg) => this.net?.handle(from, msg),
      (ev) => { if (ev.kind === 'disconnected') this.net?.peerGone(ev.id, ev.reason); });
    this.net = new NetSession({
      role: 'client', link, now: () => performance.now(),
      hooks: { ...this.netHooks(), onWelcome },
    });
    this._netTimer = setInterval(() => this.net?.tick(), TICK_MS);
    return this.net;
  }

  stopLan() {
    if (this._netTimer) clearInterval(this._netTimer);
    this._netTimer = null;
    const session = this.net;
    this.net = null;
    session?.link?.dispose?.();
    session?.close('left', false);
    if (session?.role === 'host') globalThis.spaceAPI?.net?.unhost({ reason: 'not-hosting' });
    this._waitingFurnace = null;
    this.avatars?.dispose();
    this.avatars = null;
  }

  /**
   * Everything the mob simulation is allowed to touch, handed in explicitly -
   * mobs.js imports no world, no THREE and no game, the same way drops.js does.
   */
  mobContext() {
    const p = this.player;
    const ctx = this._mobCtx ?? (this._mobCtx = {
      hurtPlayer: (amount, cause) => this.applyEvents(this.survival.damage(amount, cause)),
      pushPlayer: (vx, vy, vz) => {
        this.player.vel.x += vx;
        this.player.vel.y = Math.max(this.player.vel.y, vy);
        this.player.vel.z += vz;
      },
      spawnDrop: (x, y, z, itemId, count) => this.drops.spawn(x, y, z, itemId, count),
      burst: (x, y, z, color, count, spread) => this.bursts.spawn(x, y, z, color, count, spread),
      setBlocks: (flat, n) => {
        this.world.setBlocks(flat, n);
        for (let i = 0; i < n; i++) this.net?.sendEdit(flat[i * 4], flat[i * 4 + 1], flat[i * 4 + 2], flat[i * 4 + 3], 0);
      },
      blocked: (x, y, z) => this.boxIntersectsPlayer(x, y, z),
      onBlast: (x, y, z) => {
        this.hooks.audio?.hurt?.('lava');
        const d = Math.hypot(x - p.pos.x, y - p.pos.y, z - p.pos.z);
        this.shake = Math.max(this.shake ?? 0, Math.max(0, 1 - d / 14));
      },
      onHit: (_id, killed) => this.hooks.audio?.[killed ? 'break_' : 'step']?.('soft'),
    });
    ctx.world = this.world;
    ctx.planet = this.planet;
    ctx.mode = this.mode;
    ctx.paused = this.paused && !this.net;
    ctx.dead = this.dead;
    ctx.gravity = p.gravity;
    ctx.playerPos = p.pos;
    ctx.playerH = PLAYER_H;
    ctx.players = this.net?.role === 'host' ? [
      { id: 0, pos: p.pos, h: PLAYER_H, dead: this.dead, hurt: ctx.hurtPlayer, push: ctx.pushPlayer },
      ...[...this.net.players].flatMap(([id, rec]) => {
        const sample = rec.buf.at(-1);
        if (!sample) return [];
        return [{ id, pos: sample, h: PLAYER_H, dead: !!(sample.f & F.DEAD),
          hurt: (amount, cause) => this.net?.link.send(id, { t: 'hurt', amount, cause }),
          push: (vx, vy, vz) => this.net?.link.send(id, { t: 'hurt', vx, vy, vz }),
        }];
      }),
    ] : undefined;
    ctx.playerEyeY = p.pos.y + EYE_H;
    ctx.heldToolTier = ITEMS[this.heldItem()]?.tool?.tier ?? 0;
    // Mobs only spawn in the dark, and the sky already knows how bright it is.
    ctx.daylight = Math.max(0, Math.sin(this.sky.time * Math.PI * 2));
    return ctx;
  }

  /** Damage a swing does: bare hands 1, up to 5 with a crystal tool. */
  attackDamage() {
    const t = ITEMS[this.heldItem()]?.tool;
    if (!t) return 1;
    return 1 + t.tier + (t.type === 'axe' ? 1 : 0);
  }

  /** Health, hunger, oxygen, smelters. No-op in creative beyond keeping bars full. */
  /** Push what the player is wearing into the damage model. */
  refreshArmour() {
    const a = armourStats(this.armourInv.slots);
    this.survival.setArmour(a);
    this.armourPoints = a.points;
    this.armourMinWear = a.minWear;
    this.helmetTier = armourOf(this.armourInv.get(0)?.item)?.tier ?? 0;
  }

  updateSurvival(dt) {
    this.refreshArmour();
    this.updateStations(dt);
    const p = this.player;
    if (this.mode !== 'survival') {
      p.justLanded = false;
      p.jumped = false;
      return;
    }

    if (this.dead) { p.justLanded = false; p.jumped = false; return; }

    if (p.justLanded) { this.applyEvents(this.survival.onLand(p.impactSpeed)); p.justLanded = false; }
    if (p.jumped) { this.survival.exert(0.2); p.jumped = false; }

    const body = this.world.getBlock(Math.floor(p.pos.x), Math.floor(p.pos.y + 0.9), Math.floor(p.pos.z));
    const bodyBlock = BLOCKS[body];
    this.applyEvents(this.survival.update(dt, {
      planet: this.planet,
      inLiquid: p.inLiquid,
      submerged: !!p.submerged,
      liquidKey: bodyBlock?.liquid ? bodyBlock.key : null,
      sprinting: p.sprinting,
      onGround: p.onGround,
      moved: p.distance,
      nearLifeSupport: this.stations.nearLifeSupport(p.pos, 9),
      creative: false,
    }));
  }

  /** Turn survival events into sound, HUD flashes and the death screen. */
  applyEvents(events) {
    if (!events || !events.length) return;
    for (const e of events) {
      switch (e.type) {
        case 'damage':
          this.hooks.onDamage?.(e);
          this.hooks.audio?.hurt?.(e.cause);
          for (const _broken of wearArmour(this.armourInv.slots, wearCost(e.raw))) {
            this.hooks.audio?.ui(false);
            this.hooks.onWarning?.('armour-broke');
          }
          if (e.absorbed > 0) this.hooks.onArmourHit?.(e);
          break;
        case 'death':
          this.dead = true;
          this.clearInput();
          // Hand back anything the player was holding or laying out before the
          // death screen takes over, or it vanishes with the grid object.
          if (this.openScreenKind) this.closeScreen();
          this.hooks.onDeath?.(e.cause ?? 'unknown');
          break;
        case 'oxygen-low':
        case 'hunger-low':
        case 'starving':
          this.hooks.onWarning?.(e.type);
          break;
        default:
          break;
      }
    }
  }

  /** Respawn after death: fresh bars, back at the landing site. */
  reviveSurvival() {
    this.survival.reset();
    this.dead = false;
    this.inventoryOpen = false;   // the death card had suppressed pointer-lock pausing
    this.player.setPosition(this.spawnPoint);
    this.player.vel.y = 0;
    this.pushHotbar();
  }

  /**
   * Runs after sky.update() on purpose: the sky rewrites scene.fog.color from
   * the day/night curve every frame, so an override written earlier in the
   * frame never reaches the renderer.
   */
  applyVoidFog(vp) {
    if (!this.scene?.fog) return;
    if (vp.haze > 0) {
      if (!this._voidBlack) this._voidBlack = new THREE.Color(0, 0, 0);
      this.scene.fog.color.lerp(this._voidBlack, vp.haze);
      this.scene.fog.density = this.planet.sky.fogDensity
        + (0.05 - this.planet.sky.fogDensity) * vp.haze;
      this._fogVoid = true;
    } else if (this._fogVoid) {
      this.scene.fog.density = this.planet.sky.fogDensity;
      this._fogVoid = false;
    }
  }

  /** Right-click repeats at ~4.5 Hz; gate the toast so it cannot strobe. */
  buildLimitToast() {
    const now = performance.now();
    if (this._buildToastUntil && now < this._buildToastUntil) return;
    this._buildToastUntil = now + 2000;
    this.hooks.onWarning?.('build-limit');
  }

  /** Per-frame payload the music player uses to pick a mood. */
  musicSituation() {
    const p = this.player;
    const now = performance.now();
    if (this._surfaceYAt == null || now - this._surfaceYAt > 500) {
      this._surfaceY = this.world.gen.columnTop(Math.floor(p.pos.x), Math.floor(p.pos.z));
      this._surfaceYAt = now;
    }
    return {
      y: p.pos.y,
      surfaceY: this._surfaceY,
      dayFraction: this.sky.time,
      floating: this.planet.terrain.mode === 'floating',
    };
  }

  updateCamera(dt) {
    const p = this.player;
    const bobAmt = p.onGround && !p.flying ? Math.sin(p.bob * 2) * 0.045 : 0;
    const roll = Math.sin(p.bob) * 0.012 + (p.landImpact * 0.02);
    this.camera.position.set(
      p.pos.x,
      p.pos.y + EYE_H - p.stepOffset - p.landImpact * 0.35 + bobAmt,
      p.pos.z,
    );
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotateY(p.yaw);
    this.camera.rotateX(p.pitch);
    this.camera.rotateZ(roll);

    // a whiff of speed FOV so sprinting and flying read physically
    const targetFov = this.settings.fov + (p.sprinting ? 6 : 0) + (p.flying && p.sprinting ? 8 : 0);
    if (Math.abs(this.camera.fov - targetFov) > 0.05) {
      this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 8);
      this.camera.updateProjectionMatrix();
    }

    // underwater / lava tint
    const head = this.world.getBlock(Math.floor(p.pos.x), Math.floor(p.pos.y + EYE_H), Math.floor(p.pos.z));
    const b = BLOCKS[head];
    if (b?.liquid) {
      const c = tileBaseColor(b.tex[1]);
      this.scene.fog.color.setRGB(c[0], c[1], c[2]);
      this.scene.fog.density = b.key === 'lava' ? 1.4 : 0.14;
      this._fogOverridden = true;
    } else if (this._fogOverridden) {
      this.scene.fog.density = this.planet.sky.fogDensity;
      this._fogOverridden = false;
    }
  }

  // --------------------------------------------------------------- targeting
  updateTargeting(dt) {
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const o = this.camera.position;
    const hit = raycastVoxel(this.world, o.x, o.y, o.z, dir.x, dir.y, dir.z, REACH,
      (id) => id !== AIR && !BLOCKS[id].liquid);

    this.target = hit;
    if (hit) {
      this.highlight.visible = true;
      this.highlight.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
      this.highlight.material.opacity = 0.55;
      this.highlight.scale.setScalar(1);
    } else {
      this.highlight.visible = false;
      this.mining = null;
      this.crack?.hide();
      this._crackStage = -1;
      this._crackKey = null;
    }

    // --- swing at a mob first: it is standing between you and the block
    this.attackCd -= dt;
    if (this.mouse.left && !this.dead && this.attackCd <= 0) {
      const target = this.mobs.pick(o.x, o.y, o.z, dir.x, dir.y, dir.z, 3.6);
      if (target && (!hit || target.dist < hit.dist)) {
        this.attackCd = 0.35;
        if (this.net?.role === 'client') this.net.sendMobHit(target.mob.id, this.heldItem(), dir.x, dir.z);
        else this.mobs.hit(target.mob.id, this.attackDamage(), dir.x, dir.z, this.mobContext());
        this.mining = null;
        this.crack?.hide();
        this._crackStage = -1;
        return;
      }
    }

    // --- breaking
    if (this.mouse.left && hit && !this.dead) {
      const key = hit.x + ',' + hit.y + ',' + hit.z;
      if (!this.mining || this.mining.key !== key) this.mining = { key, t: 0 };
      const block = BLOCKS[hit.id];
      // Creative keeps the old snappy timing; survival asks the tool how long
      // this should take, and whether it will yield anything at all.
      const need = this.mode === 'survival'
        ? miningTime(hit.id, this.heldItem())
        : Math.min(6, block.hardness) * 0.18;
      this.mining.t += dt;
      const prog = Math.min(1, this.mining.t / need);
      // The wireframe is back to being a pure aiming affordance; the cracks are
      // what tell you the block is coming apart.
      const st = stageFor(prog);
      if (st !== this._crackStage || key !== this._crackKey) {
        if (st < 0) this.crack.hide();
        else this.crack.show(hit.x, hit.y, hit.z, st);
        this._crackStage = st;
        this._crackKey = key;
      }
      if (block.hardness < 999 && this.mining.t >= need) {
        this.breakBlock(hit);
        this.mining = null;
      }
    } else {
      this.crack.hide();
      this._crackStage = -1;
      this._crackKey = null;
      if (!this.mouse.left) this.mining = null;
    }

    // --- placing
    this.placeCooldown -= dt;
    if (this.mouse.right && hit && this.placeCooldown <= 0 && !this.dead) {
      this.placeBlock(hit);
      this.placeCooldown = REPEAT_PLACE;
    }
  }

  breakBlock(hit) {
    const block = BLOCKS[hit.id];
    const held = this.heldItem();

    // A smelter spills whatever was inside it rather than eating your ingots.
    let spill = null;
    if (block.interact === 'furnace') {
      const st = this.stations.removeFurnace(hit.x, hit.y, hit.z);
      if (st) spill = [st.input, st.fuel, st.output].filter(Boolean);
      if (this.openScreenKind === 'furnace') this.hooks.onCloseScreen?.();
    } else if (block.interact === 'oxygen') {
      this.stations.removeLifeSupport(hit.x, hit.y, hit.z);
    }

    if (!this.editWorld(hit.x, hit.y, hit.z, AIR, held)) return;
    this.mobs?.noise(hit.x + .5, hit.y + .5, hit.z + .5);
    this.bursts.spawn(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, tileBaseColor(block.tex[1]), 16, 3.6);
    if (block.light > 0) {
      this.placedLights = this.placedLights.filter((l) => l.x !== hit.x || l.y !== hit.y || l.z !== hit.z);
    }
    this.hooks.audio?.break_(block.sound);
    this.hooks.onBreak?.(block);

    if (this.mode !== 'survival') return;

    if (this.net?.role !== 'client') {
      const d = dropFor(hit.id, held, Math.random());
      if (d) this.drops.spawn(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, d.item, d.count);
      for (const st of spill ?? []) this.drops.spawn(hit.x + 0.5, hit.y + 0.7, hit.z + 0.5, st.item, st.count, st.dur);
    }

    if (isTool(held)) {
      if (this.inventory.damageHeld(1) === 'broke') {
        this.hooks.audio?.ui(false);
        this.hooks.onWarning?.('tool-broke');
      }
      this.pushHotbar();
    }
    this.survival.exert(0.06);
  }

  placeBlock(hit) {
    const itemId = this.heldItem();
    if (!itemId || !isBlockItem(itemId)) return;
    const id = blockOfItem(itemId);
    if (!id) return;
    const x = hit.x + hit.face[0], y = hit.y + hit.face[1], z = hit.z + hit.face[2];
    if (!canBuildAt(y)) { this.buildLimitToast(); return; }
    const occupying = this.world.getBlock(x, y, z);
    if (occupying !== AIR && !BLOCKS[occupying].liquid) return;
    if (BLOCKS[id].solid && this.boxIntersectsPlayer(x, y, z)) return;
    if (!this.editWorld(x, y, z, id)) return;
    this.mobs?.noise(x + .5, y + .5, z + .5);

    if (BLOCKS[id].interact === 'oxygen') this.stations.addLifeSupport(x, y, z);
    if (BLOCKS[id].interact === 'furnace') this.stations.furnaceAt(x, y, z, true);
    if (this.mode === 'survival') {
      this.inventory.consumeHeld(1);
      this.pushHotbar();
    }
    this.registerLight(x, y, z, id);
    this.hooks.audio?.place(BLOCKS[id].sound);
  }

  // ------------------------------------------------------ stations & screens
  /** Right-clicking a fabricator / smelter / life support opens or uses it. */
  openStation(kind, hit) {
    if (kind === 'oxygen') {
      this.hooks.onWarning?.('life-support');
      return;
    }
    this.stationPos = { x: hit.x, y: hit.y, z: hit.z };
    if (kind === 'crafting') {
      this.spillCraftGrid();
      this.craftGrid = new Container(9, 'craft');
      this.recomputeCraft();
      this.openScreen('fabricator');
    } else if (kind === 'furnace') {
      if (this.net) {
        const at = `${hit.x},${hit.y},${hit.z}`;
        if (!this.net.openFurnace(at)) { this.hooks.onWarning?.('furnace-busy'); return; }
        if (this.net.role === 'client') { this._waitingFurnace = at; return; }
      }
      this.furnace = this.stations.furnaceAt(hit.x, hit.y, hit.z, true);
      this.openScreen('furnace');
    }
  }

  /** The 2x2 personal crafting grid, opened with E in survival. */
  openInventoryScreen() {
    this.spillCraftGrid();
    this.craftGrid = new Container(4, 'craft');
    this.recomputeCraft();
    this.openScreen('inventory');
  }

  openScreen(kind) {
    this.openScreenKind = kind;
    // Set the exemption *before* releasing the lock, or the pointerlockchange
    // handler reads it as "player alt-tabbed" and pauses to the menu.
    this.inventoryOpen = true;
    this.mouse.left = this.mouse.right = false;
    this.mining = null;
    this.setPaused(true);
    document.exitPointerLock?.();
    this.hooks.onOpenScreen?.(kind, this.screenData());
  }

  screenData() {
    return {
      inventory: this.inventory,
      armour: this.armourInv,
      craftGrid: this.craftGrid,
      craftResult: this.craftResult,
      furnace: this.openScreenKind === 'furnace' ? this.furnace : null,
      cursor: this.cursor,
      survival: this.survival,
      mode: this.mode,
      planet: this.planet,
    };
  }

  /** Empty the crafting grid and the cursor back into the pack, dropping the rest. */
  spillCraftGrid() {
    const spill = [];
    if (this.craftGrid) {
      for (let i = 0; i < this.craftGrid.size; i++) {
        const st = this.craftGrid.get(i);
        if (!st) continue;
        const left = this.inventory.addStack(st);
        if (left) spill.push(left);
        this.craftGrid.set(i, null);
      }
    }
    if (this.cursor.stack) {
      const left = this.inventory.addStack(this.cursor.stack);
      if (left) spill.push(left);
      this.cursor.stack = null;
    }
    for (const st of spill) this.dropAtPlayer(st);
    this.craftResult?.set(0, null);
  }

  /** Closing a screen must never eat items: anything left over falls at your feet. */
  closeScreen() {
    this.net?.closeFurnace();
    this.spillCraftGrid();
    this.openScreenKind = null;
    this.furnace = null;
    this.inventoryOpen = false;
    this.setPaused(false);
    this.pushHotbar();
  }

  dropAtPlayer(stack) {
    const p = this.player.pos;
    if (this.net?.role === 'client') this.net.sendSpill(stack.item, stack.count, stack.dur, p.x, p.y + 1.1, p.z);
    else this.drops.spawn(p.x, p.y + 1.1, p.z, stack.item, stack.count, stack.dur);
  }

  // ------------------------------------------------------------- crafting
  makeStack(item, count) {
    const tool = ITEMS[item]?.tool;
    return tool ? { item, count, dur: tool.durability } : { item, count };
  }

  recomputeCraft() {
    if (this.openScreenKind === 'furnace' && this.furnace && this.net?.role === 'client') {
      const p = this.stationPos;
      this.net.setFurnace(`${p.x},${p.y},${p.z}`, this.furnace);
    }
    if (!this.craftGrid) return;
    const size = this.craftGrid.size === 9 ? 3 : 2;
    const res = craftingResult(this.craftGrid.slots, size);
    this.craftResult.set(0, res ? this.makeStack(res.item, res.count) : null);
  }

  /** Called by the UI once the player has taken the result out of the slot. */
  onCraftTaken() {
    const size = this.craftGrid.size === 9 ? 3 : 2;
    const recipe = matchRecipe(this.craftGrid.slots, size);
    if (recipe) consumeGrid(this.craftGrid.slots, size, recipe);
    this.recomputeCraft();
    this.hooks.audio?.ui(true);
    this.pushHotbar();
  }

  findItemFor(spec) {
    for (let i = 0; i < this.inventory.size; i++) {
      const st = this.inventory.get(i);
      if (st && matchesIngredient(st.item, spec)) return st.item;
    }
    return 0;
  }

  /** Recipe-book click: clear the grid, then lay the recipe out from stock. */
  quickCraft(recipe) {
    const size = this.craftGrid.size === 9 ? 3 : 2;
    for (let i = 0; i < this.craftGrid.size; i++) {
      const st = this.craftGrid.get(i);
      if (!st) continue;
      const left = this.inventory.addStack(st);
      this.craftGrid.set(i, null);
      if (left) this.dropAtPlayer(left);
    }
    const layout = layoutFor(recipe, size) ?? [];
    const taken = [];
    for (let i = 0; i < layout.length && i < this.craftGrid.size; i++) {
      const spec = layout[i];
      if (!spec) continue;
      const id = this.findItemFor(spec);
      if (!id || !this.inventory.removeItems(id, 1)) {
        // not enough stock: put back whatever we already pulled
        for (const t of taken) this.inventory.addItem(t.item, 1, t.dur);
        for (let k = 0; k < this.craftGrid.size; k++) this.craftGrid.set(k, null);
        this.recomputeCraft();
        return false;
      }
      taken.push({ item: id });
      this.craftGrid.set(i, { item: id, count: 1 });
    }
    this.recomputeCraft();
    this.pushHotbar();
    return true;
  }

  /** Eat or use whatever is in hand. Returns true when it consumed the click. */
  useHeldItem() {
    if (this.mode !== 'survival' || this.dead) return false;
    const stack = this.inventory.held();
    if (!stack) return false;
    const item = ITEMS[stack.item];
    if (!item) return false;
    if (item.kind === 'food') {
      const r = this.survival.eat(stack.item);
      if (r?.ok) {
        this.inventory.consumeHeld(1);
        this.pushHotbar();
        this.hooks.audio?.ui(true);
      }
      this.applyEvents(r?.events);
      return true;
    }
    if (item.kind === 'use') {
      const r = this.survival.applyUse(stack.item);
      if (r?.ok) {
        this.inventory.consumeHeld(1);
        this.pushHotbar();
        this.hooks.audio?.ui(true);
      }
      this.applyEvents(r?.events);
      return true;
    }
    return false;
  }

  boxIntersectsPlayer(x, y, z) {
    const p = this.player.pos, hw = PLAYER_W / 2 + 0.02;
    return x + 1 > p.x - hw && x < p.x + hw &&
           y + 1 > p.y && y < p.y + PLAYER_H &&
           z + 1 > p.z - hw && z < p.z + hw;
  }

  pickBlock() {
    if (!this.target || this.mode !== 'creative') return;
    const idx = this.hotbar.indexOf(this.target.id);
    if (idx >= 0) { this.selectSlot(idx); return; }
    this.hotbar[this.slot] = this.target.id;
    this.pushHotbar();
    this.hooks.audio?.ui(true);
  }

  // --------------------------------------------------------------------- hud
  updateHud() {
    if (!this.hooks.onHud) return;
    const p = this.player;
    this.hooks.onHud({
      fps: this.fps,
      x: p.pos.x, y: p.pos.y, z: p.pos.z,
      yaw: p.yaw,
      chunks: this.world.stats.chunks,
      tris: this.world.stats.tris,
      flying: p.flying,
      sprinting: p.sprinting,
      onGround: p.onGround,
      inLiquid: p.inLiquid,
      speed: Math.hypot(p.vel.x, p.vel.z),
      vy: p.vel.y,
      time: this.sky.time,
      target: this.target ? BLOCKS[this.target.id].name : null,
      jump: p.jumpHeight(),
      gravity: this.planet.gravity,
      lamp: this.lampOn,
      limit: this._limitUntil && performance.now() < this._limitUntil ? this._lastLimit : null,
      mode: this.mode,
      dead: this.dead,
      health: this.survival?.health ?? 20,
      hunger: this.survival?.hunger ?? 20,
      oxygen: this.survival?.oxygen ?? 100,
      breathable: !!this.planet.atmosphere?.breathable,
      drops: this.drops?.count ?? 0,
      mobs: this.mobs?.count ?? 0,
      armour: this.armourPoints ?? 0,
      armourMinWear: this.armourMinWear ?? 1,
      helmetTier: this.helmetTier ?? 0,
      armourO2: this.survival?.armourO2 ?? 0,
      cold: !!this.planet.cold,
      voidHaze: voidPhase(p.pos.y).haze,
    });
  }

  // ------------------------------------------------------------------ system
  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setPaused(v) {
    this.paused = v;
    if (v) this.clearInput();
    if (!v) this.clock.getDelta();
  }

  applySettings(s) {
    Object.assign(this.settings, s);
    this.camera.fov = this.settings.fov;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.settings.renderScale ?? 1.5));
    this.resize();
    this.world?.setRenderDistance(this.settings.renderDistance);
    if (this.world) this.world.update(this.player.pos.x, this.player.pos.z);
  }

  snapshot() {
    if (!this.world) return null;
    return {
      version: 2,
      planetId: this.planet.id,
      seed: this.seed,
      worldUid: this.worldUid,
      mode: this.mode,
      time: this.sky.time,
      player: this.player.serialize(),
      edits: this.world.serializeEdits(),
      hotbar: this.mode === 'creative' ? this.hotbar.slice() : undefined,
      survival: this.survival?.serialize(),
      inventory: this.inventory?.serialize(),
      armour: this.armourInv?.serialize(),
      carried: this.openScreenKind ? {
        craft: this.craftGrid?.serialize(),
        cursor: this.cursor.stack
          ? [this.cursor.stack.item, this.cursor.stack.count, this.cursor.stack.dur ?? null]
          : null,
      } : undefined,
      stations: this.stations?.serialize(),
      drops: this.drops?.serialize(),
      savedAt: Date.now(),
    };
  }

  dispose(full = true) {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.world?.dispose();
    this.sky?.dispose();
    this.weather?.dispose();
    this.bursts?.dispose();
    this.drops?.dispose();
    if (this.highlight) {
      this.highlight.geometry.dispose();
      this.highlight.material.dispose();
      this.highlight = null;
    }
    if (this.crack) { this.crack.dispose(); this.crack = null; }
    if (!this._keepNet) this.stopLan();
    this.mobs?.clear();
    this.mobRender?.dispose();
    this.mobs = this.mobRender = null;
    this._mobCtx = null;
    this.limitView?.dispose();
    this.limitView = null;
    this._pendingLit?.clear();
    this.world = this.sky = this.weather = this.bursts = this.drops = null;
    if (this.scene) {
      this.scene.clear();
      this.scene = null;
    }
    if (full) {
      window.removeEventListener('resize', this.onResize);
      window.removeEventListener('blur', this._onBlur);
      document.removeEventListener('keydown', this._onKeyDown);
      document.removeEventListener('keyup', this._onKeyUp);
      document.removeEventListener('mousedown', this._onMouseDown);
      document.removeEventListener('mouseup', this._onMouseUp);
      document.removeEventListener('mousemove', this._onMouseMove);
      document.removeEventListener('wheel', this._onWheel);
      document.removeEventListener('pointerlockchange', this._onPointerLock);
      this.renderer.dispose();
    }
  }
}
