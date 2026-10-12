// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The classification of the rows held as columns and their GPU chunks
 *
 * - `classifyRow` gives every row the kind `classifyFeature` gives its feature, whatever the
 *   type, the style, the style rule of the layer, the custom types and the companions (the two
 *   must stay one to one, or the order breaks)
 * - A chunk ends where the kind changes and where it would hold too many coordinates, and only
 *   between two rows
 */

import { describe, expect, it } from 'vitest';
import { rowFeature } from '../../feature-table/row-read.js';
import { drawPropertyKey } from '../../shared/properties.js';
import type { Feature, Layer } from '../../shared/types/model.js';
import { createTestDrawer, feature, tablesOfFeatures } from '../../test-utils.js';
import {
  createFeatureCompanionRegistry,
  type FeatureCompanionProvider,
} from '../feature-companion.js';
import type { RetainedStyleResolver } from '../renderers/retained.js';
import { classifyFeature } from './store-retained-classify.js';
import { RowStyleSlots } from './table-collect.js';
import { classifyRow, partitionRowGroup } from './table-partition.js';

const square = [
  [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
    [0, 0],
  ],
];

/** Features of every type and of the styles that decide the kind of their run */
function variety(): Feature[] {
  const radius = { [drawPropertyKey('radiusMeters')]: 100 };
  return [
    feature('p', 'Point', [0, 0]),
    feature('p-square', 'Point', [0, 0], { style: { pointShape: 'square' } }),
    feature('p-star', 'Point', [0, 0], { style: { pointShape: 'star' } }),
    feature('mp', 'MultiPoint', [
      [0, 0],
      [1, 1],
    ]),
    feature('l', 'LineString', [
      [0, 0],
      [1, 1],
    ]),
    feature(
      'l-dash',
      'LineString',
      [
        [0, 0],
        [1, 1],
      ],
      { style: { lineStyle: 'dashed' } },
    ),
    feature('fh', 'Freehand', [
      [0, 0],
      [1, 1],
    ]),
    feature('ml', 'MultiLineString', [
      [
        [0, 0],
        [1, 1],
      ],
    ]),
    feature('g', 'Polygon', square),
    feature('g-dash', 'Polygon', square, { style: { lineStyle: 'dotted' } }),
    feature('g-dash-hidden', 'Polygon', square, {
      style: { lineStyle: 'dashed', strokeOpacity: 0 },
    }),
    feature('g-fill-only', 'Polygon', square, { style: { strokeOpacity: 0 } }),
    feature('mg', 'MultiPolygon', [square]),
    feature('c', 'Circle', [0, 0], { properties: radius }),
    feature('c-dash', 'Circle', [0, 0], { properties: radius, style: { lineStyle: 'dashed' } }),
    feature('img', 'Image', [0, 0]),
    feature('custom', 'Marker', [0, 0]),
    feature('kind-a', 'Point', [0, 0], { properties: { kind: 'a' } }),
    feature(
      'kind-b',
      'LineString',
      [
        [0, 0],
        [1, 1],
      ],
      { properties: { kind: 'b' } },
    ),
  ];
}

/** The kinds the rows of the features get, and the kinds the features get */
function kinds(
  features: Feature[],
  options: {
    layer?: Layer;
    customTypes?: Map<string, unknown>;
    companions?: ReturnType<typeof createFeatureCompanionRegistry>;
    resolver?: RetainedStyleResolver;
  } = {},
): { rows: Array<string | null>; features: string[] } {
  const resolver = options.resolver ?? createTestDrawer();
  const customTypes = options.customTypes ?? new Map();
  const companions = options.companions ?? createFeatureCompanionRegistry();
  const { internals, table } = tablesOfFeatures('layer', features);
  const group = table.groupAt(0);
  const slots = new RowStyleSlots(resolver, internals.styles, options.layer?.styleRule);
  const context = {
    slots,
    customTypes,
    companions,
    featureOf: (g: typeof group, row: number) => rowFeature(internals.readContext, 'layer', g, row),
    layer: options.layer,
  };
  return {
    rows: features.map((_, row) => classifyRow(group, row, context)),
    features: features.map((f) =>
      classifyFeature(f, resolver, customTypes, companions, options.layer),
    ),
  };
}

const LAYER: Layer = {
  id: 'layer',
  name: 'layer',
  visible: true,
  locked: false,
  opacity: 1,
  items: [],
  styleRule: undefined,
  metadata: undefined,
};

