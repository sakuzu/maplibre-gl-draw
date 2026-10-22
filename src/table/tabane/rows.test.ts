// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="node" />

/**
 * A row block of the Tabane format read as a row block of the tables: the same columns the
 * builder of the blocks of rows makes from the same rows, and the tables take it as it is
 */

import {
  formatTabaneId,
  readBlockData,
  readValue,
  type TabaneRow,
  tabaneRowSuffixOf,
  utf8String,
  writeTabaneBlock,
} from '@sakuzu/tabane';
import type { Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import type { FeatureTables } from '../../api/tables.js';
import { featureTablesInternals } from '../../feature-table/feature-tables.js';
import { createTableStore } from '../../store/table-memory.js';
import { seededRandom } from '../../test-utils.js';
import { createRowBlockDataBuilder } from '../row-group-builder.js';
import type { RowBlockData } from '../row-group-types.js';
import { rowBlockDataOfTabane } from './rows.js';

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
    const flagged = buildings(50, 6).map((r, i) => ({
      ...r,
      ...(i % 3 === 0 && { visible: false }),
      ...(i % 4 === 0 && { locked: true }),
    }));
    // Circles only: fills written that hold no triangle, and the rings of the circles
    const circles = buildings(3, 9).map((r, i) => ({
      ...r,
      type: 'Circle',
      geometry: { type: 'Point' as const, coordinates: [i, i] },
      properties: { 'maplibre-gl-draw:radiusMeters': 25 + i },
    }));
    for (const rows of [buildings(1000, 3), variety(), flagged, circles]) {
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
            visible: row.visible,
            locked: row.locked,
          });
        });
        const [built] = builder.finish();
        expectSameBlock(rowBlockDataOfTabane(rowBlock), built);
      }
    }
  });

  it('is taken by the tables as it is, and read back as features', () => {
    const rows = buildings(1500, 5).map((r, i) => ({
      ...r,
      ...(i === 999 && { visible: false }),
      ...(i === 1000 && { locked: true }),
    }));
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
      expect(feature?.visible).toBe(rows[k].visible ?? true);
      expect(feature?.locked).toBe(rows[k].locked ?? false);
    }
  });
});
