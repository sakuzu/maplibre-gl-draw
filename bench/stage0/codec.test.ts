// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The blocks of the trial of opening in steps read back to every value: segments made in the test
 * (every kind of value and geometry, coordinates that are not decimal), and the first 20,000
 * features of the files of `bench/data/` when they are there (compressed by Node, decompressed by
 * fzstd as the page does)
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants, zstdCompressSync } from 'node:zlib';
import { decompress } from 'fzstd';
import type { Geometry } from 'geojson';
import { describe, expect, it } from 'vitest';
import {
  ByteReader,
  ByteWriter,
  decodeSegment,
  encodeSegment,
  packFile,
  type SegmentRows,
  sameValue,
  unpackFile,
  XorReader,
  XorWriter,
} from './codec.ts';
import { decodeFile } from './decode-work.ts';
import { clientText, idText, rowInputsOf, rowKey } from './rows.ts';

const A = '0123456789abcdef';
const B = 'fedcba9876543210';

function segmentOf(
  geometries: (Geometry | null)[],
  properties: Record<string, unknown>[],
): SegmentRows {
  return {
    ids: geometries.map((_, i) => ({
      client: i < 3 ? A : B,
      serial: i < 3 ? 10 + i : 100 + i * 2,
    })),
    place: { layer: 'layer-1', head: 'a0V', firstRow: 5 },
    sources: geometries.map((_, i) => ({ client: i % 2 === 0 ? A : B, batch: 1 + (i >> 2) })),
    deleted: geometries.map((_, i) => i === 2),
    geometries,
    properties,
    styles: geometries.map((_, i) => (i === 1 ? { fillColor: '#f00' } : { fillColor: '#00f' })),
  };
}

function expectRoundTrip(rows: SegmentRows): void {
  const back = decodeSegment(encodeSegment(rows).bytes);
  expect(back.ids).toEqual(rows.ids);
  expect(back.place).toEqual(rows.place);
  expect(back.sources).toEqual(rows.sources);
  expect(back.deleted).toEqual(rows.deleted);
  rows.geometries.forEach((g, i) => {
    expect(sameValue(back.geometries[i], g), `geometry ${i}`).toBe(true);
  });
  rows.properties.forEach((p, i) => {
    expect(sameValue(back.properties[i], p), `attributes ${i}`).toBe(true);
  });
  rows.styles.forEach((s, i) => {
    expect(sameValue(back.styles[i], s), `style ${i}`).toBe(true);
  });
}

describe('bytes', () => {
  it('reads back varints up to 2^53', () => {
    const values = [0, 1, 127, 128, 300, 2 ** 31, 2 ** 32 + 5, 2 ** 52, 2 ** 53 - 1];
    const signed = [0, -1, 1, -64, 64, -(2 ** 40), 2 ** 50, -(2 ** 51)];
    const w = new ByteWriter();
    for (const v of values) w.uvarint(v);
    for (const v of signed) w.svarint(v);
    const r = new ByteReader(w.finish());
    expect(values.map(() => r.uvarint())).toEqual(values);
    expect(signed.map(() => r.svarint())).toEqual(signed);
    expect(r.done).toBe(true);
  });

  it('reads back floats written by XOR to their bits', () => {
    const values = [
      0,
      -0,
      1,
      1,
      0.1 + 0.2,
      Math.PI,
      -Math.E,
      139.652211848,
      139.65221185,
      Number.MIN_VALUE,
      Number.MAX_VALUE,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      2 ** -1074,
      123456789.123,
    ];
    for (let i = 0; i < 200; i++) values.push((Math.random() - 0.5) * 10 ** ((i % 20) - 5));
    const w = new XorWriter();
    for (const v of values) w.put(v);
    const r = new XorReader(w.bytes());
    for (const v of values) expect(Object.is(r.get(), v)).toBe(true);
  });
});