describe('classifyRow', () => {
  it('gives every row the kind classifyFeature gives its feature', () => {
    const result = kinds(variety());
    expect(result.rows).toEqual(result.features);
    expect(new Set(result.rows)).toEqual(new Set(['point', 'line', 'polygon', 'immediate']));
  });

  it('agrees under a style rule of the layer', () => {
    const layer: Layer = {
      ...LAYER,
      styleRule: { kind: 'categorical', property: 'kind', map: { a: '#ff0000' }, other: '#00ff00' },
    };
    const result = kinds(variety(), { layer });
    expect(result.rows).toEqual(result.features);
  });

  it('agrees with the custom types, a renderer that refuses some features included', () => {
    const customTypes = new Map<string, unknown>([
      ['Marker', {}],
      ['Point', { appliesTo: (f: Feature) => f.properties.kind === 'a' }],
    ]);
    const result = kinds(variety(), { customTypes });
    expect(result.rows).toEqual(result.features);
    expect(result.rows[variety().findIndex((f) => f.id === 'kind-a')]).toBe('immediate');
    expect(result.rows[0]).toBe('point');
  });

  it('agrees with the companions', () => {
    const companions = createFeatureCompanionRegistry();
    companions.register({
      id: 'b',
      has: (f: Feature) => f.properties.kind === 'b',
    } as unknown as FeatureCompanionProvider);
    const result = kinds(variety(), { companions });
    expect(result.rows).toEqual(result.features);
    expect(result.rows[variety().findIndex((f) => f.id === 'kind-b')]).toBe('immediate');
  });

  it('agrees on a shape that is not instanced', () => {
    const base = createTestDrawer();
    const resolver: RetainedStyleResolver = {
      getPointStyle: (f, layer) => {
        const style = base.getPointStyle(f, layer);
        return f?.style?.pointShape === 'square' ? { ...style, shape: 'icon' as never } : style;
      },
      getLineStringStrokeStyle: (f, layer) => base.getLineStringStrokeStyle(f, layer),
      getPolygonStyles: (f, layer) => base.getPolygonStyles(f, layer),
    };
    const result = kinds(variety(), { resolver });
    expect(result.rows).toEqual(result.features);
    expect(result.rows[1]).toBe('immediate');
  });

  it('makes no feature of a row when no extension is registered, and only for the rows an extension answers for', () => {
    const features = variety();
    const { internals, table } = tablesOfFeatures('layer', features);
    const group = table.groupAt(0);
    const slots = new RowStyleSlots(createTestDrawer(), internals.styles, undefined);
    const made: string[] = [];
    const classifyAll = (customTypes: Map<string, unknown>) => {
      made.length = 0;
      for (let row = 0; row < features.length; row++) {
        classifyRow(group, row, {
          slots,
          customTypes,
          companions: createFeatureCompanionRegistry(),
          featureOf: (g, r) => {
            const f = rowFeature(internals.readContext, 'layer', g, r);
            made.push(f.type);
            return f;
          },
        });
      }
      return [...made];
    };
    // The built-in types (points, lines, polygons, Circles, images) are read from the columns
    expect(classifyAll(new Map())).toEqual([]);
    // A renderer that takes every feature of its type needs no feature either
    expect(classifyAll(new Map([['Marker', {}]]))).toEqual([]);
    // A renderer that answers from a feature is asked for the rows of its type only
    const pointRows = features.filter((f) => f.type === 'Point').length;
    expect(
      classifyAll(new Map([['Point', { appliesTo: (f: Feature) => f.properties.kind === 'a' }]])),
    ).toEqual(Array(pointRows).fill('Point'));
  });

  it('gives a row without a geometry no kind', () => {
    const { internals, table } = tablesOfFeatures('layer', [feature('p', 'Point', [0, 0])]);
    const group = table.groupAt(0);
    // A geometry column of no child stands for a row without a geometry
    group.data.geometry.types[0] = -1;
    const slots = new RowStyleSlots(createTestDrawer(), internals.styles, undefined);
    expect(
      classifyRow(group, 0, {
        slots,
        customTypes: new Map(),
        companions: createFeatureCompanionRegistry(),
        featureOf: () => {
          throw new Error('no feature is made');
        },
      }),
    ).toBeNull();
  });
});

describe('partitionRowGroup', () => {
  const line = (n: number): unknown => Array.from({ length: n }, (_, i) => [i, 0]);

  it('ends a chunk where the kind changes, and only between rows', () => {
    const features = [
      feature('a', 'Polygon', square),
      feature('b', 'Polygon', square),
      feature('c', 'Point', [5, 5]),
      feature('d', 'LineString', line(3)),
      feature('e', 'Point', [6, 6]),
      feature('f', 'Point', [7, 7], { style: { pointShape: 'star' } }),
    ];
    const { internals, table } = tablesOfFeatures('layer', features);
    const group = table.groupAt(0);
    const slots = new RowStyleSlots(createTestDrawer(), internals.styles, undefined);
    const context = {
      slots,
      customTypes: new Map(),
      companions: createFeatureCompanionRegistry(),
      featureOf: (g: typeof group, row: number) =>
        rowFeature(internals.readContext, 'layer', g, row),
    };
    const ranges = partitionRowGroup(group, (row) => classifyRow(group, row, context));
    expect(ranges.map((r) => [r.kind, r.from, r.to])).toEqual([
      ['polygon', 0, 2],
      ['point', 2, 3],
      ['line', 3, 4],
      ['point', 4, 6],
    ]);
    expect(ranges[0].bounds).toEqual({ minX: 0, minY: 0, maxX: 1, maxY: 1 });
    expect(ranges[3].bounds).toEqual({ minX: 6, minY: 6, maxX: 7, maxY: 7 });
  });

  it('ends a chunk where it would hold too many coordinates, a large row making a chunk of its own', () => {
    const features = [
      feature('a', 'LineString', line(4)),
      feature('b', 'LineString', line(4)),
      feature('c', 'LineString', line(30)),
      feature('d', 'LineString', line(2)),
    ];
    const { table } = tablesOfFeatures('layer', features);
    const group = table.groupAt(0);
    const ranges = partitionRowGroup(group, () => 'line', 10);
    expect(ranges.map((r) => [r.from, r.to, r.vertices])).toEqual([
      [0, 2, 8],
      [2, 3, 30],
      [3, 4, 2],
    ]);
  });

  it('puts a row without a kind in the run it is in', () => {
    const features = [
      feature('a', 'Point', [0, 0]),
      feature('b', 'Point', [1, 1]),
      feature('c', 'Point', [2, 2]),
    ];
    const { table } = tablesOfFeatures('layer', features);
    const group = table.groupAt(0);
    const ranges = partitionRowGroup(group, (row) => (row === 1 ? null : 'point'));
    expect(ranges.map((r) => [r.kind, r.from, r.to])).toEqual([['point', 0, 3]]);
    expect(partitionRowGroup(group, () => null)).toEqual([]);
  });
});
