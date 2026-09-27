// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for a dataset given as a table
 *
 * The same rows are given once as features and once as columns, and the two datasets are
 * compared: what goes onto the retained batches (the polygons, the lines and the points with
 * their resolved styles, in draw order), what goes to immediate mode, what a hit returns, the
 * selection, the thinning and `getFeatures`. The mock renderers record what they are handed; the
 * packed arrays are compared with the arrays of objects in `packed.test.ts`.
 */

import type { ProjectionData } from 'maplibre-gl';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_FEATURE_STYLE_CONFIG } from '../shared/config/feature-style.js';
import type {
  BoundingBox,
  Coordinate,
  Feature,
  FeatureStyle,
  StyleRule,
} from '../shared/types/model.js';
import { prepareTable } from '../table/prepare.js';
import type {
  Column,
  GeometryType,
  PreparedTable,
  Table,
  TableGeometry,
  TableMixedGeometry,
} from '../table/types.js';
import { toRow } from '../test-utils.js';
import { FeatureDrawer } from '../view/renderers/drawer.js';
import type { ImageRenderer } from '../view/renderers/image.js';
import { toLineInstanceColor } from '../view/renderers/line/line-geometry.js';
import type { LineBatchItem, RetainedLineBatch } from '../view/renderers/line/line-types.js';
import type { SDFLineRenderer } from '../view/renderers/line/sdf-line.js';
import type {
  PackedPointInstances,
  PointInstanceDataFull,
  RetainedPointBatch,
} from '../view/renderers/point/point-instance.js';
import type { PointShapeRenderer } from '../view/renderers/point/point-shape.js';
import type {
  RetainedPolygonBatch,
  SDFPolygonBatchData,
} from '../view/renderers/polygon/sdf-polygon.js';
import type { RetainedRendererSet } from '../view/renderers/retained.js';
import { TerrainContext } from '../view/terrain/context.js';
import type { DisplayBatchTarget } from './dataset.js';
import { createDatasetManager, type DatasetManager } from './manager.js';
import type { Dataset, DatasetOptions, DatasetRow } from './types.js';

const WORLD: BoundingBox = { minX: -180, minY: -85, maxX: 180, maxY: 85 };

function createStubGL(): WebGL2RenderingContext {
  return {
    createBuffer: (): object => ({}),
    createVertexArray: (): object => ({}),
    bindBuffer: (): void => {},
    bindVertexArray: (): void => {},
    enableVertexAttribArray: (): void => {},
    vertexAttribPointer: (): void => {},
  } as unknown as WebGL2RenderingContext;
}

/** What the renderers were handed, in build order */
interface Recorded {
  polygons: unknown[];
  lines: unknown[];
  points: unknown[];
  immediate: Feature[];
  packedPointBuilds: number;
}

/** A draw target whose renderers record what they are handed (as plain values) */
function createProbe(options: { packed?: boolean } = {}): {
  target: DisplayBatchTarget;
  recorded: Recorded;
} {
  const recorded: Recorded = {
    polygons: [],
    lines: [],
    points: [],
    immediate: [],
    packedPointBuilds: 0,
  };
  const pointValues = (points: PointInstanceDataFull[]): unknown =>
    points.map((p) => ({
      coord: [...p.coord],
      fillColor: [...p.fillColor],
      strokeColor: [...p.strokeColor],
      fillSize: p.fillSize,
      strokeWidth: p.strokeWidth,
    }));
  const renderers: RetainedRendererSet = {
    polygon: {
      buildRetained: (polygons: SDFPolygonBatchData[], opts): RetainedPolygonBatch => {
        recorded.polygons.push({
          widthZoom: opts?.widthZoom ?? null,
          polygons: polygons.map((p) => ({
            coordinates: p.coordinates,
            style: p.style,
            createdZoom: p.createdZoom,
            featureId: p.featureId,
            partIndex: p.partIndex ?? 0,
          })),
        });
        return {} as RetainedPolygonBatch;
      },
      drawRetained: (): void => {},
      disposeRetained: (): void => {},
    },
    line: {
      buildRetainedBatch: (items: LineBatchItem[], _shape, opts): RetainedLineBatch => {
        recorded.lines.push({
          widthZoom: opts?.widthZoom ?? null,
          items: items.map((item) => ({
            coords: item.coords.map((c) => [c[0], c[1]]),
            strokeWidth: item.strokeWidth,
            createdZoom: item.createdZoom,
            // The instance color is what reaches the GPU (the opacity folded in)
            color: toLineInstanceColor(item.color, item.opacity),
          })),
        });
        return {} as RetainedLineBatch;
      },
      drawRetainedBatch: (): void => {},
      disposeRetainedBatch: (): void => {},
    },
    point: {
      buildRetained: (points: PointInstanceDataFull[], shape): RetainedPointBatch => {
        recorded.points.push({ shape, points: pointValues(points) });
        return {} as RetainedPointBatch;
      },
      drawRetained: (): void => {},
      disposeRetained: (): void => {},
      ...(options.packed
        ? {
            buildRetainedPacked: (packed: PackedPointInstances): RetainedPointBatch => {
              recorded.packedPointBuilds++;
              recorded.points.push({ packedCount: packed.count });
              return {} as RetainedPointBatch;
            },
          }
        : {}),
    },
    styles: new FeatureDrawer({
      gl: createStubGL(),
      map: {} as never,
      sdfLineRenderer: {} as SDFLineRenderer,
      pointShapeRenderer: {} as PointShapeRenderer,
      imageRenderer: {} as ImageRenderer,
      featureStyle: DEFAULT_FEATURE_STYLE_CONFIG,
    }),
    viewport: (): [number, number] => [800, 600],
  };
  const terrain = new TerrainContext();
  const target: DisplayBatchTarget = {
    beginFrame: vi.fn(),
    processFeature: (feature: Feature): boolean => {
      recorded.immediate.push(feature);
      return false;
    },
    endFrame: vi.fn(),
    getRetainedRenderers: () => renderers,
    getTerrain: () => terrain,
  };
  return { target, recorded };
}

