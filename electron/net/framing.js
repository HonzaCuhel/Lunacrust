// Wire framing for the LAN transport. Pure Node - no `electron` import - so it
// runs headlessly in tests and in either the host or the client role.
//
// Layout, big-endian:
//   [u32 payloadLen][u8 codec][payload]
//   codec 0 = utf8 JSON
//   codec 1 = gzip(utf8 JSON)
//
// The length prefix is fixed-width and comes before the codec byte and the
// payload, so a `FrameReader` can always decide whether a frame is affordable
// from just the first 5 bytes it has buffered - it never has to grow a buffer
// to `payloadLen` before finding out that length is bogus.

import { gzipSync, gunzipSync } from 'node:zlib';

export const HEADER_BYTES = 5;
export const MAX_FRAME = 8 * 1024 * 1024;
export const GZIP_OVER = 32 * 1024;

const CODEC_JSON = 0;
const CODEC_GZIP = 1;

/** JSON-encode `obj`, gzip it when that saves bytes, and prefix the frame header. */
export function encodeFrame(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  if (json.length > MAX_FRAME) throw new RangeError('encodeFrame: decoded payload exceeds MAX_FRAME');
  const codec = json.length > GZIP_OVER ? CODEC_GZIP : CODEC_JSON;
  const payload = codec === CODEC_GZIP ? gzipSync(json) : json;
  if (payload.length > MAX_FRAME) {
    throw new RangeError(`encodeFrame: payload ${payload.length} exceeds MAX_FRAME ${MAX_FRAME}`);
  }
  const header = Buffer.allocUnsafe(HEADER_BYTES);
  header.writeUInt32BE(payload.length, 0);
  header.writeUInt8(codec, 4);
  return Buffer.concat([header, payload], HEADER_BYTES + payload.length);
}

/**
 * Incremental parser for one socket's inbound byte stream. `push()` accepts
 * however many bytes arrived in one `data` event and returns every frame that
 * became complete as a result - zero, one, or several, since TCP has no
 * message boundaries and a chunk can hold a fraction of a frame or a handful
 * of whole ones glued together.
 *
 * The length prefix is read the moment 5 bytes are available, before the
 * payload bytes for that frame have necessarily even arrived, so an oversize
 * claim throws immediately instead of accumulating up to `MAX_FRAME` of
 * attacker-controlled data first. `subarray()` below is a view, not a copy,
 * so buffering the unconsumed remainder never reallocates more than the one
 * `Buffer.concat` per `push()` call.
 */
export class FrameReader {
  #buf = Buffer.alloc(0);

  push(chunk) {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
    const frames = [];
    for (;;) {
      if (this.#buf.length < HEADER_BYTES) break;
      const len = this.#buf.readUInt32BE(0);
      if (len > MAX_FRAME) {
        // Refused before a payload byte is buffered - the whole point of a
        // fixed-width prefix ahead of the payload.
        throw new RangeError(`FrameReader: frame length ${len} exceeds MAX_FRAME ${MAX_FRAME}`);
      }
      const codec = this.#buf.readUInt8(4);
      const total = HEADER_BYTES + len;
      if (this.#buf.length < total) break; // frame not fully arrived yet
      const payload = this.#buf.subarray(HEADER_BYTES, total);
      this.#buf = this.#buf.subarray(total);
      const raw = codec === CODEC_GZIP ? gunzipSync(payload, { maxOutputLength: MAX_FRAME })
        : codec === CODEC_JSON ? payload
        : (() => { throw new RangeError(`FrameReader: unknown codec ${codec}`); })();
      frames.push(JSON.parse(raw.toString('utf8')));
    }
    return frames;
  }
}
