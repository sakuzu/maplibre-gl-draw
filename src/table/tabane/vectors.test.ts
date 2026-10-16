// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="node" />

/**
 * The test vectors of the Tabane format (`vectors/` of this folder, described in its README)
 *
 * Every implementation of the format writes the bytes of each vector from its input and reads
 * the rows back from them. The files of `vectors/` are what the scenarios below give: the test
 * fails when they differ, and `TABANE_VECTORS_WRITE=1` writes them again.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { polygonRanges, ringOffsetsOf, toRowGeometry, triangulateRow } from '../row-geometry.js';
import { isKindValue, valueFromJSON } from '../value.js';
import {
  BigInteger,
  Bytes,
  CalendarDate,
  DateTime,
  Decimal,
  Duration,
  Reference,
  TimeOfDay,
} from '../value-kinds.js';
import {
  packTabaneBlock,
  readTabaneBlock,
  type TabaneBlockInput,
  writeTabaneBlocks,
} from './block.js';
import { type TabaneCompressor, tabaneNameOf, unpackTabaneFile } from './file.js';
import { formatTabaneId } from './ids.js';
import { readTabaneManifest, tabaneManifestEntryOf, writeTabaneManifest } from './manifest.js';
import { tabaneRowsOf } from './rows.js';
import type { TabaneRow } from './types.js';

const DIR = join(import.meta.dirname, 'vectors');
const WRITE = process.env.TABANE_VECTORS_WRITE === '1';

const zstd: TabaneCompressor = {
  compress: (raw) => new Uint8Array(zstdCompressSync(raw)),
  decompress: (stored) => new Uint8Array(zstdDecompressSync(stored)),
};

// === The JSON of the vectors: a float JSON cannot write is {"$f64": its 16 hex digits}, and a
// value of a kind JSON has not (a date, a reference) is its JSON form ({"$date": "2026-10-16"}) ===

/** The names of the JSON forms of the values of the kinds JSON has not */
const VALUE_TAGS = new Set([
  '$number',
  '$integer',
  '$decimal',
  '$bytes',
  '$date',
  '$time',
  '$datetime',
  '$duration',
  '$reference',
]);

const view = new DataView(new ArrayBuffer(8));

function toJson(v: unknown): unknown {
  if (typeof v === 'number') {
    if (Number.isFinite(v) && !Object.is(v, -0)) return v;
    view.setFloat64(0, v, false);
    let hex = '';
    for (let k = 0; k < 8; k++) hex += view.getUint8(k).toString(16).padStart(2, '0');
    return { $f64: hex };
  }
  if (Array.isArray(v)) return v.map(toJson);
  if (v !== null && typeof v === 'object' && isKindValue(v)) {
    return (v as { toJSON(): unknown }).toJSON();
  }
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v)
        .filter(([, x]) => x !== undefined)
        .map(([k, x]) => [k, toJson(x)]),
    );
  }
  return v;
}

function fromJson(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(fromJson);
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1 && keys[0] === '$f64' && typeof o.$f64 === 'string') {
      for (let k = 0; k < 8; k++)
        view.setUint8(k, Number.parseInt(o.$f64.slice(k * 2, k * 2 + 2), 16));
      return view.getFloat64(0, false);
    }
    if (keys.length === 1 && VALUE_TAGS.has(keys[0])) return valueFromJSON(o);
    return Object.fromEntries(keys.map((k) => [k, fromJson(o[k])]));
  }
  return v;
}

function hex(b: Uint8Array): string {
  return Buffer.from(b).toString('hex');
}

// === The scenarios ===

const A = '1AAAAAAAAAAAA';
const B = 'F000000000001';
const id = (origin: string, n: number) => formatTabaneId({ origin, number: n });

/** The fill of a polygon row as the writer makes it */
function withFill(row: TabaneRow): TabaneRow {
  const g = row.geometry;
  if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) return row;
  const rg = toRowGeometry(g, 'xy');
  const made = triangulateRow(rg.coords, ringOffsetsOf(rg), polygonRanges(rg), rg.stride);
  return { ...row, fill: { vertices: made.vertices, indices: made.indices } };
}

