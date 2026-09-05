// Ten-stage crack art for the block-break overlay.
//
// The stages are not ten independent drawings - that would make the overlay
// flicker as mining progresses, because a pixel present at stage 4 could be
// gone at stage 5. Instead the field is built once, with every pixel tagged
// with the stage it first appears at, and stage n's texture paints every pixel
// whose tag is <= n. Nesting is then true by construction: the set of painted
// pixels only ever grows as n grows, because nothing is ever un-tagged.
//
// Zero imports on purpose (not even textures.js, which imports this) so the
// dependency only runs one way and this stays trivially unit-testable.

export const CRACK_STAGES = 10;
export const crackTileName = (stage) => 'crack_' + stage;

/** -1 when nothing should be drawn, else 0..CRACK_STAGES-1. */
export const stageFor = (progress) =>
  (progress <= 0 ? -1 : Math.min(CRACK_STAGES - 1, Math.floor(progress * CRACK_STAGES)));

// Same xorshift prng/strSeed pair textures.js and itemart.js already carry,
// copied rather than imported so this module stays dependency-free.
function prng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}
const strSeed = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};

const TILE = 16;
const CENTER = 7.5;
const ARMS = 4;
const BRANCH_FROM_STAGE = 3;
const BRANCH_P = 0.45;
const STEP_LEN = 0.4;     // per sub-step, along the arm's fixed direction
const STEP_GROW = 0.06;   // steps lengthen with stage, so the tip accelerates outward
const SUBSTEPS = 2;       // per stage, per arm - keeps the line from gapping at 16px
const LATERAL = 1.0;      // max px of perpendicular kink per sub-step
const CORE_A = 210;
const HALO_A = 70;
const CHIP_A = 150;
const CHIP_COUNT = 14;

let cached = null;

/** @returns {Array<{x:number,y:number,stage:number,a:number}>} lazily built once */
export function crackField() {
  if (cached) return cached;
  const rnd = prng(strSeed('destroy'));
  // 'x,y' -> entry, so a pixel keeps the earliest stage it appeared at and the
  // darkest ink anything ever wrote there - never both a stale stage and alpha.
  const pixels = new Map();

  const mark = (x, y, stage, a) => {
    // Clamp rather than discard: an arm that overshoots the 16px tile just
    // hugs the edge instead of wasting the rest of its walk off-canvas.
    x = Math.max(0, Math.min(TILE - 1, Math.round(x)));
    y = Math.max(0, Math.min(TILE - 1, Math.round(y)));
    const key = x + ',' + y;
    const cur = pixels.get(key);
    if (!cur) { pixels.set(key, { x, y, stage, a }); return; }
    if (stage < cur.stage) cur.stage = stage;
    if (a > cur.a) cur.a = a; // a core always outranks a halo, written before or after it
  };
  const core = (x, y, stage) => {
    mark(x, y, stage, CORE_A);
    mark(x + 1, y, stage, HALO_A);
    mark(x - 1, y, stage, HALO_A);
    mark(x, y + 1, stage, HALO_A);
    mark(x, y - 1, stage, HALO_A);
  };
  const walk = (x, y, angle, steps, stage) => {
    for (let i = 0; i < steps; i++) {
      x += Math.cos(angle) * STEP_LEN;
      y += Math.sin(angle) * STEP_LEN;
      core(x, y, stage);
    }
  };

  for (let arm = 0; arm < ARMS; arm++) {
    const angle = (arm / ARMS) * Math.PI * 2 + (rnd() * 2 - 1) * 0.6;
    let x = CENTER, y = CENTER;
    for (let stage = 0; stage < CRACK_STAGES; stage++) {
      const stepLen = STEP_LEN + stage * STEP_GROW;
      for (let s = 0; s < SUBSTEPS; s++) {
        x += Math.cos(angle) * stepLen;
        y += Math.sin(angle) * stepLen;
        // The lateral jitter is what gives the crack its kinked look rather
        // than drawing a straight ray from the centre.
        const perp = angle + Math.PI / 2;
        const lat = (rnd() * 2 - 1) * LATERAL;
        core(x + Math.cos(perp) * lat, y + Math.sin(perp) * lat, stage);
      }
      if (stage >= BRANCH_FROM_STAGE && rnd() < BRANCH_P) {
        const bAngle = angle + (rnd() < 0.5 ? -1 : 1) * 0.9;
        walk(x, y, bAngle, 2 + ((rnd() * 3) | 0), stage);
      }
    }
  }

  // Stage 9 chips: the last frame before the block goes reads as shattered
  // rather than as one more line.
  for (let i = 0; i < CHIP_COUNT; i++) {
    mark((rnd() * TILE) | 0, (rnd() * TILE) | 0, CRACK_STAGES - 1, CHIP_A);
  }

  cached = [...pixels.values()];
  return cached;
}
