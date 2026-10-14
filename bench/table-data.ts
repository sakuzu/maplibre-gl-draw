// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The features of the measurement of the layers held as rows
 *
 * The page and its Worker make the same features from the same parameters: the Worker builds
 * them into row groups, the page loads them into the Store as features, so both ways of holding
 * them draw the same map. The features are made in the page (no network), or read from a
 * GeoJSON file put in `bench/data/` (`data=<file>`: a FeatureCollection, or one feature per line
 * for a name ending in `.ndjson` or `.geojsonl`), from the same origin. Nothing is fetched from
 * elsewhere.
 */

import type { Geometry } from 'geojson';

/** What the features are made of */
export interface TableBenchParams {
  /** The number of features */
  readonly n: number;
  /** The kind of the features */
  readonly kind: 'point' | 'line' | 'polygon5' | 'polygon50' | 'mixed';
  /** The number of distinct styles (at most one per feature) */
  readonly styles: number;
  /** Whether the fills, the lines and the points are translucent */
  readonly translucent: boolean;
  /** The file of `bench/data/` the features are read from (made in the page when empty) */
  readonly data: string;
  /** Whether the rows are put in an order at random rather than in the order of the file */
  readonly shuffle: boolean;
}

/** The parameters of the page */
export interface TableBenchPageParams extends TableBenchParams {
  /** How the features are held: as rows of columns, or as features of the Store */
  readonly mode: 'table' | 'store';
  /**
   * How the rows are drawn (rows only): in one draw per chunk with rows of every kind, or with
   * one renderer per kind (the drawing of the terrain and the globe), to compare the two
   */
  readonly drawing: 'one-draw' | 'by-kind';
  /** The number of places the ranges drawn are cut at (rows only) */
  readonly cuts: number;
  /** The heap the run stops at (MB) */
  readonly limitMb: number;
  /** The edit the edit button repeats (`EDIT_OPS`) */
  readonly op: EditOp;
  /** The times an edit is repeated */
  readonly reps: number;
  /** The kind of the changes of others the stream button sends */
  readonly remote: RemoteKind;
  /** The rows the stream changes per second */
  readonly rate: number;
  /** The seconds the stream runs */
  readonly seconds: number;
  /**
   * The style rule the sliding of the rule moves: a graduated rule on an attribute of numbers
   * (`key:break,break,...`)
   */
  readonly rule: { readonly key: string; readonly breaks: readonly number[] };
  /** The rows the import of others writes (`remote=import`) */
  readonly importN: number;
  /** The rows of one write of the import of others (a transaction) */
  readonly txn: number;
  /** The groups of features the reorders of others move (`remote=group`), and their members */
  readonly groups: number;
  readonly members: number;
  /**
   * The time the chunks of the next versions of row groups may take to build in a frame while
   * the camera moves (0: they are built once it is still)
   */
  readonly moving: number;
  /** Whether the large merges and builds of rows run in a Worker of the page */
  readonly worker: boolean;
  /**
   * The vertices of a large area put under every row (an administrative area, a land use: what
   * the pointer moves over between the buildings; 0 for none)
   */
  readonly bigArea: number;
  /** The rows the edits of many rows held select and move or keep while panning */
  readonly held: number;
  /**
   * The number of rows held from which a row held moved as a whole is drawn moved by its state
   * (`moveHeldByStateFrom` of the tables; null for the default of the library)
   */
  readonly moveFrom: number | null;
}

/**
 * The edits a page repeats: written to the rows (`color1` to `finish`), made as the select mode
 * makes them, a feature at a time (`hover` to `delete`): the pointer moved over the map, a click
 * that selects and shows the handles, a vertex added by a drag of a midpoint, a vertex taken off
 * and put back, a feature selected and deleted; and the edits of many rows (`moveHeld` to
 * `undoRedo`): `held` rows selected and dragged, `held` rows selected while the map pans,
 * `members` rows grouped and ungrouped, put in another layer and back, one row and `members`
 * rows brought to the front and sent to the back, an edit of `members` rows undone and redone,
 * and a box drawn with Shift grown and shrunk over the map (`boxHeld`)
 */
