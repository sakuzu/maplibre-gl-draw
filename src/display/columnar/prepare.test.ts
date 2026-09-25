// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the preparation of a columnar table (the part that runs in a Worker)
 */

import { describe, expect, it } from 'vitest';
import { chunkTargetSizeFor, partitionIntoChunks } from '../chunk.js';
import { searchPackedRTree } from '../packed-rtree.js';
import { normalizeDisplayFeature } from '../types.js';
import { columnarTransferables, prepareDatasetColumnar } from './prepare.js';
import type { DatasetColumnarGeometry, DatasetColumnarInput } from './types.js';

/** 2,000 points on a spiral, as a table */
function points(count = 2_000): {
  input: DatasetColumnarInput & { geometry: DatasetColumnarGeometry };
  coords: Array<[number, number]>;
} {
  const coords: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) {
    const angle = i * 0.37;
    coords.push([139 + Math.cos(angle) * i * 1e-4, 35 + Math.sin(angle) * i * 1e-4]);
  }
  return {
    input: {
      length: count,
      geometry: { type: 'Point', coords: Float64Array.from(coords.flat()) },
      columns: { value: Float64Array.from(coords, (_, i) => i) },
    },
    coords,
  };
}

describe('prepareDatasetColumnar', () => {
  it('splits the rows into the same chunks as the same features', () => {
    const { input, coords } = points();
    const prepared = prepareDatasetColumnar(input);
    const features = coords.map((coordinates, i) =>
      normalizeDisplayFeature({ id: String(i), type: 'Point', coordinates }),
    );
    const chunks = partitionIntoChunks(features, chunkTargetSizeFor(features.length));
    expect(prepared.chunkOffsets.length - 1).toBe(chunks.length);
    chunks.forEach((chunk, c) => {
      const rows = prepared.chunkRows.subarray(
        prepared.chunkOffsets[c],
        prepared.chunkOffsets[c + 1],
      );
      expect(Array.from(rows)).toEqual(Array.from(chunk.rows));
      expect(Array.from(prepared.chunkBounds.subarray(c * 4, c * 4 + 4))).toEqual([
        chunk.bounds.minX,
        chunk.bounds.minY,
        chunk.bounds.maxX,
        chunk.bounds.maxY,
      ]);
    });
  });

  it('builds the spatial index of the hit testing', () => {
    const { input, coords } = points();
    const prepared = prepareDatasetColumnar(input);
    const found = searchPackedRTree(
      {
        nodeSize: prepared.indexNodeSize,
        numItems: prepared.indexItemCount,
        boxes: prepared.indexBoxes,
        indices: prepared.indexEntries,
        levelBounds: prepared.indexLevels,
      },
      coords[1234][0],
      coords[1234][1],
      coords[1234][0],
      coords[1234][1],
    );
    expect(found).toContain(1234);
  });

  it('lists every buffer once for the transfer', () => {
    const { input } = points(10);
    const shared = new Float64Array(20);
    const table = {
      ...input,
      columns: {
        a: shared.subarray(0, 10),
        b: shared.subarray(10, 20),
        name: new Array(10).fill('x'),
      },
      ids: { codes: new Int32Array(10), dictionary: ['id'] },
    };
    const prepared = prepareDatasetColumnar(table);
    const buffers = columnarTransferables(table, prepared);
    expect(new Set(buffers).size).toBe(buffers.length);
    expect(buffers).toContain(table.geometry.coords.buffer);
    expect(buffers).toContain(shared.buffer);
    expect(buffers).toContain(prepared.indexBoxes.buffer);
    // coords, the shared column buffer, the codes of the ids, and 7 prepared arrays
    expect(buffers).toHaveLength(3 + 7);
  });

  it('lists the arrays of a mixed geometry column and of every child', () => {
    const types = Int8Array.of(0, 1);
    const offsets = Int32Array.of(0, 0);
    const point = Float64Array.of(1, 1);
    const line = Float64Array.of(0, 0, 2, 2);
    const lineOffsets = Int32Array.of(0, 2);
    const table: DatasetColumnarInput = {
      length: 2,
      geometry: {
        type: 'Mixed',
        types,
        offsets,
        children: [
          { type: 'Point', coords: point },
          { type: 'LineString', coords: line, offsets: [lineOffsets] },
        ],
      },
    };
    const prepared = prepareDatasetColumnar(table);
    expect(Array.from(prepared.bounds)).toEqual([1, 1, 1, 1, 0, 0, 2, 2]);
    const buffers = columnarTransferables(table);
    expect(buffers).toEqual(
      [types, offsets, point, line, lineOffsets].map((array) => array.buffer),
    );
  });
});
