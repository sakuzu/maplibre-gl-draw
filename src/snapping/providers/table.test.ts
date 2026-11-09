// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The snapping to the rows held as columns
 *
 * - The vertices and the edges of the rows, read on their columns, are the candidates the Store
 *   providers give for the same features (the vertex references, the closing vertex of a ring,
 *   the parts of a `Multi`), with the same exclusions (the features excluded, the vertex being
 *   dragged and the edges touching it)
 * - The rows held as features are left out (the Store providers give them), and so are the
 *   hidden rows
 * - The intersections are made between rows, and between a row and a feature of the Store
 */

import { describe, expect, it } from 'vitest';
import type { BBox } from '../../geometry/types.js';
import { RenderedShapes } from '../../sketches/rendered-shapes.js';
import { MemoryStore } from '../../store/memory.js';
import { StoreSpatialIndex } from '../../store/spatial/store-spatial-index.js';
import type { Store } from '../../store/store.js';
import { createTableStore } from '../../store/table-memory.js';
import type { Feature } from '../../store/types.js';
import { seededRandom } from '../../test-utils.js';
import { createSnapTargetsRegistry } from '../custom-targets.js';
import type { SnapCandidate, SnapProviderContext } from '../types.js';
import { createStoreIntersectionSnapProvider } from './intersection.js';
import { createStoreEdgeSnapProvider, createStoreVertexSnapProvider } from './store.js';
import { createTableEdgeSnapProvider, createTableVertexSnapProvider } from './table.js';

const LAYER = {
  id: 'l',
  name: 'l',
  visible: true,
  locked: false,
  opacity: 1,
  items: [],
  styleRule: undefined,
  metadata: undefined,
};

function context(overrides: Partial<SnapProviderContext> = {}): SnapProviderContext {
  return {
    zoom: 10,
    modifiers: { shift: false, ctrl: false, alt: false, meta: false },
    lngLat: { lng: 0, lat: 0 },
    point: { x: 0, y: 0 },
    tolerancePx: 10,
    toleranceLngDeg: 1,
    toleranceLatDeg: 1,
    ...overrides,
  };
}

/** A ring around a center (closed) */
function ring(x: number, y: number, r: number, n: number): number[][] {
  const out = Array.from({ length: n }, (_, k) => {
    const a = (k / n) * Math.PI * 2;
    return [x + Math.cos(a) * r, y + Math.sin(a) * r];
  });
  out.push(out[0]);
  return out;
}

/** Features of the built-in types at random, around the origin */
function randomFeatures(seed: number, count: number): Feature[] {
  const random = seededRandom(seed);
  const at = () => random() * 2 - 1;
  const out: Feature[] = [];
  for (let i = 0; i < count; i++) {
    const x = at();
    const y = at();
    const base = {
      id: `f${i}`,
      layerId: 'l',
      groupId: undefined,
      properties: {},
      style: {},
      visible: true,
      locked: false,
    };
    const kind = i % 7;
    const geometry =
      kind === 0
        ? { type: 'Point', coordinates: [x, y] }
        : kind === 1
          ? {
              type: 'MultiPoint',
              coordinates: [
                [x, y],
                [x + 0.1, y],
              ],
            }
          : kind === 2
            ? {
                type: 'LineString',
                coordinates: [
                  [x, y],
                  [x + 0.3, y + 0.2],
                  [x, y],
                ],
              }
            : kind === 3
              ? { type: 'Polygon', coordinates: [ring(x, y, 0.3, 5), ring(x, y, 0.1, 4).reverse()] }
              : kind === 4
                ? {
                    type: 'MultiLineString',
                    coordinates: [
                      [
                        [x, y],
                        [x + 0.2, y],
                      ],
                      [
                        [x, y + 0.1],
                        [x + 0.2, y + 0.3],
                      ],
                    ],
                  }
                : kind === 5
                  ? {
                      type: 'MultiPolygon',
                      coordinates: [[ring(x, y, 0.2, 3)], [ring(x + 0.5, y, 0.2, 6)]],
                    }
                  : {
                      type: 'LineString',
                      coordinates: [
                        [x, y],
                        [x + 0.1, y + 0.1],
                      ],
                    };
    out.push({ ...base, type: geometry.type, geometry } as Feature);
  }
  return out;
}

/** The candidates in a comparable order */
function sorted(candidates: SnapCandidate[]): string[] {
  return candidates.map((c) => JSON.stringify(c)).sort();
}

/** A Store of objects and a Store of rows with the same features */
function stores(features: Feature[]) {
  const objects = new MemoryStore();
  objects.createLayer(LAYER);
  for (const feature of features) objects.createFeature(feature);
  const rows = createTableStore().store;
  rows.createLayer(LAYER);
  for (const feature of features) rows.createFeature(feature);
  const snapTargets = createSnapTargetsRegistry();
  const deps = (store: Store) => ({
    store,
    shapes: new RenderedShapes(store),
    spatialIndex: new StoreSpatialIndex(store),
    snapTargets,
  });
  return { objects: deps(objects), rows: deps(rows) };
}

