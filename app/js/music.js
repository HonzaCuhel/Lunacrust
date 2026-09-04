// Background music. Two <audio> decks stream the three WAV tracks straight off the
// app:// protocol - never `decodeAudioData`, which would hold ~200 MB of
// Float32 PCM for three tracks this size. The pure half of this module
// (TRACKS, moodFor, pickNext, gapFor, equalPowerCurve, trackUrl) has no DOM
// or WebAudio in it and is exercised directly by tests/music.test.mjs; the
// `Music` class is the DOM/WebAudio half and is driven entirely by one
// per-frame `update(dt, situation)` call - there is no internal timer, which
// is what keeps the gap/crossfade/prewarm maths frame-rate independent.
//
// THE ONE FOOTGUN: `ctx.createMediaElementSource(el)` may be called only
// ONCE per <audio> element - a second call throws and kills the music
// silently. That is exactly why the two decks are created once (in the
// constructor) and every track reuses them by swapping `.src`; nothing in
// this file ever constructs a third element.
//
// Routing (see audio.js's resume() for the other half of this):
//   deck 0 ─┐                                          ┌─ ctx.destination
//   deck 1 ─┴─ createMediaElementSource → deckGain ──┴─ this.bus ─ audio.musicBus
// `audio.musicBus` is a fixed-gain sibling of the SFX master and is never
// touched here. `this.bus` is this instance's own volume/duck control, and
// is the node the "music not gated behind effects volume" invariant is
// actually about.

export const TRACKS = [
  { key: 'classic', sec: 158, moods: ['night', 'day'] },
  { key: 'dark-cave', sec: 235, moods: ['deep'] },
  { key: 'explore', sec: 168, moods: ['day'] },
];

const FADE_OUT = 3; // natural end-of-track fade, seconds
const CROSSFADE = 4; // mood-change crossfade, seconds
const CURVE_STEPS = 16;
const MOOD_HOLD = 45; // minimum seconds between mood-driven track swaps
const DEEP_ENTER = 12; // depth at which "day/night" gives way to "deep"
const DEEP_RELEASE = 8; // depth at which "deep" gives back up, once already deep
const PREWARM_LEAD = 12; // seconds before track end to start loading the next one
const DUCK_LEVEL = 0.45; // bus level while a menu/screen has the game paused

/**
 * @param {{y:number, surfaceY:number, dayFraction:number, floating:boolean}} s
 * @param {string|null} prevMood the mood currently sounding, for hysteresis
 */
export function moodFor(s, prevMood) {
  const depth = s.floating ? -Infinity : s.surfaceY - s.y;
  const deepBand = prevMood === 'deep' ? DEEP_RELEASE : DEEP_ENTER;
  if (depth >= deepBand) return 'deep';
  // Same sun-altitude test main.js's timeLabel uses, so the soundtrack and
  // the HUD clock never disagree about whether it is night.
  return Math.sin(s.dayFraction * Math.PI * 2) < -0.12 ? 'night' : 'day';
}

// A track that matches the mood scores highest; one that is mood-tagged but
// for something else still has a shot (three tracks is a small library - a
// hard exclusion would make the "day" playlist feel like one song); a track
// with no moods at all (none exist yet, but nothing here assumes there
// won't ever be a mood-agnostic filler track) is a rare wildcard.
const scoreTrack = (t, mood) => (t.moods.includes(mood) ? 2 : t.moods.length ? 1 : 0.15);

/**
 * @param {string} mood
 * @param {string|null} lastKey
 * @param {() => number} rng
 */
export function pickNext(mood, lastKey, rng = Math.random) {
  const scores = TRACKS.map((t) => scoreTrack(t, mood));
  // Every score above is > 0, so this only leaves lastKey un-zeroed when it
  // is the sole track in the list - "never repeat unless it is the only
  // option" falls out of that rather than needing a special case.
  const anotherIsViable = TRACKS.some((t, i) => t.key !== lastKey && scores[i] > 0);
  const weights = scores.map((s, i) => (anotherIsViable && TRACKS[i].key === lastKey ? 0 : s));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  // The comparison has to happen BEFORE subtracting: checking `r <= 0` after
  // subtracting a zero weight would let rng() === 0 exactly "land on" a
  // zeroed-out (excluded) track just because r never moved off zero.
  for (let i = 0; i < TRACKS.length; i++) {
    if (r < weights[i]) return TRACKS[i].key;
    r -= weights[i];
  }
  return TRACKS[TRACKS.length - 1].key;
}

/** Seconds of silence between tracks - Long silences make each expedition feel spacious. */
export const gapFor = (rng = Math.random) => 25 + rng() * 70;

/**
 * A quarter-cosine power curve, read forwards as a fade-OUT (1 -> 0) and
 * reversed as the matching fade-IN (0 -> 1): curve[i]^2 + curve[n-1-i]^2 == 1
 * for every i, which is the property that keeps a crossfade's summed power
 * flat instead of dipping in the middle the way a linear fade would.
 * @returns {Float32Array}
 */