interface Scenario {
  readonly name: string;
  readonly description: string;
  readonly input: TabaneBlockInput & { readonly targetBytes?: number };
  readonly manifest?: {
    readonly coordinates: {
      readonly system: string;
      readonly dimensions: 'xy' | 'xyz' | 'xym' | 'xyzm';
    };
    readonly extra?: Record<string, unknown>;
  };
}

function square(x: number, y: number, size: number): number[][] {
  return [
    [x, y],
    [x + size, y],
    [x + size, y + size],
    [x, y + size],
    [x, y],
  ];
}

const SCENARIOS: Scenario[] = [
  {
    name: 'points',
    description: 'Points of 6 decimal digits, one type, one style, attributes in every row',
    input: {
      parent: 'L',
      head: 'V',
      dimensions: 'xy',
      rows: Array.from({ length: 5 }, (_, i) => ({
        id: id(A, i + 1),
        type: 'Point',
        geometry: { type: 'Point', coordinates: [139.767125 + i / 1e6, 35.681236 - i / 1e6] },
        style: { color: '#ff0000' },
        properties: { name: `p${i}`, rank: i },
      })),
    },
  },
  {
    name: 'variety',
    description:
      'Every geometry type and none, two origins of ids, types, styles, deleted rows, values of every kind, dense and sparse columns, fills given',
    input: {
      parent: 'layer-1',
      head: 'a0V',
      dimensions: 'xy',
      rows: (
        [
          {
            id: id(A, 1),
            type: 'Point',
            geometry: { type: 'Point', coordinates: [139.767125, 35.681236] },
            properties: { name: '東京駅', rank: 1, ratio: 0.1 + 0.2, flag: true, none: null },
            style: { color: '#ff0000', width: 2.5 },
          },
          {
            id: id(A, 2),
            type: 'LineString',
            geometry: {
              type: 'LineString',
              coordinates: [
                [0.1 + 0.2, -0],
                [1e-300, 123456789.123],
                [-180, 90],
              ],
            },
            properties: {
              name: '線',
              nested: { z: 'x', a: [1, 2.5, { b: null, c: -0 }] },
              rank: -(2 ** 60),
              big: 2 ** 53 - 1,
            },
            deleted: true,
          },
          {
            id: id(A, 3),
            type: 'Polygon',
            geometry: {
              type: 'Polygon',
              coordinates: [
                square(0, 0, 10),
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
            id: id(A, 4),
            type: 'MultiPoint',
            geometry: {
              type: 'MultiPoint',
              coordinates: [
                [1.5, 2.5],
                [3.25, 4.125],
              ],
            },
            properties: { name: '東京駅' },
          },
          {
            id: id(A, 5),
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
            id: id(A, 6),
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
                [square(5, 5, 1)],
              ],
            },
            style: { color: '#00ff00' },
          },
          { id: id(B, 7), type: 'Marker', geometry: null, properties: { text: '' } },
          {
            id: id(B, 8),
            type: 'Circle',
            geometry: { type: 'Point', coordinates: [139.7, 35.6] },
            properties: { radius: 100 },
          },
        ] as TabaneRow[]
      ).map(withFill),
    },
  },
  {
    name: 'dimensions',
    description: 'Coordinates of xyzm, a missing z and m as NaN, floats that are not decimal',
    input: {
      parent: '',
      head: 'z',
      dimensions: 'xyzm',
      fills: false,
      rows: [
        {
          id: id(A, 100),
          type: 'LineString',
          geometry: {
            type: 'LineString',
            coordinates: [
              [1, 2, 3, 4],
              [5, 6, 7.5, -0],
              [0.1, 0.2, 0.3, 1e21],
            ],
          },
        },
        { id: id(A, 101), type: 'Point', geometry: { type: 'Point', coordinates: [1, 2] } },
        {
          id: id(A, 102),
          type: 'Polygon',
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [0, 0, 1],
                [1, 0, 1],
                [1, 1, 1],
                [0, 0, 1],
              ],
            ],
          },
        },
      ],
    },
  },
  {
    name: 'revisions',
    description: 'What created the rows and the revisions of their cells, from three origins',
    input: {
      parent: 'L',
      head: 'k',
      dimensions: 'xy',
      fills: false,
      rows: Array.from(
        { length: 6 },
        (_, i): TabaneRow => ({
          id: id(A, 10 + i),
          type: 'Point',
          geometry: { type: 'Point', coordinates: [i, i] },
          properties: i % 2 === 0 ? { name: `n${i}` } : {},
          created: (i < 4 ? [1, A, 1] : [9, B, 3]) as [number, string, number],
          ...(i === 1 && {
            revisions: { 'p.name': [12, B, 4], geometry: [13, '0000000000002', 1] },
          }),
          ...(i === 5 && { revisions: { $place: [20, A, 7] } }),
        }),
      ),
    },
  },
  {
    name: 'flags',
    description:
      'Rows deleted, not shown and locked, alone and together, written as three columns of bits',
    input: {
      parent: 'L',
      head: 'V',
      dimensions: 'xy',
      fills: false,
      rows: Array.from(
        { length: 10 },
        (_, i): TabaneRow => ({
          id: id(A, 50 + i),
          type: 'Point',
          geometry: { type: 'Point', coordinates: [i, -i] },
          ...(i % 4 === 1 && { deleted: true }),
          ...(i % 3 === 0 && { visible: false }),
          ...(i % 5 === 2 && { locked: true }),
          ...(i === 9 && { visible: true, locked: false }),
        }),
      ),
    },
  },
  {
    name: 'values',
    description:
      'Attributes of every kind of value: NaN, the infinities and -0 as floats, and big integers, decimals, bytes, dates, times, date-times of the three zones, durations and references (nested and alone) under the tag other, held as their canonical bytes',
    input: {
      parent: 'L',
      head: 'V',
      dimensions: 'xy',
      rows: [
        {
          id: id(A, 200),
          type: 'Point',
          geometry: { type: 'Point', coordinates: [0, 0] },
          properties: {
            depth: Number.NaN,
            upper: Number.POSITIVE_INFINITY,
            lower: Number.NEGATIVE_INFINITY,
            zero: -0,
            osm: new BigInteger(2n ** 60n),
            area: Decimal.parse('1234.50'),
            raw: new Bytes(new Uint8Array([0, 1, 2, 255])),
            opened: CalendarDate.parse('1998-04-01'),
            opens: TimeOfDay.parse('09:30:00.5'),
            local: DateTime.parse('2026-10-16T09:30:00'),
            utc: DateTime.parse('2026-10-16T00:30:00.123456789Z'),
            tokyo: DateTime.parse('2026-10-16T09:30:00+09:00'),
            span: Duration.parse('P1M2DT3.5S'),
            target: new Reference(id(A, 201)),
            leaders: [{ target: { featureId: new Reference(id(A, 201)) } }],
          },
        },
        {
          id: id(A, 201),
          type: 'Point',
          geometry: { type: 'Point', coordinates: [1, 1] },
          properties: {
            depth: 1.5,
            osm: 7,
            opened: '1998-04-01',
            target: id(A, 200),
          },
        },
      ],
    },
  },
  {
    name: 'blocks',
    description:
      'A run cut into row blocks of 4 rows and into blocks of at most 600 bytes of row blocks, and the manifest of the blocks',
    input: {
      parent: 'L',
      head: 'V',
      dimensions: 'xy',
      targetRows: 4,
      targetBytes: 600,
      rows: Array.from({ length: 22 }, (_, i) =>
        withFill({
          id: id(A, 1000 + i),
          type: 'Polygon',
          geometry: {
            type: 'Polygon',
            coordinates: [square(139.7 + i * 0.001, 35.6 + (i % 5) * 0.001, 0.0005)],
          },
          properties: { fid: `f-${i}`, ...(i % 7 === 0 && { floors: i }) },
        }),
      ),
    },
    manifest: {
      coordinates: { system: 'lnglat', dimensions: 'xy' },
      extra: { small: { records: [{ id: 'L', kind: 'layer' }] } },
    },
  },
];