function createManager(zoom = 10): DatasetManager {
  return createDatasetManager({
    getViewportBounds: () => WORLD,
    getZoom: () => zoom,
    onViewportChange: () => () => {},
    requestRepaint: () => {},
    providerDebounceMs: 0,
  });
}

/** Draws frames until nothing is left to build */
function drawAll(manager: DatasetManager, target: DisplayBatchTarget): void {
  for (let i = 0; i < 50; i++) {
    manager.draw('below-store', target, {} as ProjectionData, 10);
    const pending = manager.listInternal().some((c) => c.hasPendingBuild);
    if (!pending) return;
  }
}

// === Building the same rows in both forms (written apart from the library's reader) ===

type Geometry = Coordinate | Coordinate[] | Coordinate[][] | Coordinate[][][];

interface Row {
  geometry: Geometry | null;
  properties: Record<string, string | number>;
  /** The type of the row in a mixed table (the type of the table otherwise) */
  type?: GeometryType;
}

/** The depth of the offsets of each type */
const DEPTH: Record<GeometryType, number> = {
  Point: 0,
  LineString: 1,
  MultiPoint: 1,
  Polygon: 2,
  MultiLineString: 2,
  MultiPolygon: 3,
};

/** A table whose geometry column has one type */
type SingleTypeInput = Table & { geometry: TableGeometry };

/** Encodes the rows as a GeoArrow table (a dictionary for strings, Float64 for numbers) */
function toTable(type: GeometryType, rows: Row[]): SingleTypeInput {
  const coords: number[] = [];
  const depth = DEPTH[type];
  const offsets: number[][] = Array.from({ length: depth }, () => [0]);
  const validity = new Uint8Array(Math.ceil(rows.length / 8));
  /** Appends the elements of one level and records where they end */
  const push = (value: unknown, level: number): void => {
    if (level === depth) {
      const c = value as Coordinate;
      coords.push(c[0], c[1]);
      return;
    }
    const items = value as unknown[];
    for (const item of items) push(item, level + 1);
    const next = level + 1 < depth ? offsets[level + 1].length - 1 : coords.length / 2;
    offsets[level].push(next);
  };
  rows.forEach((row, i) => {
    if (row.geometry === null) {
      // An empty run: a repeated offset at the row level (NaN coordinates for a point)
      if (type === 'Point') coords.push(Number.NaN, Number.NaN);
      else offsets[0].push(offsets[0][offsets[0].length - 1]);
      return;
    }
    validity[i >> 3] |= 1 << (i & 7);
    push(row.geometry, 0);
  });

  return {
    length: rows.length,
    geometry: {
      type,
      coords: Float64Array.from(coords),
      offsets: offsets.map((o) => Int32Array.from(o)),
    },
    validity,
    ...attributesOf(rows),
  };
}

/** The ids and the attribute columns of the rows */
function attributesOf(rows: Row[]): Pick<Table, 'ids' | 'columns'> {
  const columns: Record<string, Column> = {};
  const names = [...new Set(rows.flatMap((row) => Object.keys(row.properties)))];
  for (const name of names) {
    const values = rows.map((row) => row.properties[name]);
    // A missing number is NaN
    if (values.every((v) => typeof v === 'number' || v === undefined)) {
      columns[name] = Float64Array.from(values, (v) => (v === undefined ? Number.NaN : v));
    } else {
      const dictionary = [...new Set(values.map(String))];
      columns[name] = {
        codes: Int32Array.from(values, (v) => dictionary.indexOf(String(v))),
        dictionary,
      };
    }
  }
  return { ids: rows.map((_, i) => `r${i}`), columns };
}

/**
 * The same rows as features (the rows without a geometry are left out; a property that a row
 * lacks is null, as a column reads it back)
 */
function toFeatures(type: GeometryType, rows: Row[]): DatasetRow[] {
  const names = [...new Set(rows.flatMap((row) => Object.keys(row.properties)))];
  const features: DatasetRow[] = [];
  rows.forEach((row, i) => {
    if (row.geometry === null) return;
    const properties: Record<string, unknown> = {};
    for (const name of names) properties[name] = row.properties[name] ?? null;
    features.push(
      toRow({
        id: `r${i}`,
        type: row.type ?? type,
        coordinates: row.geometry,
        properties,
      }),
    );
  });
  return features;
}

const square = (x: number, y: number, size: number): Coordinate[] => [
  [x, y],
  [x + size, y],
  [x + size, y + size],
  [x, y + size],
  [x, y],
];

const CLASSES = ['a', 'b', 'c'];

