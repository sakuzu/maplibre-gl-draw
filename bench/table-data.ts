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
   * The Workers the rows of the opening are made (or read) and built in, each a run of the
   * order (0: one per logical core but one, at most {@link MAX_OPEN_WORKERS})
   */
  readonly workers: number;
  /**
   * The vertices of a large area put under every row (an administrative area, a land use: what
   * the pointer moves over between the buildings; 0 for none)
   */
  readonly bigArea: number;
  /** The number of rows the edits of many rows select and move, or keep selected while panning */
  readonly held: number;
  /**
   * The number of rows held from which a row held moved as a whole is drawn moved by its state
   * (`moveOpenedByStateFrom` of the tables; null for the default of the library)
   */
  readonly moveFrom: number | null;
  /**
   * Whether the map has the terrain on (`terrain=1`): the elevation tiles of the examples, as a
   * raster-dem source of the map, under `map.setTerrain`
   */
  readonly terrain: boolean;
}

/**
 * The edits a page repeats: written to the rows (`color1` to `finish`), made as the select mode
 * makes them, a feature at a time (`hover` to `delete`): the pointer moved over the map, a click
 * that selects and shows the handles, a vertex added by a drag of a midpoint, a vertex taken off
 * and put back, a feature selected and deleted; and the edits of many rows (`moveSelected`
 * to `undoRedo`): `held` rows selected and dragged, `held` rows selected while the map pans,
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
  'moveSelected',
  'panSelected',
  'group',
  'toLayer',
  'order1',
  'orderMany',
  'undoRedo',
  'boxHeld',
  'selectAll',
  'bulkMove',
  'bulkRotate',
  'bulkResize',
  'bulkColor',
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
    workers: number('workers', 0),
    bigArea: number('bigArea', 0),
    held: Math.max(1, number('held', 2000)),
    moveFrom: (params.get('moveFrom') ?? '') === '' ? null : number('moveFrom', 0),
    terrain: params.get('terrain') === '1',
  };
}

/** The most Workers the rows of the opening are made (or read) and built in */
export const MAX_OPEN_WORKERS = 8;

/**
 * The Workers the rows of the opening are made (or read) and built in: the number asked, or one
 * per logical core of the device but one (the page's own), at most {@link MAX_OPEN_WORKERS}
 *
 * @param cores The logical cores of the device (`navigator.hardwareConcurrency`)
 */
export function openWorkerCount(params: TableBenchPageParams, cores: number): number {
  if (params.workers > 0) return params.workers;
  return Math.max(1, Math.min(MAX_OPEN_WORKERS, (cores || 2) - 1));
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

/** A feature as a file holds it */
export type RawFeature = { id?: unknown; geometry?: Geometry | null; properties?: unknown };

/**
 * The order of the lines of a file: the place of each line in the order of the rows, the one of
 * the file or one at random (the same for a seed)
 */
export function lineOrder(count: number, shuffle: boolean): Int32Array {
  const order = new Int32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;
  if (shuffle) {
    let seed = 1;
    for (let i = count - 1; i > 0; i--) {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      const j = seed % (i + 1);
      [order[i], order[j]] = [order[j], order[i]];
    }
  }
  return order;
}

/** Whether a feature of a file has a geometry a row holds */
export function holdsRow(raw: RawFeature): boolean {
  return !!raw.geometry && ROW_GEOMETRIES.has(raw.geometry.type);
}

/**
 * The feature of the `i`-th line of a file at the place `order` of the order of the rows (null for
 * a line without a geometry a row holds); its id is made unique by its line
 */
export function featureOfLine(
  raw: RawFeature,
  i: number,
  order: number,
  styles: readonly Record<string, unknown>[],
): BenchFeature | null {
  const geometry = raw.geometry;
  if (!geometry || !ROW_GEOMETRIES.has(geometry.type)) return null;
  const properties =
    raw.properties && typeof raw.properties === 'object'
      ? (raw.properties as Record<string, unknown>)
      : {};
  return {
    id: `${i}:${String(raw.id ?? '')}`,
    type: geometry.type,
    geometry,
    style: styles[i % styles.length],
    properties: withoutNulls(properties),
    order: `k${String(order).padStart(9, '0')}`,
  };
}

/**
 * Whether a line of a file of one feature per line holds a feature: it has a character other than
 * the blanks of JSON (space, tab, carriage return), read the same from its text and from its bytes
 * (`countFeatureLines`)
 */
export function isFeatureLine(line: string): boolean {
  return /[^ \t\r\n]/.test(line);
}

/**
 * Counts the lines that hold a feature in bytes of a file, as `isFeatureLine` reads them, a part
 * of the file at a time
 *
 * @param open Whether the line the bytes begin in has a character other than a blank already
 * @returns The lines ended in the bytes that hold a feature, and whether the line they end in has
 *   such a character
 */
export function countFeatureLines(
  bytes: Uint8Array,
  open: boolean,
): { lines: number; open: boolean } {
  let lines = 0;
  let filled = open;
  for (let k = 0; k < bytes.length; k++) {
    const b = bytes[k];
    if (b === 10) {
      if (filled) lines++;
      filled = false;
    } else if (b !== 32 && b !== 9 && b !== 13) {
      filled = true;
    }
  }
  return { lines, open: filled };
}

/** The features of a file as text, one feature per line (`ndjson`) or a FeatureCollection */
export function rawFeaturesOf(text: string, lines: boolean): RawFeature[] {
  return lines
    ? text
        .split('\n')
        .filter(isFeatureLine)
        .map((line) => JSON.parse(line))
    : (JSON.parse(text).features ?? []);
}

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
  const raw = rawFeaturesOf(text, lines);
  const order = lineOrder(raw.length, params.shuffle);
  const out: BenchFeature[] = [];
  for (let i = 0; i < raw.length; i++) {
    const feature = featureOfLine(raw[i], i, order[i], styles);
    if (feature) out.push(feature);
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

/** An extent that holds nothing yet (`widenExtent` widens it) */
export function emptyExtent(): [number, number, number, number] {
  return [
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];
}

/** Widens an extent to the coordinates of a geometry */
export function widenExtent(extent: [number, number, number, number], geometry: Geometry): void {
  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === 'number') {
      const [x, y] = value as number[];
      if (x < extent[0]) extent[0] = x;
      if (x > extent[2]) extent[2] = x;
      if (y < extent[1]) extent[1] = y;
      if (y > extent[3]) extent[3] = y;
      return;
    }
    for (const item of value) visit(item);
  };
  visit((geometry as { coordinates?: unknown }).coordinates);
}

