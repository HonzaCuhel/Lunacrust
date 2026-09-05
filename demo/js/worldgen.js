// Terrain generation. Pure functions of (world coords, seed) - no mutable state,
// no THREE, no DOM - so the exact same module runs inside the web worker (to
// build chunks) and on the main thread (to answer "where is the ground?" when
// picking a spawn point).

import { fbm2, fbm3, ridged2, worley2, perlin3, rand2, rand3 } from './noise.js';
import { BY_KEY, AIR } from './blocks.js';

export const CHUNK_SX = 16;
export const CHUNK_SZ = 16;
export const WORLD_H = 128;
export const CHUNK_VOLUME = CHUNK_SX * CHUNK_SZ * WORLD_H;

/** x-major, then z, then y: columns are strided, layers are contiguous. */
export const vIndex = (x, y, z) => x + z * CHUNK_SX + y * (CHUNK_SX * CHUNK_SZ);

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export class WorldGen {
  constructor(planet, seed) {
    this.planet = planet;
    this.seed = seed | 0;
    this.t = planet.terrain;
    const id = (key) => (key ? BY_KEY.get(key).id : AIR);
    const L = this.t.layers;
    this.ids = {
      surface: id(L.surface),
      subsurface: id(L.subsurface),
      deep: id(L.deep),
      beach: id(L.beach),
      underwater: id(L.underwater),
      sea: id(this.t.sea),
      snow: id(this.t.snowBlock),
      bedrock: id('bedrock'),
      coal: id('coal_ore'),
      iron: id('iron_ore'),
      gold: id('gold_ore'),
      crystal: id('crystal_ore'),
      ice: id('ice_ore'),
      luminite: id('luminite'),
      water: id('water'),
      ammonia: id('ammonia_ice'),
      cloud: id('cloud'),
      storm: id('storm_stone'),
      packIce: id('pack_ice'),
    };
    this.seaLevel = this.t.seaLevel;
  }

  // ------------------------------------------------------------ height field
  heightAt(wx, wz) {
    const t = this.t, s = this.seed;
    if (t.mode === 'floating') return t.base;

    // Domain warping: offsetting the sample point by another noise field is what
    // turns "rolling hills" into coastlines and river-ish valleys.
    const warp = fbm2(wx * 0.0055, wz * 0.0055, s + 901, 2) * 22;
    const warp2 = fbm2(wx * 0.0055 + 31.7, wz * 0.0055 - 12.3, s + 902, 2) * 22;

    const cont = fbm2((wx + warp) * 0.0021, (wz + warp2) * 0.0021, s, 4);
    const hills = fbm2(wx * 0.011, wz * 0.011, s + 11, 4);
    let h = t.base + cont * t.amplitude + hills * t.amplitude * 0.45 * t.roughness;

    if (t.ridgeAmp > 0) {
      const mask = clamp((cont * 0.5 + 0.5 - 0.34) / 0.66, 0, 1);
      const r = ridged2(wx * 0.0042, wz * 0.0042, s + 22, 4);
      h += Math.pow(r, 2.4) * t.ridgeAmp * mask;
    }

    if (t.canyons) {
      // Ridged noise pushed past a threshold cuts steep-walled rifts.
      const c = ridged2(wx * 0.0016, wz * 0.0016, s + 33, 3);
      if (c > 0.80) h -= (c - 0.80) * t.canyons * 230;
    }

    if (t.craters) {
      h += this.craterOffset(wx, wz, 0.013, 0.34, 11, s + 44) * t.craters;
      h += this.craterOffset(wx, wz, 0.052, 0.30, 4, s + 45) * t.craters;
    }

    if (t.dunes) {
      const d = fbm2(wx * 0.004, wz * 0.004, s + 55, 2);
      h += Math.sin(wx * 0.075 + wz * 0.02 + d * 7) * 2.6 + Math.sin(wz * 0.05) * 1.2;
    }

    if (t.mode === 'iceshell') {
      // Flat shell scored by long linear fractures.
      const crack = 1 - Math.min(1, worley2(wx * 0.011, wz * 0.011, s + 66) * 3.2);
      h -= crack * crack * 7;
    }

    return h;
  }

  craterOffset(wx, wz, freq, radius, depth, seed) {
    const d = worley2(wx * freq, wz * freq, seed);
    if (d < radius) {
      const t = d / radius;
      return -(1 - t * t) * depth;         // bowl
    }
    if (d < radius * 1.35) {
      const t = (d - radius) / (radius * 0.35);
      return (1 - t) * depth * 0.28;       // raised rim
    }
    return 0;
  }

  /**
   * Per-chunk cache of column heights. heightAt() is the single most expensive
   * call in generation (four fBm stacks), and features re-query the same columns
   * many times, so one padded grid per chunk pays for itself immediately.
   */
  primeHeights(cx, cz, margin) {
    const size = CHUNK_SX + margin * 2;
    if (!this._pad || this._pad.length !== size * size) this._pad = new Float32Array(size * size);
    this._padOx = cx * CHUNK_SX - margin;
    this._padOz = cz * CHUNK_SZ - margin;
    this._padSize = size;
    for (let z = 0; z < size; z++) {
      for (let x = 0; x < size; x++) {
        this._pad[x + z * size] = this.rawColumnTop(this._padOx + x, this._padOz + z);
      }
    }
  }

  rawColumnTop(wx, wz) {
    if (this.t.mode === 'floating') {
      for (let y = WORLD_H - 2; y > 4; y--) if (this.floatingSolid(wx, y, wz)) return y + 1;
      return 0;
    }
    return Math.round(clamp(this.heightAt(wx, wz), 1, WORLD_H - 3));
  }

  /** Topmost solid block of a column - used for spawning and feature tests. */
  columnTop(wx, wz) {
    if (this._pad) {
      const x = wx - this._padOx, z = wz - this._padOz;
      if (x >= 0 && z >= 0 && x < this._padSize && z < this._padSize) return this._pad[x + z * this._padSize];
    }
    return this.rawColumnTop(wx, wz) || this.t.base;
  }

  // ------------------------------------------------------------------- caves
  isCave(wx, wy, wz) {
    const c = this.t.caves;
    if (!c) return false;
    // Two decorrelated noise fields near zero at the same time trace out tubes
    // rather than the swiss-cheese blobs a single threshold gives you.
    const a = perlin3(wx * 0.026, wy * 0.05, wz * 0.026, this.seed + 77);
    const b = perlin3(wx * 0.026, wy * 0.05, wz * 0.026, this.seed + 78);
    if (a * a + b * b < 0.0055 * c) return true;
    if (wy >= this.t.base - 8) return false;   // large caverns only run deep
    return fbm3(wx * 0.017, wy * 0.028, wz * 0.017, this.seed + 79, 3) > 0.62 - (c - 1) * 0.06;
  }

  floatingSolid(wx, wy, wz) {
    const decks = [50, 74, 98];
    let band = 1e9;
    for (const d of decks) band = Math.min(band, Math.abs(wy - d));
    if (band > 13) return false;
    const n = fbm3(wx * 0.013, wy * 0.026, wz * 0.013, this.seed, 3);
    return n + 0.62 - band * 0.072 > 0;
  }

  // ------------------------------------------------------------------- chunk
  generate(cx, cz) {
    const v = new Uint8Array(CHUNK_VOLUME);
    const ox = cx * CHUNK_SX, oz = cz * CHUNK_SZ;
    this.primeHeights(cx, cz, 4);
    if (this.t.mode === 'floating') this.fillFloating(v, ox, oz);
    else this.fillSolid(v, ox, oz);
    this.stampFeatures(v, cx, cz);
    return v;
  }

  fillSolid(v, ox, oz) {
    const ids = this.ids, t = this.t, sea = this.seaLevel;
    const snowLine = t.snowLine ?? 1e9;
    for (let z = 0; z < CHUNK_SZ; z++) {
      for (let x = 0; x < CHUNK_SX; x++) {
        const wx = ox + x, wz = oz + z;
        const h = this.columnTop(wx, wz);

        let top = ids.surface;
        if (sea >= 0) {
          if (h <= sea) top = ids.underwater;
          else if (h <= sea + 2) top = ids.beach;
        }
        if (ids.snow && h >= snowLine) top = ids.snow;

        const maxY = Math.max(h - 1, sea);
        for (let y = 0; y <= maxY; y++) {
          let id = AIR;
          if (y === 0) id = ids.bedrock;
          else if (y < h - 4) id = ids.deep;
          else if (y < h - 1) id = ids.subsurface;
          else if (y < h) id = top;
          else if (y <= sea) id = ids.sea;

          if (id !== AIR && y > 0 && y < h - 1 && this.isCave(wx, y, wz)) id = AIR;
          if (id === ids.deep) id = this.oreAt(wx, y, wz, id);
          if (id !== AIR) v[vIndex(x, y, z)] = id;
        }
      }
    }
    if (t.mode === 'iceshell') this.carveOcean(v, ox, oz);
  }

  /** Europa: a thin shell, a deep ocean, then a rocky floor. */
  carveOcean(v, ox, oz) {
    const ids = this.ids, crust = this.t.crustDepth ?? 12;
    const floor = 14;
    for (let z = 0; z < CHUNK_SZ; z++) {
      for (let x = 0; x < CHUNK_SX; x++) {
        const wx = ox + x, wz = oz + z;
        const h = this.columnTop(wx, wz);
        const shellBottom = h - crust - Math.round(fbm2(wx * 0.03, wz * 0.03, this.seed + 88, 2) * 4);
        const seaBed = floor + Math.round((fbm2(wx * 0.02, wz * 0.02, this.seed + 89, 3) * 0.5 + 0.5) * 8);
        for (let y = 1; y < WORLD_H; y++) {
          const i = vIndex(x, y, z);
          if (y > seaBed && y < shellBottom) v[i] = ids.water;
          else if (y <= seaBed && y > 0 && v[i] === AIR) v[i] = ids.deep;
          else if (y >= shellBottom && y < h - 2 && v[i] !== AIR) v[i] = ids.packIce;
        }
      }
    }
  }

  fillFloating(v, ox, oz) {
    const ids = this.ids;
    for (let z = 0; z < CHUNK_SZ; z++) {
      for (let x = 0; x < CHUNK_SX; x++) {
        const wx = ox + x, wz = oz + z;
        let run = 0;
        for (let y = WORLD_H - 2; y >= 1; y--) {
          if (!this.floatingSolid(wx, y, wz)) { run = 0; continue; }
          run++;
          let id = run === 1 ? ids.surface : run <= 4 ? ids.subsurface : ids.deep;
          if (id === ids.deep) id = this.oreAt(wx, y, wz, id);
          v[vIndex(x, y, z)] = id;
        }
      }
    }
  }

  oreAt(wx, wy, wz, fallback) {
    const rich = this.t.oreRich ?? 1;
    const r = rand3(wx, wy, wz, this.seed + 4242);
    const ids = this.ids;
    // Ore rarity is a function of depth, but Jupiter's cloud decks float at
    // y 50-98: measured against absolute height they would never carry gold or
    // void crystal at all, so the decks get their own datum.
    // Floating decks repeat every 24 blocks, so depth is measured within the deck
    // you are standing in: otherwise the top deck - the one you always spawn on -
    // has no iron at all and the only fix is a fall between decks.
    const depth = this.t.mode === 'floating' ? ((wy - 38) % 24) * 2 : wy;
    if (depth < 14 && r < 0.0055 * rich) return ids.crystal;
    if (depth < 22 && r < 0.011 * rich) return ids.gold;
    if (depth < 46 && r < 0.020 * rich) return ids.iron;
    if (r < 0.030 * rich) return ids.coal;
    if (depth < 12 && r < 0.034 * rich) return ids.luminite;
    // Frozen volatiles exist on every world (SO2 frost on Io, water ice elsewhere):
    // they are the universal food and oxygen feedstock, so survival must never
    // strand a player on a planet without them.
    const iceRate = this.t.sea === 'lava' ? 0.033 : 0.036;
    if (depth > 10 && r < iceRate * rich) return ids.ice;
    return fallback;
  }

  // ---------------------------------------------------------------- features
  /**
   * Structures are stamped from a 3-column margin around the chunk so a tree
   * whose trunk sits in the neighbouring chunk still drops its leaves here -
   * without that margin you get a visible grid of bare chunk seams.
   */
  stampFeatures(v, cx, cz) {
    const feats = this.planet.features ?? [];
    if (!feats.length) return;
    const ox = cx * CHUNK_SX, oz = cz * CHUNK_SZ;
    const M = 4;
    const put = (x, y, z, id, replace = false) => {
      if (x < 0 || z < 0 || x >= CHUNK_SX || z >= CHUNK_SZ || y < 1 || y >= WORLD_H) return;
      const i = vIndex(x, y, z);
      if (!replace && v[i] !== AIR) return;
      v[i] = id;
    };
    const surfaceIds = new Set([this.ids.surface, this.ids.subsurface, this.ids.beach]);

    for (let fz = -M; fz < CHUNK_SZ + M; fz++) {
      for (let fx = -M; fx < CHUNK_SX + M; fx++) {
        const wx = ox + fx, wz = oz + fz;
        for (let fi = 0; fi < feats.length; fi++) {
          const f = feats[fi];
          const roll = rand2(wx, wz, this.seed + 7717 * (fi + 1));
          if (roll >= f.density) continue;
          const h = this.columnTop(wx, wz);
          if (h < 3 || h > WORLD_H - 20) continue;
          if (this.seaLevel >= 0 && h <= this.seaLevel + 1 && f.type !== 'patch') continue;
          const onIds = (f.on ?? []).map((k) => BY_KEY.get(k).id);
          const groundId = this.groundIdAt(wx, wz, h);
          if (onIds.length && !onIds.includes(groundId) && !surfaceIds.has(groundId)) continue;
          const r2 = rand2(wx + 13, wz - 7, this.seed + 31 * (fi + 1));

          switch (f.type) {
            case 'tree': {
              const logId = BY_KEY.get(f.log).id, leafId = BY_KEY.get(f.leaves).id;
              const th = f.minH + Math.floor(r2 * (f.maxH - f.minH + 1));
              for (let y = 0; y < th; y++) put(fx, h + y, fz, logId, true);
              const cy = h + th;
              for (let dy = -2; dy <= 1; dy++) {
                const rad = dy <= -1 ? 2 : dy === 0 ? 2 : 1;
                for (let dz = -rad; dz <= rad; dz++) {
                  for (let dx = -rad; dx <= rad; dx++) {
                    if (Math.abs(dx) === rad && Math.abs(dz) === rad && rad > 1) continue;
                    put(fx + dx, cy + dy, fz + dz, leafId);
                  }
                }
              }
              break;
            }
            case 'boulder': {
              const id = BY_KEY.get(f.block).id;
              const rad = 1 + Math.floor(r2 * 2);
              for (let dy = -rad; dy <= rad; dy++)
                for (let dz = -rad; dz <= rad; dz++)
                  for (let dx = -rad; dx <= rad; dx++)
                    if (dx * dx + dy * dy + dz * dz <= rad * rad + 1) put(fx + dx, h + dy, fz + dz, id, true);
              break;
            }
            case 'spire': {
              const id = BY_KEY.get(f.block).id;
              const th = f.minH + Math.floor(r2 * (f.maxH - f.minH + 1));
              for (let y = 0; y < th; y++) {
                const rad = Math.max(0, Math.round((1 - y / th) * 2));
                for (let dz = -rad; dz <= rad; dz++)
                  for (let dx = -rad; dx <= rad; dx++)
                    if (dx * dx + dz * dz <= rad * rad + 1) put(fx + dx, h + y - 1, fz + dz, id, true);
              }
              break;
            }
            case 'crystal': {
              const id = BY_KEY.get(f.block).id;
              for (let k = 0; k < 3; k++) {
                const dx = Math.round((rand2(wx + k, wz - k, this.seed + 5) - 0.5) * 3);
                const dz = Math.round((rand2(wx - k, wz + k, this.seed + 6) - 0.5) * 3);
                const th = f.minH + Math.floor(rand2(wx + k * 3, wz + k * 5, this.seed + 7) * (f.maxH - f.minH + 1));
                for (let y = 0; y < th; y++) put(fx + dx, h + y, fz + dz, id);
              }
              break;
            }
            case 'patch': {
              const id = BY_KEY.get(f.block).id;
              const rad = 1 + Math.floor(r2 * f.radius);
              for (let dz = -rad; dz <= rad; dz++) {
                for (let dx = -rad; dx <= rad; dx++) {
                  if (dx * dx + dz * dz > rad * rad) continue;
                  const th = this.columnTop(wx + dx, wz + dz);
                  if (this.seaLevel >= 0 && th <= this.seaLevel) continue;
                  put(fx + dx, th - 1, fz + dz, id, true);
                }
              }
              break;
            }
          }
        }
      }
    }
  }

  groundIdAt(wx, wz, h) {
    const t = this.t, ids = this.ids;
    if (t.mode === 'floating') return ids.surface;
    if (this.seaLevel >= 0) {
      if (h <= this.seaLevel) return ids.underwater;
      if (h <= this.seaLevel + 2) return ids.beach;
    }
    if (ids.snow && h >= (t.snowLine ?? 1e9)) return ids.snow;
    return ids.surface;
  }

  /** A standing spot near (x,z): walks outward until it finds solid dry ground. */
  findSpawn(cx = 0, cz = 0) {
    this._pad = null;
    for (let r = 0; r < 96; r += 2) {
      for (let a = 0; a < 12; a++) {
        const ang = (a / 12) * Math.PI * 2;
        const x = Math.round(cx + Math.cos(ang) * r);
        const z = Math.round(cz + Math.sin(ang) * r);
        const h = this.columnTop(x, z);
        if (h > (this.seaLevel >= 0 ? this.seaLevel + 1 : 2) && h < WORLD_H - 24) {
          return { x: x + 0.5, y: h + 2.2, z: z + 0.5 };
        }
      }
    }
    return { x: 0.5, y: this.t.base + 6, z: 0.5 };
  }
}