describe('the snapping to the rows held as columns', () => {
  it('gives the candidates the Store gives for the same features', () => {
    const features = randomFeatures(11, 70);
    const { objects, rows } = stores(features);
    const random = seededRandom(5);
    for (let k = 0; k < 30; k++) {
      const x = random() * 2 - 1;
      const y = random() * 2 - 1;
      const bbox: BBox = [x - 0.3, y - 0.3, x + 0.3, y + 0.3];
      const target = features[Math.floor(random() * features.length)];
      const ctx = context({
        excludeFeatureId: k % 3 === 0 ? target.id : undefined,
        excludeParts:
          k % 3 === 1
            ? {
                featureId: target.id,
                vertices: [{ ring: 0, index: 1 }],
                edges: [
                  { ring: 0, index: 0 },
                  { ring: 0, index: 1 },
                ],
              }
            : undefined,
      });
      const vertices = (deps: typeof objects, table: boolean) =>
        (table
          ? createTableVertexSnapProvider(deps)
          : createStoreVertexSnapProvider(deps)
        ).candidates(bbox, ctx);
      const edges = (deps: typeof objects, table: boolean) =>
        (table ? createTableEdgeSnapProvider(deps) : createStoreEdgeSnapProvider(deps)).candidates(
          bbox,
          ctx,
        );
      // A Store of rows holds none of them: the rows give them all
      expect(vertices(rows, false)).toEqual([]);
      expect(sorted(vertices(rows, true))).toEqual(sorted(vertices(objects, false)));
      expect(sorted(edges(rows, true))).toEqual(sorted(edges(objects, false)));
      const intersections = (deps: typeof objects) =>
        createStoreIntersectionSnapProvider(deps).candidates(bbox, ctx);
      // The same points, but for the rounding of the order the edges are met in (the Store
      // meets them in the order of its index)
      const points = (deps: typeof objects) =>
        intersections(deps).map((c) => ('coordinate' in c ? c.coordinate : [0, 0]));
      const near = (p: number[], list: number[][]) =>
        list.some((q) => Math.abs(p[0] - q[0]) < 1e-12 && Math.abs(p[1] - q[1]) < 1e-12);
      const a = points(rows);
      const b = points(objects);
      expect(a.every((p) => near(p, b))).toBe(true);
      expect(b.every((p) => near(p, a))).toBe(true);
    }
  });

  it('takes the rows selected as any row, and leaves out the hidden rows', () => {
    const features = randomFeatures(3, 14);
    const { rows } = stores(features);
    const bbox: BBox = [-2, -2, 2, 2];
    const ids = () =>
      new Set(
        createTableVertexSnapProvider(rows)
          .candidates(bbox, context())
          .map((c) => c.featureId),
      );
    expect(ids().has('f0')).toBe(true);
    rows.store.setSelection('feature', ['f0']);
    expect(ids().has('f0')).toBe(true);
    // The Store gives no feature of its rows
    expect(
      createStoreVertexSnapProvider(rows)
        .candidates(bbox, context())
        .some((c) => c.featureId === 'f0'),
    ).toBe(false);
    rows.store.setLocallyHidden('f2', true);
    expect(ids().has('f2')).toBe(false);
    rows.store.updateFeature('f3', { visible: false });
    expect(ids().has('f3')).toBe(false);
  });

  it('makes the intersections of a row and a feature of the Store', () => {
    const cross: Feature[] = [
      {
        id: 'a',
        type: 'LineString',
        geometry: {
          type: 'LineString',
          coordinates: [
            [-1, 0],
            [1, 0],
          ],
        },
        layerId: 'l',
        groupId: undefined,
        properties: {},
        style: {},
        visible: true,
        locked: false,
      },
      {
        id: 'b',
        type: 'LineString',
        geometry: {
          type: 'LineString',
          coordinates: [
            [0, -1],
            [0, 1],
          ],
        },
        layerId: 'l',
        groupId: undefined,
        properties: {},
        style: {},
        visible: true,
        locked: false,
      },
    ];
    const { rows } = stores(cross);
    const bbox: BBox = [-0.5, -0.5, 0.5, 0.5];
    const points = () =>
      createStoreIntersectionSnapProvider(rows)
        .candidates(bbox, context())
        .map((c) => ('coordinate' in c ? c.coordinate : null));
    expect(points()).toEqual([[0, 0]]);
    rows.store.setSelection('feature', ['a']);
    expect(points()).toEqual([[0, 0]]);
  });
});