describe('segments', () => {
  it('read back every kind of value and geometry', () => {
    const geometries: (Geometry | null)[] = [
      { type: 'Point', coordinates: [139.7, 35.68] },
      {
        type: 'LineString',
        coordinates: [
          [139.70000001, 35.6],
          [139.7 + 1e-12, 35.6 + Math.PI * 1e-9],
        ],
      },
      null,
      {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [-0, 0],
          ],
        ],
      },
      {
        type: 'MultiPolygon',
        coordinates: [
          [
            [
              [10, 10],
              [11, 10],
              [11, 11],
              [10, 10],
            ],
          ],
          [
            [
              [20.5, 20.25],
              [21, 20],
              [21, 21],
              [20.5, 20.25],
            ],
            [
              [20.6, 20.4],
              [20.7, 20.4],
              [20.7, 20.5],
              [20.6, 20.4],
            ],
          ],
        ],
      },
      // Positions of another length than the first: written as a nested value
      {
        type: 'LineString',
        coordinates: [
          [1, 2, 3],
          [4, 5, 6],
        ],
      },
      {
        type: 'GeometryCollection',
        geometries: [{ type: 'Point', coordinates: [1, 2] }],
      },
      {
        type: 'MultiPoint',
        coordinates: [
          [1, 2],
          [3, 4],
        ],
      },
      {
        type: 'MultiLineString',
        coordinates: [
          [
            [1, 2],
            [3, 4],
          ],
          [
            [5, 6],
            [7, 8],
          ],
        ],
      },
    ];
    const properties: Record<string, unknown>[] = [
      { name: 'あいう', height: 12.5, floors: 3, ok: true, none: null },
      { name: 'あいうえ', height: -0, floors: 2 ** 52, ok: false, list: [1, 'two', null] },
      {},
      { name: '😀 emoji', floors: -7, nested: { a: { b: [1.5, -0, 2 ** 60] } } },
      { name: '😀 emoji', nested: { a: { b: [1.5, -0, 2 ** 60] } }, extra: 'x' },
      { name: 'a\u0000b', height: Number.MAX_VALUE },
      { floors: 0 },
      { name: '' },
      { list: [] },
    ];
    expectRoundTrip(segmentOf(geometries, properties));
  });

  it('read back the coordinates of three dimensions as columns', () => {
    const geometries: Geometry[] = [
      { type: 'Point', coordinates: [139.7, 35.68, 12.5] },
      {
        type: 'LineString',
        coordinates: [
          [1, 2, 3],
          [4.25, 5, -6],
        ],
      },
      { type: 'Point', coordinates: [0.1 + 0.2, 1, 2] },
    ];
    expectRoundTrip(segmentOf(geometries, [{}, {}, {}]));
  });

  it('pack and unpack files of segments', () => {
    const segments = [
      { rows: 3, bytes: Uint8Array.of(1, 2, 3) },
      { rows: 1000, bytes: new Uint8Array(500).fill(7) },
    ];
    const back = unpackFile(packFile(segments));
    expect(back.map((s) => s.rows)).toEqual([3, 1000]);
    expect(back.map((s) => [...s.bytes])).toEqual(segments.map((s) => [...s.bytes]));
  });
});

describe('rows for the builder', () => {
  it('make ids of the client in base 32 and keys in the order of the rows', () => {
    expect(clientText('0000000000000000')).toBe('0000000000000');
    expect(clientText('ffffffffffffffff')).toBe('fzzzzzzzzzzzz');
    expect(idText({ client: A, serial: 42 })).toBe(`${clientText(A)}-42`);
    const keys = [0, 1, 9, 10, 999, 1000, 123456].map((r) => rowKey('a0', r));
    expect([...keys].sort()).toEqual(keys);
  });

  it('decode a file into blocks of every row, deleted ones flagged', () => {
    const geometries: Geometry[] = Array.from({ length: 2500 }, (_, i) => ({
      type: 'Point',
      coordinates: [139 + i * 1e-4, 35 + i * 1e-4],
    }));
    const rows = segmentOf(
      geometries,
      geometries.map((_, i) => ({ n: i })),
    );
    const segment = encodeSegment({ ...rows, deleted: rows.deleted.map(() => false) }).bytes;
    const file = packFile([{ rows: 2500, bytes: new Uint8Array(zstdCompressSync(segment)) }]);
    const decoded = decodeFile(file);
    expect(decoded.rows).toBe(2500);
    expect(decoded.blocks.reduce((s, b) => s + b.length, 0)).toBe(2500);
    const inputs = rowInputsOf(decodeSegment(segment));
    expect(inputs[0].order).toBe(rowKey('a0V', 5));
    expect(inputs[2499].id).toBe(idText({ client: B, serial: 100 + 2499 * 2 }));
  });
});

const DATA = join(import.meta.dirname, '..', 'data');
/** The features of each file checked (the tests hold at most 20,000) */
const CHECKED = 20_000;

describe.each([
  'fgd-buildings-tokyo-100k',
  'overture-buildings-tokyo-attrs',
  'fgd-roadedges-tokyo-100k',
])('the features of %s', (name) => {
  const path = join(DATA, `${name}.ndjson`);
  it.skipIf(!existsSync(path))('read back from segments compressed by Node, by fzstd', () => {
    const text = readFileSync(path, 'utf8');
    const lines: string[] = [];
    let at = 0;
    while (lines.length < CHECKED && at < text.length) {
      const end = text.indexOf('\n', at);
      const line = text.slice(at, end < 0 ? text.length : end);
      if (line.trim()) lines.push(line);
      at = end < 0 ? text.length : end + 1;
    }
    const features = lines.map(
      (l) => JSON.parse(l) as { id: unknown; geometry: Geometry; properties: object },
    );
    for (let s = 0; s < features.length; s += 1000) {
      const part = features.slice(s, s + 1000);
      const rows: SegmentRows = {
        ids: part.map((_, i) => ({ client: A, serial: 2 + s + i })),
        place: { layer: 'l', head: 'a0', firstRow: s },
        sources: part.map(() => ({ client: A, batch: 1 })),
        deleted: part.map(() => false),
        geometries: part.map((f) => f.geometry),
        properties: part.map((f) => ({ ...f.properties, source_id: f.id })),
        styles: part.map(() => ({ fillColor: '#123456' })),
      };
      const packed = zstdCompressSync(encodeSegment(rows).bytes, {
        params: { [constants.ZSTD_c_compressionLevel]: 3 },
      });
      const back = decodeSegment(decompress(new Uint8Array(packed)));
      for (let i = 0; i < part.length; i++) {
        if (!sameValue(back.geometries[i], rows.geometries[i])) {
          throw new Error(`the geometry of ${s + i}`);
        }
        if (!sameValue(back.properties[i], rows.properties[i])) {
          throw new Error(`the attributes of ${s + i}`);
        }
      }
      expect(back.ids).toEqual(rows.ids);
    }
  });
});