export function equalPowerCurve(n) {
  const steps = Math.max(2, n | 0);
  const curve = new Float32Array(steps);
  for (let i = 0; i < steps; i++) curve[i] = Math.cos((i / (steps - 1)) * (Math.PI / 2));
  return curve;
}

// Same trick world.js uses to resolve its worker: correct under both
// app://space/js/music.js and http://localhost:5178/js/music.js with no
// base-URL configuration needed.
export const trackUrl = (key) => new URL(`../audio/${key}.wav`, import.meta.url).href;

const trackByKey = (key) => TRACKS.find((t) => t.key === key);

export class Music {
  constructor({ audio, rng = Math.random }) {
    this.audio = audio;
    this.rng = rng;
    this.volume = 1;
    this.ducked = false;
    this._state = 'idle';
    this.mood = null;
    this.lastKey = null;
    this.currentKey = null;
    this.active = 0; // index of the deck carrying the current/most recent track

    this._routed = false; // WebAudio graph wired (false until an AudioContext exists)
    this.decks = null;
    this.gains = null; // per-deck GainNode, for crossfading between decks
    this.bus = null; // this instance's own volume/duck GainNode

    this._holdT = MOOD_HOLD; // seconds since the last mood-driven swap; starts open
    this._restT = 0; // seconds left in the silent gap between tracks
    this._crossfade = null; // {from, to, t, key} while a mood crossfade is running
    this._fading = false; // true while the active deck is fading out at track end
    this._fadeT = 0;
    this._prewarmed = false;
    this._muteTimer = null;
    this._stopTimer = null;
  }

  get state() { return this._state; }

  _ensureDecks() {
    if (this.decks) return;
    this.decks = [0, 1].map(() => {
      const el = document.createElement('audio');
      el.preload = 'none';
      return el;
    });
  }

  /** No-op until audio.ctx exists; safe to call every time start() runs. */
  _ensureRouting() {
    if (this._routed) return;
    const a = this.audio;
    if (!a?.ctx || !a.musicBus) return;
    const ctx = a.ctx;
    this.bus = ctx.createGain();
    this.bus.gain.value = this._effectiveVolume();
    this.bus.connect(a.musicBus);
    this.gains = this.decks.map((el) => {
      const src = ctx.createMediaElementSource(el);
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(g).connect(this.bus);
      return g;
    });
    this._routed = true;
  }

  _effectiveVolume() {
    return this.volume * (this.ducked ? DUCK_LEVEL : 1);
  }

  /** Safe to call more than once - a rejected first play() is retried by calling this again. */
  start() {
    this._ensureDecks();
    this._ensureRouting();
    if (this._state !== 'idle') return;
    this._beginTrack(pickNext(this.mood ?? 'day', this.lastKey, this.rng));
  }

  stop(fade = 1.5) {
    if (this._state === 'idle' || !this.decks) return;
    if (this._routed) {
      const now = this.audio.ctx.currentTime;
      this.bus.gain.cancelScheduledValues(now);
      this.bus.gain.setTargetAtTime(0, now, Math.max(0.001, fade / 5));
    } else {
      for (const el of this.decks) el.volume = 0;
    }
    clearTimeout(this._stopTimer);
    this._stopTimer = setTimeout(() => {
      for (const el of this.decks) el.pause();
      this._state = 'idle';
      this._crossfade = null;
      this._fading = false;
      this._fadeT = 0;
      this._restT = 0;
      this._prewarmed = false;
      if (this._routed) this.bus.gain.value = this._effectiveVolume();
    }, Math.max(0, fade * 1000));
  }

