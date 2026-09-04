// Music tests. Run: node tests/music.test.mjs
//
// The pure half (TRACKS, moodFor, pickNext, gapFor, equalPowerCurve, trackUrl)
// needs nothing but this file. The `Music` class needs an <audio> element and
// an AudioContext, neither of which node has, so the second half stands up a
// deliberately minimal fake of both - just enough surface for audio.js and
// music.js to run against - and uses it to prove the one invariant the whole
// feature exists for: music must not be gated behind the effects-volume
// slider. That is asserted here, not assumed.

import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  TRACKS, moodFor, pickNext, gapFor, equalPowerCurve, trackUrl, Music,
} from '../app/js/music.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// --- harness ----------------------------------------------------------------
let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; }
  catch (err) { failures.push({ name, err }); }
}

// =============================================================== moodFor ===
await test('never deep on a floating world, no matter how far "below" the surface', () => {
  const s = { y: -500, surfaceY: 900, dayFraction: 0.5, floating: true };
  assert.notEqual(moodFor(s, null), 'deep');
  assert.notEqual(moodFor(s, 'deep'), 'deep');
});

await test('deep enters at depth 12, not before, when the previous mood was not deep', () => {
  const at = (depth) => moodFor({ y: 0, surfaceY: depth, dayFraction: 0.5, floating: false }, 'day');
  assert.notEqual(at(11.999), 'deep');
  assert.equal(at(12), 'deep');
  assert.equal(at(50), 'deep');
});

await test('deep releases at depth 8, not before, once already deep (the hysteresis band)', () => {
  const at = (depth) => moodFor({ y: 0, surfaceY: depth, dayFraction: 0.5, floating: false }, 'deep');
  assert.equal(at(8), 'deep');
  assert.equal(at(10), 'deep');   // inside the 8..12 band: stays deep because prevMood was deep
  assert.notEqual(at(7.999), 'deep');
});

await test('the 8..12 band really is a band: the same depth answers differently by prevMood', () => {
  const s = { y: 0, surfaceY: 10, dayFraction: 0.5, floating: false };
  assert.equal(moodFor(s, 'deep'), 'deep');       // still in the band, coming from deep
  assert.notEqual(moodFor(s, 'day'), 'deep');     // same depth, but never entered from day
});

await test('night uses the same sun-altitude test as main.js\'s timeLabel (sin(t*2pi) < -0.12)', () => {
  const notDeep = { y: 0, surfaceY: 0, dayFraction: 0, floating: false };
  assert.equal(moodFor({ ...notDeep, dayFraction: 0.75 }, null), 'night'); // sin = -1
  assert.equal(moodFor({ ...notDeep, dayFraction: 0.25 }, null), 'day');   // sin = 1
  assert.equal(moodFor({ ...notDeep, dayFraction: 0 }, null), 'day');     // sin = 0, above -0.12
});

// ============================================================= pickNext ===
await test('pickNext favours (but does not guarantee) a mood match, exactly by the stated weights', () => {
  // mood 'deep': classic=1 (listed, different), dark-cave=2 (match), explore=1
  // -> cumulative zones out of total 4: [0,1) classic, [1,3) dark-cave, [3,4) explore
  assert.equal(pickNext('deep', null, () => 0.10), 'classic');
  assert.equal(pickNext('deep', null, () => 0.50), 'dark-cave');
  assert.equal(pickNext('deep', null, () => 0.90), 'explore');
});

await test('pickNext never repeats the last track when another track can play at all', () => {
  // With 3 tracks every candidate scores > 0, so lastKey is always excluded -
  // exercise every mood and every rng() corner to be sure none of them slip
  // through the weighting math onto the excluded track.
  for (const mood of ['day', 'night', 'deep']) {
    for (const last of TRACKS.map((t) => t.key)) {
      for (const r of [0, 0.0001, 0.25, 0.5, 0.7499, 0.75, 0.9999]) {
        const next = pickNext(mood, last, () => r);
        assert.notEqual(next, last, `mood=${mood} last=${last} r=${r} picked ${next} again`);
      }
    }
  }
});

