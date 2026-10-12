// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The features of the measurement of the layers held as rows, made in the page (no network)
 *
 * The page and its Worker make the same features from the same parameters: the Worker builds
 * them into row groups, the page loads them into the Store as features, so both ways of holding
 * them draw the same map.
 */

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
}

/** The parameters of the page */
export interface TableBenchPageParams extends TableBenchParams {
  /** How the features are held: as rows of columns, or as features of the Store */
  readonly mode: 'table' | 'store';
  /** The number of places the ranges drawn are cut at (rows only) */
  readonly cuts: number;
  /** The heap the run stops at (MB) */
  readonly limitMb: number;
}

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
  return {
    n,
    kind,
    styles: Math.max(1, Math.min(n, number('styles', 1))),
    translucent: params.get('alpha') !== '0',
    mode: params.get('mode') === 'store' ? 'store' : 'table',
    cuts: number('cuts', 0),
    limitMb: Math.max(1, number('limit', 1024)),
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
  readonly type: 'Point' | 'LineString' | 'Polygon';
  readonly geometry:
    | { type: 'Point'; coordinates: [number, number] }
    | { type: 'LineString'; coordinates: [number, number][] }
    | { type: 'Polygon'; coordinates: [number, number][][] };
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