/** The union of extents (the center of the features for an extent that holds nothing) */
export function unionOfExtents(
  extents: ReadonlyArray<readonly [number, number, number, number]>,
): [number, number, number, number] {
  const out = emptyExtent();
  for (const [west, south, east, north] of extents) {
    out[0] = Math.min(out[0], west);
    out[1] = Math.min(out[1], south);
    out[2] = Math.max(out[2], east);
    out[3] = Math.max(out[3], north);
  }
  if (out[0] > out[2]) return [CENTER[0], CENTER[1], CENTER[0], CENTER[1]];
  return out;
}

/** The extent of features, `[west, south, east, north]` */
export function extentOfFeatures(
  features: readonly BenchFeature[],
): [number, number, number, number] {
  const extent = emptyExtent();
  for (const feature of features) widenExtent(extent, feature.geometry);
  return unionOfExtents([extent]);
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

/**
 * The number of features between two of the rows taken at random (about 2,000 of them, taken
 * by the place of the feature among every feature)
 */
export function candidateStep(features: number): number {
  return Math.max(1, Math.floor(features / 2000));
}

/** The kind of a feature as the rows taken at random are taken (0: neither, 1: a point, 2: a polygon) */
export function candidateKind(feature: BenchFeature): number {
  return feature.geometry.type === 'Point' ? 1 : feature.geometry.type === 'Polygon' ? 2 : 0;
}

/**
 * Picks the rows the edits change among features given in their order, each with its place
 * among every feature (a part of them at a time: the picks of the parts are put together by
 * {@link mergeCandidates})
 */
export class CandidatePicker implements CandidatePick {
  point: string | null = null;
  line: string | null = null;
  lineVertices = 0;
  polygon: string | null = null;
  polygonCorners = Number.POSITIVE_INFINITY;
  readonly ids: string[] = [];
  readonly points: string[] = [];
  readonly polygons: string[] = [];

  /** @param step The number of features between two of the rows taken at random */
  constructor(private readonly step: number) {}

  /** A feature and its place among every feature */
  add(feature: BenchFeature, index: number): void {
    this.note(feature);
    this.take(feature.id, candidateKind(feature), index);
  }

  /** A feature, for the first point, the longest line and the polygon of the fewest corners */
  note(feature: BenchFeature): void {
    const geometry = feature.geometry;
    if (geometry.type === 'Point') {
      this.point ??= feature.id;
    } else if (geometry.type === 'LineString') {
      if (geometry.coordinates.length > this.lineVertices) {
        this.lineVertices = geometry.coordinates.length;
        this.line = feature.id;
      }
    } else if (geometry.type === 'Polygon') {
      const corners = geometry.coordinates[0].length - 1;
      if (corners >= 4 && corners < this.polygonCorners) {
        this.polygonCorners = corners;
        this.polygon = feature.id;
      }
    }
  }

  /** A feature at its place, of its kind (`candidateKind`): taken when its place is on the step */
  take(id: string, kind: number, index: number): void {
    if (index % this.step !== 0) return;
    if (kind === 1) this.points.push(id);
    else if (kind === 2) this.polygons.push(id);
    this.ids.push(id);
  }
}

/** What a part of the features picked (as a Worker sends it) */
export interface CandidatePick {
  readonly point: string | null;
  readonly line: string | null;
  readonly lineVertices: number;
  readonly polygon: string | null;
  readonly polygonCorners: number;
  readonly ids: readonly string[];
  readonly points: readonly string[];
  readonly polygons: readonly string[];
}

/** The rows the edits change, from the picks of the parts of the features, in their order */
export function mergeCandidates(parts: readonly CandidatePick[]): BenchCandidates {
  const out = new CandidatePicker(1);
  for (const part of parts) {
    out.point ??= part.point;
    if (part.line !== null && part.lineVertices > out.lineVertices) {
      out.line = part.line;
      out.lineVertices = part.lineVertices;
    }
    if (part.polygon !== null && part.polygonCorners < out.polygonCorners) {
      out.polygon = part.polygon;
      out.polygonCorners = part.polygonCorners;
    }
    out.ids.push(...part.ids);
    out.points.push(...part.points);
    out.polygons.push(...part.polygons);
  }
  const { point, line, polygon, ids, points, polygons } = out;
  return { point, line, polygon, ids, points, polygons };
}

/** The rows the edits change, from the features */
export function candidatesOf(features: readonly BenchFeature[]): BenchCandidates {
  const picker = new CandidatePicker(candidateStep(features.length));
  features.forEach((feature, i) => {
    picker.add(feature, i);
  });
  return mergeCandidates([picker]);
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
