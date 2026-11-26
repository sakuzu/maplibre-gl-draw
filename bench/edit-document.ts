// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The documents of the editing benchmark (`edit.html`), made without a map
 *
 * The features are laid on a square grid, one per cell, in the order of the cells: half of them
 * polygons (one in five a regular 24-gon, the others squares), three in ten lines of 5 points
 * and the rest points. They are the same on every visit (no random numbers), so two branches
 * are measured on the same document. The same features are made as a document of the library
 * (to open) and as GeoJSON (to import).
 *
 * With `dash=1` in the address of the page, one polygon in ten and one line in ten of the
 * document of the library are dashed (`dashedFromSearch`).
 */

import type { DocumentLayer, DrawDocument, Feature as DrawFeature } from '@sakuzu/maplibre-gl-draw';
import type { Feature, FeatureCollection, Geometry, Position } from 'geojson';

/** The numbers of features the page links to, from the fewest */
export const EDIT_COUNTS: readonly number[] = [1_000, 10_000, 100_000];

/** The number of features when the address does not give one */
export const DEFAULT_COUNT = 1_000;

/** The most features the address may ask for */
export const MAX_COUNT = 250_000;

/** The center of the grid (and of the camera of the page) */
export const GRID_CENTER: [number, number] = [139.55, 35.75];

/** The ID of the one layer of the document */
export const LAYER_ID = 'edit-layer';

/** The version of the format of the library */
const FORMAT_VERSION = '3.0.0';

/** The size of one cell, in degrees */
const CELL_DEG = 0.003;

/**
 * Reads the number of features from the address (`n`)
 *
 * @returns The number, or an error to show when `n` is not a whole number from 1 to
 *   {@link MAX_COUNT}
 */
export function countFromSearch(search: string): { n: number } | { error: string } {
  const value = new URLSearchParams(search).get('n');
  if (value === null || value === '') return { n: DEFAULT_COUNT };
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_COUNT) {
    return {
      error: `n=${value} is not a whole number from 1 to ${MAX_COUNT.toLocaleString('en')}`,
    };
  }
  return { n };
}

/**
 * Reads the time a scene may run once it is prepared from the address (`run`, in ms)
 *
 * @returns The time (null when `run` is not given: a scene may take the limit of the page,
 *   preparation included), or an error to show when it is not a whole number of 0 or more
 */
export function runLimitFromSearch(search: string): { runMs: number | null } | { error: string } {
  const value = new URLSearchParams(search).get('run');
  if (value === null || value === '') return { runMs: null };
  const runMs = Number(value);
  if (!Number.isInteger(runMs) || runMs < 0) {
    return { error: `run=${value} is not a whole number of milliseconds, 0 or more` };
  }
  return { runMs };
}

/**
 * Reads from the address whether the map has the terrain of the page (`terrain`: `1` with it,
 * `0` or nothing without it)
 *
 * @returns Whether it has, or an error to show for another value
 */
export function terrainFromSearch(search: string): { terrain: boolean } | { error: string } {
  const value = new URLSearchParams(search).get('terrain');
  if (value === null || value === '' || value === '0') return { terrain: false };
  if (value === '1') return { terrain: true };
  return { error: `terrain=${value} is neither 1 nor 0` };
}

/**
 * Reads from the address whether one polygon in ten and one line in ten of the document of the
 * library are dashed (`dash=1`)
 */
export function dashedFromSearch(search: string): boolean {
  return new URLSearchParams(search).get('dash') === '1';
}