/** The vector of a scenario */
async function vectorOf(s: Scenario): Promise<Record<string, unknown>> {
  const blocks = writeTabaneBlocks(s.input);
  const out: Record<string, unknown> = {
    description: s.description,
    input: toJson(s.input),
    blocks: await Promise.all(
      blocks.map(async (b) => ({
        name: await tabaneNameOf(b.content),
        rows: b.rows,
        partEnds: b.partEnds,
        content: hex(b.content),
        stored: hex(packTabaneBlock(b)),
        zstd: hex(packTabaneBlock(b, zstd)),
      })),
    ),
  };
  // The rows read back (a position shorter than the dimensions gets NaN for the others)
  out.rows = toJson(
    blocks.flatMap((b) => readTabaneBlock(b.content).flatMap((g) => tabaneRowsOf(g))),
  );
  if (s.manifest) {
    const entries = await Promise.all(blocks.map((b) => tabaneManifestEntryOf(b)));
    const content = writeTabaneManifest({
      coordinates: s.manifest.coordinates,
      partition: { kind: 'order' },
      blocks: entries,
      ...(s.manifest.extra && { extra: s.manifest.extra }),
    });
    out.manifest = {
      coordinates: s.manifest.coordinates,
      ...(s.manifest.extra && { extra: s.manifest.extra }),
      entries: toJson(entries),
      content: hex(content),
      name: await tabaneNameOf(content),
    };
  }
  return out;
}

