// framing.test.mjs - the byte layer for electron/net/framing.js.
//
// Three things matter about a length-prefixed frame reader that nothing else
// here proves: it must reassemble a payload TCP hands back in arbitrary
// pieces (including one byte at a time, and including two frames glued into
// a single `data` event), it must never buffer an attacker-sized payload
// just to find out the frame claims to be too big, and gzip must be a
// transparent, lossless detour above the size threshold. No sockets, no
// Electron - this is pure buffer arithmetic.

import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { encodeFrame, FrameReader, MAX_FRAME, GZIP_OVER, HEADER_BYTES } from '../electron/net/framing.js';

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

check('round trip: encode then parse back an equal object', () => {
  const obj = { t: 'hello', proto: 1, hash: 'deadbeef', name: 'Jan', code: null };
  const out = new FrameReader().push(encodeFrame(obj));
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], obj);
});

check('a frame fed one byte at a time completes only on the last byte', () => {
  const obj = { t: 'move', x: 1.5, y: 64, z: -2.25, yaw: 0.1, pitch: 0, f: 5 };
  const frame = encodeFrame(obj);
  const reader = new FrameReader();
  const out = [];
  for (let i = 0; i < frame.length; i++) {
    const got = reader.push(frame.subarray(i, i + 1));
    out.push(...got);
    if (i < frame.length - 1) assert.equal(got.length, 0, `byte ${i} must not complete the frame early`);
  }
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], obj);
});

check('two frames glued into one chunk both come back, in order', () => {
  const a = { t: 'a', n: 1 };
  const b = { t: 'b', n: 2 };
  const out = new FrameReader().push(Buffer.concat([encodeFrame(a), encodeFrame(b)]));
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], a);
  assert.deepEqual(out[1], b);
});

check('a payload split across three chunks reassembles correctly', () => {
  const obj = { t: 'edits', list: Array.from({ length: 200 }, (_, i) => [i, 0, 0, i % 2, 0]) };
  const frame = encodeFrame(obj);
  assert.ok(frame.length > 30, 'fixture should be big enough to actually split');
  const cut1 = Math.floor(frame.length / 3);
  const cut2 = Math.floor((frame.length * 2) / 3);
  const reader = new FrameReader();
  const out = [
    ...reader.push(frame.subarray(0, cut1)),
    ...reader.push(frame.subarray(cut1, cut2)),
    ...reader.push(frame.subarray(cut2)),
  ];
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], obj);
});

check('a frame arriving glued to the start of the next one is still separated', () => {
  const a = { t: 'players', list: [{ i: 1, x: 0, y: 64, z: 0 }] };
  const b = { t: 'time', v: 120.5 };
  const frameA = encodeFrame(a);
  const frameB = encodeFrame(b);
  const reader = new FrameReader();
  const glueLen = 3; // deliver all of A plus a few leading bytes of B in one chunk
  const out1 = reader.push(Buffer.concat([frameA, frameB.subarray(0, glueLen)]));
  assert.deepEqual(out1, [a], 'the still-incomplete second frame must not be returned early');
  const out2 = reader.push(frameB.subarray(glueLen));
  assert.deepEqual(out2, [b]);
});

check('an oversize length prefix is rejected before any payload byte is buffered', () => {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32BE(MAX_FRAME + 1, 0);
  header.writeUInt8(0, 4);
  // Not a single payload byte follows - if the reader needed the payload to
  // decide, this push would hang waiting rather than throw synchronously.
  assert.throws(() => new FrameReader().push(header), RangeError);
});

check('the oversize check fires the instant the length is available, even split across chunks', () => {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32BE(MAX_FRAME * 4, 0);
  header.writeUInt8(0, 4);
  const reader = new FrameReader();
  const first = reader.push(header.subarray(0, 4)); // length only, no codec byte yet
  assert.equal(first.length, 0, 'four bytes is not yet a complete header');
  assert.throws(() => reader.push(header.subarray(4)), RangeError);
});

check('an unknown codec byte is rejected rather than silently misread as JSON or gzip', () => {
  const corrupted = Buffer.from(encodeFrame({ t: 'x' }));
  corrupted.writeUInt8(9, 4);
  assert.throws(() => new FrameReader().push(corrupted), RangeError);
});

check('a payload at exactly MAX_FRAME is accepted, one byte over is not', () => {
  // MAX_FRAME itself must be reachable - only strictly-over is refused.
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32BE(MAX_FRAME, 0);
  header.writeUInt8(0, 4);
  assert.doesNotThrow(() => new FrameReader().push(header)); // waits for payload, doesn't throw
  header.writeUInt32BE(MAX_FRAME + 1, 0);
  assert.throws(() => new FrameReader().push(header), RangeError);
});

check('gzip round trip above GZIP_OVER: smaller on the wire, identical after parsing', () => {
  const big = {
    t: 'edits',
    list: Array.from({ length: 4000 }, (_, i) => [i % 40, (i >> 5) % 8, (i >> 8) % 40, i % 5, i % 3]),
  };
  const plainLen = Buffer.byteLength(JSON.stringify(big), 'utf8');
  assert.ok(plainLen > GZIP_OVER, 'fixture must exceed the gzip threshold to exercise it');
  const frame = encodeFrame(big);
  assert.equal(frame.readUInt8(4), 1, 'codec byte must select gzip above the threshold');
  assert.ok(frame.length < plainLen, 'a repetitive payload this large must land smaller than plain JSON');
  const out = new FrameReader().push(frame);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], big);
});

check('a payload under GZIP_OVER stays uncompressed (codec 0)', () => {
  const small = { t: 'hello', proto: 1, hash: 'abcd1234', name: 'A', code: null };
  const frame = encodeFrame(small);
  assert.equal(frame.readUInt8(4), 0);
  assert.equal(frame.readUInt32BE(0), Buffer.byteLength(JSON.stringify(small), 'utf8'));
});

check('gzip frames interleave with plain frames on the same reader', () => {
  const small = { t: 's', n: 0 };
  const big = { t: 'l', list: Array.from({ length: 5000 }, (_, i) => i) };
  const reader = new FrameReader();
  const out = reader.push(Buffer.concat([encodeFrame(small), encodeFrame(big), encodeFrame(small)]));
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], small);
  assert.deepEqual(out[1], big);
  assert.deepEqual(out[2], small);
});

check('a FrameReader instance is reusable across many frames on one long-lived socket', () => {
  const reader = new FrameReader();
  const seen = [];
  for (let i = 0; i < 50; i++) seen.push(...reader.push(encodeFrame({ t: 'move', n: i })));
  assert.equal(seen.length, 50);
  assert.equal(seen[0].n, 0);
  assert.equal(seen[49].n, 49);
});

check('a tiny gzip frame cannot inflate past the world snapshot limit', () => {
  const compressed = gzipSync(Buffer.from(JSON.stringify({ t: 'snapshot', data: 'x'.repeat(MAX_FRAME) })));
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32BE(compressed.length);
  header.writeUInt8(1, 4);
  assert.throws(() => new FrameReader().push(Buffer.concat([header, compressed])));
});

console.log(`\n${pass} checks passed`);
