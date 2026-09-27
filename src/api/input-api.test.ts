// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for synthetic input (draw.input)
 *
 * Verifies that feeding synthesized normalized events into the same entry point of the
 * InputRouter advances the drawing just as a real operation would. The real drawing modes
 * (DrawLineMode / DrawPolygonMode / DrawPointMode) are used, and the test watches all the
 * way to a feature appearing in the Store. Snapping is stubbed out at the SnapService, so
 * that going through it or not can be observed.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import { beforeEach, describe, expect, it } from 'vitest';
import type { InputRouter } from '../dispatcher/input-router.js';
import { createInputRouter } from '../dispatcher/input-router.js';
import type { NormalizedEvent } from '../dispatcher/types.js';
import {
  DrawCircleMode,
  DrawLineMode,
  DrawPointMode,
  DrawPolygonMode,
} from '../modes/draw/index.js';
import type { ModeContext } from '../modes/handler.js';
import { ModeManagerImpl } from '../modes/manager.js';
import { coordinatesOf } from '../shared/utils/coordinates.js';
import type { SnapLngLat, SnapService } from '../snapping/types.js';
import { MemoryStore } from '../store/memory.js';
import { RBushSpatialIndex } from '../store/spatial/spatial-index.js';
import type { Coordinate, Mode } from '../store/types.js';
import type { InputOperations } from './input-api.js';
import { createInputApi } from './input-api.js';

const ZOOM = 14;
/** Degrees per pixel at zoom 14 (= 360 / (512 * 2^14)) */
const DEG_PER_PIXEL = 360 / (512 * 2 ** ZOOM);

/** Origin of the projection (screen coordinate (0, 0)) */
const ORIGIN = { lng: 139.7, lat: 35.68 };

/** Places the points far enough apart to clear the vertex click threshold (10px) */
const STEP = 40 * DEG_PER_PIXEL;

const A: Coordinate = [ORIGIN.lng, ORIGIN.lat];
const B: Coordinate = [ORIGIN.lng + STEP, ORIGIN.lat];
const C: Coordinate = [ORIGIN.lng + STEP, ORIGIN.lat - STEP];

/**
 * A normalizer that only records the events
 *
 * Synthetic input does not go through the normalizer, so it is used here only for wiring.
 */
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
}

