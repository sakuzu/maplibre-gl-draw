// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="node" />

/**
 * The Tabane format
 *
 * - The ids, the keys of the rows, the floats by XOR and the decimal coordinates read back as
 *   they were written
 * - A block reads back to the rows it was written from: every coordinate to the same bits, every
 *   value to the same value, the deleted rows, what created the rows and the revisions of their
 *   cells; the same rows always give the same bytes
 * - A row block read is a row block of the tables: the same columns the builder of the blocks of
 *   rows makes from the same rows, and the tables take it as it is
 * - Files: parts compressed or stored, read a part at a time or whole; the name is the hash of
 *   the content whatever the parts
 * - A reader refuses bytes a writer never writes
 */

import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import type { Geometry, Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import type { FeatureTables } from '../../api/tables.js';
import { featureTablesInternals } from '../../feature-table/feature-tables.js';
import { createTableStore } from '../../store/table-memory.js';
import { seededRandom } from '../../test-utils.js';
import { decodeCanonicalValue } from '../canonical-value.js';
import { createRowBlockDataBuilder } from '../row-group-builder.js';
import type { RowBlockData } from '../row-group-types.js';
import { utf8String } from '../utf8-column.js';
import { readValue } from '../value-column.js';
import {
  packTabaneBlock,
  readBlockData,
  readTabaneBlock,
  readTabaneBlockFile,
  writeTabaneBlock,
  writeTabaneBlocks,
} from './block.js';
import { ByteSink, ByteSource } from './bytes.js';
import { decimalAt, fewestDecimals } from './decimals.js';
import { packTabaneFile, type TabaneCompressor, tabaneNameOf, unpackTabaneFile } from './file.js';
import {
  formatTabaneId,
  isTabaneOrigin,
  originBytes,
  originOf,
  parseTabaneId,
  tabaneRowSuffixOf,
  writeRowSuffix,
} from './ids.js';
import { readTabaneManifest, tabaneManifestEntryOf, writeTabaneManifest } from './manifest.js';
import { rowBlockDataOfTabane, tabaneRowsOf } from './rows.js';
import type { TabaneRow } from './types.js';
import { XorSink, XorSource } from './xor.js';

const zstd: TabaneCompressor = {
  compress: (raw) => new Uint8Array(zstdCompressSync(raw)),
  decompress: (stored) => new Uint8Array(zstdDecompressSync(stored)),
};

const ORIGIN = '1AAAAAAAAAAAA';
const OTHER = 'F000000000001';

/** Whether two values are the same, numbers by their bits */
function same(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    return Object.is(a, b);
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object).sort();
  const kb = Object.keys(b as object).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) =>
    same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/** The rows as the reader gives them back: a style always, no fill (compared apart) */
function normal(rows: readonly TabaneRow[]): unknown[] {
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    geometry: r.geometry,
    style: r.style ?? {},
    properties: Object.fromEntries(
      Object.entries(r.properties ?? {}).filter(([, v]) => v !== undefined),
    ),
    ...(r.deleted && { deleted: true }),
    ...(r.created && { created: r.created }),
    ...(r.revisions && Object.keys(r.revisions).length > 0 && { revisions: r.revisions }),
  }));
}

function withoutFill(rows: readonly TabaneRow[]): unknown[] {
  return rows.map(({ fill: _, ...rest }) => rest);
}

/** A polygon of buildings: a ring of 5 to 12 corners around a point, coordinates of 9 digits */
function building(random: () => number, x: number, y: number): Polygon {
  const corners = 5 + Math.floor(random() * 8);
  const ring: number[][] = [];
  for (let k = 0; k < corners; k++) {
    const a = (k / corners) * Math.PI * 2;
    const r = 0.0001 + random() * 0.0002;
    ring.push([
      Math.round((x + Math.cos(a) * r) * 1e9) / 1e9,
      Math.round((y + Math.sin(a) * r) * 1e9) / 1e9,
    ]);
  }
  ring.push([...ring[0]]);
  return { type: 'Polygon', coordinates: [ring] };
}