/** The extent of the grid of `n` features */
export interface GridExtent {
  readonly columns: number;
  readonly rows: number;
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

/** The grid of `n` features, centered on {@link GRID_CENTER} */
export function gridOf(n: number): GridExtent {
  const columns = Math.max(1, Math.ceil(Math.sqrt(n)));
  const rows = Math.max(1, Math.ceil(n / columns));
  const west = GRID_CENTER[0] - (columns * CELL_DEG) / 2;
  const south = GRID_CENTER[1] - (rows * CELL_DEG) / 2;
  return {
    columns,
    rows,
    west,
    south,
    east: west + columns * CELL_DEG,
    north: south + rows * CELL_DEG,
  };
}

/** The shape of one feature: its ID, its type and its geometry */
interface Shape {
  readonly id: string;
  readonly type: 'Polygon' | 'LineString' | 'Point';
  readonly geometry: Geometry;
}

function squareRing(x: number, y: number): Position[] {
  const s = CELL_DEG * 0.8;
  return [
    [x, y],
    [x + s, y],
    [x + s, y + s],
    [x, y + s],
    [x, y],
  ];
}

function polygon24Ring(x: number, y: number): Position[] {
  const r = CELL_DEG * 0.4;
  const cx = x + CELL_DEG * 0.4;
  const cy = y + CELL_DEG * 0.4;
  const ring: Position[] = [];
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    ring.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  ring.push(ring[0]);
  return ring;
}

function zigzagLine(x: number, y: number): Position[] {
  const s = CELL_DEG * 0.8;
  return [
    [x, y],
    [x + s * 0.25, y + s],
    [x + s * 0.5, y],
    [x + s * 0.75, y + s],
    [x + s, y],
  ];
}

/**
 * The kinds of ten cells in turn of the interleaved document: as many polygons, lines and points
 * as the others hold (5, 3 and 2 in 10), one kind after another
 */
const INTERLEAVED_KINDS = ['p', 'l', 'pt', 'p', 'l', 'p', 'l', 'p', 'pt', 'p'] as const;

/**
 * The shapes of `n` features, in the order of the cells: the polygons first, then the lines, then
 * the points, or with `interleaved` one kind after another along the cells
 */
function makeShapes(n: number, interleaved = false): Shape[] {
  const grid = gridOf(n);
  const polygons = Math.floor(n * 0.5);
  const lines = Math.floor(n * 0.3);
  const shapes: Shape[] = [];
  for (let i = 0; i < n; i++) {
    const x = grid.west + (i % grid.columns) * CELL_DEG;
    const y = grid.south + Math.floor(i / grid.columns) * CELL_DEG;
    const kind = interleaved
      ? INTERLEAVED_KINDS[i % INTERLEAVED_KINDS.length]
      : i < polygons
        ? 'p'
        : i < polygons + lines
          ? 'l'
          : 'pt';
    if (kind === 'p') {
      const ring = i % 5 === 4 ? polygon24Ring(x, y) : squareRing(x, y);
      shapes.push({
        id: `p-${i}`,
        type: 'Polygon',
        geometry: { type: 'Polygon', coordinates: [ring] },
      });
    } else if (kind === 'l') {
      shapes.push({
        id: `l-${i}`,
        type: 'LineString',
        geometry: { type: 'LineString', coordinates: zigzagLine(x, y) },
      });
    } else {
      shapes.push({
        id: `pt-${i}`,
        type: 'Point',
        geometry: { type: 'Point', coordinates: [x + CELL_DEG * 0.4, y + CELL_DEG * 0.4] },
      });
    }
  }
  return shapes;
}

function layerOf(items: readonly string[]): DocumentLayer {
  return {
    id: LAYER_ID,
    name: 'Features',
    visible: true,
    locked: false,
    opacity: 1,
    items,
    styleRule: undefined,
    metadata: undefined,
  };
}

/**
 * A document of the library with `n` features in one layer (with `interleaved`, its polygons,
 * lines and points one kind after another)
 *
 * With `dash=1` in the address of the page, the polygons and the lines are counted apart, each
 * kind in the order of the document from 0, and those whose number is a multiple of 10 are
 * dashed; the points are not. In the document of polygons, lines and points one kind after the
 * other, with a number of features that is a multiple of 20, those are the features that are not
 * points whose number in the document is a multiple of 10.
 */
export function makeDocument(n: number, interleaved = false): DrawDocument {
  const dashed = dashedFromSearch(globalThis.location?.search ?? '');
  const seen = { Polygon: 0, LineString: 0, Point: 0 };
  const features: DrawFeature[] = makeShapes(n, interleaved).map((shape) => ({
    id: shape.id,
    type: shape.type,
    geometry: shape.geometry,
    layerId: LAYER_ID,
    groupId: undefined,
    properties: {},
    style:
      dashed && shape.type !== 'Point' && seen[shape.type]++ % 10 === 0
        ? { lineStyle: 'dashed' }
        : {},
    visible: true,
    locked: false,
  }));
  return {
    version: FORMAT_VERSION,
    layers: [layerOf(features.map((f) => f.id))],
    layerOrder: [LAYER_ID],
    groups: [],
    features,
    files: {},
  };
}

/** A document of the library with the one layer and no features */
export function makeEmptyDocument(): DrawDocument {
  return makeDocument(0);
}

/** The same `n` features as GeoJSON, their IDs under the key of the library */
export function makeFeatureCollection(n: number): FeatureCollection {
  const features: Feature[] = makeShapes(n).map((shape) => ({
    type: 'Feature',
    geometry: shape.geometry,
    properties: { 'maplibre-gl-draw:id': shape.id },
  }));
  return { type: 'FeatureCollection', features };
}

/** The IDs of the `n` features, in the order of the document */
export function featureIdsOf(n: number): string[] {
  return makeShapes(n).map((shape) => shape.id);
}
