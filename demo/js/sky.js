// Sky: gradient dome, stars, a sun that actually moves, and the neighbouring
// world hanging overhead (Earth from the Moon, Jupiter from Europa).

import * as THREE from '../vendor/three.module.js';

const SKY_R = 900;

/** One ring band: [radius multiple, width multiple, alpha]. */
const RING_BANDS = [
  [2.26, 0.10, 0.30],   // faint outer
  [2.05, 0.26, 0.85],   // A ring
  [1.78, 0.06, 0.12],   // Cassini division - the gap is what sells it as rings
  [1.62, 0.34, 1.00],   // B ring, the bright one
  [1.30, 0.22, 0.45],   // C ring, thin and dim against the planet
];
const RING_TILT = -0.30;
const RING_SQUASH = 0.30;

/**
 * Draw one half of the ring system. The far half has to go down before the
 * planet and the near half after it, or the ring reads as an arc parked behind
 * the disc rather than a ring the planet sits inside.
 */
function drawRingHalf(g, cx, cy, r, cfg, half) {
  g.save();
  g.translate(cx, cy);
  g.rotate(RING_TILT);
  g.beginPath();
  const span = r * 4;
  // In ring space the far side is above the centre line and the near side below.
  if (half === 'far') g.rect(-span, -span, span * 2, span);
  else g.rect(-span, 0, span * 2, span);
  g.clip();
  g.scale(1, RING_SQUASH);
  for (const [rad, width, alpha] of RING_BANDS) {
    g.beginPath();
    g.arc(0, 0, r * rad, 0, Math.PI * 2);
    g.strokeStyle = cfg.ringColor ?? cfg.accent;
    g.globalAlpha = alpha * 0.9;
    g.lineWidth = Math.max(1.5, r * width);
    g.stroke();
  }
  g.restore();
  g.globalAlpha = 1;
}

