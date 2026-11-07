// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The sizes in pixels that a flat Web Mercator view without terrain shows as they are
 *
 * On a map of Web Mercator, untilted and unturned, the quantities given in pixels are the pixels
 * on the screen: the margin of the frame of a selection, the sizes of the handles, the frame of a
 * point, an image at the zoom it was placed at, the dashes, a width in meters and the move of an
 * arrow key. These tests hold them on such a map, through a map whose projection is the exact
 * Web Mercator of maplibre at a zoom, so that the way a size in pixels is put on the map can
 * change without changing what such a view shows.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import type { EngineModeContext } from '../../modes/handler.js';
import { Nudge } from '../../modes/select/nudge.js';
import { handleNudgeShortcut } from '../../modes/select/shortcut-handler.js';
import { DEFAULT_SELECTION_CONFIG } from '../../shared/config/selection.js';
import { createCoordinateTransform } from '../../shared/math/index.js';
import { coordinatesOf } from '../../shared/utils/coordinates.js';
import { getBoundingBox } from '../../shared/utils/feature-bbox.js';
import { MemoryStore } from '../../store/memory.js';
import type { Feature } from '../../store/types.js';
import { createSketches } from '../../test-utils.js';
import { splitIntoDashes } from '../renderers/line/dash.js';
import { StrokeRenderer } from '../renderers/stroke.js';
import { hitTestHandles } from './handle-test.js';
import { createSelectionScope } from './selection-scope.js';
import { computeBoundingBox } from './selection-ui/index.js';

const ZOOM = 14;
const CENTER: [number, number] = [139.7, 35.68];
const WIDTH = 640;
const HEIGHT = 480;
/** The width of the world in CSS pixels at the zoom */
const WORLD = 512 * 2 ** ZOOM;

const mercatorX = (lng: number) => ((lng + 180) / 360) * WORLD;
const mercatorY = (lat: number) =>
  ((1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2) * WORLD;

/** A map of Web Mercator at the zoom, centered on the center, untilted and unturned */
function mercatorMap(): MapLibreMap {
  const x0 = mercatorX(CENTER[0]) - WIDTH / 2;
  const y0 = mercatorY(CENTER[1]) - HEIGHT / 2;
  const map = {
    project: (lngLat: [number, number] | { lng: number; lat: number }) => {
      const [lng, lat] = Array.isArray(lngLat) ? lngLat : [lngLat.lng, lngLat.lat];
      return { x: mercatorX(lng) - x0, y: mercatorY(lat) - y0 };
    },
    unproject: (point: [number, number] | { x: number; y: number }) => {
      const [x, y] = Array.isArray(point) ? point : [point.x, point.y];
      const lng = ((x + x0) / WORLD) * 360 - 180;
      const n = Math.PI * (1 - (2 * (y + y0)) / WORLD);
      return { lng, lat: (Math.atan(Math.sinh(n)) * 180) / Math.PI };
    },
    getZoom: () => ZOOM,
    getCenter: () => ({ lng: CENTER[0], lat: CENTER[1] }),
    getBearing: () => 0,
    getPitch: () => 0,
  };
  return map as unknown as MapLibreMap;
}

function feature(partial: Pick<Feature, 'type' | 'geometry'> & Partial<Feature>): Feature {
  return {
    id: 'f',
    layerId: 'l',
    groupId: undefined,
    properties: {},
    locked: false,
    visible: true,
    style: {},
    ...partial,
  };
}

const R = 0.004;
const square = (): Feature =>
  feature({
    type: 'Polygon',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [CENTER[0] - R, CENTER[1] - R],
          [CENTER[0] + R, CENTER[1] - R],
          [CENTER[0] + R, CENTER[1] + R],
          [CENTER[0] - R, CENTER[1] + R],
          [CENTER[0] - R, CENTER[1] - R],
        ],
      ],
    },
  });

const point = (): Feature =>
  feature({ type: 'Point', geometry: { type: 'Point', coordinates: [...CENTER] } });

const MARGIN = DEFAULT_SELECTION_CONFIG.box.margin;

describe('the frame and the handles of a selection on a flat Web Mercator view', () => {
  const map = mercatorMap();
  const transform = createCoordinateTransform(map);
  const scope = createSelectionScope();
  const hit = (x: number, y: number, features: Feature[]) =>
    hitTestHandles({ x, y }, features, transform, DEFAULT_SELECTION_CONFIG, ZOOM, scope);

  it('puts the resize handles on the corners of the frame, the margin out of the outline', () => {
    const ne = map.project([CENTER[0] + R, CENTER[1] + R]);
    const corner = { x: ne.x + MARGIN, y: ne.y - MARGIN };
    const half = DEFAULT_SELECTION_CONFIG.resizeHandle.point.size / 2;
    for (const [dx, dy] of [
      [0, 0],
      [half - 0.01, half - 0.01],
      [-(half - 0.01), -(half - 0.01)],
      [half - 0.01, -(half - 0.01)],
    ]) {
      expect(hit(corner.x + dx, corner.y + dy, [square()])).toEqual({
        type: 'resize',
        handle: 'resize-ne',
      });
    }
    expect(hit(corner.x + half + 0.01, corner.y, [square()])?.type).not.toBe('resize');
    expect(hit(corner.x, corner.y - half - 0.01, [square()])?.type).not.toBe('resize');
  });

  it('takes a press as a move inside the frame, the margin out of the outline', () => {
    const east = map.project([CENTER[0] + R, CENTER[1]]);
    expect(hit(east.x + MARGIN - 0.05, east.y, [square()])).toEqual({ type: 'move' });
    expect(hit(east.x + MARGIN + 0.05, east.y, [square()])).toBeNull();
    const north = map.project([CENTER[0], CENTER[1] + R]);
    // Away from the rotate handle above the middle of the top edge
    const x = north.x - 60;
    expect(hit(x, north.y - MARGIN + 0.05, [square()])).toEqual({ type: 'move' });
    expect(hit(x, north.y - MARGIN - 0.05, [square()])).toBeNull();
  });

  it('frames a point with the square of its marker and the margin, on the screen', () => {
    const at = map.project(CENTER);
    const half = 6 + MARGIN;
    expect(hit(at.x + half - 0.05, at.y, [point()])).toEqual({ type: 'move' });
    expect(hit(at.x + half + 0.05, at.y, [point()])).toBeNull();
    expect(hit(at.x, at.y - half + 0.05, [point()])).toEqual({ type: 'move' });
    expect(hit(at.x, at.y - half - 0.05, [point()])).toBeNull();
  });
});

