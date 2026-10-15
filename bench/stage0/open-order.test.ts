// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The blocks of files added in another order than the order of their rows (as the page adds the
 * files of the view first, then the others as they come) are put at the places of their keys:
 * the rows are read in the order of the run, and every one is in a block of its own file, none
 * left for the rows changed since their blocks were built
 */

import { zstdCompressSync } from 'node:zlib';
import { createFeatureTables } from '@sakuzu/maplibre-gl-draw/kasane';
import { describe, expect, it } from 'vitest';
import * as featureTablesModule from '../../src/feature-table/feature-tables';
import { encodeSegment, packFile, type SegmentRows } from './codec.ts';
import { decodeFile } from './decode-work.ts';
import { idText } from './rows.ts';

// The library keeps these to itself (the declarations of its build leave them out)
const { featureTablesInternals } = featureTablesModule as unknown as {
  featureTablesInternals(
    tables: unknown,
  ):
    | { addQueuedBlocks(): void; groupsOfRows(handles: Int32Array): Map<number, number[]> }
    | undefined;
};

const CLIENT = '00000000000000aa';
const LAYER = 'layer';

/** A file of `segments` segments of `rows` points, from the row `first` of the run */
function fileOf(first: number, segments: number, rows: number): Uint8Array {
  const packed = [];
  for (let s = 0; s < segments; s++) {
    const firstRow = first + s * rows;
    const index = Array.from({ length: rows }, (_, i) => firstRow + i);
    const segment: SegmentRows = {
      ids: index.map((r) => ({ client: CLIENT, serial: 2 + r })),
      place: { layer: LAYER, head: 'a0', firstRow },
      sources: index.map(() => ({ client: CLIENT, batch: 1 })),
      deleted: index.map(() => false),
      // The rows of the run zigzag over the area, so that the blocks of the files overlap in space
      geometries: index.map((r) => ({
        type: 'Point',
        coordinates: [139 + (r % 100) * 0.001, 35 + ((r * 7) % 100) * 0.001],
      })),
      properties: index.map((r) => ({ n: r })),
      styles: index.map(() => ({ pointColor: '#123456' })),
    };
    packed.push({ rows, bytes: new Uint8Array(zstdCompressSync(encodeSegment(segment).bytes)) });
  }
  return packFile(packed);
}

describe('the blocks of files added out of their order', () => {
  it('are read in the order of the run, each at the place of its keys', () => {
    const FILES = 4;
    const SEGMENTS = 3;
    const ROWS = 1000;
    const files = Array.from({ length: FILES }, (_, f) =>
      decodeFile(fileOf(f * SEGMENTS * ROWS, SEGMENTS, ROWS)),
    );
    const rejected: string[] = [];
    const { tables, writer } = createFeatureTables({
      onBlockRejected: (_layer, reason) => rejected.push(reason.message),
    });
    for (const f of [2, 0, 3, 1]) writer.addBlocks(LAYER, files[f].blocks);
    const internals = featureTablesInternals(tables);
    expect(internals).toBeDefined();
    internals?.addQueuedBlocks();
    expect(rejected).toEqual([]);
    const view = tables.get(LAYER);
    const total = FILES * SEGMENTS * ROWS;
    expect(view?.rowCount).toBe(total);
    const handles = view?.listRowHandles(0, total) ?? new Int32Array(0);
    const ids = Array.from(handles, (h) => tables.getRowId(h));
    const clientTexts = new Map<string, string>();
    expect(ids).toEqual(
      Array.from({ length: total }, (_, r) =>
        idText({ client: CLIENT, serial: 2 + r }, clientTexts),
      ),
    );
    // Every row is in a block (none in the rows changed since their blocks were built)
    const grouped = internals?.groupsOfRows(handles);
    const inBlocks = [...(grouped?.values() ?? [])].reduce((s, rows) => s + rows.length, 0);
    expect(inBlocks).toBe(total);
  });
});