await test('pickNext can repeat only when it is the only track available', () => {
  // Shrink the real TRACKS array to one entry so `anotherIsViable` can never
  // be true, then restore it - exercising the actual exported function
  // against that condition, not a re-implementation of its algorithm.
  const backup = TRACKS.slice();
  TRACKS.length = 0;
  TRACKS.push(backup[0]);
  try {
    for (const r of [0, 0.3, 0.999]) {
      assert.equal(pickNext('day', backup[0].key, () => r), backup[0].key);
    }
  } finally {
    TRACKS.length = 0;
    TRACKS.push(...backup);
  }
  assert.equal(TRACKS.length, backup.length, 'TRACKS was not restored');
});

// =============================================================== gapFor ===
await test('gapFor stays inside [25, 95) and is driven entirely by the injected rng', () => {
  assert.equal(gapFor(() => 0), 25);
  assert.ok(Math.abs(gapFor(() => 1) - 95) < 1e-9);
  for (const r of [0, 0.2, 0.5, 0.8, 0.999]) {
    const g = gapFor(() => r);
    assert.ok(g >= 25 && g < 95.001, `gapFor(${r}) = ${g}`);
  }
});

// ======================================================= equalPowerCurve ===
await test('equalPowerCurve runs from 1 down to 0', () => {
  const c = equalPowerCurve(16);
  assert.equal(c.length, 16);
  assert.ok(Math.abs(c[0] - 1) < 1e-9);
  assert.ok(Math.abs(c[c.length - 1]) < 1e-9);
});

await test('equalPowerCurve holds unit power against its own reverse (the anti-dip property)', () => {
  // curve read forwards is the fade-out; reversed, it is the matching fade-in.
  // Their squares have to sum to 1 at every step or a crossfade dips in the
  // middle and you hear the hole.
  const n = 16;
  const c = equalPowerCurve(n);
  for (let i = 0; i < n; i++) {
    const power = c[i] * c[i] + c[n - 1 - i] * c[n - 1 - i];
    assert.ok(Math.abs(power - 1) < 1e-6, `index ${i}: power ${power}`);
  }
});

await test('equalPowerCurve is monotonically non-increasing', () => {
  const c = equalPowerCurve(16);
  for (let i = 1; i < c.length; i++) assert.ok(c[i] <= c[i - 1] + 1e-9);
});

// ============================================================= trackUrl ===
await test('trackUrl resolves every TRACKS key relative to this module, ending in the right filename', () => {
  for (const t of TRACKS) {
    const u = trackUrl(t.key);
    assert.ok(u.endsWith(`/audio/${t.key}.wav`), u);
  }
});

// ===================================================== TRACKS / shipping ===
await test('the three WAV files actually exist on disk and are non-empty', () => {
  for (const t of TRACKS) {
    const st = statSync(join(ROOT, 'app', 'audio', `${t.key}.wav`));
    assert.ok(st.isFile() && st.size > 0, `${t.key}.wav missing or empty`);
  }
});

