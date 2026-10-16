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
export const PART_STORED = 0;
/** A part compressed with zstd */
export const PART_ZSTD = 1;

/**
 * The compressor of the parts (zstd), given by the platform: the format depends on no
 * compressor of its own
 *
 * @experimental
 */
export interface TabaneCompressor {
  /** The zstd frame of `raw` (the parts are stored as they are when omitted) */
  compress?(raw: Uint8Array): Uint8Array;
  /** The bytes of a zstd frame, of `contentBytes` bytes */
  decompress(stored: Uint8Array, contentBytes: number): Uint8Array;
}

/**
 * A part of a file read: where its content is in the content of the file
 *
 * @experimental
 */
export interface TabaneFilePart {
  /** How the part is stored: as it is, or compressed with zstd */
  readonly method: 'stored' | 'zstd';
  /** Where the content of the part starts in the content of the file */
  readonly contentStart: number;
  /** The number of bytes of the content of the part */
  readonly contentBytes: number;
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
  compressor?: TabaneCompressor,
): Uint8Array {
  const ends = [...partEnds.filter((c) => c > 0 && c < content.length), content.length];
  const parts: { method: number; raw: number; stored: Uint8Array }[] = [];
  let start = 0;
  for (const end of ends) {
    if (end < start) throw formatError('the partEnds of a file are not in order');
    const raw = content.subarray(start, end);
    let method = PART_STORED;
    let stored = raw;
    if (compressor?.compress && raw.length > 0) {
      const packed = compressor.compress(raw);
      if (packed.length < raw.length) {
        method = PART_ZSTD;
        stored = packed;
      }
    }
    parts.push({ method, raw: raw.length, stored });
    start = end;
  }
  const out = new ByteSink(content.length + 64);
  out.bytes(FILE_MAGIC);
  out.uint(parts.length);
  for (const f of parts) {
    out.byte(f.method);
    out.uint(f.raw);
    out.uint(f.stored.length);
  }
  for (const f of parts) out.bytes(f.stored);
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
    if (method !== PART_STORED && method !== PART_ZSTD)
      throw formatError(`a part of the method ${method}`);
    const raw = r.uint();
    const stored = r.uint();
    if (method === PART_STORED && raw !== stored) throw formatError('a stored part of two lengths');
    heads.push({ method, raw, stored });
  }
  const out: TabaneFilePart[] = [];
  let contentStart = 0;
  for (const h of heads) {
    out.push({
      method: h.method === PART_ZSTD ? 'zstd' : 'stored',
      contentStart,
      contentBytes: h.raw,
      stored: r.take(h.stored),
    });
    contentStart += h.raw;
  }
  if (!r.done) throw formatError('bytes are left after the parts');
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
  part: TabaneFilePart,
  compressor?: TabaneCompressor,
): Uint8Array {
  if (part.method === 'stored') return part.stored;
  if (!compressor) throw formatError('a compressed part and no compressor');
  const content = compressor.decompress(part.stored, part.contentBytes);
  if (content.length !== part.contentBytes)
    throw formatError('a part that does not hold its length');
  return content;
}

/**
 * The content of a file: its parts, decompressed and put together
 *
 * @param maxBytes The most bytes of content read (a file that says more is refused)
 *
 * @experimental
 */
export function unpackTabaneFile(
  file: Uint8Array,
  compressor?: TabaneCompressor,
  maxBytes = 1 << 30,
): Uint8Array {
  const parts = listTabaneFileParts(file);
  let total = 0;
  for (const p of parts) total += p.contentBytes;
  if (total > maxBytes) throw formatError(`a content of ${total} bytes`);
  if (parts.length === 1) return readTabaneFilePart(parts[0], compressor).slice();
  const out = new Uint8Array(total);
  for (const p of parts) out.set(readTabaneFilePart(p, compressor), p.contentStart);
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