/** The geometry of row `i` of a type (a grid of cells 2 degrees apart) */
function geometryOf(type: GeometryType, i: number): Geometry {
  const x = (i % 6) * 2;
  const y = Math.floor(i / 6) * 2;
  switch (type) {
    case 'Point':
      return [x, y];
    case 'MultiPoint':
      return [
        [x, y],
        [x + 0.5, y + 0.5],
      ];
    case 'LineString':
      return [
        [x, y],
        [x + 1, y + 0.5],
        [x + 1.5, y + 1],
      ];
    case 'MultiLineString':
      return [
        [
          [x, y],
          [x + 1, y],
        ],
        [
          [x, y + 1],
          [x + 1, y + 1],
        ],
      ];
    case 'Polygon':
      return [square(x, y, 1.5), square(x + 0.5, y + 0.5, 0.25).reverse()];
    case 'MultiPolygon':
      return [[square(x, y, 0.5)], [square(x + 1, y + 1, 0.5)]];
  }
}

/** The properties of row `i` (some with createdZoom) */
function propertiesOf(i: number): Record<string, string | number> {
  const properties: Record<string, string | number> = { cls: CLASSES[i % 3], value: i };
  if (i % 4 === 0) properties.createdZoom = 12;
  return properties;
}

/** Rows of every geometry type (a few without a geometry, some with createdZoom) */
function rowsOf(type: GeometryType, count = 30): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < count; i++) {
    rows.push({ geometry: i % 7 === 3 ? null : geometryOf(type, i), properties: propertiesOf(i) });
  }
  return rows;
}

const RULE: StyleRule = {
  kind: 'categorical',
  property: 'cls',
  map: { a: '#ff0000', b: '#00ff00' },
  other: '#0000ff',
};

/** Draws one dataset and returns what the renderers were handed */
function drawDataset(
  options: DatasetOptions,
  probeOptions: { packed?: boolean } = {},
): { recorded: Recorded; manager: DatasetManager } {
  const manager = createManager();
  manager.add(options);
  const { target, recorded } = createProbe(probeOptions);
  drawAll(manager, target);
  return { recorded, manager };
}

const TYPES: GeometryType[] = [
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
];

describe('the table input draws what the same features draw', () => {
  for (const type of TYPES) {
    it(`${type}, with a rule on a dictionary column and a base style`, () => {
      const rows = rowsOf(type);
      const style = {
        styleRule: RULE,
        baseStyle: {
          point: { pointRadius: 5 },
          stroke: { strokeWidth: 3 },
          fill: { fillOpacity: 0.4 },
        },
      };
      const features = drawDataset({ id: 'c', rows: toFeatures(type, rows), ...style });
      const asTable = drawDataset({ id: 'c', table: toTable(type, rows), ...style });

      expect(asTable.recorded.polygons).toEqual(features.recorded.polygons);
      expect(asTable.recorded.lines).toEqual(features.recorded.lines);
      expect(asTable.recorded.points).toEqual(features.recorded.points);
      expect(asTable.recorded.immediate).toEqual(features.recorded.immediate);
      expect(
        features.recorded.polygons.length +
          features.recorded.lines.length +
          features.recorded.points.length,
      ).toBeGreaterThan(0);
    });
  }

  it('without a rule or a base style, with the default styles', () => {
    const rows = rowsOf('Polygon');
    const features = drawDataset({ id: 'c', rows: toFeatures('Polygon', rows) });
    const asTable = drawDataset({ id: 'c', table: toTable('Polygon', rows) });
    expect(asTable.recorded.polygons).toEqual(features.recorded.polygons);
  });

  it('a dashed line goes to immediate mode as the same feature', () => {
    const rows = rowsOf('LineString', 8);
    const style = { styleRule: RULE, baseStyle: { stroke: { lineStyle: 'dashed' as const } } };
    const features = drawDataset({
      id: 'c',
      rows: toFeatures('LineString', rows),
      ...style,
    });
    const asTable = drawDataset({
      id: 'c',
      table: toTable('LineString', rows),
      ...style,
    });
    expect(features.recorded.lines).toEqual([]);
    expect(asTable.recorded.lines).toEqual([]);
    expect(asTable.recorded.immediate.length).toBeGreaterThan(0);
    expect(asTable.recorded.immediate).toEqual(features.recorded.immediate);
  });

  it('a row that the predicate of an external renderer claims is not drawn', () => {
    const rows = rowsOf('Point', 12);
    const externalPointRender = (feature: Feature): boolean => feature.properties.cls === 'a';
    const features = drawDataset({
      id: 'c',
      rows: toFeatures('Point', rows),
      externalPointRender,
    });
    const asTable = drawDataset({
      id: 'c',
      table: toTable('Point', rows),
      externalPointRender,
    });
    expect(asTable.recorded.points).toEqual(features.recorded.points);
  });

  it('the points are packed without an object per point when the renderer can take them', () => {
    const rows = rowsOf('Point');
    const { recorded } = drawDataset(
      { id: 'c', table: toTable('Point', rows), styleRule: RULE },
      { packed: true },
    );
    expect(recorded.packedPointBuilds).toBeGreaterThan(0);
    const drawn = recorded.points.reduce(
      (sum: number, batch) => sum + (batch as { packedCount: number }).packedCount,
      0,
    );
    // The rows without a geometry are not drawn
    expect(drawn).toBe(rows.filter((row) => row.geometry !== null).length);
  });

  it('the thinned rows are the same, and so are the counts', () => {
    const rows: Row[] = [];
    for (let i = 0; i < 40; i++) {
      rows.push({ geometry: [i * 0.0001, 0], properties: { cls: CLASSES[i % 3], value: i } });
    }
    const options = { collisionThinning: { enabled: true }, styleRule: RULE };
    const features = drawDataset({ id: 'c', rows: toFeatures('Point', rows), ...options });
    const asTable = drawDataset({ id: 'c', table: toTable('Point', rows), ...options });
    const a = features.manager.get('c');
    const b = asTable.manager.get('c');
    expect(b?.getThinningStats()).toEqual(a?.getThinningStats());
    expect(a?.getThinningStats().visible).toBeLessThan(40);
    expect([...(b?.getVisibleFeatureIds() ?? [])].sort()).toEqual(
      [...(a?.getVisibleFeatureIds() ?? [])].sort(),
    );
    expect(asTable.recorded.points).toEqual(features.recorded.points);
  });
});