function makeBodyTexture(cfg) {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  g.clearRect(0, 0, S, S);

  const cx = S / 2, cy = S / 2;
  // A ringed body needs room for its rings inside the same sprite, so the disc
  // itself is drawn smaller and planets.js scales the sprite back up.
  const r = cfg.ring ? S * 0.20 : S * 0.36;

  if (cfg.ring) drawRingHalf(g, cx, cy, r, cfg, 'far');

  const grad = g.createRadialGradient(cx - r * 0.3, cy - r * 0.35, r * 0.1, cx, cy, r);
  grad.addColorStop(0, cfg.color);
  grad.addColorStop(0.72, cfg.color);
  grad.addColorStop(1, cfg.accent);
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.fillStyle = grad;
  g.fill();

  if (cfg.bands) {
    g.save();
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.clip();
    for (let i = 0; i < 9; i++) {
      const y = cy - r + (i / 9) * r * 2;
      g.fillStyle = i % 2 ? cfg.accent : cfg.color;
      g.globalAlpha = 0.35 + (i % 3) * 0.12;
      g.fillRect(cx - r, y, r * 2, (r * 2) / 9 * (0.6 + (i % 2) * 0.5));
    }
    g.globalAlpha = 1;
    // the great red spot, because of course
    g.fillStyle = '#b4543a';
    g.globalAlpha = 0.65;
    g.beginPath();
    g.ellipse(cx + r * 0.25, cy + r * 0.22, r * 0.22, r * 0.12, 0.2, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }
  if (cfg.landColor) {
    g.save();
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.clip();
    g.fillStyle = cfg.landColor;
    g.globalAlpha = 0.85;
    for (let i = 0; i < 7; i++) {
      const a = i * 1.7, rr = r * (0.25 + (i % 3) * 0.18);
      g.beginPath();
      g.ellipse(cx + Math.cos(a) * r * 0.4, cy + Math.sin(a) * r * 0.4, rr * 0.6, rr * 0.4, a, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  }

  // Ring shadow: a soft dark band the rings cast across the disc. Cheap, and it
  // is most of what makes the ring look like it is really there.
  if (cfg.ring) {
    g.save();
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.clip();
    g.translate(cx, cy);
    g.rotate(RING_TILT);
    g.globalAlpha = 0.16;
    g.fillStyle = '#1a1206';
    g.fillRect(-r * 2, -r * 0.16, r * 4, r * 0.32);
    g.restore();
    g.globalAlpha = 1;
  }

  // soft terminator so it reads as a lit sphere
  const shade = g.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
  shade.addColorStop(0, 'rgba(255,255,255,0.18)');
  shade.addColorStop(0.5, 'rgba(0,0,0,0)');
  shade.addColorStop(1, 'rgba(0,0,10,0.55)');
  g.save();
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.clip();
  g.fillStyle = shade;
  g.fillRect(cx - r, cy - r, r * 2, r * 2);
  g.restore();

  if (cfg.ring) drawRingHalf(g, cx, cy, r, cfg, 'near');

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeGlowTexture(color) {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grad.addColorStop(0, color);
  grad.addColorStop(0.25, color);
  grad.addColorStop(0.5, 'rgba(255,255,255,0.25)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Sky {
  constructor(scene, planet) {
    this.planet = planet;
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.renderOrder = -1000;
    scene.add(this.group);

    const s = planet.sky;
    this.topColor = new THREE.Color(s.top);
    this.horizonColor = new THREE.Color(s.horizon);
    this.nightTop = this.topColor.clone().multiplyScalar(0.12);
    this.nightHorizon = this.horizonColor.clone().multiplyScalar(0.18);

    // --- dome
    this.uniforms = {
      topColor: { value: this.topColor.clone() },
      horizonColor: { value: this.horizonColor.clone() },
      groundColor: { value: new THREE.Color(s.fog).multiplyScalar(0.85) },
      exponent: { value: 0.65 },
    };
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(SKY_R, 32, 20),
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        vertexShader: `
          varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: `
          uniform vec3 topColor, horizonColor, groundColor;
          uniform float exponent;
          varying vec3 vDir;
          void main() {
            float h = normalize(vDir).y;
            vec3 c = h >= 0.0
              ? mix(horizonColor, topColor, pow(h, exponent))
              : mix(horizonColor, groundColor, min(1.0, -h * 3.0));
            gl_FragColor = vec4(c, 1.0);
          }`,
      }),
    );
    dome.frustumCulled = false;
    dome.renderOrder = -30;
    this.group.add(dome);

    // --- stars
    if (s.stars > 0) {
      const count = Math.round(2200 * s.stars);
      const pos = new Float32Array(count * 3);
      const col = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        // even-ish sphere sampling, biased away from straight down
        const u = Math.random() * 2 - 1;
        const th = Math.random() * Math.PI * 2;
        const r = Math.sqrt(1 - u * u);
        const R = SKY_R * 0.94;
        pos[i * 3] = Math.cos(th) * r * R;
        pos[i * 3 + 1] = Math.abs(u) * R;
        pos[i * 3 + 2] = Math.sin(th) * r * R;
        const warm = 0.75 + Math.random() * 0.25;
        const b = 0.55 + Math.random() * 0.45;
        col[i * 3] = b; col[i * 3 + 1] = b * warm; col[i * 3 + 2] = b * (0.85 + Math.random() * 0.15);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      this.stars = new THREE.Points(geo, new THREE.PointsMaterial({
        size: 2.6, sizeAttenuation: false, vertexColors: true,
        transparent: true, opacity: s.stars, depthWrite: false, fog: false,
      }));
      this.stars.frustumCulled = false;
      this.stars.renderOrder = -20;   // behind the sun and the companion worlds
      this.group.add(this.stars);
    }

    // --- sun
    this.sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeGlowTexture(s.sun), transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, fog: false,
    }));
    this.sunSprite.scale.setScalar(s.sunSize * 3.2);
    this.sunSprite.renderOrder = -8;
    this.group.add(this.sunSprite);

    // --- companion worlds
    this.companions = (s.companions ?? []).map((c) => {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: makeBodyTexture({
          color: c.color, accent: c.accent ?? c.color, bands: c.bands,
          ring: c.ring, ringColor: c.ringColor, landColor: c.land,
        }),
        transparent: true, depthWrite: false, fog: false,
      }));
      sprite.scale.setScalar(c.size * 2.6);
      sprite.renderOrder = -10;
      const el = c.el, az = c.az;
      sprite.position.set(
        Math.cos(el) * Math.sin(az) * SKY_R * 0.8,
        Math.sin(el) * SKY_R * 0.8,
        Math.cos(el) * Math.cos(az) * SKY_R * 0.8,
      );
      this.group.add(sprite);
      return sprite;
    });

    // --- lights
    this.sun = new THREE.DirectionalLight(new THREE.Color(s.sun), s.sunIntensity);
    this.sun.position.set(80, 120, 40);
    scene.add(this.sun);
    this.hemi = new THREE.HemisphereLight(new THREE.Color(s.ambientSky), new THREE.Color(s.ambientGround), s.ambientIntensity);
    scene.add(this.hemi);

    this.fogColor = new THREE.Color(s.fog);
    scene.fog = new THREE.FogExp2(this.fogColor.clone(), s.fogDensity);
    scene.background = new THREE.Color(s.fog).multiplyScalar(0.9);

    this.time = 0.28;   // start mid-morning
  }

  /** @param {number} dt seconds @param {THREE.Vector3} camPos */
  update(dt, camPos) {
    const s = this.planet.sky;
    this.time = (this.time + dt / this.planet.dayLength) % 1;
    const ang = this.time * Math.PI * 2;
    const dir = new THREE.Vector3(Math.cos(ang) * 0.55, Math.sin(ang), Math.sin(ang * 0.5) * 0.45).normalize();

    this.group.position.copy(camPos);
    this.sunSprite.position.copy(dir).multiplyScalar(SKY_R * 0.85);
    this.sun.position.copy(camPos).addScaledVector(dir, 220);
    this.sun.target.position.copy(camPos);
    this.sun.target.updateMatrixWorld();

    // Altitude drives day/night: everything dims together, so a sunset actually
    // reads as one.
    const alt = Math.max(0, dir.y);
    const day = Math.min(1, alt * 2.4);
    this.sun.intensity = s.sunIntensity * (0.06 + day * 0.94);
    this.hemi.intensity = s.ambientIntensity * (0.22 + day * 0.78);
    this.sunSprite.material.opacity = 0.25 + day * 0.75;

    this.uniforms.topColor.value.lerpColors(this.nightTop, this.topColor, day);
    this.uniforms.horizonColor.value.lerpColors(this.nightHorizon, this.horizonColor, Math.min(1, day * 1.5));
    const fog = this.fogColor.clone().multiplyScalar(0.14 + day * 0.86);
    this.scene.fog.color.copy(fog);
    this.scene.background.copy(fog).multiplyScalar(0.9);

    if (this.stars) this.stars.material.opacity = s.stars * (1 - day * 0.85);
  }

  dispose() {
    this.scene.remove(this.group, this.sun, this.hemi);
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) { o.material.map?.dispose(); o.material.dispose(); }
    });
  }
}