export const EDIT_OPS = [
  'color1',
  'colorSlide',
  'ruleSlide',
  'attr',
  'point',
  'longLine',
  'corner',
  'finish',
  'hover',
  'click',
  'vertexAdd',
  'vertexRemove',
  'delete',
  'moveHeld',
  'panHeld',
  'group',
  'toLayer',
  'order1',
  'orderMany',
  'undoRedo',
  'boxHeld',
] as const;

/** An edit a page repeats */
export type EditOp = (typeof EDIT_OPS)[number];

/**
 * The kinds of the changes of others the stream sends: written in place (colors, attributes,
 * positions of points, corners of buildings), and placed elsewhere (rows put in another place of
 * the order, groups of features put in another place, a vertex added to a building past its
 * place, new rows imported a transaction at a time)
 */
export const REMOTE_KINDS = [
  'color',
  'attr',
  'position',
  'corner',
  'reorder',
  'group',
  'vertex',
  'import',
] as const;

/** A kind of the changes of others */
export type RemoteKind = (typeof REMOTE_KINDS)[number];

const KINDS = ['point', 'line', 'polygon5', 'polygon50', 'mixed'] as const;

/** Reads the parameters of the address */
export function parseParams(search: string): TableBenchPageParams {
  const params = new URLSearchParams(search);
  const number = (key: string, fallback: number): number => {
    const value = Number(params.get(key) ?? fallback);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
  };
  const kind = KINDS.find((k) => k === params.get('kind')) ?? 'mixed';
  const n = Math.max(1, number('n', 10_000));
  const [ruleKey, ruleBreaks] = (params.get('rule') ?? 'value:25,50,75').split(':');
  const breaks = (ruleBreaks ?? '')
    .split(',')
    .map(Number)
    .filter((value) => Number.isFinite(value));
  return {
    n,
    kind,
    styles: Math.max(1, Math.min(n, number('styles', 1))),
    translucent: params.get('alpha') !== '0',
    data: (params.get('data') ?? '').replace(/[^\w.-]/g, ''),
    shuffle: params.get('shuffle') === '1',
    mode: params.get('mode') === 'store' ? 'store' : 'table',
    drawing: params.get('drawing') === 'by-kind' ? 'by-kind' : 'one-draw',
    cuts: number('cuts', 0),
    limitMb: Math.max(1, number('limit', 1024)),
    op: EDIT_OPS.find((op) => op === params.get('op')) ?? 'color1',
    reps: Math.max(1, number('reps', 100)),
    remote: REMOTE_KINDS.find((kind) => kind === params.get('remote')) ?? 'color',
    rate: Math.max(1, number('rate', 10)),
    seconds: Math.max(1, number('seconds', 10)),
    rule: { key: ruleKey || 'value', breaks: breaks.length > 0 ? breaks : [25, 50, 75] },
    importN: Math.max(1, number('importN', 100_000)),
    txn: Math.max(1, number('txn', 1000)),
    groups: Math.max(1, number('groups', 20)),
    members: Math.max(1, number('members', 50)),
    moving: number('moving', 0),
    worker: params.get('worker') !== '0',
    bigArea: number('bigArea', 0),
    held: Math.max(1, number('held', 2000)),
    moveFrom: (params.get('moveFrom') ?? '') === '' ? null : number('moveFrom', 0),
  };
}

/** The center of the features (Tokyo) */
export const CENTER: [number, number] = [139.7, 35.68];

/** The side of the cell of one feature, in degrees */
const CELL = 0.003;

/** The extent of the features, `[west, south, east, north]` */
export function extentOf(params: TableBenchParams): [number, number, number, number] {
  const columns = Math.ceil(Math.sqrt(params.n));
  const rows = Math.ceil(params.n / columns);
  const west = CENTER[0] - (columns * CELL) / 2;
  const south = CENTER[1] - (rows * CELL) / 2;
  return [west, south, west + columns * CELL, south + rows * CELL];
}

/** One feature as both ways of holding it take it */
export interface BenchFeature {
  readonly id: string;
  readonly type: Geometry['type'];
  readonly geometry: Geometry;
  readonly style: Record<string, unknown>;
  readonly properties: Record<string, unknown>;
  /** The key of its order (the features are in the order of their number) */
  readonly order: string;
}