function withoutZstd(vector: Record<string, unknown>): unknown {
  const v = JSON.parse(JSON.stringify(vector));
  for (const b of v.blocks) delete b.zstd;
  return v;
}

describe('the test vectors', () => {
  it('are what the scenarios give', async () => {
    const files = new Set(readdirSync(DIR).filter((f) => f.endsWith('.json')));
    for (const s of SCENARIOS) {
      const vector = await vectorOf(s);
      const path = join(DIR, `${s.name}.json`);
      if (WRITE) writeFileSync(path, `${JSON.stringify(vector, null, 2)}\n`);
      // The bytes of zstd depend on the version of the compressor: they are read, not compared
      else expect(withoutZstd(JSON.parse(readFileSync(path, 'utf8')))).toEqual(withoutZstd(vector));
      files.delete(`${s.name}.json`);
    }
    expect([...files]).toEqual([]);
  });

  it('read back from every file to the content and the rows of their input', async () => {
    for (const f of readdirSync(DIR).filter((name) => name.endsWith('.json'))) {
      const vector = JSON.parse(readFileSync(join(DIR, f), 'utf8'));
      const input = fromJson(vector.input) as TabaneBlockInput;
      expect(writeTabaneBlocks(input).map((b) => hex(b.content))).toEqual(
        vector.blocks.map((b: { content: string }) => b.content),
      );
      const rows: TabaneRow[] = [];
      for (const b of vector.blocks) {
        const content = Buffer.from(b.content, 'hex');
        expect(await tabaneNameOf(content)).toBe(b.name);
        for (const file of [b.stored, b.zstd]) {
          expect(hex(unpackTabaneFile(Buffer.from(file, 'hex'), zstd))).toBe(b.content);
        }
        for (const g of readTabaneBlock(content)) rows.push(...tabaneRowsOf(g));
      }
      expect(toJson(rows)).toEqual(vector.rows);
      // The rows read back are the rows of the input, but for the values the dimensions add
      expect(rows.length).toBe(input.rows.length);
      rows.forEach((row, i) => {
        expect(row.id).toBe(input.rows[i].id);
        expect(toJson(row.properties)).toEqual(toJson(input.rows[i].properties ?? {}));
      });
      if (vector.manifest) {
        const content = Buffer.from(vector.manifest.content, 'hex');
        expect(await tabaneNameOf(content)).toBe(vector.manifest.name);
        expect(toJson(readTabaneManifest(content).blocks)).toEqual(vector.manifest.entries);
      }
    }
  });
});
