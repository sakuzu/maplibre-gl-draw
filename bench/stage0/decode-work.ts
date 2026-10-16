// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Decodes a file of segments into row blocks, as a Worker of the page does and as the
 * measurement in Node does: each segment decompressed (fzstd, the same in both), decoded to its
 * columns, made rows for the builder and added to it; the builder of the file then cuts the rows
 * into blocks (`createRowBlockBuilder`). The time of each step is told.
 */

import { createRowBlockBuilder, type RowBlock } from '@sakuzu/maplibre-gl-draw/kasane';
import { decompress } from 'fzstd';
import { decodeSegment, unpackFile } from './codec.ts';
import { rowInputsOf } from './rows.ts';

/** The time of the steps of decoding a file (ms) */
export interface DecodeTimes {
  /** Decompressing the segments */
  unzipMs: number;
  /** Decoding the columns of the segments to values and geometries */
  decodeMs: number;
  /** Making the rows of the builder (ids and keys as strings) */
  rowsMs: number;
  /** Adding the rows to the builder */
  addMs: number;
  /** Cutting them into blocks (`finish`: the order, the triangles, the index) */
  finishMs: number;
}

/** A file decoded */
export interface DecodedFile {
  readonly blocks: RowBlock[];
  readonly rows: number;
  readonly segments: number;
  readonly times: DecodeTimes;
}

/** Decodes the file of segments `bytes` into row blocks */
export function decodeFile(bytes: Uint8Array): DecodedFile {
  const times: DecodeTimes = { unzipMs: 0, decodeMs: 0, rowsMs: 0, addMs: 0, finishMs: 0 };
  const builder = createRowBlockBuilder();
  const clientTexts = new Map<string, string>();
  const segments = unpackFile(bytes);
  let rows = 0;
  for (const packed of segments) {
    const t0 = performance.now();
    const raw = decompress(packed.bytes);
    const t1 = performance.now();
    const segment = decodeSegment(raw);
    const t2 = performance.now();
    const inputs = rowInputsOf(segment, clientTexts);
    const t3 = performance.now();
    for (const input of inputs) builder.addRow(input);
    const t4 = performance.now();
    times.unzipMs += t1 - t0;
    times.decodeMs += t2 - t1;
    times.rowsMs += t3 - t2;
    times.addMs += t4 - t3;
    rows += inputs.length;
  }
  const f0 = performance.now();
  const blocks = builder.finish();
  times.finishMs = performance.now() - f0;
  return { blocks, rows, segments: segments.length, times };
}
