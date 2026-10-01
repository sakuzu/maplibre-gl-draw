// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * No sample feature over the Imperial Palace
 *
 * The examples, the scenes of the playground and the development page of the standard UI place
 * their features around Tokyo Station on its east side, or elsewhere. None may lie over the
 * Imperial Palace in Tokyo, its East Gardens and Kitanomaru Park: the box from longitude
 * 139.7430 to 139.7650 and from latitude 35.6760 to 35.6950.
 *
 * The test imports the data of every page (examples/<name>/data.ts, the scene data of
 * playground/showcase/ and ui/dev/data.ts) without a browser, walks every value they export, and
 * fails when anything reaches into the box: a position, an edge of a line or of an area (a bare
 * list of positions is taken as a line), the inside of an area, or a circle or an image with its
 * size. An exported function without parameters makes the data of a page (the large ones are
 * made in code): it is called and what it returns is walked. A page keeps the data it draws in
 * its data.ts for this test to see; what a page makes in the browser (the city of the large-data
 * scene, the points a dataset fetches for the view) is not checked.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The Imperial Palace, its East Gardens and Kitanomaru Park */
const PALACE = { west: 139.743, east: 139.765, south: 35.676, north: 35.695 };

/**
 * A circle or an image larger than this is a shape of a continent (the 2,500 km around Tokyo of
 * the globe scene), not a drawing over the palace
 */
const LARGEST_CHECKED_RADIUS_METERS = 10_000;

/** Examples whose data is being reworked elsewhere and is checked once that work is in */
const NOT_YET_CHECKED = new Set(['style-features']);

const RADIUS = 'maplibre-gl-draw:radiusMeters';
const CREATED_ZOOM = 'maplibre-gl-draw:createdZoom';
const IMAGE_WIDTH = 'maplibre-gl-draw:imageWidth';
const IMAGE_HEIGHT = 'maplibre-gl-draw:imageHeight';

type Position = [number, number];