describe('reading the rows back', () => {
  /** A test that hits a feature whose bbox holds the position */
  const insideBbox = (feature: Feature, coordinate: Coordinate): boolean => {
    const flat = (feature.coordinates as unknown as number[]).flat(3) as number[];
    const xs = flat.filter((_, i) => i % 2 === 0);
    const ys = flat.filter((_, i) => i % 2 === 1);
    return (
      coordinate[0] >= Math.min(...xs) &&
      coordinate[0] <= Math.max(...xs) &&
      coordinate[1] >= Math.min(...ys) &&
      coordinate[1] <= Math.max(...ys)
    );
  };

  for (const type of TYPES) {
    it(`${type}: a hit returns the same feature and its row`, () => {
      const rows = rowsOf(type);
      const manager = createManager();
      manager.add({ id: 'f', rows: toFeatures(type, rows), interactive: true });
      const asTable = createManager();
      asTable.add({ id: 'c', table: toTable(type, rows), interactive: true });

      for (const probe of [
        [0.2, 0.2],
        [2.6, 0.6],
        [4.1, 2.1],
      ] as Coordinate[]) {
        const a = manager.hitTestSide('below-store', probe, 0.3, insideBbox);
        const b = asTable.hitTestSide('below-store', probe, 0.3, insideBbox);
        expect(b?.feature).toEqual(a?.feature);
        // The row is the row of the table; the features left the rows without a geometry out
        if (b?.feature) expect(b.row).toBe(Number(b.feature.id.slice(1)));
      }
    });
  }

  it('getFeatures, collectVisible and the selection match the features', () => {
    const rows = rowsOf('Polygon');
    const manager = createManager();
    const a = manager.add({ id: 'f', rows: toFeatures('Polygon', rows), styleRule: RULE });
    const b = manager.add({ id: 'c', table: toTable('Polygon', rows), styleRule: RULE });

    expect(b.getFeatures()).toEqual(a.getFeatures());
    const view: BoundingBox = { minX: 1, minY: 1, maxX: 5, maxY: 3 };
    expect(b.collectVisible(view)).toEqual(a.collectVisible(view));

    b.setSelectedIds(['r5', 'r1', 'r3', 'nope']);
    a.setSelectedIds(['r5', 'r1', 'r3', 'nope']);
    // r3 has no geometry
    expect(b.getSelectedIds()).toEqual(['r1', 'r5']);
    expect(b.getSelectedIds()).toEqual(a.getSelectedIds());
  });

  it('the terrain drape gets the same features, and nothing from a table of points', () => {
    const manager = createManager();
    manager.add({ id: 'f', rows: toFeatures('Polygon', rowsOf('Polygon')), styleRule: RULE });
    manager.add({ id: 'c', table: toTable('Polygon', rowsOf('Polygon')), styleRule: RULE });
    manager.add({ id: 'p', table: toTable('Point', rowsOf('Point')) });
    const drape = (id: string) => manager.getInternal(id)?.drapeFeatures();
    expect(drape('c')).toEqual(drape('f'));
    expect(drape('c')?.length).toBeGreaterThan(0);
    expect(drape('p')).toEqual([]);
  });

  it('without an ids column the id of a row is its number', () => {
    const input = toTable('Point', rowsOf('Point', 5));
    delete input.ids;
    const manager = createManager();
    const dataset = manager.add({ id: 'c', table: input });
    expect(dataset.getFeatures().map((f) => f.id)).toEqual(['0', '1', '2', '4']);
    dataset.setSelectedIds(['4', '3', '01']);
    expect(dataset.getSelectedIds()).toEqual(['4']);
  });
});

