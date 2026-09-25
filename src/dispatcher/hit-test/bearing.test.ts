// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Hit testing does not depend on the bearing
 *
 * The click tolerance is a screen length (clickTolerance px). The same pixel distance from a
 * feature must give the same decision however the map is turned and at any latitude. The
 * map is stood in for by a Web Mercator camera whose project / unproject rotate by the
 * bearing, like maplibre's.
 */

import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../../store/memory.js';
import { RBushSpatialIndex } from '../../store/spatial/spatial-index.js';
import type { Coordinate, Feature } from '../../store/types.js';
import { toleranceDegrees } from './local-frame.js';
import { HitTestServiceImpl } from './service.js';

const TILE_SIZE = 512;
const WIDTH = 800;
const HEIGHT = 600;

interface Camera {
  project(coord: Coordinate): { x: number; y: number };
  unproject(point: { x: number; y: number }): { lng: number; lat: number };
}

/**
 * A pitch-free Web Mercator camera centred on `center`, turned by `bearing` degrees
 */
function mercatorCamera(center: Coordinate, zoom: number, bearing: number): Camera {
  const worldSize = TILE_SIZE * 2 ** zoom;
  const toWorld = ([lng, lat]: Coordinate): [number, number] => [
    ((lng + 180) / 360) * worldSize,
    ((1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2) * worldSize,
  ];
  const fromWorld = (x: number, y: number): { lng: number; lat: number } => ({
    lng: (x / worldSize) * 360 - 180,
    lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / worldSize))) * 180) / Math.PI,
  });
  const [cx, cy] = toWorld(center);
  const angle = (bearing * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  return {
    project(coord) {
      const [x, y] = toWorld(coord);
      const dx = x - cx;
      const dy = y - cy;
      return { x: WIDTH / 2 + dx * cos + dy * sin, y: HEIGHT / 2 - dx * sin + dy * cos };
    },
    unproject(point) {
      const sx = point.x - WIDTH / 2;
      const sy = point.y - HEIGHT / 2;
      return fromWorld(cx + sx * cos - sy * sin, cy + sx * sin + sy * cos);
    },
  };
}

function feature(id: string, type: Feature['type'], coordinates: Feature['coordinates']): Feature {
  return { id, type, coordinates, layerId: 'l1', properties: {}, locked: false, visible: true };
}

function serviceWith(features: Feature[]): HitTestServiceImpl {
  const store = new MemoryStore();
  store.createLayer({ id: 'l1', name: 'l1', visible: true, locked: false, opacity: 1, order: [] });
  const index = new RBushSpatialIndex();
  for (const f of features) {
    store.createFeature(f);
    index.insert(f);
  }
  return new HitTestServiceImpl(store, index, { clickTolerance: 6 });
}

/** Whether a click `offsetPx` screen pixels to the right of the feature anchor hits it */
function hitsAtOffset(make: (camera: Camera) => Feature, camera: Camera, offsetPx: number) {
  const f = make(camera);
  const service = serviceWith([f]);
  const anchor = camera.project(
    f.type === 'Point' ? (f.coordinates as Coordinate) : (f.coordinates as Coordinate[])[0],
  );
  const click = { x: anchor.x + offsetPx, y: anchor.y };
  return service.hitTestAll(click, camera.unproject, [f]).length > 0;
}

const LATITUDES = [0, 60, 80];
const BEARINGS = [0, 45, 90, 180, 270];

describe('the click tolerance is a screen length', () => {
  it.each(LATITUDES)('does not change with the bearing at latitude %d', (lat) => {
    const center: Coordinate = [139.7, lat];
    const reference = toleranceDegrees(
      mercatorCamera(center, 14, 0).unproject,
      { x: 400, y: 300 },
      6,
    );
    for (const bearing of BEARINGS) {
      const camera = mercatorCamera(center, 14, bearing);
      const tolerance = toleranceDegrees(camera.unproject, { x: 400, y: 300 }, 6);
      expect(tolerance / reference).toBeCloseTo(1, 4);
    }
  });
});

describe('the same pixel distance gives the same decision at any bearing', () => {
  // A point sitting at the screen centre
  const pointAtCenter = (center: Coordinate) => () => feature('p', 'Point', center);
  // A line whose segment runs along the screen y axis through the centre: the click is
  // offset along screen x, so the distance to it is the pixel offset
  const verticalLine = (camera: Camera) => {
    const top = camera.unproject({ x: WIDTH / 2, y: HEIGHT / 2 - 50 });
    const bottom = camera.unproject({ x: WIDTH / 2, y: HEIGHT / 2 + 50 });
    return feature('l', 'LineString', [
      [top.lng, top.lat],
      [bottom.lng, bottom.lat],
    ]);
  };

  for (const lat of LATITUDES) {
    const center: Coordinate = [139.7, lat];
    for (const bearing of BEARINGS) {
      it(`point at latitude ${lat}, bearing ${bearing}`, () => {
        const camera = mercatorCamera(center, 14, bearing);
        expect(hitsAtOffset(pointAtCenter(center), camera, 5)).toBe(true);
        expect(hitsAtOffset(pointAtCenter(center), camera, 7)).toBe(false);
      });

      it(`line at latitude ${lat}, bearing ${bearing}`, () => {
        const camera = mercatorCamera(center, 14, bearing);
        const make = () => verticalLine(camera);
        const probe = (offset: number) => {
          const f = make();
          const service = serviceWith([f]);
          return service.hitTestAll({ x: WIDTH / 2 + offset, y: HEIGHT / 2 }, camera.unproject, [f])
            .length;
        };
        expect(probe(5)).toBe(1);
        expect(probe(7)).toBe(0);
      });
    }
  }
});