/** Rows like the buildings of a city: polygons, a few attributes of strings */
function buildings(count: number, seed = 1, from = 1): TabaneRow[] {
  const random = seededRandom(seed);
  const kinds = ['普通建物', '堅ろう建物', '普通無壁舎'];
  return Array.from({ length: count }, (_, i) => ({
    id: formatTabaneId({ origin: ORIGIN, number: from + i }),
    type: 'Polygon',
    geometry: building(random, 139.7 + random() * 0.1, 35.6 + random() * 0.1),
    properties: {
      fid: `20260625-${50000 + i}`,
      type: kinds[Math.floor(random() * kinds.length)],
      ...(i % 3 === 0 && { floors: 1 + Math.floor(random() * 10) }),
    },
  }));
}

/** Rows of every geometry type, value and flag */
function variety(): TabaneRow[] {
  const id = (n: number) => formatTabaneId({ origin: ORIGIN, number: n });
  return [
    {
      id: id(1),
      type: 'Point',
      geometry: { type: 'Point', coordinates: [139.767125, 35.681236] },
      properties: { name: '東京駅', rank: 1, ratio: 0.1 + 0.2, flag: true, none: null },
      style: { color: '#ff0000', size: 3 },
    },
    {
      id: id(2),
      type: 'LineString',
      geometry: {
        type: 'LineString',
        coordinates: [
          [0.1 + 0.2, -0],
          [1e-300, 123456789.123],
          [-180, 90],
        ],
      },
      properties: { name: '線', nested: { a: [1, 2, { b: null }], z: 'x' }, rank: -(2 ** 60) },
      deleted: true,
    },
    {
      id: id(3),
      type: 'Polygon',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
            [0, 0],
          ],
          [
            [2, 2],
            [4, 2],
            [4, 4],
            [2, 2],
          ],
        ],
      },
      properties: { name: '面', flag: false, ratio: -0 },
      style: { color: '#00ff00' },
    },
    {
      id: id(4),
      type: 'MultiPoint',
      geometry: {
        type: 'MultiPoint',
        coordinates: [
          [1.5, 2.5],
          [3.25, 4.125],
        ],
      },
    },
    {
      id: id(5),
      type: 'MultiLineString',
      geometry: {
        type: 'MultiLineString',
        coordinates: [
          [
            [0, 0],
            [1, 1],
          ],
          [
            [2, 2],
            [3, 3],
            [4, 5],
          ],
        ],
      },
      properties: { name: '線' },
    },
    {
      id: id(6),
      type: 'MultiPolygon',
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 0],
            ],
          ],
          [
            [
              [5, 5],
              [6, 5],
              [6, 6],
              [5, 6],
              [5, 5],
            ],
          ],
        ],
      },
      style: { color: '#00ff00' },
    },
    { id: formatTabaneId({ origin: OTHER, number: 7 }), type: 'Marker', geometry: null },
    {
      id: formatTabaneId({ origin: OTHER, number: 8 }),
      type: 'Circle',
      geometry: { type: 'Point', coordinates: [139.7, 35.6] },
      properties: { radius: 100 },
    },
  ];
}

