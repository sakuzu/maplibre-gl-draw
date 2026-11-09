// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The hits of the rows held as columns, tested on their columns
 *
 * - A row of a built-in type is hit on its column read in place, by the test of its type: the
 *   same answer, and the same distance, as the feature of the row (the tolerance, the ends of a
 *   line, the holes and the edges of a polygon, the parts of a `Multi`, the radius of a circle)
 * - A geometry written in place, of another shape than its column, is read where it is written
 * - Moving the pointer over a large polygon makes no feature (the test of a feature is never
 *   called)
 * - A strategy an extension registers for a built-in type, and a shape cut on the globe, test a
 *   feature of the row instead
 */

import { planarCoordinates } from '@sakuzu/tabane';
import type { Geometry } from 'geojson';
import { describe, expect, it, vi } from 'vitest';
import { hitTestLayerTable, rowHitShape } from '../../feature-table/hit-test.js';
import { rowFeature } from '../../feature-table/row-read.js';
import { writeRowGeometry } from '../../feature-table/row-write.js';
import { drawPropertyKey } from '../../shared/properties.js';
import { MemoryStore } from '../../store/memory.js';
import { RBushSpatialIndex } from '../../store/spatial/spatial-index.js';
import type { Coordinate, Feature } from '../../store/types.js';
import { circleRowRings } from '../../table/circle-rings.js';
import { FEATURE_CACHES } from '../../table/fill-triangles.js';
import { feature, seededRandom, tablesOfFeatures } from '../../test-utils.js';
import type { DrawnShapeResolver } from './globe-shape.js';
import { HitTestServiceImpl } from './service.js';

/** A ring around a center */
function ring(x: number, y: number, r: number, n: number): number[][] {
  const out = Array.from({ length: n }, (_, k) => {
    const a = (k / n) * Math.PI * 2;
    return [x + Math.cos(a) * r, y + Math.sin(a) * r];
  });
  out.push(out[0]);
  return out;
}

/** Features of every built-in type at random */
function randomFeatures(random: () => number, count: number): Feature[] {
  const out: Feature[] = [];
  for (let i = 0; i < count; i++) {
    const x = random() * 20;
    const y = random() * 20;
    const kind = i % 9;
    const id = `f${i}`;
    switch (kind) {
      case 0:
        out.push(feature(id, 'Point', [x, y]));
        break;
      case 1:
        out.push(
          feature(id, 'MultiPoint', [
            [x, y],
            [x + 1, y + 1],
            [x - 1, y],
          ]),
        );
        break;
      case 2:
        out.push(
          feature(
            id,
            'LineString',
            Array.from({ length: 2 + (i % 5) }, (_, k) => [x + k * 0.7, y + random()]),
          ),
        );
        break;
      case 3:
        out.push(
          feature(id, 'MultiLineString', [
            [
              [x, y],
              [x + 2, y],
            ],
            [
              [x, y + 2],
              [x + 1, y + 3],
              [x + 2, y + 2],
            ],
          ]),
        );
        break;
      case 4:
        // A polygon with a hole
        out.push(feature(id, 'Polygon', [ring(x, y, 2, 7), ring(x, y, 0.8, 5).reverse()]));
        break;
      case 5:
        out.push(
          feature(id, 'MultiPolygon', [
            [ring(x, y, 1, 6)],
            [ring(x + 3, y, 1, 4), ring(x + 3, y, 0.3, 4)],
          ]),
        );
        break;
      case 6:
        out.push(
          feature(id, 'Circle', [x, y], {
            properties: { [drawPropertyKey('radiusMeters')]: 50_000 + random() * 100_000 },
          }),
        );
        break;
      case 7:
        out.push(
          feature(
            id,
            'Freehand',
            Array.from({ length: 6 }, (_, k) => [x + k * 0.3, y + (k % 2)]),
          ),
        );
        break;
      default:
        // A long line (through the index of the segments as a feature)
        out.push(
          feature(
            id,
            'LineString',
            Array.from({ length: 2000 }, (_, k) => [x + k * 0.001, y + Math.sin(k / 50)]),
          ),
        );
    }
  }
  return out;
}