  /** 0..1, smoothed; at 0 the decks pause rather than decode an WAV nobody hears. */
  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    this._applyVolume();
  }

  /** Pause-menu / open-screen ducking - restored by the matching duck(false). */
  duck(on) {
    const next = !!on;
    if (this.ducked === next) return;
    this.ducked = next;
    this._applyVolume();
  }

  _applyVolume() {
    const eff = this._effectiveVolume();
    if (this._routed) {
      const now = this.audio.ctx.currentTime;
      this.bus.gain.setTargetAtTime(eff, now, 0.05);
    } else if (this.decks) {
      for (const el of this.decks) el.volume = eff;
    }
    clearTimeout(this._muteTimer);
    if (eff <= 0.0001) {
      this._muteTimer = setTimeout(() => { for (const el of this.decks ?? []) el.pause(); }, 300);
    } else if (this._state === 'playing' || this._state === 'fading' || this._crossfade) {
      for (const el of this.decks ?? []) if (el.paused && el.src) el.play()?.catch?.(() => {});
    }
  }

  /** @param {number} dt @param {{y:number, surfaceY:number, dayFraction:number, floating:boolean}} situation */
  update(dt, situation) {
    if (this._state === 'idle' || !this.decks) return;
    this._holdT += dt;

    const nextMood = moodFor(situation, this.mood);
    if (nextMood !== this.mood) {
      if (this._state === 'playing' && !this._crossfade && this._holdT >= MOOD_HOLD) {
        this._startCrossfade(pickNext(nextMood, this.lastKey, this.rng));
        this.mood = nextMood;
        this._holdT = 0;
      } else if (this._state !== 'playing') {
        // Nothing sounding yet (idle/rest) - nothing to interrupt, so adopt now.
        this.mood = nextMood;
      }
      // else: still on cooldown: keep the current mood and re-check next frame.
    }

    if (this._crossfade) {
      this._crossfade.t += dt;
      if (this._crossfade.t >= CROSSFADE) this._finishCrossfade();
      return;
    }

    if (this._state === 'rest') {
      this._restT -= dt;
      if (this._restT <= 0) this._beginTrack(this._nextKey ?? pickNext(this.mood, this.lastKey, this.rng));
      return;
    }

    // 'fading' has to keep running this block too, or the fade-out started
    // below would never reach the code (further down) that finishes it and
    // hands off to 'rest' - it would just hang at zero volume forever.
    if (this._state !== 'playing' && this._state !== 'fading') return;
    const el = this.decks[this.active];
    const track = trackByKey(this.currentKey);
    if (!track) return;
    const remaining = track.sec - (el.currentTime || 0);

    if (!this._prewarmed && remaining <= PREWARM_LEAD) {
      this._nextKey = pickNext(this.mood, this.lastKey, this.rng);
      const idle = this.decks[1 - this.active];
      idle.src = trackUrl(this._nextKey);
      idle.load();
      this._prewarmed = true;
    }

    if (!this._fading && remaining <= FADE_OUT) {
      this._fading = true;
      this._fadeT = 0;
      this._state = 'fading';
      this._rampDeckOut(this.active, FADE_OUT);
    }
    if (this._fading) {
      this._fadeT += dt;
      if (this._fadeT >= FADE_OUT || el.ended) {
        el.pause();
        this._fading = false;
        this._fadeT = 0;
        this._state = 'rest';
        this._restT = gapFor(this.rng);
      }
    }
  }

  _rampDeckOut(idx, dur) {
    if (this._routed) {
      const now = this.audio.ctx.currentTime;
      this.gains[idx].gain.setTargetAtTime(0, now, dur / 5);
    } else {
      this.decks[idx].volume = 0;
    }
  }

  _startCrossfade(nextKey) {
    const from = this.active, to = 1 - this.active;
    const el = this.decks[to];
    const url = trackUrl(nextKey);
    if (el.src !== url) el.src = url;
    el.load();
    el.currentTime = 0;
    const p = el.play();
    p?.catch?.(() => {});
    this._crossfade = { from, to, t: 0, key: nextKey };
    this._fading = false;
    this._prewarmed = false;

    if (this._routed) {
      const curve = equalPowerCurve(CURVE_STEPS);
      const fadeIn = curve.slice().reverse();
      const now = this.audio.ctx.currentTime;
      this.gains[from].gain.setValueCurveAtTime(curve, now, CROSSFADE);
      this.gains[to].gain.setValueCurveAtTime(fadeIn, now, CROSSFADE);
    } else {
      // No WebAudio graph to ramp: hard-cut. Music still plays, it just loses
      // the equal-power fade - see the module header and audio.js's resume().
      this.decks[from].volume = 0;
      el.volume = this._effectiveVolume();
    }
  }

  _finishCrossfade() {
    const { from, to, key } = this._crossfade;
    this.decks[from].pause();
    this.active = to;
    this.currentKey = key;
    this.lastKey = key;
    this._crossfade = null;
    this._prewarmed = false;
  }

  _beginTrack(key) {
    const idx = this.active;
    const el = this.decks[idx];
    const url = trackUrl(key);
    if (el.src !== url) { el.src = url; el.load(); }
    el.currentTime = 0;
    if (this._routed) {
      this.gains[idx].gain.value = 1;
      this.gains[1 - idx].gain.value = 0;
    } else {
      el.volume = this._effectiveVolume();
    }
    const p = el.play();
    p?.catch?.(() => { this._state = 'idle'; });
    this.currentKey = key;
    this.lastKey = key;
    this._state = 'playing';
    this._prewarmed = false;
    this._fading = false;
    this._fadeT = 0;
    // The 45s mood-hold dwell has to count from THIS track's start, not from
    // whatever _holdT happened to be already (the constructor primes it at
    // MOOD_HOLD so the gate reads "open"). Without this reset, the very
    // first update() after start() sees _holdT >= MOOD_HOLD immediately and
    // - because `this.mood` is still null and any real mood differs from
    // null - fires a crossfade one frame after the track begins, before a
    // single second of it has been heard.
    this._holdT = 0;
  }
}
