// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The packing of the rows held as columns writes, for each row, exactly what the retained
 * batches of the Store write for its feature (the same values of every instance, coordinate and
 * vertex, in the same order), and the number of the row after them
 */

import type { RowTable } from '@sakuzu/kasane/engine';
import { ValueStringCache } from '@sakuzu/tabane';
import { describe, expect, it } from 'vitest';
import type { FeatureTablesInternals } from '../../feature-table/feature-tables.js';
import { drawPropertyKey } from '../../shared/properties.js';
import type { Feature, Layer } from '../../shared/types/model.js';
import { createTestDrawer, feature, tablesOfFeatures } from '../../test-utils.js';
import { GpuLedger } from '../gpu-ledger.js';
import { buildLineBatchArrays, ROW_LINE_STRIDE } from '../renderers/line/line-geometry.js';
import { buildPointInstanceData, ROW_POINT_STRIDE } from '../renderers/point/point-instance.js';
import { ROW_POLYGON_STRIDE, SDFPolygonRenderer } from '../renderers/polygon/sdf-polygon.js';
import { TerrainContext } from '../terrain/context.js';
import { collectLineItems, collectPoints, collectPolygons } from './store-retained-collect.js';
import {
  createLineRowArrays,
  linePartsOf,
  planPolygonRow,
  pointInstancesOf,
  type RowPackContext,
  RowStyleSlots,
  writeLineRow,
  writePointRow,
  writePolygonRow,
} from './table-collect.js';

const ORIGIN: [number, number] = [139.5, 35.5];
const RATIO = 2;
const CREATED = { [drawPropertyKey('createdZoom')]: 12 };

const LAYER: Layer = {
  id: 'layer',
  name: 'layer',
  visible: true,
  locked: false,
  opacity: 1,
  items: [],
  styleRule: { kind: 'categorical', property: 'kind', map: { a: '#336699' }, other: '#996633' },
  metadata: undefined,
};

function setup(features: Feature[]): {
  internals: FeatureTablesInternals;
  table: RowTable;
  context: RowPackContext;
} {
  const { internals, table } = tablesOfFeatures('layer', features);
  return {
    internals,
    table,
    context: {
      slots: new RowStyleSlots(createTestDrawer(), internals.styles, LAYER.styleRule),
      strings: new ValueStringCache(),
      pixelRatio: RATIO,
      terrain: new TerrainContext(),
    },
  };
}

/** The values of every instance without the number of the row */
function withoutRow(data: Float32Array, stride: number, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < stride - 1; k++) out.push(data[i * stride + k]);
  }
  return out;
}

/**
 * The triangles of an index array, each turned to start at its smallest index (the winding kept)
 * and sorted
 */
function trianglesOf(indices: ArrayLike<number>): string[] {
  const out: string[] = [];
  for (let i = 0; i < indices.length; i += 3) {
    const t = [indices[i], indices[i + 1], indices[i + 2]];
    const k = t.indexOf(Math.min(...t));
    out.push([t[k], t[(k + 1) % 3], t[(k + 2) % 3]].join(','));
  }
  return out.sort();
}

/** The number of the row of every instance */
function rowsOf(data: Float32Array, stride: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => data[i * stride + stride - 1]);
}

describe('the packing of the points of the rows', () => {
  it('writes the instances the batches of the Store write, with the number of the row', () => {
    const features = [
      feature('a', 'Point', [139.7, 35.6], { properties: { kind: 'a' } }),
      feature('b', 'Point', [139.71, 35.61], {
        style: { pointColor: '#ff0000', pointRadius: 9, pointShape: 'star' },
      }),
      feature('c', 'MultiPoint', [
        [139.72, 35.62],
        [139.73, 35.63],
      ]),
    ];
    const { table, context } = setup(features);
    const group = table.groupAt(0);
    const count = features.reduce((n, _, row) => n + pointInstancesOf(group, row), 0);
    expect(count).toBe(4);
    const data = new Float32Array(count * ROW_POINT_STRIDE);
    let at = 0;
    for (let row = 0; row < features.length; row++) {
      at += writePointRow(group, row, data, at, ORIGIN, context);
    }

    const store = buildPointInstanceData(
      collectPoints(features, createTestDrawer(), LAYER),
      ORIGIN,
      RATIO,
      new TerrainContext(),
    );
    expect(withoutRow(data, ROW_POINT_STRIDE, count)).toEqual(Array.from(store));
    expect(rowsOf(data, ROW_POINT_STRIDE, count)).toEqual([0, 1, 2, 2]);
  });
});

