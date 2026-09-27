// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the snapping of freehand
 *
 * Through the real InputRouter, the real SnapService and the freehand mode, this checks that
 * the inside of a stroke (dragmove) is not bent by snapping, and that the start point
 * (dragstart) and the end point (dragend) are snapped as before.
 *
 * The assembly follows the same style as trace-mode.test.ts: instead of synthetic input, drag
 * events are fed from the normalizer (because draw.input does not synthesize drags).
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import { beforeEach, describe, expect, it } from 'vitest';
import { bridgeMode } from '../../api/v2/impl/input.js';
import { createInputRouter } from '../../dispatcher/input-router.js';
import type { DragNormalizedEvent, NormalizedEvent } from '../../dispatcher/types.js';
import { coordinatesOf } from '../../shared/utils/coordinates.js';
import { createSnapService } from '../../snapping/service.js';
import type { SnapService } from '../../snapping/types.js';
import { MemoryStore } from '../../store/memory.js';
import { RBushSpatialIndex } from '../../store/spatial/spatial-index.js';
import type { Coordinate, Feature, Mode } from '../../store/types.js';
import { createModeHarness } from '../../test-utils.js';
import type { ModeContext } from '../handler.js';
import { ModeManagerImpl } from '../manager.js';
import { drawFreehandMode } from './freehand.js';

const ZOOM = 14;
/** The degrees corresponding to one pixel at zoom 14 (= 360 / (512 * 2^14)) */
const DEG_PER_PIXEL = 360 / (512 * 2 ** ZOOM);

/** The origin of the projection (screen coordinate (0, 0)) */
const ORIGIN = { lng: 139.7, lat: 35.68 };

/**
 * An existing boundary line with dense vertices (a mock administrative boundary)
 *
 * Vertices are lined up at 4 pixel intervals on the horizontal line at screen y = 0. When
 * tracing inside the tolerance (10px), snapping always pulls the point to some vertex or edge.
 */
const BOUNDARY_VERTEX_COUNT = 40;
const BOUNDARY_STEP_PIXELS = 4;
const BOUNDARY: Coordinate[] = Array.from({ length: BOUNDARY_VERTEX_COUNT }, (_, i) => [
  ORIGIN.lng + i * BOUNDARY_STEP_PIXELS * DEG_PER_PIXEL,
  ORIGIN.lat,
]);

/** The distance from the boundary line to the stroke (in pixels). Inside the 10px tolerance */
const STROKE_OFFSET_PIXELS = 5;

/** The latitude of the stroke (5 pixels above the boundary line) */
const STROKE_LAT = ORIGIN.lat + STROKE_OFFSET_PIXELS * DEG_PER_PIXEL;

/** The sample interval of the stroke (in pixels). A width that passes the minimum distance sieve */
const STROKE_STEP_PIXELS = 8;

/** A normalizer that can do no more than feed events */
class FakeNormalizer {
  private handlers = new Set<(event: NormalizedEvent) => void>();
  attach(): void {}
  detach(): void {}
  on(handler: (event: NormalizedEvent) => void): void {
    this.handlers.add(handler);
  }
  off(handler: (event: NormalizedEvent) => void): void {
    this.handlers.delete(handler);
  }
  emit(event: NormalizedEvent): void {
    for (const handler of this.handlers) handler(event);
  }
}

/** A map that does no more than map longitude/latitude and screen coordinates linearly */
function createFakeMap(): MapLibreMap {
  const canvas = { style: {} as { cursor?: string } };
  let dragPanEnabled = true;
  return {
    getZoom: () => ZOOM,
    getCanvas: () => canvas,
    dragPan: {
      enable: () => {
        dragPanEnabled = true;
      },
      disable: () => {
        dragPanEnabled = false;
      },
      isEnabled: () => dragPanEnabled,
    },
    project: (coord: Coordinate) => ({
      x: (coord[0] - ORIGIN.lng) / DEG_PER_PIXEL,
      y: (ORIGIN.lat - coord[1]) / DEG_PER_PIXEL,
    }),
    unproject: (point: [number, number]) => ({
      lng: ORIGIN.lng + point[0] * DEG_PER_PIXEL,
      lat: ORIGIN.lat - point[1] * DEG_PER_PIXEL,
    }),
  } as unknown as MapLibreMap;
}

let store: MemoryStore;
let spatialIndex: RBushSpatialIndex;
let modeManager: ModeManagerImpl;
let normalizer: FakeNormalizer;
let snapService: SnapService;
let map: MapLibreMap;
let harness: ReturnType<typeof createModeHarness>;

function setup(): void {
  store = new MemoryStore();
  store.createLayer({
    id: 'l1',
    name: 'l1',
    visible: true,
    locked: false,
    opacity: 1,
    items: [],
    styleRule: undefined,
    metadata: undefined,
  });
  spatialIndex = new RBushSpatialIndex();

  const boundary: Feature = {
    id: 'boundary',
    type: 'LineString',
    geometry: { type: 'LineString', coordinates: BOUNDARY },
    layerId: 'l1',
    groupId: undefined,
    properties: {},
    locked: false,
    visible: true,
    style: {},
  };
  store.createFeature(boundary);
  spatialIndex.insert(boundary);

  map = createFakeMap();
  modeManager = new ModeManagerImpl(store);
  modeManager.registerMode('select', () => ({ modeName: 'select' }));
  harness = createModeHarness({ store, map, modeManager, getWritableLayerId: () => 'l1' });
  harness.register('draw_freehand', drawFreehandMode);

  snapService = createSnapService({ store, spatialIndex });

  let idCounter = 0;
  const context = {
    map,
    store,
    spatialIndex,
    autoNameGenerator: { generateName: () => undefined },
    generateFeatureId: () => `f${++idCounter}`,
    getCurrentLayerId: () => 'l1',
    setMode: (mode: Mode) => modeManager.setMode(mode),
    getSnapResult: () => snapService.getResult(),
  } as unknown as ModeContext;

  modeManager.setContext(context);
  modeManager.start();

  normalizer = new FakeNormalizer();
  const inputRouter = createInputRouter({
    normalizer: normalizer as unknown as Parameters<typeof createInputRouter>[0]['normalizer'],
    modeManager,
    context,
    map,
    snapService,
    extensionInput: harness.route,
  });
  inputRouter.start();
}

