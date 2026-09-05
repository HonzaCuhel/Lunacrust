#!/usr/bin/env node
/**
 * Lunacrust — original 35-second trailer cue, "Departure Window".
 * Pure Node synthesis: no samples, soundfonts, downloads, or dependencies.
 * Run from any directory: node tools/make-promo-score.mjs
 * All timing, composition, oscillator phases, and noise are deterministic.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'videos/lunacrust-promo/assets');
const SR = 48000;
const SECONDS = 35;
const LENGTH = SR * SECONDS;
const TAU = Math.PI * 2;
const SEED = 0x4c554e41;
let randomState = SEED;
const noise = () => {
  randomState ^= randomState << 13;
  randomState ^= randomState >>> 17;
  randomState ^= randomState << 5;
  return (randomState >>> 0) / 2147483648 - 1;
};
const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);
const smooth = (x) => {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
};
const music = [new Float64Array(LENGTH), new Float64Array(LENGTH)];
const percussion = [new Float64Array(LENGTH), new Float64Array(LENGTH)];
const bass = [new Float64Array(LENGTH), new Float64Array(LENGTH)];
const ambience = [new Float64Array(LENGTH), new Float64Array(LENGTH)];
const sends = [new Float64Array(LENGTH), new Float64Array(LENGTH)];
const kicks = [];

function add(bus, start, duration, pan, render, send = 0) {
  const first = Math.round(start * SR);
  const count = Math.min(Math.ceil(duration * SR), LENGTH - first);
  const left = Math.cos((pan + 1) * Math.PI / 4);
  const right = Math.sin((pan + 1) * Math.PI / 4);
  for (let n = 0; n < count; n++) {
    const i = first + n;
    if (i < 0) continue;
    const sample = render(n / SR, n);
    bus[0][i] += sample * left;
    bus[1][i] += sample * right;
    if (send) {
      sends[0][i] += sample * left * send;
      sends[1][i] += sample * right * send;
    }
  }
}

// Band-limited sawtooth with polynomial discontinuity correction.
function saw(phase, increment) {
  let correction = 0;
  if (phase < increment) {
    const t = phase / increment;
    correction = t + t - t * t - 1;
  } else if (phase > 1 - increment) {
    const t = (phase - 1) / increment;
    correction = t * t + t + t + 1;
  }
  return 2 * phase - 1 - correction;
}

function pad(start, duration, notes, amplitude, brightness = 1800) {
  notes.forEach((note, index) => {
    const frequency = hz(note);
    const increments = [0.996, 1, 1.004].map((detune) => frequency * detune / SR);
    const phases = [0.17 + index * 0.031, 0.51, 0.83];
    let lp1 = 0;
    let lp2 = 0;
    const length = duration + 0.8;
    add(music, start, length, (index / (notes.length - 1) - 0.5) * 1.35, (t) => {
      const env = smooth(t / 0.3) * (1 - smooth((t - duration + 0.12) / 0.92));
      let value = 0;
      for (let v = 0; v < 3; v++) {
        phases[v] = (phases[v] + increments[v]) % 1;
        value += saw(phases[v], increments[v]) / 3;
      }
      const cutoff = 800 + brightness * (0.6 + 0.15 * Math.sin(TAU * 0.18 * t + index));
      const coefficient = 1 - Math.exp(-TAU * cutoff / SR);
      lp1 += coefficient * (value - lp1);
      lp2 += coefficient * (lp1 - lp2);
      return amplitude * env * (lp2 + 0.1 * Math.sin(TAU * frequency * t));
    }, 0.48);
  });
}

function pluck(start, note, amplitude, pan, duration = 0.48, bright = 4800) {
  const frequency = hz(note);
  const increment = frequency / SR;
  let p1 = 0.1;
  let p2 = 0.43;
  let lp1 = 0;
  let lp2 = 0;
  add(music, start, duration, pan, (t) => {
    p1 = (p1 + increment) % 1;
    p2 = (p2 + increment * 1.004) % 1;
    const env = smooth(t / 0.006) * Math.exp(-t * 8.5) * (1 - smooth((t - duration + 0.06) / 0.06));
    const coefficient = 1 - Math.exp(-TAU * (850 + bright * Math.exp(-t * 8)) / SR);
    const tone = saw(p1, increment) * 0.6 + saw(p2, increment * 1.004) * 0.4;
    lp1 += coefficient * (tone - lp1);
    lp2 += coefficient * (lp1 - lp2);
    return amplitude * env * (lp2 + 0.16 * Math.sin(TAU * frequency * 2 * t) * Math.exp(-t * 18));
  }, 0.37);
}

function lead(start, note, duration, amplitude, pan = 0) {
  const frequency = hz(note);
  const phases = [0, 0.22, 0.48, 0.69, 0.92];
  const detunes = [0.993, 0.997, 1, 1.003, 1.007];
  let low = 0;
  add(music, start, duration + 0.2, pan, (t) => {
    const vibrato = 1 + 0.0018 * Math.sin(TAU * 5.1 * t) * smooth(t / 0.2);
    let tone = 0;
    for (let v = 0; v < 5; v++) {
      const increment = frequency * detunes[v] * vibrato / SR;
      phases[v] = (phases[v] + increment) % 1;
      tone += saw(phases[v], increment) / 5;
    }
    const env = smooth(t / 0.018) * (1 - smooth((t - duration + 0.03) / 0.23));
    const coefficient = 1 - Math.exp(-TAU * (2400 + 2000 * Math.exp(-t * 4)) / SR);
    low += coefficient * (tone - low);
    return amplitude * env * low;
  }, 0.35);
}

function bassNote(start, note, duration, amplitude) {
  const frequency = hz(note);
  const increment = frequency / SR;
  let phase = 0;
  let low = 0;
  add(bass, start, duration + 0.06, 0, (t) => {
    phase = (phase + increment) % 1;
    const env = smooth(t / 0.008) * (1 - smooth((t - duration + 0.035) / 0.095));
    const coefficient = 1 - Math.exp(-TAU * (220 + 950 * Math.exp(-t * 12)) / SR);
    low += coefficient * (saw(phase, increment) - low);
    return amplitude * env * (0.77 * Math.sin(TAU * frequency * t) + 0.42 * low);
  });
}

function kick(start, amplitude = 0.66) {
  kicks.push(start);
  let phase = 0;
  add(percussion, start, 0.6, 0, (t) => {
    phase += TAU * (46 + 113 * Math.exp(-t * 39)) / SR;
    const body = Math.sin(phase) * Math.exp(-t * 8.8);
    const click = noise() * Math.exp(-t * 250) * 0.14;
    return amplitude * (Math.tanh(body * 1.45) * 0.8 + click) * smooth(t / 0.001);
  }, 0.03);
}

function snare(start, amplitude = 0.24, pan = 0.05) {
  let low = 0;
  add(percussion, start, 0.42, pan, (t) => {
    const n = noise();
    low += 0.18 * (n - low);
    const shell = Math.sin(TAU * 181 * t) * Math.exp(-t * 26) * 0.7;
    const rattle = (n - low) * Math.exp(-t * 17);
    const clapEnvelope = Math.exp(-t * 90) + (t > 0.014 ? 0.5 * Math.exp(-(t - 0.014) * 110) : 0);
    return amplitude * (shell + rattle * 1.25 + n * clapEnvelope * 0.3) * smooth(t / 0.0015);
  }, 0.31);
}

function hat(start, amplitude, open = false, pan = -0.25) {
  let low = 0;
  const duration = open ? 0.3 : 0.095;
  add(percussion, start, duration, pan, (t) => {
    const n = noise();
    low += 0.39 * (n - low);
    const metal = Math.sin(TAU * 6231 * t) * Math.sin(TAU * 8437 * t);
    return amplitude * ((n - low) * 0.83 + metal * 0.17) * Math.exp(-t * (open ? 17 : 65)) * smooth(t / 0.001);
  }, open ? 0.12 : 0.04);
}

function impact(start, amplitude) {
  let lp = 0;
  add(ambience, start, 2.4, 0, (t) => {
    lp += 0.09 * (noise() - lp);
    const thud = Math.sin(TAU * (38 * t + 4 * (1 - Math.exp(-t * 12)))) * Math.exp(-t * 6);
    return amplitude * (thud * 0.6 + lp * Math.exp(-t * 2.5)) * smooth(t / 0.004);
  }, 0.67);
  // A broad stereo cymbal wash keeps each structural cut audible.
  for (const pan of [-0.7, 0.7]) {
    let lp = 0;
    add(ambience, start, 2.1, pan, (t) => {
      const n = noise();
      lp += 0.23 * (n - lp);
      return amplitude * 0.31 * (n - lp) * Math.exp(-t * 3.2) * smooth(t / 0.002);
    }, 0.23);
  }
}

function riser(start, duration, amplitude) {
  for (const pan of [-0.6, 0.6]) {
    let low = 0;
    let previous = 0;
    let phase = 0;
    add(ambience, start, duration, pan, (t) => {
      const progress = t / duration;
      const cutoff = 200 + 6500 * progress ** 2;
      const coefficient = 1 - Math.exp(-TAU * cutoff / SR);
      low += coefficient * (noise() - low);
      const high = low - previous;
      previous += 0.015 * (low - previous);
      phase += TAU * (90 * 2 ** (2.5 * progress)) / SR;
      const swell = smooth(progress) ** 2 * (1 - smooth((progress - 0.987) / 0.013));
      return amplitude * swell * (high + 0.18 * Math.sin(phase)) * (0.82 + 0.18 * Math.sin(TAU * 8 * t));
    }, 0.42);
  }
}

// Act 1: an open minor-ninth horizon, with a heartbeat and answering glass.
pad(0, 4.9, [50, 57, 60, 64, 65], 0.043, 900);
impact(0.08, 0.18);
for (let n = 0; n < 5; n++) {
  bassNote(0.3 + n * 0.9, 38, 0.18, 0.14 + n * 0.007);
  pluck(0.55 + n * 0.9, [74, 81, 76, 77, 81][n], 0.074, n % 2 ? 0.4 : -0.4, 0.85, 2800);
}
riser(3.25, 1.75, 0.15);

// At 120 BPM, the 5 / 12 / 20 / 28-second editorial boundaries land on beats.
const sections = [
  { start: 5, end: 12, drive: 0.73, chordStarts: [5, 7, 9, 11] },
  { start: 12, end: 20, drive: 0.9, chordStarts: [12, 14, 16, 18] },
  { start: 20, end: 28, drive: 1, chordStarts: [20, 22, 24, 26] },
];
const harmony = [
  { root: 38, notes: [62, 65, 69, 76], pad: [50, 57, 62, 65, 76] },
  { root: 34, notes: [62, 65, 69, 74], pad: [46, 53, 62, 65, 69] },
  { root: 41, notes: [60, 65, 69, 74], pad: [53, 60, 65, 69, 74] },
  { root: 36, notes: [60, 64, 67, 74], pad: [48, 55, 60, 64, 74] },
];
const arpPattern = [0, 2, 1, 3, 2, 1, 3, 2, 0, 2, 1, 3, 2, 3, 1, 2];
for (const section of sections) {
  impact(section.start, section.start === 20 ? 0.34 : 0.25);
  section.chordStarts.forEach((start, chordIndex) => {
    const end = Math.min(start + 2, section.end);
    const chord = harmony[chordIndex];
    pad(start, end - start - 0.07, chord.pad, 0.039 * section.drive, section.start === 20 ? 2800 : 1800);
    const step = section.start === 5 ? 0.25 : 0.125;
    for (let t = start, tick = 0; t < end - 0.04; t += step, tick++) {
      if (t > section.end - 0.24) continue;
      const note = chord.notes[arpPattern[tick % arpPattern.length]];
      const velocity = tick % 4 === 0 ? 1 : tick % 2 === 0 ? 0.83 : 0.67;
      pluck(t, note, 0.132 * velocity * section.drive, Math.sin(tick * 1.3) * 0.45, 0.43, 5100);
    }
    for (let t = start, tick = 0; t < end - 0.06; t += 0.25, tick++) {
      if (t > section.end - 0.26) continue;
      const octave = section.start >= 12 && tick % 4 === 3 ? 12 : 0;
      bassNote(t, chord.root + octave, tick % 2 ? 0.16 : 0.21, 0.3 * section.drive);
    }
  });
  for (let t = section.start, beat = 0; t < section.end - 0.15; t += 0.5, beat++) {
    if (section.start >= 12 || beat % 2 === 0) kick(t, 0.68 * section.drive);
    if (beat % 2 === 1) snare(t, 0.27 * section.drive);
    hat(t, 0.052 * section.drive, false, -0.33);
    if (t + 0.25 < section.end - 0.12) hat(t + 0.25, 0.08 * section.drive, beat % 2 === 0, 0.29);
    if (section.start === 20 && beat % 2 === 1) {
      hat(t + 0.125, 0.037, false, 0.48);
      hat(t + 0.375, 0.032, false, -0.48);
    }
  }
}

// A small rising answer in exploration; the full singable motif arrives at 20s.
for (const [t, note, length] of [
  [15, 81, 0.32], [15.5, 79, 0.32], [16, 77, 0.7], [17, 81, 0.7], [18, 79, 1.15],
]) lead(t, note, length, 0.065, -0.08);
for (const [t, note, length] of [
  [20, 74, 0.42], [20.5, 77, 0.2], [20.75, 81, 0.66], [21.5, 79, 0.32],
  [22, 77, 0.7], [23, 74, 0.36], [23.5, 77, 0.32],
  [24, 81, 0.68], [24.75, 84, 0.42], [25.25, 81, 0.58],
  [26, 79, 0.67], [27, 76, 0.34], [27.5, 72, 0.24],
]) lead(t, note, length, 0.112, 0.05);

// Drum fills and filtered lifts forecast the cut, then resolve precisely on it.
for (const boundary of [12, 20, 28]) {
  riser(boundary - (boundary === 28 ? 2 : 1.25), boundary === 28 ? 2 : 1.25, boundary === 28 ? 0.16 : 0.1);
  for (let n = 0; n < 4; n++) snare(boundary - 0.5 + n * 0.125, 0.09 + n * 0.028, (n % 2 ? 1 : -1) * 0.18);
}

// Act 5: clean breath at 28, followed by a spacious tonic logo resolution at 29.
impact(28, 0.32);
pad(28, 0.5, [48, 55, 62, 67], 0.025, 600);
impact(29, 0.42);
kick(29, 0.65);
bassNote(29, 38, 2.7, 0.32);
pad(29, 3.65, [50, 57, 62, 65, 69, 76], 0.052, 1850);
lead(29, 74, 1.55, 0.108);
pluck(29, 86, 0.09, -0.35, 1.2, 3200);
pluck(29.5, 81, 0.078, 0.35, 1.2, 2800);
pluck(30, 77, 0.07, -0.28, 1.4, 2300);
pluck(30.5, 76, 0.055, 0.28, 1.5, 2200);
pluck(31, 74, 0.082, 0, 1.8, 1900);

// A deterministic stereo feedback-delay reverb. Prime-ish lines diffuse the
// synthesized voices; a quieter dotted-eighth ping-pong supplies rhythmic depth.
const wet = [new Float64Array(LENGTH), new Float64Array(LENGTH)];
const reverbs = [
  { seconds: 0.0797, feedback: 0.71, pan: -0.8 },
  { seconds: 0.0971, feedback: 0.73, pan: 0.65 },
  { seconds: 0.1139, feedback: 0.74, pan: -0.3 },
  { seconds: 0.1373, feedback: 0.72, pan: 0.3 },
];
for (const config of reverbs) {
  const delay = new Float64Array(Math.round(config.seconds * SR));
  let pointer = 0;
  let damping = 0;
  const left = Math.cos((config.pan + 1) * Math.PI / 4);
  const right = Math.sin((config.pan + 1) * Math.PI / 4);
  for (let i = 0; i < LENGTH; i++) {
    const delayed = delay[pointer];
    damping += 0.28 * (delayed - damping);
    delay[pointer] = (sends[0][i] + sends[1][i]) * 0.4 + damping * config.feedback;
    pointer = (pointer + 1) % delay.length;
    wet[0][i] += delayed * left * 0.37;
    wet[1][i] += delayed * right * 0.37;
  }
}
for (const [seconds, gain] of [[0.375, 0.29], [0.75, 0.145], [1.125, 0.067]]) {
  const shift = Math.round(seconds * SR);
  for (let i = shift; i < LENGTH; i++) {
    wet[0][i] += sends[1][i - shift] * gain;
    wet[1][i] += sends[0][i - shift] * gain;
  }
}

// Stereo-linked bus compression, DC rejection, and a global smooth tail.
const output = [new Float64Array(LENGTH), new Float64Array(LENGTH)];
let lastKick = -10;
let kickIndex = 0;
kicks.sort((a, b) => a - b);
let envelope = 0;
let compression = 1;
const previousInput = [0, 0];
const previousOutput = [0, 0];
let peak = 0;
for (let i = 0; i < LENGTH; i++) {
  const t = i / SR;
  while (kickIndex < kicks.length && kicks[kickIndex] <= t) lastKick = kicks[kickIndex++];
  const duck = 1 - 0.2 * Math.exp(-(t - lastKick) * 16);
  const breath = t >= 28 && t < 29 ? 0.6 : 1;
  const tail = 1 - smooth((t - 33.7) / 1.3);
  const samples = [0, 1].map((channel) => (
    (music[channel][i] * duck + bass[channel][i] * (0.65 + duck * 0.35) + percussion[channel][i]) * breath
      + ambience[channel][i] + wet[channel][i] * (t >= 28 && t < 29 ? 0.55 : 1)
  ));
  const detector = Math.max(Math.abs(samples[0]), Math.abs(samples[1]));
  envelope += (detector > envelope ? 0.012 : 0.00011) * (detector - envelope);
  const target = envelope > 0.38 ? (0.38 / envelope) ** 0.52 : 1;
  compression += (target < compression ? 0.009 : 0.00009) * (target - compression);
  for (let channel = 0; channel < 2; channel++) {
    const value = Math.tanh(samples[channel] * compression * 1.55) / 1.55;
    const dcFree = value - previousInput[channel] + 0.9979 * previousOutput[channel];
    previousInput[channel] = value;
    previousOutput[channel] = dcFree;
    output[channel][i] = dcFree * smooth(t / 0.02) * tail;
    peak = Math.max(peak, Math.abs(output[channel][i]));
  }
}
// Extra headroom preserves the transient crests when the video encodes to AAC.
const targetPeak = 10 ** (-2 / 20);
const gain = targetPeak / peak;
const bytesPerSample = 3;
const dataSize = LENGTH * 2 * bytesPerSample;
const wav = Buffer.alloc(44 + dataSize);
wav.write('RIFF', 0);
wav.writeUInt32LE(36 + dataSize, 4);
wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(2, 22);
wav.writeUInt32LE(SR, 24);
wav.writeUInt32LE(SR * 2 * bytesPerSample, 28);
wav.writeUInt16LE(2 * bytesPerSample, 32);
wav.writeUInt16LE(24, 34);
wav.write('data', 36);
wav.writeUInt32LE(dataSize, 40);
let energy = 0;
for (let i = 0; i < LENGTH; i++) {
  for (let channel = 0; channel < 2; channel++) {
    const sample = output[channel][i] * gain;
    energy += sample * sample;
    wav.writeIntLE(Math.round(sample * 8388607), 44 + (i * 2 + channel) * 3, 3);
  }
}
mkdirSync(OUT, { recursive: true });
writeFileSync(resolve(OUT, 'score.wav'), wav);
const provenance = {
  title: 'Departure Window',
  purpose: 'Original instrumental score for the Lunacrust 35-second gameplay promo',
  generator: 'tools/make-promo-score.mjs',
  creation: 'Original deterministic musical composition and DSP synthesis using Node.js built-ins',
  sourceAudio: [],
  externalDependencies: [],
  seed: `0x${SEED.toString(16)}`,
  sampleRate: SR,
  channels: 2,
  bitDepth: 24,
  durationSeconds: SECONDS,
  frames: LENGTH,
  bpm: 120,
  key: 'D minor with added ninths',
  structure: [
    { start: 0, end: 5, description: 'Mysterious minor-ninth pad, heartbeat bass, glass plucks' },
    { start: 5, end: 12, description: 'Drum and bass build with an eighth-note arpeggio' },
    { start: 12, end: 20, description: 'Exploration energy, sixteenth-note arpeggios and four-on-the-floor drums' },
    { start: 20, end: 28, description: 'Full lead melody, wide chords, bigger rhythmic drive' },
    { start: 28, end: 29, description: 'Impact and musical breath' },
    { start: 29, end: 35, description: 'Tonic logo resolution; final 1.3 seconds fade smoothly to silence' },
  ],
  instruments: ['Band-limited detuned saw pads', 'Filtered pluck arpeggios', 'Five-voice saw lead', 'Sub and filtered saw bass', 'Synthesized kick and snare', 'Seeded-noise metallic hats', 'Filtered noise risers and impacts'],
  processing: ['Stereo panning', 'Damped feedback-delay reverb', 'Dotted-eighth ping-pong echo', 'Kick-controlled ducking', 'Stereo-linked compression', 'Gentle saturation', 'DC rejection', 'Smooth tail fade'],
  samplePeakDbFS: Number((20 * Math.log10(targetPeak)).toFixed(3)),
  rmsDbFS: Number((10 * Math.log10(energy / (LENGTH * 2))).toFixed(3)),
  sha256: createHash('sha256').update(wav).digest('hex'),
};
writeFileSync(resolve(OUT, 'score.provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
console.log(JSON.stringify({ file: resolve(OUT, 'score.wav'), ...provenance }, null, 2));
