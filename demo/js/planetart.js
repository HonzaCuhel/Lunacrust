// Menu artwork: each world painted as a 2D orb. Bands, craters, continents and
// cracks are all deterministic from the planet id, and `phase` slides the detail
// sideways so the orbs rotate slowly while you choose.

const rndFor = (seed) => {
  let s = seed >>> 0 || 7;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
};
const seedOf = (str) => {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};

export function drawPlanetOrb(ctx, planet, size, phase = 0) {
  const o = planet.orb;
  const cx = size / 2, cy = size / 2, r = size * 0.33;
  ctx.clearRect(0, 0, size, size);

  // atmosphere glow
  const halo = ctx.createRadialGradient(cx, cy, r * 0.9, cx, cy, r * 1.75);
  halo.addColorStop(0, o.glow + 'aa');
  halo.addColorStop(0.35, o.glow + '33');
  halo.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, size, size);

  if (o.ring) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-0.38);
    ctx.scale(1, 0.2);
    ctx.strokeStyle = o.ring;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = size * 0.035;
    ctx.beginPath(); ctx.arc(0, 0, r * 1.72, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 0.25;
    ctx.lineWidth = size * 0.02;
    ctx.beginPath(); ctx.arc(0, 0, r * 1.95, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();

  const base = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r * 1.15);
  base.addColorStop(0, o.cloud ?? o.base);
  base.addColorStop(0.55, o.base);
  base.addColorStop(1, o.land);
  ctx.fillStyle = base;
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);

  const rnd = rndFor(seedOf(planet.id));
  const wrap = (x) => ((x % (r * 2)) + r * 2) % (r * 2) - r;

  if (o.bands) {
    for (let i = 0; i < 11; i++) {
      const y = cy - r + (i / 11) * r * 2;
      ctx.fillStyle = i % 2 ? o.land : (o.cloud ?? o.base);
      ctx.globalAlpha = 0.2 + (i % 3) * 0.12;
      const wob = Math.sin(phase * 0.6 + i) * r * 0.04;
      ctx.fillRect(cx - r, y + wob, r * 2, (r * 2 / 11) * (0.55 + (i % 2) * 0.6));
    }
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = '#b4543a';
    ctx.beginPath();
    ctx.ellipse(cx + wrap(r * 0.3 + phase * r * 0.12), cy + r * 0.25, r * 0.22, r * 0.11, 0.15, 0, Math.PI * 2);
    ctx.fill();
  } else if (planet.id === 'luna') {
    for (let i = 0; i < 26; i++) {
      const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * r;
      const x = wrap(cx + Math.cos(a) * d + phase * r * 0.1 - cx) + cx;
      const y = cy + Math.sin(a) * d;
      const rad = r * (0.04 + rnd() * 0.1);
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = o.land;
      ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.stroke();
    }
  } else if (planet.id === 'europa') {
    ctx.globalAlpha = 0.7;
    ctx.strokeStyle = o.land;
    for (let i = 0; i < 14; i++) {
      ctx.lineWidth = 1 + rnd() * 2.4;
      ctx.beginPath();
      let x = cx - r + rnd() * r * 2 + phase * r * 0.08;
      let y = cy - r;
      ctx.moveTo(wrap(x - cx) + cx, y);
      while (y < cy + r) {
        x += (rnd() - 0.5) * r * 0.4;
        y += r * 0.22;
        ctx.lineTo(wrap(x - cx) + cx, y);
      }
      ctx.stroke();
    }
  } else {
    // generic continents / splotches
    for (let i = 0; i < 12; i++) {
      const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * r * 0.9;
      const x = wrap(Math.cos(a) * d + phase * r * 0.12) + cx;
      const y = cy + Math.sin(a) * d * 0.8;
      ctx.globalAlpha = 0.35 + rnd() * 0.35;
      ctx.fillStyle = i % 3 === 0 ? (o.cloud ?? o.land) : o.land;
      ctx.beginPath();
      ctx.ellipse(x, y, r * (0.12 + rnd() * 0.28), r * (0.08 + rnd() * 0.18), a, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // limb darkening + terminator
  ctx.globalAlpha = 1;
  const term = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
  term.addColorStop(0, 'rgba(255,255,255,0.16)');
  term.addColorStop(0.45, 'rgba(0,0,0,0)');
  term.addColorStop(1, 'rgba(2,4,12,0.72)');
  ctx.fillStyle = term;
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  ctx.restore();

  // rim light
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = o.glow;
  ctx.lineWidth = size * 0.008;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/** Slow-drifting starfield behind the menu. */
export function drawStarfield(ctx, w, h, t) {
  ctx.clearRect(0, 0, w, h);
  const rnd = rndFor(20240);
  for (let i = 0; i < 260; i++) {
    const x = (rnd() * w + t * (2 + (i % 5)) * 0.35) % w;
    const y = rnd() * h;
    const s = rnd();
    const tw = 0.55 + Math.sin(t * (0.6 + s) + i) * 0.45;
    ctx.globalAlpha = (0.2 + s * 0.75) * tw;
    ctx.fillStyle = i % 9 === 0 ? '#9fd4ff' : '#ffffff';
    const size = s > 0.93 ? 2.4 : s > 0.7 ? 1.6 : 1;
    ctx.fillRect(x, y, size, size);
  }
  ctx.globalAlpha = 1;
}
