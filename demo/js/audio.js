// Every sound is synthesised at runtime - no audio files ship with the game.
// Footsteps are filtered noise bursts, block hits are pitched clicks, and each
// planet gets a drone whose character follows its atmosphere.

const MATERIAL = {
  stone: { f: 260, noise: 0.7, decay: 0.09, type: 'square' },
  soft: { f: 150, noise: 1.0, decay: 0.14, type: 'sine' },
  wood: { f: 330, noise: 0.5, decay: 0.11, type: 'triangle' },
  glass: { f: 900, noise: 0.35, decay: 0.16, type: 'sine' },
  metal: { f: 620, noise: 0.25, decay: 0.22, type: 'square' },
  liquid: { f: 190, noise: 0.9, decay: 0.2, type: 'sine' },
};

export class Audio {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.volume = 0.5;
  }

  resume() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { this.enabled = false; return; }
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
      // A sibling of `master`, never a child of it: the player can (and does)
      // drive effects volume to 0 while still expecting to hear music, so
      // nothing downstream of `master` may be able to gate this bus. music.js
      // hangs its own volume-controlled node off this one.
      this.musicBus = this.ctx.createGain();
      this.musicBus.gain.value = 1;
      this.musicBus.connect(this.ctx.destination);
      this.noiseBuffer = this.makeNoise();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  makeNoise() {
    const len = this.ctx.sampleRate * 0.5;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  blip(kind = 'stone', pitch = 1, gain = 0.5) {
    if (!this.enabled || !this.ctx) return;
    const m = MATERIAL[kind] ?? MATERIAL.stone;
    const t = this.ctx.currentTime;

    const osc = this.ctx.createOscillator();
    osc.type = m.type;
    osc.frequency.setValueAtTime(m.f * pitch, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(40, m.f * pitch * 0.45), t + m.decay);
    const og = this.ctx.createGain();
    og.gain.setValueAtTime(gain * 0.32, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + m.decay);
    osc.connect(og).connect(this.master);
    osc.start(t); osc.stop(t + m.decay + 0.02);

    if (m.noise > 0) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      const filt = this.ctx.createBiquadFilter();
      filt.type = 'bandpass';
      filt.frequency.value = m.f * pitch * 2.2;
      filt.Q.value = 1.2;
      const ng = this.ctx.createGain();
      ng.gain.setValueAtTime(gain * 0.22 * m.noise, t);
      ng.gain.exponentialRampToValueAtTime(0.0001, t + m.decay * 1.2);
      src.connect(filt).connect(ng).connect(this.master);
      src.start(t); src.stop(t + m.decay * 1.3);
    }
  }

  step(kind = 'stone') { this.blip(kind, 0.7 + Math.random() * 0.25, 0.28); }

  /** Damage: a short descending buzz, harsher for the nastier causes. */
  hurt(cause = 'hit') {
    if (!this.enabled || !this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = cause === 'lava' || cause === 'burning' ? 'sawtooth' : 'square';
    osc.frequency.setValueAtTime(cause === 'asphyxiation' ? 180 : 320, t);
    osc.frequency.exponentialRampToValueAtTime(70, t + 0.28);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.22, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    osc.connect(g).connect(this.master);
    osc.start(t); osc.stop(t + 0.32);
  }

  /** Picking something up: two quick rising blips. */
  pickup() {
    if (!this.enabled || !this.ctx) return;
    const t = this.ctx.currentTime;
    for (const [i, f] of [[0, 620], [1, 880]]) {
      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = f;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + i * 0.05);
      g.gain.linearRampToValueAtTime(0.12, t + i * 0.05 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.05 + 0.09);
      osc.connect(g).connect(this.master);
      osc.start(t + i * 0.05); osc.stop(t + i * 0.05 + 0.1);
    }
  }
  break_(kind) { this.blip(kind, 0.85 + Math.random() * 0.3, 0.7); }
  place(kind) { this.blip(kind, 1.25 + Math.random() * 0.2, 0.55); }
  ui(up = true) { this.blip('glass', up ? 1.4 : 0.9, 0.3); }

  /** A low bed of noise/tone that gives each world its own room tone. */
  ambience(planet) {
    if (!this.enabled || !this.ctx) return;
    this.stopAmbience();
    const t = this.ctx.currentTime;
    const g = this.ctx.createGain();
    // airless worlds are almost silent; thick atmospheres hum
    const thickness = Math.min(1, planet.sky.fogDensity * 60);
    g.gain.value = 0.0001;
    g.gain.linearRampToValueAtTime(0.02 + thickness * 0.06, t + 3);
    g.connect(this.master);

    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filt = this.ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 110 + thickness * 320;
    src.connect(filt).connect(g);
    src.start();

    const drone = this.ctx.createOscillator();
    drone.type = 'sine';
    drone.frequency.value = 42 + planet.gravity * 1.6;
    const dg = this.ctx.createGain();
    dg.gain.value = 0.03 + thickness * 0.03;
    drone.connect(dg).connect(g);
    drone.start();

    this.amb = { g, src, drone };
  }

  stopAmbience() {
    if (!this.amb) return;
    try { this.amb.src.stop(); this.amb.drone.stop(); } catch { /* already stopped */ }
    this.amb.g.disconnect();
    this.amb = null;
  }
}