describe('the hits of the rows tested on their columns', () => {
  it('answer as the features of the rows, with the same distance, for every built-in type', () => {
    const random = seededRandom(7);
    const features = randomFeatures(random, 90);
    const { table, internals } = tablesOfFeatures('layer', features, 16);
    const service = new HitTestServiceImpl(new MemoryStore(), new RBushSpatialIndex());
    let hits = 0;
    let compared = 0;
    for (let g = 0; g < table.groupCount; g++) {
      const group = table.groupAt(g);
      for (let row = 0; row < group.data.length; row++) {
        const asFeature = rowFeature(internals.readContext, 'layer', group, row);
        const shape = rowHitShape(group, row);
        expect(shape).not.toBeNull();
        if (!shape) continue;
        // Clicks around the row, inside and outside its bbox
        const b = group.data.rowBounds.subarray(row * 4, row * 4 + 4);
        for (let k = 0; k < 40; k++) {
          const coordinate: Coordinate = [
            b[0] - 1 + random() * (b[2] - b[0] + 2),
            b[1] - 1 + random() * (b[3] - b[1] + 2),
          ];
          const tolerance = random() * 1.5;
          const byShape = service.hitTestShape(asFeature.type, shape, coordinate, tolerance);
          const byFeature = service.hitTestFeature(asFeature, coordinate, tolerance);
          expect(byShape).toBe(byFeature);
          const distance = service.distanceOfShape(asFeature.type, shape, coordinate, tolerance);
          const strategy = service.getStrategy(asFeature.type);
          const expected = strategy?.testDistance
            ? strategy.testDistance(asFeature, coordinate, tolerance)
            : strategy?.test(asFeature, coordinate, tolerance)
              ? strategy.distance(asFeature, coordinate)
              : null;
          expect(distance).toBe(expected);
          compared++;
          if (byFeature) hits++;
        }
      }
    }
    expect(compared).toBe(90 * 40);
    // Both answers occur
    expect(hits).toBeGreaterThan(100);
    expect(hits).toBeLessThan(compared - 100);
  });

  it('read a geometry written in place of another shape where it is written', () => {
    const square = ring(0, 0, 1, 4);
    const { table, internals } = tablesOfFeatures('layer', [feature('p', 'Polygon', [square])]);
    const group = table.groupAt(0);
    const grown: Geometry = { type: 'Polygon', coordinates: [ring(0, 0, 5, 9)] };
    writeRowGeometry(
      table,
      group,
      0,
      grown as never,
      planarCoordinates,
      circleRowRings,
      FEATURE_CACHES,
    );
    const service = new HitTestServiceImpl(new MemoryStore(), new RBushSpatialIndex());
    const shape = rowHitShape(group, 0);
    if (!shape) throw new Error('a shape');
    expect(service.hitTestShape('Polygon', shape, [4, 0], 0.01)).toBe(true);
    const asFeature = rowFeature(internals.readContext, 'layer', group, 0);
    expect(asFeature.geometry).toEqual(grown);
    expect(service.hitTestFeature(asFeature, [4, 0], 0.01)).toBe(true);
  });

  it('make no feature when the pointer moves over a large polygon', () => {
    const large = ring(0, 0, 5, 40_000);
    const { table, internals } = tablesOfFeatures('layer', [
      feature('area', 'Polygon', [large]),
      feature('house', 'Polygon', [ring(3, 3, 0.1, 4)]),
    ]);
    const service = new HitTestServiceImpl(new MemoryStore(), new RBushSpatialIndex());
    const test = vi.fn((f: Feature, c: Coordinate, t: number) => service.hitTestFeature(f, c, t));
    const input = (coordinate: Coordinate) => ({
      coordinate,
      reach: 0.01,
      toleranceOf: () => 0.01,
      testShape: (type: string, shape: never, at: Coordinate, tolerance: number) =>
        service.hitTestShape(type, shape, at, tolerance),
      test,
    });
    const random = seededRandom(3);
    for (let i = 0; i < 200; i++) {
      const at: Coordinate = [random() * 8 - 4, random() * 8 - 4];
      const hit = hitTestLayerTable(internals, table, input(at));
      const inside = Math.hypot(at[0], at[1]) < 4.9;
      if (inside) expect(hit).not.toBeNull();
    }
    expect(test).not.toHaveBeenCalled();
  });

  it('test a feature where an extension tests the type, or the globe cuts the shape', () => {
    const { table } = tablesOfFeatures('layer', [feature('p', 'Polygon', [ring(0, 0, 1, 4)])]);
    const shape = rowHitShape(table.groupAt(0), 0);
    if (!shape) throw new Error('a shape');
    const service = new HitTestServiceImpl(new MemoryStore(), new RBushSpatialIndex());
    expect(service.hitTestShape('Polygon', shape, [0, 0], 0.1)).toBe(true);
    service.registerStrategy({
      geometryType: 'Polygon',
      test: () => false,
      distance: () => 0,
    });
    expect(service.hitTestShape('Polygon', shape, [0, 0], 0.1)).toBeNull();
    expect(service.hitTestShape('Image', shape, [0, 0], 0.1)).toBeNull();
    let cuts = false;
    const resolver: DrawnShapeResolver = Object.assign((f: Feature) => f, { cuts: () => cuts });
    const onGlobe = new HitTestServiceImpl(new MemoryStore(), new RBushSpatialIndex(), {
      drawnShape: resolver,
    });
    expect(onGlobe.hitTestShape('Polygon', shape, [0, 0], 0.1)).toBe(true);
    cuts = true;
    expect(onGlobe.hitTestShape('Polygon', shape, [0, 0], 0.1)).toBeNull();
  });
});