describe('setTable', () => {
  it('takes the prepared arrays of a Worker and computes nothing again', () => {
    const rows = rowsOf('LineString');
    const input = toTable('LineString', rows);
    const withPrepared = drawDataset({ id: 'c', table: prepareTable(input) });
    const without = drawDataset({ id: 'c', table: input });
    expect(withPrepared.recorded.lines).toEqual(without.recorded.lines);
    // The dataset reads the arrays it was given
    const dataset = withPrepared.manager.getInternal('c');
    expect(dataset?.getFeatures().length).toBe(rows.filter((r) => r.geometry).length);
  });

  it('replaces the contents, keeps the selection of the ids that remain and says so', () => {
    const manager = createManager();
    const dataset = manager.add({ id: 'c', table: toTable('Point', rowsOf('Point')) });
    dataset.setSelectedIds(['r1', 'r2']);
    const change = vi.fn();
    dataset.on('change', change);

    dataset.setTable(toTable('Point', rowsOf('Point', 2)));
    expect(change).toHaveBeenCalledWith({ reason: 'features' });
    expect(dataset.getSelectedIds()).toEqual(['r1']);

    dataset.setRows([toRow({ id: 'x', type: 'Point', coordinates: [0, 0] })]);
    expect(dataset.getFeatures().map((f) => f.id)).toEqual(['x']);
  });

  it('refuses a table that does not add up, and a prepared table that does not match', () => {
    const manager = createManager();
    const dataset = manager.add({ id: 'c' });
    const input = toTable('LineString', rowsOf('LineString', 4));
    expect(() =>
      dataset.setTable({ ...input, geometry: { ...input.geometry, offsets: [] } }),
    ).toThrow(/offset arrays/);
    const other = prepareTable(toTable('LineString', rowsOf('LineString', 5)));
    expect(() => dataset.setTable({ ...other, table: input })).toThrow(/prepared/);
    expect(() => dataset.setTable({ table: input } as PreparedTable)).toThrow(/prepareTable/);
  });

  it('only one of rows, table and provider can be given', () => {
    const manager = createManager();
    const input = toTable('Point', rowsOf('Point', 2));
    expect(() => manager.add({ id: 'a', rows: [], table: input })).toThrow(/only one/);
    expect(() => manager.add({ id: 'b', table: input, provider: async () => [] })).toThrow(
      /only one/,
    );
  });
});

describe('the style of a row', () => {
  it('a row with no value for the rule column gets the other color', () => {
    const input = toTable('Point', rowsOf('Point', 3));
    const cls = input.columns?.cls as { codes: Int32Array; dictionary: string[] };
    cls.codes[1] = -1;
    const manager = createManager();
    const dataset = manager.add({ id: 'c', table: input, styleRule: RULE });
    const [, second] = dataset.collectVisible(WORLD);
    expect(second.properties.cls).toBeNull();
    expect((second.style as FeatureStyle).pointColor).toBe(
      RULE.kind === 'categorical' && RULE.other,
    );
  });
});

// === A mixed geometry column ===

/** A row of a mixed table, and how a row without a geometry says so */
interface MixedRow extends Row {
  type: GeometryType;
  /** No child (a negative type), or a geometry in its child hidden by a 0 bit of validity */
  missing?: 'type' | 'validity';
}

/** Rows of every type in turn (a few without a geometry, in both ways) */
function mixedRows(count = 36, typeOf = (i: number) => TYPES[i % TYPES.length]): MixedRow[] {
  const rows: MixedRow[] = [];
  for (let i = 0; i < count; i++) {
    const type = typeOf(i);
    const missing = i % 7 === 3 ? (i % 2 === 1 ? 'type' : 'validity') : undefined;
    rows.push({
      type,
      geometry: missing ? null : geometryOf(type, i),
      properties: propertiesOf(i),
      missing,
    });
  }
  return rows;
}

/** A geometry column with a z value after every coordinate */
function withZ(geometry: TableGeometry): TableGeometry {
  const xy = geometry.coords;
  const xyz = new Float64Array((xy.length / 2) * 3);
  for (let v = 0; v < xy.length / 2; v++) {
    xyz[v * 3] = xy[v * 2];
    xyz[v * 3 + 1] = xy[v * 2 + 1];
    xyz[v * 3 + 2] = 99;
  }
  return { ...geometry, coords: xyz, dimensions: 3 };
}

/**
 * Encodes the rows as a table with a mixed geometry column
 *
 * The children are filled from the last row to the first, so the order within a child is not the
 * order of the table. The MultiLineString child has z values.
 */
function toMixed(rows: MixedRow[]): Table {
  const childOfType = new Map<GeometryType, number>();
  const childRows: Row[][] = [];
  const childTypes: GeometryType[] = [];
  const types = new Int8Array(rows.length);
  const offsets = new Int32Array(rows.length);
  const validity = new Uint8Array(Math.ceil(rows.length / 8));
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.missing !== 'validity' && row.missing !== 'type') validity[i >> 3] |= 1 << (i & 7);
    if (row.missing === 'type') {
      types[i] = -1;
      continue;
    }
    let child = childOfType.get(row.type);
    if (child === undefined) {
      child = childRows.length;
      childOfType.set(row.type, child);
      childRows.push([]);
      childTypes.push(row.type);
    }
    types[i] = child;
    offsets[i] = childRows[child].length;
    // A row hidden by validity still has a geometry in its child
    childRows[child].push({ geometry: row.geometry ?? geometryOf(row.type, i), properties: {} });
  }
  const children = childTypes.map((type, k) => {
    const geometry = toTable(type, childRows[k]).geometry;
    return type === 'MultiLineString' ? withZ(geometry) : geometry;
  });
  return {
    length: rows.length,
    geometry: { type: 'Mixed', types, offsets, children },
    validity,
    ...attributesOf(rows),
  };
}