describe('the ids and the keys of the rows', () => {
  it('write an origin as 8 bytes and read it back', () => {
    for (const origin of ['0000000000000', ORIGIN, OTHER, 'FZZZZZZZZZZZZ', '7ZZZZZZZZZZZZ']) {
      const bytes = originBytes(origin);
      expect(bytes.length).toBe(8);
      expect(originOf(bytes)).toBe(origin);
    }
    expect(Array.from(originBytes('FZZZZZZZZZZZZ'))).toEqual(new Array(8).fill(255));
    expect(Array.from(originBytes('0000000000001'))).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(isTabaneOrigin('G000000000000')).toBe(false);
    expect(isTabaneOrigin('0000000000I00')).toBe(false);
  });

  it('write an id as text and read it back', () => {
    expect(formatTabaneId({ origin: ORIGIN, number: 42 })).toBe(`${ORIGIN}-1A`);
    expect(parseTabaneId(`${ORIGIN}-1A`)).toEqual({ origin: ORIGIN, number: 42 });
    expect(parseTabaneId(`${ORIGIN}-01A`)).toBeNull();
    expect(parseTabaneId(`${ORIGIN}-0`)).toBeNull();
    expect(parseTabaneId(`${ORIGIN}1A`)).toBeNull();
    expect(parseTabaneId(`${ORIGIN}-80000000000`)).toBeNull();
    const big = formatTabaneId({ origin: ORIGIN, number: Number.MAX_SAFE_INTEGER });
    expect(parseTabaneId(big)?.number).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('give the suffixes of the rows of a run, in their order', () => {
    const cases: [number, string][] = [
      [0, '11'],
      [1, '12'],
      [2, '13'],
      [60, '1z'],
      [61, '221'],
      [62, '222'],
      [3720, '2zz'],
      [3721, '3211'],
      [226980, '3zzz'],
      [226981, '42111'],
    ];
    const out = new Uint8Array(16);
    for (const [i, suffix] of cases) {
      expect(tabaneRowSuffixOf(i)).toBe(suffix);
      const n = writeRowSuffix(i, out, 0);
      expect(new TextDecoder().decode(out.subarray(0, n))).toBe(suffix);
    }
    for (let i = 0; i < 5000; i++)
      expect(tabaneRowSuffixOf(i) < tabaneRowSuffixOf(i + 1)).toBe(true);
  });
});

describe('the numbers', () => {
  it('read the integers back, refusing those not in their fewest bytes', () => {
    const values = [0, 1, 63, 64, 127, 128, 2 ** 31, 2 ** 53 - 1];
    const sink = new ByteSink();
    for (const v of values) {
      sink.uint(v);
      sink.int(v);
      sink.int(-v || 0);
    }
    const source = new ByteSource(sink.finish());
    for (const v of values) {
      expect(source.uint()).toBe(v);
      expect(source.int()).toBe(v);
      expect(source.int()).toBe(-v || 0);
    }
    expect(source.done).toBe(true);
    expect(() => new ByteSource(Uint8Array.of(0x80, 0x00)).uint()).toThrow(/fewest/);
    expect(() => new ByteSource(Uint8Array.of(0x81, 0x00)).int()).toThrow(/fewest/);
    expect(() => new ByteSource(Uint8Array.of(0x40)).int()).toThrow(/-0/);
  });

  it('read every float written by XOR back to the same bits', () => {
    const random = seededRandom(7);
    const values = [
      0,
      -0,
      1,
      1,
      0.1 + 0.2,
      Number.MIN_VALUE,
      -Number.MAX_VALUE,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      139.767125,
      139.767126,
    ];
    for (let k = 0; k < 2000; k++) values.push((random() - 0.5) * 10 ** Math.floor(random() * 20));
    const sink = new XorSink();
    for (const v of values) sink.put(v);
    const source = new XorSource(sink.finish());
    for (const v of values) expect(same(source.get(), v)).toBe(true);
    expect(source.finished()).toBe(true);
  });

  it('write a coordinate as an integer of a power of ten only when it reads back', () => {
    expect(decimalAt(139.767125, 6)).toBe(139767125);
    expect(fewestDecimals(139.767125)).toBe(6);
    expect(fewestDecimals(0.1 + 0.2)).toBe(-1);
    expect(fewestDecimals(-0)).toBe(-1);
    expect(fewestDecimals(Number.NaN)).toBe(-1);
    expect(decimalAt(-2.5, 0)).toBeNull();
    expect(decimalAt(-2.5, 1)).toBe(-25);
    expect(decimalAt(1e300, 0)).toBeNull();
  });
});

describe('a block', () => {
  it('reads back to the rows it was written from', () => {
    const rows = variety();
    const block = writeTabaneBlock({ parent: 'layer-1', head: 'V', rows });
    const rowBlocks = readTabaneBlock(block.content);
    expect(rowBlocks.length).toBe(1);
    const back = tabaneRowsOf(rowBlocks[0]);
    expect(same(normal(back), normal(rows))).toBe(true);
    // The fills of the polygons are those the builder makes
    expect(back.filter((r) => r.fill).map((r) => r.id)).toEqual([rows[2].id, rows[5].id]);
    expect(rowBlocks[0].place).toEqual({ parent: 'layer-1', head: 'V', firstIndex: 0 });
    expect(rowBlocks[0].ids).toEqual([
      [ORIGIN, 1, 6],
      [OTHER, 7, 2],
    ]);
  });

  it('keeps the coordinates of more dimensions, a missing value as NaN', () => {
    const rows: TabaneRow[] = [
      {
        id: formatTabaneId({ origin: ORIGIN, number: 1 }),
        type: 'LineString',
        geometry: {
          type: 'LineString',
          coordinates: [
            [1, 2, 3, 4],
            [5, 6, 7.5, -0],
          ],
        },
      },
      {
        id: formatTabaneId({ origin: ORIGIN, number: 2 }),
        type: 'Point',
        geometry: { type: 'Point', coordinates: [1, 2] },
      },
    ];
    const rowBlock = readTabaneBlock(writeTabaneBlock({ parent: '', head: 'a', rows }).content)[0];
    expect(rowBlock.dimensions).toBe('xyzm');
    const back = tabaneRowsOf(rowBlock);
    expect(same(back[0].geometry, rows[0].geometry)).toBe(true);
    expect(same(back[1].geometry, { type: 'Point', coordinates: [1, 2, NaN, NaN] })).toBe(true);
  });

  it('keeps what created the rows and the revisions of their cells', () => {
    const rows: TabaneRow[] = buildings(5).map((r, i) => ({
      ...r,
      created: i < 3 ? [10, OTHER, 2] : [11, ORIGIN, 3],
      ...(i === 1 && {
        revisions: { 'p.type': [20, OTHER, 5], geometry: [21, '0000000000002', 1] },
      }),
    }));
    const rowBlock = readTabaneBlock(writeTabaneBlock({ parent: 'l', head: 'k', rows }).content)[0];
    expect(rowBlock.created).toEqual([
      [[10, OTHER, 2], 3],
      [[11, ORIGIN, 3], 2],
    ]);
    expect(
      same(withoutFill(tabaneRowsOf(rowBlock)), withoutFill(normal(rows) as TabaneRow[])),
    ).toBe(true);
    expect(() =>
      writeTabaneBlock({
        parent: 'l',
        head: 'k',
        rows: [rows[0], { ...rows[1], created: undefined }],
      }),
    ).toThrow(/every row/);
  });

  it('gives the same bytes for the same rows, whatever the order of the keys of their values', () => {
    const rows = variety();
    const shuffled = rows.map((r) => ({
      ...r,
      properties: Object.fromEntries(Object.entries(r.properties ?? {}).reverse()),
      style: Object.fromEntries(Object.entries(r.style ?? {}).reverse()),
    }));
    const a = writeTabaneBlock({ parent: 'p', head: 'V', rows }).content;
    const b = writeTabaneBlock({ parent: 'p', head: 'V', rows: shuffled }).content;
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('cuts its rows into row blocks and its row blocks into blocks', () => {
    const rows = buildings(2500);
    const block = writeTabaneBlock({ parent: 'p', head: 'V', rows });
    const rowBlocks = readTabaneBlock(block.content);
    expect(rowBlocks.map((g) => g.length)).toEqual([1000, 1000, 500]);
    expect(rowBlocks.map((g) => g.place.firstIndex)).toEqual([0, 1000, 2000]);
    const blocks = writeTabaneBlocks({ parent: 'p', head: 'V', rows, targetBytes: 80_000 });
    expect(blocks.length).toBeGreaterThan(1);
    let first = 0;
    blocks.forEach((b, j) => {
      const gs = readTabaneBlock(b.content);
      expect(gs[0].place).toEqual({ parent: 'p', head: `V${tabaneRowSuffixOf(j)}`, firstIndex: 0 });
      expect(gs[0].ids[0][1]).toBe(1 + first);
      first += b.rows;
    });
    expect(first).toBe(2500);
  });

  it('refuses rows it cannot write', () => {
    const row = buildings(1)[0];
    const write = (rows: TabaneRow[]) => () => writeTabaneBlock({ parent: '', head: 'a', rows });
    expect(write([{ ...row, id: 'r1' }])).toThrow(/not an id/);
    expect(write([{ ...row, properties: { a: Number.NaN } }])).toThrow(/not a value/);
    expect(
      write([{ ...row, geometry: { type: 'GeometryCollection', geometries: [] } as Geometry }]),
    ).toThrow(/geometry/);
    expect(() =>
      writeTabaneBlock({
        parent: '',
        head: 'a',
        dimensions: 'xy',
        rows: variety()
          .slice(0, 1)
          .map((r) => ({ ...r, geometry: { type: 'Point', coordinates: [1, 2, 3] } })),
      }),
    ).toThrow(/geometry/);
  });
});

describe('a file', () => {
  it('reads back a part at a time, compressed or not, under the name of its content', async () => {
    const rows = buildings(2100);
    const block = writeTabaneBlock({ parent: 'p', head: 'V', rows });
    const name = await tabaneNameOf(block.content);
    for (const compressor of [undefined, zstd]) {
      const file = packTabaneBlock(block, compressor);
      expect(await tabaneNameOf(unpackTabaneFile(file, zstd))).toBe(name);
      const rowBlocks = readTabaneBlockFile(file, zstd);
      expect(same(normal(rowBlocks.flatMap((g) => tabaneRowsOf(g))), normal(rows))).toBe(true);
    }
    // One part for all: read whole
    const whole = packTabaneFile(block.content, [], zstd);
    expect(readTabaneBlockFile(whole, zstd).length).toBe(3);
    expect(packTabaneBlock(block, zstd).length).toBeLessThan(block.content.length);
  });

  it('refuses bytes a writer never writes', () => {
    const block = writeTabaneBlock({ parent: 'p', head: 'V', rows: buildings(3) });
    const content = block.content;
    expect(() => readTabaneBlock(content.subarray(0, content.length - 1))).toThrow();
    expect(() => readTabaneBlock(Uint8Array.from([...content, 0]))).toThrow();
    const bad = content.slice();
    bad[0] = 0;
    expect(() => readTabaneBlock(bad)).toThrow(/not a block/);
    const file = packTabaneBlock(block);
    expect(() => readTabaneBlockFile(file.subarray(0, file.length - 1))).toThrow();
    expect(() => readTabaneBlockFile(packTabaneBlock(block, zstd))).toThrow(/no compressor/);
  });
});

describe('a row block as a row block of the tables', () => {
  /** Every column the builder of the blocks makes of the same rows, compared */
  function expectSameBlock(a: RowBlockData, b: RowBlockData): void {
    expect(a.length).toBe(b.length);
    expect(a.ids).toEqual(b.ids);
    expect(a.idHashes).toEqual(b.idHashes);
    expect(a.itemKeys).toEqual(b.itemKeys);
    expect(a.memberKeys).toEqual(b.memberKeys);
    expect(a.groups).toEqual(b.groups);
    expect(a.flags).toEqual(b.flags);
    expect(a.types).toEqual(b.types);
    expect(a.typeNames).toEqual(b.typeNames);
    expect(a.geometry).toEqual(b.geometry);
    expect(a.rowBounds).toEqual(b.rowBounds);
    expect(a.triangles).toEqual(b.triangles);
    expect(a.index).toEqual(b.index);
    expect(a.vertexCount).toBe(b.vertexCount);
    for (let r = 0; r < a.length; r++) {
      const sa = a.styleDictionary as NonNullable<RowBlockData['styleDictionary']>;
      const sb = b.styleDictionary as NonNullable<RowBlockData['styleDictionary']>;
      expect(utf8String(sa, a.styles[r])).toBe(utf8String(sb, b.styles[r]));
      const read = (block: RowBlockData) =>
        Object.fromEntries(
          block.properties.keys
            .map((key, k) => [key, readValue(block.properties.columns[k], r)])
            .filter(([, v]) => v !== undefined),
        );
      expect(same(read(a), read(b))).toBe(true);
    }
  }

  it('holds the columns the builder makes of the same rows', () => {
    for (const rows of [buildings(1000, 3), variety()]) {
      for (const fills of [true, false]) {
        const rowBlock = readBlockData(
          writeTabaneBlock({ parent: 'p', head: 'V', rows, fills }).content,
        )[0];
        const builder = createRowBlockDataBuilder({ targetRows: 1000 });
        rows.forEach((row, i) => {
          builder.addRow({
            id: row.id,
            type: row.type,
            geometry: row.geometry,
            order: `V${tabaneRowSuffixOf(i)}`,
            style: row.style,
            properties: row.properties,
            deleted: row.deleted,
          });
        });
        const [built] = builder.finish();
        expectSameBlock(rowBlockDataOfTabane(rowBlock), built);
      }
    }
  });

  it('is taken by the tables as it is, and read back as features', () => {
    const rows = buildings(1500, 5);
    const { store, writer } = createTableStore();
    store.createLayer({
      id: 'l',
      name: 'l',
      visible: true,
      locked: false,
      opacity: 1,
      kind: 'table',
      metadata: undefined,
      styleRule: undefined,
    });
    const rowBlocks = readBlockData(writeTabaneBlock({ parent: 'l', head: 'V', rows }).content);
    writer.addRowBlocks(
      'l',
      rowBlocks.map((g) => rowBlockDataOfTabane(g)),
    );
    featureTablesInternals(store.tables as FeatureTables)?.addQueuedRowBlocks();
    for (const k of [0, 999, 1000, 1499]) {
      const feature = store.getFeature(rows[k].id);
      expect(feature?.geometry).toEqual(rows[k].geometry);
      expect(feature?.properties).toEqual(rows[k].properties);
    }
  });
});

describe('a manifest', () => {
  it('reads back, and says the box, the ids and the keys of each block', async () => {
    const rows = buildings(2500);
    const blocks = writeTabaneBlocks({ parent: 'p', head: 'V', rows, targetBytes: 80_000 });
    const entries = await Promise.all(blocks.map((b) => tabaneManifestEntryOf(b)));
    const manifest = {
      coordinates: { system: 'lnglat', dimensions: 'xy' as const },
      partition: { kind: 'order' as const },
      blocks: entries,
      extra: { state: { layers: ['p'] } },
    };
    const content = writeTabaneManifest(manifest);
    expect(readTabaneManifest(content)).toEqual(manifest);
    const first = entries[0];
    expect(first.order.first).toBe(`V${tabaneRowSuffixOf(0)}${tabaneRowSuffixOf(0)}`);
    expect(first.ids).toEqual([[ORIGIN, 1, first.rows]]);
    const box = first.box as [number, number][];
    for (const row of rows.slice(0, first.rows)) {
      for (const [x, y] of (row.geometry as Polygon).coordinates[0]) {
        expect(x >= box[0][0] && x <= box[0][1] && y >= box[1][0] && y <= box[1][1]).toBe(true);
      }
    }
    expect(() => readTabaneManifest(content.subarray(1))).toThrow(/not a manifest/);
    expect(decodeCanonicalValue(content, 4)).toMatchObject({ tabane: 1 });
  });
});
