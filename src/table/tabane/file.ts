// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The files of the Tabane format: the content of a block or of a manifest, cut into parts each
 * compressed on its own, and named by the SHA-256 of the content
 *
 * The name does not depend on how the content was cut or compressed, so two writers that write
 * the same rows give the same name whatever compressor each has, and a store may compress a
 * file again without changing its name.
 *
 * A pure module: it depends on nothing outside `/table` but the SHA-256 of the platform
 * (`crypto.subtle`), so it runs in a Worker as well.
 */

import { ByteSink, ByteSource, formatError } from './bytes.js';

/** The first bytes of a file: `TBNF` */
export const FILE_MAGIC = Uint8Array.of(0x54, 0x42, 0x4e, 0x46);

/** A part stored as it is */
export const FRAME_STORED = 0;
/** A part compressed with zstd */
export const FRAME_ZSTD = 1;

/**
 * The compressor of the parts (zstd), given by the platform: the format depends on no
 * compressor of its own
 *
 * @experimental
 */
export interface TabaneCompression {
  /** The zstd frame of `raw` (the parts are stored as they are when omitted) */
  compress?(raw: Uint8Array): Uint8Array;
  /** The bytes of a zstd frame, of `rawLength` bytes */
  decompress(stored: Uint8Array, rawLength: number): Uint8Array;
}

/**
 * A part of a file read: where its content is in the content of the file
 *
 * @experimental
 */
export interface TabaneFilePart {
  readonly method: number;
  /** Where the content of the part starts in the content of the file */
  readonly contentStart: number;
  readonly rawLength: number;
  /** The bytes of the part as stored (in the file) */
  readonly stored: Uint8Array;
}

/**
 * A file of the format: the content cut at `partEnds` (offsets into the content, ascending, between
 * 0 and its length), each part compressed when a compressor is given and the part gets smaller
 *
 * @param partEnds Where the parts end (the end of the content is a cut whether given or not)
 *
 * @experimental
 */
export function packTabaneFile(
  content: Uint8Array,
  partEnds: readonly number[] = [],
  compression?: TabaneCompression,
): Uint8Array {
  const ends = [...partEnds.filter((c) => c > 0 && c < content.length), content.length];
  const frames: { method: number; raw: number; stored: Uint8Array }[] = [];
  let start = 0;
  for (const end of ends) {
    if (end < start) throw formatError('the partEnds of a file are not in order');
    const raw = content.subarray(start, end);
    let method = FRAME_STORED;
    let stored = raw;
    if (compression?.compress && raw.length > 0) {
      const packed = compression.compress(raw);
      if (packed.length < raw.length) {
        method = FRAME_ZSTD;
        stored = packed;
      }
    }
    frames.push({ method, raw: raw.length, stored });
    start = end;
  }
  const out = new ByteSink(content.length + 64);
  out.bytes(FILE_MAGIC);
  out.uint(frames.length);
  for (const f of frames) {
    out.byte(f.method);
    out.uint(f.raw);
    out.uint(f.stored.length);
  }
  for (const f of frames) out.bytes(f.stored);
  return out.finish();
}

/**
 * The parts of a file, as stored
 *
 * @throws `DrawError` with the code `unsupported-format` when the bytes are not a file
 *
 * @experimental
 */
export function listTabaneFileParts(file: Uint8Array): TabaneFilePart[] {
  const r = new ByteSource(file);
  const magic = r.take(4);
  if (FILE_MAGIC.some((b, i) => magic[i] !== b)) throw formatError('not a file');
  const count = r.count(3);
  const heads: { method: number; raw: number; stored: number }[] = [];
  for (let k = 0; k < count; k++) {
    const method = r.byte();
    if (method !== FRAME_STORED && method !== FRAME_ZSTD) throw formatError(`a frame of ${method}`);
    const raw = r.uint();
    const stored = r.uint();
    if (method === FRAME_STORED && raw !== stored)
      throw formatError('a stored part of two lengths');
    heads.push({ method, raw, stored });
  }
  const out: TabaneFilePart[] = [];
  let contentStart = 0;
  for (const h of heads) {
    out.push({
      method: h.method,
      contentStart,
      rawLength: h.raw,
      stored: r.take(h.stored),
    });
    contentStart += h.raw;
  }
  if (!r.done) throw formatError('bytes are left after the frames');
  return out;
}

/**
 * The content of a part
 *
 * @throws `DrawError` with the code `unsupported-format` when the part is compressed and no
 *   compressor is given, or when it does not hold its length
 *
 * @experimental
 */
export function readTabaneFilePart(
  frame: TabaneFilePart,
  compression?: TabaneCompression,
): Uint8Array {
  if (frame.method === FRAME_STORED) return frame.stored;
  if (!compression) throw formatError('a compressed part and no compressor');
  const raw = compression.decompress(frame.stored, frame.rawLength);
  if (raw.length !== frame.rawLength) throw formatError('a part that does not hold its length');
  return raw;
}

/**
 * The content of a file: its parts, decompressed and put together
 *
 * @param maxLength The most bytes of content read (a file that says more is refused)
 *
 * @experimental
 */
export function unpackTabaneFile(
  file: Uint8Array,
  compression?: TabaneCompression,
  maxLength = 1 << 30,
): Uint8Array {
  const frames = listTabaneFileParts(file);
  let total = 0;
  for (const f of frames) total += f.rawLength;
  if (total > maxLength) throw formatError(`a content of ${total} bytes`);
  if (frames.length === 1) return readTabaneFilePart(frames[0], compression).slice();
  const out = new Uint8Array(total);
  for (const f of frames) out.set(readTabaneFilePart(f, compression), f.contentStart);
  return out;
}

const HEX = '0123456789abcdef';

/**
 * The name of a content: its SHA-256 in lowercase hex
 *
 * @experimental
 */
export async function tabaneNameOf(content: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', content as BufferSource));
  let s = '';
  for (const b of digest) s += HEX[b >> 4] + HEX[b & 15];
  return s;
}