describe('a mixed geometry column behaves as the same features', () => {
  const style = {
    styleRule: RULE,
    baseStyle: {
      point: { pointRadius: 5 },
      stroke: { strokeWidth: 3 },
      fill: { fillOpacity: 0.4 },
    },
  };

  it('draws the same polygons, lines and points in the order of the table', () => {
    const rows = mixedRows();
    const features = drawDataset({ id: 'c', rows: toFeatures('Point', rows), ...style });
    const asTable = drawDataset({ id: 'c', table: toMixed(rows), ...style });

    expect(asTable.recorded.polygons).toEqual(features.recorded.polygons);
    expect(asTable.recorded.lines).toEqual(features.recorded.lines);
    expect(asTable.recorded.points).toEqual(features.recorded.points);
    expect(asTable.recorded.immediate).toEqual(features.recorded.immediate);
    expect(features.recorded.polygons.length).toBeGreaterThan(0);
    expect(features.recorded.lines.length).toBeGreaterThan(0);
    expect(features.recorded.points.length).toBeGreaterThan(0);
  });

  it('sends the dashed lines and outlines to immediate mode as the same features', () => {
    const rows = mixedRows();
    const dashed = { styleRule: RULE, baseStyle: { stroke: { lineStyle: 'dashed' as const } } };
    const features = drawDataset({ id: 'c', rows: toFeatures('Point', rows), ...dashed });
    const asTable = drawDataset({ id: 'c', table: toMixed(rows), ...dashed });
    expect(asTable.recorded.immediate.length).toBeGreaterThan(0);
    expect(asTable.recorded.immediate).toEqual(features.recorded.immediate);
    expect(asTable.recorded.lines).toEqual(features.recorded.lines);
    expect(asTable.recorded.points).toEqual(features.recorded.points);
  });

  it('draws the same with the prepared arrays of a Worker', () => {
    const input = toMixed(mixedRows());
    const withPrepared = drawDataset({
      id: 'c',
      table: prepareTable(input),
      ...style,
    });
    const without = drawDataset({ id: 'c', table: input, ...style });
    expect(withPrepared.recorded).toEqual(without.recorded);
  });

  it('a hit returns the same feature and its row', () => {
    const rows = mixedRows();
    const manager = createManager();
    manager.add({ id: 'f', rows: toFeatures('Point', rows), interactive: true });
    const asTable = createManager();
    asTable.add({ id: 'c', table: toMixed(rows), interactive: true });
    /** A test that hits a feature whose bbox, grown by 0.25, holds the position */
    const nearBbox = (feature: Feature, coordinate: Coordinate): boolean => {
      const flat = (feature.coordinates as unknown as number[]).flat(3) as number[];
      const xs = flat.filter((_, i) => i % 2 === 0);
      const ys = flat.filter((_, i) => i % 2 === 1);
      return (
        coordinate[0] >= Math.min(...xs) - 0.25 &&
        coordinate[0] <= Math.max(...xs) + 0.25 &&
        coordinate[1] >= Math.min(...ys) - 0.25 &&
        coordinate[1] <= Math.max(...ys) + 0.25
      );
    };

    let hits = 0;
    const types = new Set<string>();
    for (let y = 0; y < 6; y++) {
      for (let x = 0; x < 6; x++) {
        const probe: Coordinate = [x * 2 + 0.2, y * 2 + 0.2];
        const a = manager.hitTestSide('below-store', probe, 0.3, nearBbox);
        const b = asTable.hitTestSide('below-store', probe, 0.3, nearBbox);
        expect(b?.feature).toEqual(a?.feature);
        if (b?.feature) {
          hits++;
          types.add(b.feature.type);
          expect(b.row).toBe(Number(b.feature.id.slice(1)));
        }
      }
    }
    // Every type is hit, and the rows without a geometry are not
    expect(types.size).toBe(TYPES.length);
    expect(hits).toBe(rows.filter((row) => row.geometry !== null).length);
  });

  it('getFeatures, collectVisible and the selection match the features', () => {
    const rows = mixedRows();
    const manager = createManager();
    const a = manager.add({ id: 'f', rows: toFeatures('Point', rows), styleRule: RULE });
    const b = manager.add({ id: 'c', table: toMixed(rows), styleRule: RULE });

    expect(b.getFeatures()).toEqual(a.getFeatures());
    expect(b.getFeatures().length).toBe(rows.filter((row) => row.geometry !== null).length);
    const view: BoundingBox = { minX: 1, minY: 1, maxX: 7, maxY: 5 };
    expect(b.collectVisible(view)).toEqual(a.collectVisible(view));

    // r3 has no child, r10 is hidden by validity
    b.setSelectedIds(['r8', 'r1', 'r3', 'r10', 'r4', 'nope']);
    a.setSelectedIds(['r8', 'r1', 'r3', 'r10', 'r4', 'nope']);
    expect(b.getSelectedIds()).toEqual(['r1', 'r4', 'r8']);
    expect(b.getSelectedIds()).toEqual(a.getSelectedIds());
  });

  it('thins the points among the other rows as the features do', () => {
    const rows = mixedRows(40, (i) => (i % 3 === 2 ? 'LineString' : 'Point')).map((row, i) =>
      row.type === 'Point' && row.geometry
        ? { ...row, geometry: [i * 0.0001, 0] as Geometry }
        : row,
    );
    const options = { collisionThinning: { enabled: true }, styleRule: RULE };
    const features = drawDataset({ id: 'c', rows: toFeatures('Point', rows), ...options });
    const asTable = drawDataset({ id: 'c', table: toMixed(rows), ...options });
    const a = features.manager.get('c');
    const b = asTable.manager.get('c');
    // The total of a table counts its rows without a geometry too (as for a table of one type)
    expect(b?.getThinningStats()).toEqual({ ...a?.getThinningStats(), total: rows.length });
    expect(a?.getThinningStats().visible).toBeLessThan(a?.getThinningStats().total ?? 0);
    expect([...(b?.getVisibleFeatureIds() ?? [])].sort()).toEqual(
      [...(a?.getVisibleFeatureIds() ?? [])].sort(),
    );
    expect(asTable.recorded.points).toEqual(features.recorded.points);
    expect(asTable.recorded.lines).toEqual(features.recorded.lines);
  });

  it('the terrain drape gets the same features, and nothing from points alone', () => {
    const rows = mixedRows();
    const points = mixedRows(12, (i) => (i % 2 === 0 ? 'Point' : 'MultiPoint'));
    const manager = createManager();
    manager.add({ id: 'f', rows: toFeatures('Point', rows), styleRule: RULE });
    manager.add({ id: 'c', table: toMixed(rows), styleRule: RULE });
    manager.add({ id: 'p', table: toMixed(points) });
    const drape = (id: string) => manager.getInternal(id)?.drapeFeatures();
    expect(drape('c')).toEqual(drape('f'));
    expect(drape('c')?.some((feature) => feature.type === 'MultiPolygon')).toBe(true);
    expect(drape('p')).toEqual([]);
  });

  it('an external point renderer claims the Point rows and never sees a MultiPoint', () => {
    for (const [name, rows, input] of [
      ['one type', rowsOf('MultiPoint'), toTable('MultiPoint', rowsOf('MultiPoint'))],
      [
        'mixed',
        mixedRows(36, (i) => (i % 2 === 0 ? 'Point' : 'MultiPoint')),
        toMixed(mixedRows(36, (i) => (i % 2 === 0 ? 'Point' : 'MultiPoint'))),
      ],
    ] as const) {
      const seen = { features: new Set<string>(), asTable: new Set<string>() };
      const predicate =
        (into: Set<string>) =>
        (feature: Feature): boolean => {
          into.add(feature.type);
          return true;
        };
      const features = drawDataset({
        id: 'c',
        rows: toFeatures('MultiPoint', rows as Row[]),
        externalPointRender: predicate(seen.features),
      });
      const asTable = drawDataset({
        id: 'c',
        table: input,
        externalPointRender: predicate(seen.asTable),
      });
      expect(asTable.recorded.points, name).toEqual(features.recorded.points);
      expect(asTable.recorded.immediate, name).toEqual(features.recorded.immediate);
      expect(features.recorded.points.length, name).toBeGreaterThan(0);
      // Both paths hand the predicate the Point rows only
      expect([...seen.asTable], name).toEqual([...seen.features]);
      expect(seen.asTable.has('MultiPoint'), name).toBe(false);
    }
  });

  it('refuses a row that names a missing child or a row past the end of its child', () => {
    const manager = createManager();
    const dataset = manager.add({ id: 'c' });
    const input = toMixed(mixedRows(12));
    const geometry = input.geometry as TableMixedGeometry;
    const types = geometry.types.slice();
    types[5] = 9;
    expect(() => dataset.setTable({ ...input, geometry: { ...geometry, types } })).toThrow(
      /geometry\.types\[5\] is 9/,
    );
    const offsets = geometry.offsets.slice();
    offsets[4] = 100;
    expect(() => dataset.setTable({ ...input, geometry: { ...geometry, offsets } })).toThrow(
      /geometry\.offsets\[4\] is 100/,
    );
  });
});

