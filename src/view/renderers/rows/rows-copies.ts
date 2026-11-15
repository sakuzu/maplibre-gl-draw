// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the renderer of the rows keeps of what it wrote to the GPU, for the checks of what is
 * drawn (`RowsCopies`)
 *
 * A chunk keeps no copy of its packed arrays once they are on the GPU. A renderer given this
 * (only while the checks of what is drawn run) keeps here what the GPU holds:
 *
 * - the packed arrays of each chunk as it wrote them, with the writes in place applied as they
 *   are uploaded
 * - the rows of each chunk those writes wrote, until they are read (`writtenOf`)
 * - the values of each palette as the lines of its texture were uploaded
 *
 * A renderer without it keeps none of these, and does nothing more than look whether it has it
 * once per upload of a chunk, of the writes of a chunk and of a palette.
 *
 * What a row draws is read back as text (`drawnRowText`), so that a chunk and a row packed again
 * on its own compare however their places are numbered.
 */

import {
  ROWS_INSTANCE_FLOATS,
  ROWS_KIND,
  ROWS_ROW_STYLE_FLOATS,
  ROWS_STYLE_FLOATS,
  ROWS_STYLE_WIDTH,
  type RowsChunkData,
  type RowsPalette,
  readRowsInstance,
  rowOfInstanceWord,
} from './rows-format.js';
import type { RowsChunk, RowsChunkWrites } from './rows-renderer.js';

/** The floats of a line of the texture of the values of the styles */
const PALETTE_LINE_FLOATS = ROWS_STYLE_WIDTH * 4;

/**
 * What the GPU holds of the chunks and the palettes of a renderer of the rows
 *
 * @internal
 */
export class RowsCopies {
  private readonly chunks = new WeakMap<RowsChunk, RowsChunkData>();
  private readonly written = new WeakMap<RowsChunk, Set<number>>();
  private readonly palettes = new WeakMap<RowsPalette, Float32Array>();

  /** The arrays of a chunk as the GPU holds them (none before it is written to the GPU) */
  copyOf(chunk: RowsChunk): RowsChunkData | undefined {
    return this.chunks.get(chunk);
  }

  /** The rows of a chunk written in place and uploaded since they were last forgotten */
  writtenOf(chunk: RowsChunk): Set<number> | undefined {
    return this.written.get(chunk);
  }

  /** The values of a palette as its texture holds them (none before its first upload) */
  paletteOf(palette: RowsPalette): Float32Array | undefined {
    return this.palettes.get(palette);
  }

  /** A chunk was written to the GPU from its packed arrays */
  uploaded(chunk: RowsChunk, data: RowsChunkData): void {
    this.chunks.set(chunk, data);
  }

  /** The writes in place of a chunk are uploaded: applied to its copy, and their rows noted */
  patched(chunk: RowsChunk, writes: RowsChunkWrites): void {
    const copy = this.chunks.get(chunk);
    if (!copy) return;
    let rows = this.written.get(chunk);
    if (!rows) {
      rows = new Set();
      this.written.set(chunk, rows);
    }
    const noted = rows;
    const instance =
      (target: Float32Array) => (texel: number, values: Float32Array, at: number) => {
        target.set(values.subarray(at, at + ROWS_INSTANCE_FLOATS), texel * ROWS_INSTANCE_FLOATS);
        noted.add(rowOfInstanceWord(values[at] as number) - copy.rowBase);
      };
    writes.instances.forEach(instance(copy.instances));
    writes.points.forEach(instance(copy.points));
    writes.coords.forEach((texel, values, at) => {
      copy.coords[texel * 2] = values[at];
      copy.coords[texel * 2 + 1] = values[at + 1];
      noted.add(rowOfCoord(copy.coordFirst, copy.rows, texel));
    });
    writes.rowStyles.forEach((texel, values, at) => {
      copy.rowStyles.set(
        values.subarray(at, at + ROWS_ROW_STYLE_FLOATS),
        texel * ROWS_ROW_STYLE_FLOATS,
      );
      noted.add(texel);
    });
  }

  /** A chunk was released */
  disposed(chunk: RowsChunk): void {
    this.chunks.delete(chunk);
    this.written.delete(chunk);
  }

  /** Lines of the texture of a palette were uploaded from its values */
  paletteUploaded(palette: RowsPalette, lines: readonly number[]): void {
    let copy = this.palettes.get(palette);
    if (!copy || copy.length < palette.values.length) {
      const grown = new Float32Array(palette.values.length);
      if (copy) grown.set(copy);
      copy = grown;
      this.palettes.set(palette, copy);
    }
    for (const line of lines) {
      const from = line * PALETTE_LINE_FLOATS;
      const to = Math.min(palette.values.length, from + PALETTE_LINE_FLOATS);
      if (to > from) copy.set(palette.values.subarray(from, to), from);
    }
  }
}

/** The row of a chunk a coordinate is of (`coordFirst` has the rows + 1 starts) */
function rowOfCoord(coordFirst: Int32Array, rows: number, coord: number): number {
  let lo = 0;
  let hi = rows - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (coordFirst[mid] <= coord) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * What a row of packed arrays draws, as text: its instances and the instances of its points in
 * order, each with its kind, its row, the values of its coordinates and the rest of it (the ones
 * that draw nothing left out), and, when it draws something, its created zoom, the rotation of
 * its markers (the fourth float of the texel of its style) and the values of its style. Two
 * packings of a row that draw the same give the same text, however their places and their
 * coordinates are numbered
 *
 * @param local The row in the arrays
 * @param values The values of the styles the row names (by its number)
 * @internal
 */
export function drawnRowText(data: RowsChunkData, local: number, values: Float32Array): string {
  const coord = (index: number): number[] | null =>
    index < 0 ? null : [data.coords[index * 2], data.coords[index * 2 + 1]];
  const read = (source: Float32Array, from: number, to: number): unknown[] => {
    const out: unknown[] = [];
    for (let k = from; k < to; k++) {
      const { kind, row, indices, t0, t1, extra } = readRowsInstance(source, k);
      const [a, b, c, d] = indices;
      // An instance that draws nothing (the rest of a place a row no longer fills)
      if (kind === ROWS_KIND.fill && a === b && b === c && c === d) continue;
      out.push([kind, row, coord(a), coord(b), coord(c), coord(d), t0, t1, extra]);
    }
    return out;
  };
  const instances = read(data.instances, data.rowFirst[local], data.rowFirst[local + 1]);
  const points = read(data.points, data.pointFirst[local], data.pointFirst[local + 1]);
  if (instances.length === 0 && points.length === 0) return 'nothing';
  const at = local * ROWS_ROW_STYLE_FLOATS;
  const style = data.rowStyles[at];
  const styleAt = style * ROWS_STYLE_FLOATS;
  return JSON.stringify({
    instances,
    points,
    createdZoom: data.rowStyles[at + 2] !== 0 ? data.rowStyles[at + 1] : null,
    angleSteps: data.rowStyles[at + 3],
    style:
      style >= 0 && styleAt + ROWS_STYLE_FLOATS <= values.length
        ? Array.from(values.subarray(styleAt, styleAt + ROWS_STYLE_FLOATS))
        : null,
  });
}
