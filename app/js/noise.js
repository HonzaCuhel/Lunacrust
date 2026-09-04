/**
 * Perlin's improved noise, permutation-table flavour.
 *
 * The first cut of this hashed all eight lattice corners with an integer mix
 * function, which cost ~34 ms per chunk. Precomputing a 512-entry permutation
 * per seed and folding the gradient into a bit-trick (no array of arrays to
 * chase) brings the same terrain in at a fraction of that - and terrain speed is
 * the thing that decides how far you can see while flying.
 */
const PERM_CACHE = new Map();

function buildPerm(seed) {
  const p = new Uint8Array(512);
  const src = new Uint8Array(256);
  for (let i = 0; i < 256; i++) src[i] = i;
  // Fisher-Yates driven by a seeded xorshift, so the shuffle is reproducible.
  let s = (seed | 0) || 0x9e3779b9;
  for (let i = 255; i > 0; i--) {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    const j = s % (i + 1);
    const t = src[i]; src[i] = src[j]; src[j] = t;
  }
  for (let i = 0; i < 512; i++) p[i] = src[i & 255];
  return p;
}

export function permFor(seed) {
  let p = PERM_CACHE.get(seed);
  if (!p) { p = buildPerm(seed); PERM_CACHE.set(seed, p); }
  return p;
}

/** 32-bit integer hash (xxhash-flavoured mixing), used for placement rolls. */
export function ihash(x, y, z, seed) {
  let h = seed | 0;
  h = Math.imul(h ^ (x | 0), 0x27d4eb2d);
  h = Math.imul(h ^ (y | 0), 0x165667b1);
  h = Math.imul(h ^ (z | 0), 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Uniform [0,1) from lattice coordinates. */
export function rand2(x, z, seed) {
  return ihash(x, 0, z, seed) / 4294967296;
}
export function rand3(x, y, z, seed) {
  return ihash(x, y, z, seed) / 4294967296;
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + (b - a) * t;

function grad3f(h, x, y, z) {
  const hh = h & 15;
  const u = hh < 8 ? x : y;
  const v = hh < 4 ? y : (hh === 12 || hh === 14) ? x : z;
  return ((hh & 1) === 0 ? u : -u) + ((hh & 2) === 0 ? v : -v);
}

export function perlin2p(perm, x, y) {
  const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
  const xf = x - Math.floor(x), yf = y - Math.floor(y);
  const u = fade(xf), v = fade(yf);
  const A = perm[X] + Y, B = perm[X + 1] + Y;
  return lerp(
    lerp(grad3f(perm[A], xf, yf, 0), grad3f(perm[B], xf - 1, yf, 0), u),
    lerp(grad3f(perm[A + 1], xf, yf - 1, 0), grad3f(perm[B + 1], xf - 1, yf - 1, 0), u),
    v,
  ) * 1.4;
}

export function perlin3p(perm, x, y, z) {
  const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
  const X = fx & 255, Y = fy & 255, Z = fz & 255;
  const xf = x - fx, yf = y - fy, zf = z - fz;
  const u = fade(xf), v = fade(yf), w = fade(zf);
  const A = perm[X] + Y, AA = perm[A] + Z, AB = perm[A + 1] + Z;
  const B = perm[X + 1] + Y, BA = perm[B] + Z, BB = perm[B + 1] + Z;
  return lerp(
    lerp(
      lerp(grad3f(perm[AA], xf, yf, zf), grad3f(perm[BA], xf - 1, yf, zf), u),
      lerp(grad3f(perm[AB], xf, yf - 1, zf), grad3f(perm[BB], xf - 1, yf - 1, zf), u), v),
    lerp(
      lerp(grad3f(perm[AA + 1], xf, yf, zf - 1), grad3f(perm[BA + 1], xf - 1, yf, zf - 1), u),
      lerp(grad3f(perm[AB + 1], xf, yf - 1, zf - 1), grad3f(perm[BB + 1], xf - 1, yf - 1, zf - 1), u), v),
    w,
  ) * 1.25;
}

export const perlin2 = (x, y, seed) => perlin2p(permFor(seed), x, y);
export const perlin3 = (x, y, z, seed) => perlin3p(permFor(seed), x, y, z);

/** Fractal Brownian motion: octaves of perlin at doubling frequency. */
export function fbm2(x, y, seed, octaves = 4, lacunarity = 2, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += perlin2p(permFor(seed + o * 1013), x * freq, y * freq) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

export function fbm3(x, y, z, seed, octaves = 3, lacunarity = 2, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += perlin3p(permFor(seed + o * 7919), x * freq, y * freq, z * freq) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/**
 * Ridged multifractal - folding the noise at zero turns smooth hills into the
 * sharp canyon walls and crater rims that make Mars and Io read as alien.
 */
export function ridged2(x, y, seed, octaves = 4) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let o = 0; o < octaves; o++) {
    const n = 1 - Math.abs(perlin2p(permFor(seed + o * 3571), x * freq, y * freq));
    sum += n * n * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

/** Cellular / Worley F1 distance - used for craters and Europa's ice cracks. */
export function worley2(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  let best = 8;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx, cz = yi + dz;
      const h = ihash(cx, 77, cz, seed);
      const px = cx + (h & 255) / 255;
      const pz = cz + ((h >>> 8) & 255) / 255;
      const d = (px - x) * (px - x) + (pz - y) * (pz - y);
      if (d < best) best = d;
    }
  }
  return Math.sqrt(best);
}