/** The kind of the `i`-th feature (a mixed map takes the kinds in turn) */
function kindOf(params: TableBenchParams, i: number): Exclude<TableBenchParams['kind'], 'mixed'> {
  if (params.kind !== 'mixed') return params.kind;
  return (['point', 'line', 'polygon5', 'polygon50'] as const)[i % 4];
}

/** The styles of the features, made once per run */
export function stylesOf(params: TableBenchParams): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let k = 0; k < params.styles; k++) {
    const color = hslHex((k * 137.508) % 360, 0.65, 0.5);
    const stroke = hslHex((k * 137.508 + 180) % 360, 0.6, 0.35);
    out.push({
      fillColor: color,
      fillOpacity: params.translucent ? 0.5 : 1,
      strokeColor: stroke,
      strokeOpacity: params.translucent ? 0.8 : 1,
      strokeWidth: 1 + (k % 3),
      pointColor: color,
      pointOpacity: params.translucent ? 0.7 : 1,
      pointRadius: 4 + (k % 3),
    });
  }
  return out;
}

/** The `i`-th feature */
export function benchFeature(
  params: TableBenchParams,
  styles: readonly Record<string, unknown>[],
  i: number,
): BenchFeature {
  const columns = Math.ceil(Math.sqrt(params.n));
  const [west, south] = extentOf(params);
  const x = west + (i % columns) * CELL;
  const y = south + Math.floor(i / columns) * CELL;
  const s = CELL * 0.8;
  const base = {
    id: `f${i}`,
    style: styles[i % styles.length],
    properties: { name: `feature ${i}`, value: i % 97 },
    order: `k${String(i).padStart(8, '0')}`,
  };
  switch (kindOf(params, i)) {
    case 'point':
      return {
        ...base,
        type: 'Point',
        geometry: { type: 'Point', coordinates: [x + s / 2, y + s / 2] },
      };
    case 'line': {
      // A zigzag of 10 coordinates
      const coordinates: [number, number][] = [];
      for (let k = 0; k < 10; k++) coordinates.push([x + (s * k) / 9, y + (k % 2 === 0 ? 0 : s)]);
      return { ...base, type: 'LineString', geometry: { type: 'LineString', coordinates } };
    }
    case 'polygon5': {
      const ring: [number, number][] = [
        [x, y],
        [x + s, y],
        [x + s, y + s],
        [x, y + s],
        [x, y],
      ];
      return { ...base, type: 'Polygon', geometry: { type: 'Polygon', coordinates: [ring] } };
    }
    case 'polygon50': {
      // A polygon of 49 corners and its closing coordinate
      const ring: [number, number][] = [];
      for (let k = 0; k < 49; k++) {
        const a = (k / 49) * Math.PI * 2;
        ring.push([x + s / 2 + (s / 2) * Math.cos(a), y + s / 2 + (s / 2) * Math.sin(a)]);
      }
      ring.push(ring[0]);
      return { ...base, type: 'Polygon', geometry: { type: 'Polygon', coordinates: [ring] } };
    }
  }
}

/** A color of HSL as `#rrggbb` */
function hslHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  const hex = (v: number): string =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

// === Features read from a file ===

/** The geometry types a row holds */
const ROW_GEOMETRIES = new Set([
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
]);

/**
 * The features of a GeoJSON text: a FeatureCollection, or one feature per line (`ndjson`).
 * A feature without a geometry a row holds is left out; the ids are made unique by their place
 */
export function featuresOfText(
  text: string,
  lines: boolean,
  params: TableBenchParams,
): BenchFeature[] {
  const styles = stylesOf(params);
  const raw: Array<{ id?: unknown; geometry?: Geometry | null; properties?: unknown }> = lines
    ? text
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line))
    : (JSON.parse(text).features ?? []);
  const out: BenchFeature[] = [];
  const count = raw.length;
  // The order of the rows: the one of the file, or one at random (the same for a seed)
  const order = Array.from({ length: count }, (_, i) => i);
  if (params.shuffle) {
    let seed = 1;
    for (let i = count - 1; i > 0; i--) {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      const j = seed % (i + 1);
      [order[i], order[j]] = [order[j], order[i]];
    }
  }
  for (let i = 0; i < count; i++) {
    const feature = raw[i];
    const geometry = feature.geometry;
    if (!geometry || !ROW_GEOMETRIES.has(geometry.type)) continue;
    const properties =
      feature.properties && typeof feature.properties === 'object'
        ? (feature.properties as Record<string, unknown>)
        : {};
    out.push({
      id: `${i}:${String(feature.id ?? '')}`,
      type: geometry.type,
      geometry,
      style: styles[i % styles.length],
      properties: withoutNulls(properties),
      order: `k${String(order[i]).padStart(9, '0')}`,
    });
  }
  return out;
}