describe('the sizes given at a zoom on a flat Web Mercator view', () => {
  /** The degrees of longitude of a pixel at the zoom */
  const lngPerPx = 360 / WORLD;
  /** The degrees of latitude of a pixel at the latitude of the center */
  const latPerPx = lngPerPx * Math.cos((CENTER[1] * Math.PI) / 180);

  const image = (): Feature =>
    feature({
      type: 'Image',
      geometry: { type: 'Point', coordinates: [...CENTER] },
      properties: {
        'maplibre-gl-draw:imageFileId': 'i',
        'maplibre-gl-draw:imageWidth': 200,
        'maplibre-gl-draw:imageHeight': 100,
        'maplibre-gl-draw:createdZoom': ZOOM,
      },
    });

  it('spans an image over its pixels at the zoom it was placed at', () => {
    const box = computeBoundingBox(image());
    expect(box).not.toBeNull();
    const { topLeft, bottomRight } = box as NonNullable<typeof box>;
    expect((bottomRight[0] - topLeft[0]) / lngPerPx).toBeCloseTo(200, 6);
    expect((topLeft[1] - bottomRight[1]) / latPerPx).toBeCloseTo(100, 6);

    const extent = getBoundingBox(image());
    expect((extent.maxX - extent.minX) / lngPerPx).toBeCloseTo(200, 6);
    expect((extent.maxY - extent.minY) / latPerPx).toBeCloseTo(100, 6);
  });

  it('cuts the dashes of a line by their pixels at the zoom', () => {
    const dashes = splitIntoDashes(
      [
        [CENTER[0], CENTER[1]],
        [CENTER[0] + 100 * lngPerPx, CENTER[1]],
      ],
      10,
      5,
      ZOOM,
    );
    expect(dashes.length).toBe(7);
    for (let i = 0; i < dashes.length; i++) {
      const coords = (dashes[i] as (typeof dashes)[number]).coords;
      const start = coords[0] as [number, number];
      expect((start[0] - CENTER[0]) / lngPerPx).toBeCloseTo(i * 15, 6);
    }
  });

  it('draws a width in meters over the pixels of those meters at the zoom', () => {
    const widthInPixels = (
      StrokeRenderer.prototype as unknown as {
        getWidthInPixels(width: number, unit: string, zoom: number, latitude: number): number;
      }
    ).getWidthInPixels;
    const self = { pixelRatio: 1, map: {} };
    // The pixels of 50 m at the latitude, on a world 40,075,016.686 m round; the size of the
    // world may be taken a tenth of a percent apart
    const metersPerPixel = (40075016.686 * Math.cos((CENTER[1] * Math.PI) / 180)) / WORLD;
    const pixels = widthInPixels.call(self, 50, 'meters', ZOOM, CENTER[1]);
    expect(Math.abs(pixels / (50 / metersPerPixel) - 1)).toBeLessThan(0.002);
    expect(widthInPixels.call(self, 3, 'pixels', ZOOM, CENTER[1])).toBe(3);
  });
});

describe('the arrow keys on a flat Web Mercator view', () => {
  const NO_MODIFIERS = { shift: false, ctrl: false, alt: false, meta: false };

  function moved(key: string, shift: boolean): { x: number; y: number } {
    const map = mercatorMap();
    const store = new MemoryStore();
    store.transact(() => {
      store.createLayer({
        id: 'l',
        name: 'l',
        visible: true,
        locked: false,
        opacity: 1,
        items: [],
        styleRule: undefined,
        metadata: undefined,
      });
      store.createFeature(point());
    }, 'remote');
    store.setSelection('feature', ['f']);
    // A point is the center of the frame of its selection, which the press moves by its pixels
    // (a position away from it moves by the same length on the ground, a little more or less on
    // the screen where the scale of Web Mercator is another)
    const position = () => coordinatesOf(store.getFeature('f') as Feature) as [number, number];
    const before = map.project(position());
    const context = { store, map, sketches: createSketches(store) } as unknown as EngineModeContext;
    const nudge = new Nudge();
    expect(handleNudgeShortcut(context, key, { ...NO_MODIFIERS, shift }, nudge)).toBe(true);
    // The press is written once the moves of the keys are
    nudge.flush();
    const after = map.project(position());
    return { x: after.x - before.x, y: after.y - before.y };
  }

  it('moves the selection by a pixel on the screen, ten with Shift', () => {
    for (const [key, x, y] of [
      ['ArrowRight', 1, 0],
      ['ArrowLeft', -1, 0],
      ['ArrowUp', 0, -1],
      ['ArrowDown', 0, 1],
    ] as const) {
      for (const [shift, step] of [
        [false, 1],
        [true, 10],
      ] as const) {
        const by = moved(key, shift);
        expect(by.x).toBeCloseTo(x * step, 4);
        expect(by.y).toBeCloseTo(y * step, 4);
      }
    }
  });
});