/** The data modules of the pages, by a name to report */
function dataModules(): Array<[string, string]> {
  const examples = readdirSync(join(ROOT, 'examples'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !NOT_YET_CHECKED.has(entry.name))
    .map((entry) => join('examples', entry.name, 'data.ts'))
    .filter((file) => existsSync(join(ROOT, file)));
  return [
    ...examples,
    // The overview (the tilted scene shows the same drawing), the globe and the terrain. The
    // large-data scene makes its city from the map in the browser, west of the palace
    'playground/showcase/overview-data.ts',
    'playground/showcase/globe.ts',
    'playground/showcase/terrain.ts',
    'ui/dev/data.ts',
  ].map((file) => [file, join(ROOT, file)]);
}

function isPosition(value: unknown): value is Position {
  return (
    Array.isArray(value) &&
    (value.length === 2 || value.length === 3) &&
    value.every((n) => typeof n === 'number')
  );
}

function inPalace([lng, lat]: Position): boolean {
  return lng >= PALACE.west && lng <= PALACE.east && lat >= PALACE.south && lat <= PALACE.north;
}

/** Whether the segment from `a` to `b` passes through the box (Liang-Barsky clipping) */
function segmentInPalace(a: Position, b: Position): boolean {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  let [t0, t1] = [0, 1];
  const sides: Array<[number, number]> = [
    [-dx, a[0] - PALACE.west],
    [dx, PALACE.east - a[0]],
    [-dy, a[1] - PALACE.south],
    [dy, PALACE.north - a[1]],
  ];
  for (const [p, q] of sides) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

/** Whether the rings (the outer one and its holes, by the even-odd rule) hold the box's center */
function ringsHoldPalace(rings: Position[][]): boolean {
  const [x, y] = [(PALACE.west + PALACE.east) / 2, (PALACE.south + PALACE.north) / 2];
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** The distance in meters from a position to the box, 0 inside it */
function metersToPalace([lng, lat]: Position): number {
  const dLng = Math.max(PALACE.west - lng, 0, lng - PALACE.east);
  const dLat = Math.max(PALACE.south - lat, 0, lat - PALACE.north);
  const metersPerDegree = 111_320;
  return Math.hypot(
    dLng * metersPerDegree * Math.cos((lat * Math.PI) / 180),
    dLat * metersPerDegree,
  );
}

/** Collects what reaches into the box, with where it was found */
class Walker {
  readonly hits: string[] = [];
  private readonly seen = new WeakSet<object>();

  walk(value: unknown, path: string): void {
    if (typeof value === 'function') {
      if (value.length === 0) this.walk(value(), `${path}()`);
      return;
    }
    if (value === null || typeof value !== 'object' || this.seen.has(value)) return;
    this.seen.add(value);

    if (value instanceof Float64Array || value instanceof Float32Array) {
      // The coordinates of a columnar table: x and y of each row in turn
      for (let i = 0; i + 1 < value.length; i += 2) {
        this.point([value[i], value[i + 1]], `${path}[${i / 2}]`);
      }
      return;
    }
    if (isPosition(value)) {
      this.point(value, path);
      return;
    }
    if (Array.isArray(value)) {
      if (value.length > 1 && value.every(isPosition)) {
        this.line(value, path);
        return;
      }
      value.forEach((item, i) => {
        this.walk(item, `${path}[${i}]`);
      });
      return;
    }
    const record = value as Record<string, unknown>;
    if (this.geometry(record, path)) return;
    this.feature(record, path);
    for (const [key, item] of Object.entries(record)) this.walk(item, `${path}.${key}`);
  }

  private point(position: Position, path: string): void {
    if (inPalace(position)) this.hits.push(`${path}: ${position.join(', ')}`);
  }

  private line(positions: Position[], path: string): void {
    for (const [i, position] of positions.entries()) {
      if (inPalace(position)) {
        this.hits.push(`${path}[${i}]: ${position.join(', ')}`);
        return;
      }
      if (i > 0 && segmentInPalace(positions[i - 1], position)) {
        this.hits.push(`${path}: the edge ${i - 1} to ${i} crosses it`);
        return;
      }
    }
  }

  private polygon(rings: Position[][], path: string): void {
    rings.forEach((ring, i) => {
      this.line(ring, `${path}[${i}]`);
    });
    if (ringsHoldPalace(rings)) this.hits.push(`${path}: the area holds it`);
  }

  /** A GeoJSON geometry, walked by its type; false for anything else */
  private geometry(record: Record<string, unknown>, path: string): boolean {
    const { type, coordinates } = record;
    if (typeof type !== 'string' || coordinates === undefined) return false;
    const at = `${path}.coordinates`;
    switch (type) {
      case 'Point':
        this.walk(coordinates, at);
        return true;
      case 'MultiPoint':
        for (const [i, position] of (coordinates as Position[]).entries()) {
          this.point(position, `${at}[${i}]`);
        }
        return true;
      case 'LineString':
        this.line(coordinates as Position[], at);
        return true;
      case 'MultiLineString':
        for (const [i, line] of (coordinates as Position[][]).entries()) {
          this.line(line, `${at}[${i}]`);
        }
        return true;
      case 'Polygon':
        this.polygon(coordinates as Position[][], at);
        return true;
      case 'MultiPolygon':
        for (const [i, rings] of (coordinates as Position[][][]).entries()) {
          this.polygon(rings, `${at}[${i}]`);
        }
        return true;
      default:
        return false;
    }
  }

  /** A circle with its radius, or an image with its size, as a disc around its center */
  private feature(record: Record<string, unknown>, path: string): void {
    const geometry = record.geometry as { type?: unknown; coordinates?: unknown } | undefined;
    const properties = record.properties as Record<string, unknown> | undefined;
    if (geometry?.type !== 'Point' || !isPosition(geometry.coordinates) || !properties) return;
    const center = geometry.coordinates;
    let radius = 0;
    if (typeof properties[RADIUS] === 'number') radius = properties[RADIUS];
    const [width, height, zoom] = [
      properties[IMAGE_WIDTH],
      properties[IMAGE_HEIGHT],
      properties[CREATED_ZOOM],
    ];
    if (typeof width === 'number' && typeof height === 'number' && typeof zoom === 'number') {
      // The size in pixels at the zoom it was placed at, in meters there
      const metersPerPixel =
        (40_075_016.686 * Math.cos((center[1] * Math.PI) / 180)) / (512 * 2 ** zoom);
      radius = (Math.hypot(width, height) / 2) * metersPerPixel;
    }
    if (radius > 0 && radius <= LARGEST_CHECKED_RADIUS_METERS) {
      if (metersToPalace(center) < radius) {
        this.hits.push(`${path}: ${Math.round(radius)} m around ${center.join(', ')}`);
      }
    }
  }
}

describe('the sample geometry', () => {
  const modules = dataModules();

  it('finds the data of the pages', () => {
    expect(modules.length).toBeGreaterThan(10);
  });

  it.each(modules)('of %s stays off the Imperial Palace', async (_name, file) => {
    const exports: Record<string, unknown> = await import(pathToFileURL(file).href);
    const walker = new Walker();
    for (const [key, value] of Object.entries(exports)) walker.walk(value, key);
    // The first few, and how many there are in all
    const { hits } = walker;
    expect(hits.length > 10 ? [...hits.slice(0, 10), `${hits.length} in all`] : hits).toEqual([]);
  });
});