describe('the packing of the lines of the rows', () => {
  it('writes the coordinates and the instances the batches of the Store write', () => {
    const features = [
      feature(
        'a',
        'LineString',
        [
          [139.7, 35.6],
          [139.71, 35.62],
          [139.72, 35.6],
        ],
        { properties: { ...CREATED, kind: 'a' } },
      ),
      feature(
        'b',
        'MultiLineString',
        [
          [
            [139.8, 35.7],
            [139.81, 35.71],
          ],
          // A part of one coordinate draws nothing
          [[139.9, 35.9]],
          [
            [139.82, 35.7],
            [139.83, 35.72],
            [139.84, 35.7],
          ],
        ],
        { style: { strokeColor: '#00ff00', strokeOpacity: 0.5, strokeWidth: 4 } },
      ),
      feature('c', 'Freehand', [
        [139.6, 35.5],
        [139.61, 35.51],
      ]),
    ];
    const { table, context } = setup(features);
    const group = table.groupAt(0);
    const parts: number[] = [];
    let coords = 0;
    let instances = 0;
    for (let row = 0; row < features.length; row++) {
      parts.length = 0;
      linePartsOf(group, row, parts);
      for (let k = 0; k < parts.length; k += 2) {
        coords += parts[k + 1] - parts[k];
        instances += parts[k + 1] - parts[k] - 1;
      }
    }
    const arrays = createLineRowArrays(coords, instances);
    const perRow = features.map((_, row) =>
      writeLineRow(group, row, arrays, ORIGIN, context, parts),
    );
    expect(perRow).toEqual([2, 3, 1]);

    const store = buildLineBatchArrays(
      collectLineItems(features, createTestDrawer(), LAYER),
      0,
      ORIGIN,
      RATIO,
    );
    if (!store) throw new Error('store arrays');
    expect(arrays.texSize).toBe(store.texSize);
    expect(Array.from(arrays.texData)).toEqual(Array.from(store.texData));
    expect(withoutRow(arrays.instanceData, ROW_LINE_STRIDE, arrays.instanceCount)).toEqual(
      Array.from(store.instanceData),
    );
    expect(arrays.maxSegmentMeters).toBe(store.maxSegmentMeters);
    expect(rowsOf(arrays.instanceData, ROW_LINE_STRIDE, arrays.instanceCount)).toEqual([
      0, 0, 1, 1, 1, 2,
    ]);
  });
});

/** The vertex and the index data an SDF polygon renderer builds for a batch, on a GL that keeps them */
function storePolygonArrays(polygons: ReturnType<typeof collectPolygons>): {
  vertices: Float32Array;
  indices: Uint32Array;
} {
  const uploads: ArrayBufferView[] = [];
  const gl = new Proxy({} as Record<string, unknown>, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      if (prop === 'bufferData') {
        return (_target: number, data: ArrayBufferView) => {
          uploads.push(data);
        };
      }
      if (prop.startsWith('create')) return () => ({});
      if (prop === 'getShaderParameter' || prop === 'getProgramParameter') return () => true;
      if (prop === 'getUniformLocation') return () => null;
      if (prop === 'drawingBufferWidth' || prop === 'drawingBufferHeight') return 100;
      if (/^[A-Z_0-9]+$/.test(prop)) return 1;
      return () => undefined;
    },
  }) as unknown as WebGL2RenderingContext;
  const renderer = new SDFPolygonRenderer(gl, { gpu: new GpuLedger() }, RATIO);
  renderer.ensureShader({ vertexShaderPrelude: '', define: '', variantName: 'mercator' });
  renderer.buildRetained(polygons, { origin: ORIGIN });
  return { vertices: uploads[0] as Float32Array, indices: uploads[1] as Uint32Array };
}

describe('the packing of the polygons of the rows', () => {
  it('writes the vertices and the indices the batches of the Store write, fill then outline', () => {
    const ring = [
      [139.7, 35.6],
      [139.72, 35.6],
      [139.72, 35.62],
      [139.7, 35.62],
      [139.7, 35.6],
    ];
    const hole = [
      [139.705, 35.605],
      [139.71, 35.605],
      [139.71, 35.61],
      [139.705, 35.605],
    ];
    const features = [
      feature('a', 'Polygon', [ring, hole], { properties: { kind: 'a' } }),
      feature('b', 'MultiPolygon', [[ring], [ring.map(([x, y]) => [x + 0.1, y])]], {
        properties: CREATED,
        style: { fillColor: '#ff00ff', fillOpacity: 0.4, strokeWidth: 3 },
      }),
      feature('c', 'Polygon', [ring], { style: { strokeOpacity: 0 } }),
      // A transparent outline is still drawn (its opacity is in its color), as in the Store
      feature('d', 'Polygon', [ring], { style: { strokeOpacity: 0, fillOpacity: 0 } }),
      // Neither a fill nor an outline: nothing is drawn
      feature('f', 'Polygon', [ring], { style: { strokeWidth: 0, fillOpacity: 0 } }),
      feature('e', 'Circle', [139.75, 35.65], {
        properties: { [drawPropertyKey('radiusMeters')]: 200 },
      }),
    ];
    const { table, context } = setup(features);
    const group = table.groupAt(0);
    const plans = features.map((_, row) => planPolygonRow(group, row, context));
    expect(plans[4]).toBeNull();
    const vertexCount = plans.reduce((n, plan) => n + (plan?.vertexCount ?? 0), 0);
    const indexCount = plans.reduce((n, plan) => n + (plan?.indexCount ?? 0), 0);
    const vertices = new Float32Array(vertexCount * ROW_POLYGON_STRIDE);
    const indices = new Uint32Array(indexCount);
    let v = 0;
    let i = 0;
    plans.forEach((plan, row) => {
      if (!plan) return;
      writePolygonRow(plan, row, vertices, v, indices, i, v, ORIGIN, RATIO);
      v += plan.vertexCount;
      i += plan.indexCount;
    });

    const store = storePolygonArrays(collectPolygons(features, createTestDrawer(), LAYER));
    expect(withoutRow(vertices, ROW_POLYGON_STRIDE, vertexCount)).toEqual(
      Array.from(store.vertices),
    );
    // The same triangles with the same windings: the fills are taken from the pairs of their
    // triangulation, so their triangles come in the order of the pairs
    expect(indices.length).toBe(store.indices.length);
    expect(trianglesOf(indices)).toEqual(trianglesOf(store.indices));
    // The rows of the vertices, in the order of the rows
    const rows = rowsOf(vertices, ROW_POLYGON_STRIDE, vertexCount);
    expect([...new Set(rows)]).toEqual([0, 1, 2, 3, 5]);
  });
});