function makeDragEvent(
  type: DragNormalizedEvent['type'],
  coord: Coordinate,
  start: Coordinate,
): DragNormalizedEvent {
  const project = (c: Coordinate) => ({
    x: (c[0] - ORIGIN.lng) / DEG_PER_PIXEL,
    y: (ORIGIN.lat - c[1]) / DEG_PER_PIXEL,
  });
  return {
    type,
    point: project(coord),
    lngLat: { lng: coord[0], lat: coord[1] },
    originalEvent: {} as unknown as MouseEvent,
    modifiers: { shift: false, ctrl: false, alt: false, meta: false },
    dragStartPoint: project(start),
    dragStartLngLat: { lng: start[0], lat: start[1] },
  };
}

/**
 * Feeds one stroke (dragstart -> dragmove ... -> dragend)
 */
function stroke(coordinates: Coordinate[]): void {
  const start = coordinates[0];
  normalizer.emit(makeDragEvent('dragstart', start, start));
  for (const coord of coordinates.slice(1, -1)) {
    normalizer.emit(makeDragEvent('dragmove', coord, start));
  }
  normalizer.emit(makeDragEvent('dragend', coordinates[coordinates.length - 1], start));
}

/** A stroke drawn straight in the x direction, parallel to the boundary line, 5 pixels away */
function straightStroke(sampleCount: number): Coordinate[] {
  return Array.from({ length: sampleCount }, (_, i) => [
    ORIGIN.lng + i * STROKE_STEP_PIXELS * DEG_PER_PIXEL,
    STROKE_LAT,
  ]);
}

/** The drawn feature (excluding the boundary line) */
function drawnFeature(): Feature {
  const features = store.listFeatures().filter((f) => f.id !== 'boundary');
  expect(features).toHaveLength(1);
  return features[0];
}

beforeEach(() => {
  setup();
});

describe('snapping of freehand', () => {
  it('does not snap inside a stroke to a dense boundary line (a straight line is not bent)', () => {
    modeManager.setMode('draw_freehand');

    const path = straightStroke(6);
    stroke(path);

    // The intermediate points (excluding the first and the last) keep the input coordinates.
    // If they were snapped, they would fall onto the boundary line (ORIGIN.lat) and become a
    // bent polyline
    const coordinates = coordinatesOf(drawnFeature()) as Coordinate[];
    const middle = coordinates.slice(1, -1);
    expect(middle).toEqual(path.slice(1, -1));
    for (const coord of middle) {
      expect(coord[1]).toBe(STROKE_LAT);
    }
  });

  it('snaps the start point and the end point of the drag to vertices of the boundary line', () => {
    modeManager.setMode('draw_freehand');

    const path = straightStroke(6);
    stroke(path);

    const coordinates = coordinatesOf(drawnFeature()) as Coordinate[];
    const first = coordinates[0];
    const last = coordinates[coordinates.length - 1];

    // They are only 5 pixels away, so both stick to the nearest boundary vertex
    expect(first[1]).toBe(ORIGIN.lat);
    expect(last[1]).toBe(ORIGIN.lat);
    expect(BOUNDARY.some((v) => v[0] === first[0] && v[1] === first[1])).toBe(true);
    expect(BOUNDARY.some((v) => v[0] === last[0] && v[1] === last[1])).toBe(true);
  });

  it('the declaration of the mode refuses only the drag move', () => {
    const mode = bridgeMode('draw_freehand', drawFreehandMode(harness.modeContext()), () => {});

    expect(mode.isSnapEnabledFor?.('dragmove')).toBe(false);
    expect(mode.isSnapEnabledFor?.('dragstart')).toBe(true);
    expect(mode.isSnapEnabledFor?.('dragend')).toBe(true);
    expect(mode.isSnapEnabledFor?.('click')).toBe(true);
    expect(mode.isSnapEnabledFor?.('mousemove')).toBe(true);
  });
});

describe('cancel of a freehand stroke (dragcancel)', () => {
  it('a second finger discards the stroke in progress and gives dragPan back', () => {
    modeManager.setMode('draw_freehand');
    const points = straightStroke(6);
    const start = points[0];
    normalizer.emit({
      ...makeDragEvent('dragstart', start, start),
      type: 'mousedown',
    } as unknown as NormalizedEvent);
    expect(map.dragPan.isEnabled()).toBe(false);

    normalizer.emit(makeDragEvent('dragstart', start, start));
    for (const coord of points.slice(1, 4)) {
      normalizer.emit(makeDragEvent('dragmove', coord, start));
    }
    expect(store.getTentative()).not.toBeNull();

    normalizer.emit({ ...makeDragEvent('dragcancel', points[3], start), pointerType: 'touch' });

    expect(store.getTentative()).toBeNull();
    expect(map.dragPan.isEnabled()).toBe(true);
    // The stroke does not hang: what follows the cancel draws nothing
    normalizer.emit(makeDragEvent('dragmove', points[4], start));
    normalizer.emit(makeDragEvent('dragend', points[5], start));
    expect(store.listFeatures().map((f) => f.id)).toEqual(['boundary']);
  });
});