/** A map that only maps longitude/latitude to screen coordinates linearly */
function createFakeMap(): MapLibreMap {
  const canvas = { style: {} as { cursor?: string } };
  return {
    getZoom: () => ZOOM,
    getCanvas: () => canvas,
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

/** A stub that records the resolve calls and always snaps to a fixed coordinate */
function createSnapStub(snapped: { lng: number; lat: number }): {
  service: SnapService;
  calls: SnapLngLat[];
} {
  const calls: SnapLngLat[] = [];
  const service = {
    resolve: (lngLat: SnapLngLat) => {
      calls.push(lngLat);
      return { lngLat: snapped, target: { kind: 'vertex' as const } };
    },
    register: () => () => {},
    setEnabled: () => {},
    isEnabled: () => true,
    getResult: () => null,
    getOptions: () => ({}) as ReturnType<SnapService['getOptions']>,
  } as unknown as SnapService;
  return { service, calls };
}

let store: MemoryStore;
let spatialIndex: RBushSpatialIndex;
let modeManager: ModeManagerImpl;
let inputRouter: InputRouter;
let input: InputOperations;

/**
 * Assembles the set of objects used by the tests
 *
 * The real ModeManager / drawing modes / InputRouter are used, and only the synthetic
 * input is given from outside. The select mode is needed only as a transition target, so
 * it gets a minimal implementation.
 */
function setup(snapService?: SnapService): void {
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

  const map = createFakeMap();
  modeManager = new ModeManagerImpl(store);
  modeManager.registerMode('select', () => ({ modeName: 'select' }));
  modeManager.registerMode('draw_point', () => new DrawPointMode());
  modeManager.registerMode('draw_line', () => new DrawLineMode());
  modeManager.registerMode('draw_polygon', () => new DrawPolygonMode());
  modeManager.registerMode('draw_circle', () => new DrawCircleMode());

  let idCounter = 0;
  const context = {
    map,
    store,
    spatialIndex,
    autoNameGenerator: { generateName: () => undefined },
    generateFeatureId: () => `f${++idCounter}`,
    getCurrentLayerId: () => 'l1',
    setMode: (mode: Mode) => modeManager.setMode(mode),
  } as unknown as ModeContext;

  modeManager.setContext(context);
  modeManager.start();

  const normalizer = new FakeNormalizer();
  inputRouter = createInputRouter({
    normalizer: normalizer as unknown as Parameters<typeof createInputRouter>[0]['normalizer'],
    modeManager,
    context,
    map,
    snapService,
  });
  inputRouter.start();

  input = createInputApi({ map, inputRouter }).input;
}

beforeEach(() => {
  setup();
});

describe('drawing with a sequence of clicks from draw.input', () => {
  it('creates a LineString from a sequence of clicks and Enter', () => {
    modeManager.setMode('draw_line');

    input.click(A);
    input.click(B);
    input.click(C);
    input.key('Enter');

    const features = store.listFeatures();
    expect(features).toHaveLength(1);
    expect(features[0].type).toBe('LineString');
    expect(coordinatesOf(features[0])).toEqual([A, B, C]);
    // After committing it returns to the select mode, and the provisional geometry is gone
    expect(store.getMode()).toBe('select');
    expect(store.getTentative()).toBeNull();
  });

  it('creates a Polygon from a sequence of clicks and Enter', () => {
    modeManager.setMode('draw_polygon');

    input.click(A);
    input.click(B);
    input.click(C);
    input.key('Enter');

    const features = store.listFeatures();
    expect(features).toHaveLength(1);
    expect(features[0].type).toBe('Polygon');
    // A Polygon is an array of rings, and its first and last points are closed
    const ring = (coordinatesOf(features[0]) as Coordinate[][])[0];
    expect(ring[0]).toEqual(A);
    expect(ring[ring.length - 1]).toEqual(A);
    expect(store.getMode()).toBe('select');
  });

  it('closes the Polygon when the first vertex is clicked again', () => {
    modeManager.setMode('draw_polygon');

    input.click(A);
    input.click(B);
    input.click(C);
    // click delivers a mousemove at the same coordinate first, so the proximity test
    // against the first point holds just as in a real operation, and the next click commits
    input.click(A);

    const features = store.listFeatures();
    expect(features).toHaveLength(1);
    expect(features[0].type).toBe('Polygon');
    expect((coordinatesOf(features[0]) as Coordinate[][])[0]).toHaveLength(4);
  });

  it('creates a Circle from two clicks', () => {
    modeManager.setMode('draw_circle');

    // The mousemove contained in the second click decides the radius, so clicks alone
    // advance to the commit (the synthetic sequence suffices even for a mode whose value
    // is decided by a move)
    input.click(A);
    input.click(B);

    const features = store.listFeatures();
    expect(features).toHaveLength(1);
    expect(features[0].type).toBe('Circle');
    expect(features[0].properties['maplibre-gl-draw:radiusMeters']).toBeGreaterThan(0);
  });

  it('can draw with coordinates in the { lng, lat } form as well', () => {
    modeManager.setMode('draw_point');

    input.click({ lng: B[0], lat: B[1] });

    const features = store.listFeatures();
    expect(features).toHaveLength(1);
    expect(coordinatesOf(features[0])).toEqual(B);
  });
});

describe('draw.input.move', () => {
  it('moves the preview coordinate while drawing', () => {
    modeManager.setMode('draw_line');
    input.click(A);

    input.move(B);
    const first = store.getTentative();
    expect(first?.coordinates).toEqual([A, B]);

    input.move(C);
    const second = store.getTentative();
    expect(second?.coordinates).toEqual([A, C]);
    // The committed vertices stay at one (the preview one is not included)
    expect(second?.confirmedCount).toBe(1);
  });
});

describe('draw.input.key', () => {
  it("key('Escape') cancels the drawing", () => {
    modeManager.setMode('draw_line');
    input.click(A);
    input.click(B);

    input.key('Escape');

    expect(store.listFeatures()).toHaveLength(0);
    expect(store.getTentative()).toBeNull();
  });

  it("key('Backspace') undoes the most recent vertex", () => {
    modeManager.setMode('draw_line');
    input.click(A);
    input.click(B);
    input.click(C);

    input.key('Backspace');
    input.key('Enter');

    const features = store.listFeatures();
    expect(features).toHaveLength(1);
    expect(coordinatesOf(features[0])).toEqual([A, B]);
  });

  it('infers the equivalent of KeyboardEvent.code in key', () => {
    const received: string[] = [];
    modeManager.registerMode('draw_point', () => ({
      modeName: 'draw_point',
      onKeyDown: (event) => {
        received.push(event.code);
      },
    }));
    modeManager.setMode('draw_point');

    input.key('Enter');
    input.key('a');
    input.key('1');
    input.key('x', { code: 'Custom' });

    expect(received).toEqual(['Enter', 'KeyA', 'Digit1', 'Custom']);
  });
});

describe('draw.input and snapping', () => {
  it('goes through snapping by default and draws with the snapped coordinate', () => {
    const snapped = { lng: C[0], lat: C[1] };
    const stub = createSnapStub(snapped);
    setup(stub.service);
    modeManager.setMode('draw_point');

    input.click(A);

    expect(stub.calls.length).toBeGreaterThan(0);
    const features = store.listFeatures();
    expect(features).toHaveLength(1);
    expect(coordinatesOf(features[0])).toEqual([snapped.lng, snapped.lat]);
  });

  it('skips snapping with snap: false and draws with the raw coordinate', () => {
    const stub = createSnapStub({ lng: C[0], lat: C[1] });
    setup(stub.service);
    modeManager.setMode('draw_point');

    input.click(A, { snap: false });

    expect(stub.calls).toHaveLength(0);
    const features = store.listFeatures();
    expect(features).toHaveLength(1);
    expect(coordinatesOf(features[0])).toEqual(A);
  });

  it('makes move go through snapping by default too, and pass through with snap: false', () => {
    const snapped = { lng: C[0], lat: C[1] };
    const stub = createSnapStub(snapped);
    setup(stub.service);
    modeManager.setMode('draw_line');

    input.click(A, { snap: false });
    input.move(B);
    expect(store.getTentative()?.coordinates).toEqual([A, [snapped.lng, snapped.lat]]);

    const callsAfterMove = stub.calls.length;
    input.move(B, { snap: false });
    expect(stub.calls).toHaveLength(callsAfterMove);
    expect(store.getTentative()?.coordinates).toEqual([A, B]);
  });
});

describe('the shape of the synthetic events', () => {
  it('delivers mousemove and click in that order for click', () => {
    const seen: string[] = [];
    modeManager.registerMode('draw_point', () => ({
      modeName: 'draw_point',
      onMouseMove: () => {
        seen.push('mousemove');
      },
      onClick: () => {
        seen.push('click');
      },
    }));
    modeManager.setMode('draw_point');

    input.click(A);

    expect(seen).toEqual(['mousemove', 'click']);
  });

  it('computes the screen point with map.project and carries modifiers and originalEvent', () => {
    let captured: import('../dispatcher/types.js').MouseNormalizedEvent | null = null;
    modeManager.registerMode('draw_point', () => ({
      modeName: 'draw_point',
      onClick: (event) => {
        captured = event;
      },
    }));
    modeManager.setMode('draw_point');

    input.click(B, { modifiers: { shift: true } });

    const event = captured as unknown as import('../dispatcher/types.js').MouseNormalizedEvent;
    expect(event.point).toEqual({ x: 40, y: 0 });
    expect(event.modifiers).toEqual({ shift: true, ctrl: false, alt: false, meta: false });
    // A dummy carrying the methods the InputRouter and the modes touch
    expect(typeof event.originalEvent.preventDefault).toBe('function');
    expect(typeof event.originalEvent.stopPropagation).toBe('function');
    expect(event.originalEvent.shiftKey).toBe(true);
  });
});