/** The attributes without their nested nulls kept as they are (a value of a row is any JSON) */
function withoutNulls(properties: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value === undefined) continue;
    if (typeof value === 'number' && !Number.isFinite(value)) continue;
    out[key] = value;
  }
  return out;
}

/** The extent of features, `[west, south, east, north]` */
export function extentOfFeatures(
  features: readonly BenchFeature[],
): [number, number, number, number] {
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === 'number') {
      const [x, y] = value as number[];
      if (x < west) west = x;
      if (x > east) east = x;
      if (y < south) south = y;
      if (y > north) north = y;
      return;
    }
    for (const item of value) visit(item);
  };
  for (const feature of features) {
    visit((feature.geometry as { coordinates?: unknown }).coordinates);
  }
  if (west > east) return [CENTER[0], CENTER[1], CENTER[0], CENTER[1]];
  return [west, south, east, north];
}

// === The rows the edits change ===

/** The rows the edits and the stream change, chosen once */
export interface BenchCandidates {
  /** A point (its first) */
  readonly point: string | null;
  /** The line of the most vertices */
  readonly line: string | null;
  /** A polygon of the fewest corners of 4 or more (a building) */
  readonly polygon: string | null;
  /** Rows at random (up to 2,000) */
  readonly ids: readonly string[];
  /** Points at random (up to 2,000) */
  readonly points: readonly string[];
  /** Polygons at random (up to 2,000) */
  readonly polygons: readonly string[];
}

/** The rows the edits change, from the features */
export function candidatesOf(features: readonly BenchFeature[]): BenchCandidates {
  let point: string | null = null;
  let line: string | null = null;
  let lineVertices = 0;
  let polygon: string | null = null;
  let polygonCorners = Number.POSITIVE_INFINITY;
  const ids: string[] = [];
  const points: string[] = [];
  const polygons: string[] = [];
  const step = Math.max(1, Math.floor(features.length / 2000));
  features.forEach((feature, i) => {
    const geometry = feature.geometry;
    if (geometry.type === 'Point') {
      point ??= feature.id;
      if (i % step === 0) points.push(feature.id);
    } else if (geometry.type === 'LineString') {
      if (geometry.coordinates.length > lineVertices) {
        lineVertices = geometry.coordinates.length;
        line = feature.id;
      }
    } else if (geometry.type === 'Polygon') {
      const corners = geometry.coordinates[0].length - 1;
      if (corners >= 4 && corners < polygonCorners) {
        polygonCorners = corners;
        polygon = feature.id;
      }
      if (i % step === 0) polygons.push(feature.id);
    }
    if (i % step === 0) ids.push(feature.id);
  });
  return { point, line, polygon, ids, points, polygons };
}

/**
 * A large area of `vertices` vertices around the extent of the rows (a ring a little outside it,
 * waving so that it has as many vertices as asked)
 */
export function bigAreaOf(extent: [number, number, number, number], vertices: number): Geometry {
  const [west, south, east, north] = extent;
  const cx = (west + east) / 2;
  const cy = (south + north) / 2;
  const rx = ((east - west) / 2) * 1.1 + 1e-3;
  const ry = ((north - south) / 2) * 1.1 + 1e-3;
  const n = Math.max(4, vertices - 1);
  const ring: [number, number][] = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    const wave = 1 + 0.02 * Math.sin(k * 0.7);
    ring.push([cx + rx * wave * Math.cos(a), cy + ry * wave * Math.sin(a)]);
  }
  ring.push(ring[0]);
  return { type: 'Polygon', coordinates: [ring] };
}