describe('reading by row matches the features', () => {
  const style = { styleRule: RULE, baseStyle: { point: { pointRadius: 5 } } };
  /** The rows of every type, with dense points so that the thinning drops some */
  const denseRows = (): MixedRow[] =>
    mixedRows(48, (i) => (i % 3 === 2 ? TYPES[i % TYPES.length] : 'Point')).map((row, i) =>
      row.type === 'Point' && row.geometry
        ? { ...row, geometry: [i * 0.0001, i * 0.00005] as Geometry }
        : row,
    );
  /** Dense points only (a few without a geometry) */
  const densePoints = (): Row[] =>
    rowsOf('Point', 40).map((row, i) =>
      row.geometry ? { ...row, geometry: [i * 0.0001, i * 0.00005] as Geometry } : row,
    );
  const VIEW: BoundingBox = { minX: -0.001, minY: -0.001, maxX: 7, maxY: 5 };

  /** What collectVisible and getVisibleFeatureIds say is drawn in the view */
  const drawnFeatures = (dataset: Dataset, view: BoundingBox): Feature[] => {
    const drawable = dataset.getVisibleFeatureIds();
    return dataset
      .collectVisible(view)
      .filter((feature) => feature.visible && (drawable === null || drawable.has(feature.id)));
  };
  /** The bbox of the coordinates of a feature */
  const bboxOf = (feature: Feature): BoundingBox => {
    const flat = (feature.coordinates as unknown as number[]).flat(3) as number[];
    const xs = flat.filter((_, i) => i % 2 === 0);
    const ys = flat.filter((_, i) => i % 2 === 1);
    return {
      minX: Math.min(...xs),
      minY: Math.min(...ys),
      maxX: Math.max(...xs),
      maxY: Math.max(...ys),
    };
  };

  for (const thinning of [false, true]) {
    const options = { ...style, collisionThinning: { enabled: thinning } };
    const forms: [string, DatasetOptions][] = [
      ['features', { id: 'f', rows: toFeatures('Point', denseRows()), ...options }],
      ['a table of one type', { id: 'c', table: toTable('Point', densePoints()) }],
      ['a mixed table', { id: 'm', table: toMixed(denseRows()), ...options }],
    ];
    for (const [name, input] of forms) {
      it(`${name}, thinning ${thinning ? 'on' : 'off'}: the drawn rows are the drawn features`, () => {
        const dataset = createManager().add({ ...options, ...input });
        const rows = dataset.collectDrawnRows(VIEW);

        expect(rows).toBeInstanceOf(Int32Array);
        expect([...rows]).toEqual([...rows].sort((a, b) => a - b));
        const features = [...rows].map((row) => dataset.getRow(row));
        expect(features).toEqual(drawnFeatures(dataset, VIEW));
        expect(features.length).toBeGreaterThan(0);
        if (thinning) {
          expect(dataset.getThinningStats().active).toBe(true);
          expect(features.length).toBeLessThan(dataset.collectVisible(VIEW).length);
        }

        // The reads of one row agree with its feature
        for (const row of rows) {
          const feature = dataset.getRow(row) as Feature;
          expect(dataset.getRowId(row)).toBe(feature.id);
          expect(dataset.getRowType(row)).toBe(feature.type);
          expect(dataset.getRowBounds(row)).toEqual(bboxOf(feature));
          expect(dataset.getRowPoint(row)).toEqual(
            feature.type === 'Point' ? feature.coordinates : null,
          );
        }
      });
    }

    it(`thinning ${thinning ? 'on' : 'off'}: a table and its features draw the same rows`, () => {
      const rows = denseRows();
      const manager = createManager();
      const a = manager.add({ id: 'f', rows: toFeatures('Point', rows), ...options });
      const b = manager.add({ id: 'm', table: toMixed(rows), ...options });
      const read = (dataset: Dataset) =>
        [...dataset.collectDrawnRows(VIEW)].map((row) => dataset.getRow(row));

      expect(read(b)).toEqual(read(a));
      // The row of a table is its row; the features left the rows without a geometry out
      for (const row of b.collectDrawnRows(VIEW)) {
        expect(b.getRowId(row)).toBe(`r${row}`);
      }
    });
  }

  it('an extent outside everything gives no rows, and a row without a geometry is not drawn', () => {
    const manager = createManager();
    const features = toFeatures('Point', rowsOf('Point', 6));
    features[1] = { ...features[1], geometry: null };
    const dataset = manager.add({ id: 'f', rows: features });

    expect(dataset.collectDrawnRows({ minX: 100, minY: 60, maxX: 101, maxY: 61 })).toHaveLength(0);
    const ids = [...dataset.collectDrawnRows(WORLD)].map((row) => dataset.getRowId(row));
    expect(ids).toEqual(features.filter((f) => f.geometry !== null).map((f) => f.id));
    // A row without a geometry can still be read by its row
    expect(dataset.getRowId(1)).toBe(features[1].id);
  });

  it('a row without a geometry, and a number that is not a row', () => {
    const dataset = createManager().add({ id: 'c', table: toMixed(mixedRows()) });
    // Row 3 names no child; row 10 is hidden by validity
    for (const row of [3, 10]) {
      expect(dataset.getRowType(row)).toBeNull();
      expect(dataset.getRowBounds(row)).toBeNull();
      expect(dataset.getRowPoint(row)).toBeNull();
      expect(dataset.getRowId(row)).toBe(`r${row}`);
    }
    expect([...dataset.collectDrawnRows(WORLD)]).not.toContain(3);
    for (const row of [-1, 36, 1.5, Number.NaN]) {
      expect(dataset.getRow(row)).toBeUndefined();
      expect(dataset.getRowId(row)).toBeNull();
      expect(dataset.getRowType(row)).toBeNull();
      expect(dataset.getRowBounds(row)).toBeNull();
      expect(dataset.getRowPoint(row)).toBeNull();
    }
  });

  it('findRow is the reverse of getRowId, for every form', () => {
    const rows = mixedRows();
    const manager = createManager();
    const features = manager.add({ id: 'f', rows: toFeatures('Point', rows) });
    const table = manager.add({ id: 'm', table: toMixed(rows) });
    for (const dataset of [features, table]) {
      let row = 0;
      for (let id = dataset.getRowId(row); id !== null; id = dataset.getRowId(++row)) {
        expect(dataset.findRow(id)).toBe(row);
      }
      expect(row).toBeGreaterThan(0);
      expect(dataset.findRow('missing')).toBeNull();
    }
    // A row without a geometry is found too
    expect(table.findRow('r3')).toBe(3);

    // Without an ids column the id is the number of the row, written as it is
    const input = toTable('Point', rowsOf('Point', 5));
    delete input.ids;
    const plain = manager.add({ id: 'p', table: input });
    expect(plain.findRow('4')).toBe(4);
    expect(plain.findRow('04')).toBeNull();
    expect(plain.findRow('5')).toBeNull();

    // The index follows a replacement of the contents
    features.setRows([toRow({ id: 'x', type: 'Point', coordinates: [0, 0] })]);
    expect(features.findRow('x')).toBe(0);
    expect(features.findRow(`r0`)).toBeNull();
  });

  it('the row of a hit reads back the feature of the hit', () => {
    const manager = createManager();
    const dataset = manager.add({
      id: 'c',
      table: toMixed(mixedRows()),
      interactive: true,
      ...style,
    });
    const hit = manager.hitTestSide('below-store', [4.1, 2.1], 0.3, () => true);

    expect(hit).not.toBeNull();
    expect(dataset.getRow(hit?.row ?? -1)).toEqual(hit?.feature);
  });
});