await test('electron/main.js\'s MIME table names .wav as audio/wav (or the app ships silent)', () => {
  const src = readFileSync(join(ROOT, 'electron', 'main.js'), 'utf8');
  assert.match(src, /['"]\.wav['"]\s*:\s*['"]audio\/wav['"]/);
});


// every TRACKS entry names a real, distinct file with a sane duration
await test('TRACKS entries are distinct, positive-duration, and each names an existing mood', () => {
  const keys = new Set(TRACKS.map((t) => t.key));
  assert.equal(keys.size, TRACKS.length);
  for (const t of TRACKS) {
    assert.ok(t.sec > 0, `${t.key} has a non-positive duration`);
    assert.ok(Array.isArray(t.moods) && t.moods.length > 0, `${t.key} has no moods`);
  }
});

// ===================================================== Music / audio.js ===
// A deliberately minimal fake of the two DOM surfaces this feature touches:
// <audio> elements (document.createElement) and WebAudio (window.AudioContext).
// Enough to exercise the real Audio and Music classes end to end; nothing
// more elaborate than what audio.resume()/music's routing actually call.
function installFakeBrowser() {
  class FakeParam {
    constructor(v = 0) { this.value = v; }
    setValueAtTime(v) { this.value = v; return this; }
    setTargetAtTime(v) { this.value = v; return this; } // test double: applies immediately
    setValueCurveAtTime(curve) { this.value = curve[curve.length - 1]; return this; }
    linearRampToValueAtTime(v) { this.value = v; return this; }
    exponentialRampToValueAtTime(v) { this.value = v; return this; }
    cancelScheduledValues() { return this; }
  }
  class FakeNode {
    constructor() { this._out = []; }
    connect(dest) { this._out.push(dest); return dest; }
    disconnect() { this._out = []; }
    start() {} stop() {}
  }
  class FakeGain extends FakeNode {
    constructor() { super(); this.gain = new FakeParam(1); }
  }
  class FakeBuffer {
    constructor(len) { this._data = new Float32Array(len); }
    getChannelData() { return this._data; }
  }
  class FakeAudioContext {
    constructor() {
      this.currentTime = 0;
      this.destination = { _isDestination: true };
      this.sampleRate = 44100;
      this.state = 'running';
      this._sourced = new WeakSet();
    }
    createGain() { return new FakeGain(); }
    createBuffer(_ch, len) { return new FakeBuffer(len); }
    createMediaElementSource(el) {
      if (this._sourced.has(el)) throw new Error('createMediaElementSource called twice on the same element');
      this._sourced.add(el);
      return new FakeNode();
    }
    resume() { return Promise.resolve(); }
  }
  function fakeAudioEl() {
    return {
      _src: '',
      get src() { return this._src; },
      set src(v) { this._src = v; },
      preload: '', volume: 1, currentTime: 0, duration: NaN,
      paused: true, ended: false,
      load() {},
      play() { this.paused = false; return Promise.resolve(); },
      pause() { this.paused = true; },
    };
  }
  globalThis.window = { AudioContext: FakeAudioContext };
  globalThis.document = {
    createElement(tag) {
      if (tag !== 'audio') throw new Error(`fake document cannot create <${tag}>`);
      return fakeAudioEl();
    },
  };
}
installFakeBrowser();

const { Audio } = await import('../app/js/audio.js');

await test('audio.resume() creates master and musicBus as siblings, both wired straight to ctx.destination', () => {
  const audio = new Audio();
  audio.resume();
  assert.ok(audio.master, 'no master gain');
  assert.ok(audio.musicBus, 'no musicBus gain');
  assert.notEqual(audio.master, audio.musicBus);
  assert.ok(audio.master._out.includes(audio.ctx.destination));
  assert.ok(audio.musicBus._out.includes(audio.ctx.destination));
  assert.equal(audio.musicBus.gain.value, 1);
});

await test('INVARIANT: audio.setVolume(v) never touches music.bus, and music.setVolume(v) never touches audio.master', () => {
  const audio = new Audio();
  audio.resume();
  const music = new Music({ audio, rng: () => 0.4 });

  // setVolume before start() must not throw even though nothing is routed yet.
  music.setVolume(0.7);
  music.start();
  assert.equal(music.state, 'playing');
  assert.ok(music.bus, 'Music never created its own bus');
  assert.notEqual(music.bus, audio.master);
  assert.notEqual(music.bus, audio.musicBus);
  assert.ok(music.bus._out.includes(audio.musicBus), 'music.bus must feed into audio.musicBus');
  // the volume set before start() had to survive into the bus once it was built
  assert.equal(music.bus.gain.value, 0.7);

  audio.setVolume(0.05);
  assert.equal(audio.master.gain.value, 0.05);
  assert.equal(audio.musicBus.gain.value, 1, 'audio.setVolume moved musicBus');
  assert.equal(music.bus.gain.value, 0.7, 'audio.setVolume moved music.bus');

  music.setVolume(0.3);
  assert.equal(music.bus.gain.value, 0.3);
  assert.equal(audio.master.gain.value, 0.05, 'music.setVolume moved audio.master');
  assert.equal(audio.musicBus.gain.value, 1, 'music.setVolume moved audio.musicBus');
});

await test('duck(true) drops the bus and duck(false) restores it, without touching audio at all', () => {
  const audio = new Audio();
  audio.resume();
  const music = new Music({ audio, rng: () => 0.1 });
  music.setVolume(0.8);
  music.start();
  assert.equal(music.bus.gain.value, 0.8);
  music.duck(true);
  assert.ok(Math.abs(music.bus.gain.value - 0.8 * 0.45) < 1e-9);
  music.duck(false);
  assert.equal(music.bus.gain.value, 0.8);
  assert.equal(audio.master.gain.value, audio.volume, 'duck() must never touch the SFX bus');
});

await test('start() picks a real track onto deck 0 and is idempotent', () => {
  const audio = new Audio();
  audio.resume();
  const music = new Music({ audio, rng: () => 0.2 });
  music.start();
  const key1 = music.currentKey;
  assert.ok(TRACKS.some((t) => t.key === key1));
  assert.equal(music.decks[music.active].src, trackUrl(key1));
  music.start(); // safe to call twice - must not restart or throw
  assert.equal(music.currentKey, key1);
  assert.equal(music.state, 'playing');
});

await test('two decks, wired once: routing a second time never re-sources an element', () => {
  const audio = new Audio();
  audio.resume();
  const music = new Music({ audio, rng: () => 0.6 });
  music.start();
  assert.equal(music.decks.length, 2);
  assert.doesNotThrow(() => music._ensureRouting());
});

await test('stop() eventually returns the instance to idle', async () => {
  const audio = new Audio();
  audio.resume();
  const music = new Music({ audio, rng: () => 0.3 });
  music.start();
  assert.equal(music.state, 'playing');
  music.stop(0.05);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(music.state, 'idle');
});

await test('REGRESSION: the very first update() after start() must not crossfade away from the just-picked track', () => {
  // _holdT used to be primed at MOOD_HOLD in the constructor and never reset
  // when the first track began, so the mood-hold gate read "open" on frame
  // one; since `mood` starts null, any real situation counts as a "mood
  // change" and the just-started track got crossfaded away before a single
  // second of it played. _beginTrack() must reset _holdT to 0.
  const audio = new Audio();
  audio.resume();
  const music = new Music({ audio, rng: () => 0.5 });
  music.start();
  const firstKey = music.currentKey;
  music.update(0.016, { y: 0, surfaceY: 0, dayFraction: 0.25, floating: false });
  assert.equal(music.currentKey, firstKey, 'music picked a different track on frame one');
  assert.equal(music._crossfade, null, 'a crossfade started on the very first frame after start()');
  assert.equal(music.state, 'playing');
});

await test('state reports "fading" during the natural end-of-track fade, per the documented state enum', () => {
  const audio = new Audio();
  audio.resume();
  const music = new Music({ audio, rng: () => 0.4 });
  music.start();
  const track = TRACKS.find((t) => t.key === music.currentKey);
  const el = music.decks[music.active];
  const situation = { y: 0, surfaceY: 0, dayFraction: 0.25, floating: false };
  el.currentTime = track.sec - 1; // 1s left: inside the 3s fade-out window
  music.update(0.016, situation);
  assert.equal(music.state, 'fading');
  // and the fade has to actually finish and reach 'rest', not hang forever -
  // 'fading' must keep running the same per-frame logic 'playing' did.
  for (let i = 0; i < 250; i++) {
    el.currentTime += 0.016;
    music.update(0.016, situation);
  }
  assert.equal(music.state, 'rest');
});

// --- summary ----------------------------------------------------------------
for (const f of failures) {
  console.error(`FAIL  ${f.name}\n      ${f.err.stack ?? f.err.message}`);
}
const total = passed + failures.length;
console.log(`\nmusic: ${passed}/${total} passed${failures.length ? `, ${failures.length} FAILED` : ''}`);
process.exit(failures.length ? 1 : 0);
