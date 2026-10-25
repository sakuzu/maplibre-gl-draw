// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the drawing modes leave once a shape is finished, which a change of how the shape being
 * drawn is shown must keep: the feature created (its type and its positions, where the pointer
 * put them), one `document.changed` for it, and the mode and the selection after it; a point is
 * placed by a click, a line and an area by clicks finished by Enter, a double click or a click on
 * their first vertex, a circle by its center and a point of its edge, a freehand stroke by a drag,
 * and an image is asked of the application without anything written.
 *
 * The clicks and the drags go through the input router of an instance as the pointer gives them,
 * and are read from the instance: its events and the Store it reads. The ids in the names (DR-1,
 * DR-2...) are the rows of the list of the edits of the drawing modes they hold.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Draw } from '../../api/draw.js';
import type { DocumentChange } from '../../api/events.js';
import { createDrawOnEngine } from '../../api/impl/create-draw.js';
import { createEngine, type Engine } from '../../api/impl/engine.js';
import type { DragNormalizedEvent, MouseNormalizedEvent } from '../../dispatcher/types.js';
import { haversineDistanceMeters } from '../../geometry/distance.js';
import type { Store } from '../../store/store.js';
import type { Feature } from '../../store/types.js';
import { createMapStub, createSyntheticInput, STORE_KINDS } from '../../test-utils.js';

type LngLat = [number, number];

interface Opened {
  engine: Engine;
  draw: Draw;
  store: Store;
  /** The `document.changed` received, in their order */
  changes: DocumentChange[];
}

const opened: Draw[] = [];

afterEach(() => {
  for (const draw of opened.splice(0)) draw.destroy();
  vi.useRealTimers();
});

/** An instance over a Store with an empty layer `l` */
function open(store: Store): Opened {
  vi.useFakeTimers();
  store.createLayer({
    id: 'l',
    name: 'l',
    visible: true,
    locked: false,
    opacity: 1,
    ...(store.tables ? { kind: 'table' } : { items: [] }),
    styleRule: undefined,
    metadata: undefined,
  } as never);
  const engine = createEngine(
    createMapStub().map,
    { store, initDefaultLayer: false },
    { deferDefaultMode: true },
  );
  const draw = createDrawOnEngine(engine, { store, initDefaultLayer: false });
  engine.enterDefaultMode();
  opened.push(draw);
  const changes: DocumentChange[] = [];
  draw.on('document.changed', (change) => changes.push(change));
  return { engine, draw, store, changes };
}

/**
 * The features a list of `document.changed` created, as the Store reads them: the features it
 * notified as created, and the rows it put in the stacking order from nowhere (a Store of rows
 * notifies a row not selected so)
 */
function created(view: Opened, changes: readonly DocumentChange[]): Feature[] {
  const ids = new Set<string>();
  for (const change of changes) {
    for (const feature of change.features?.created ?? []) ids.add(feature.id);
    for (const entry of change.order ?? []) {
      if (entry.kind === 'item' && entry.from === null) ids.add(entry.itemId);
    }
  }
  return [...ids].map((id) => view.store.getFeature(id) as Feature);
}

/** The coordinates of a feature */
function coordinatesOf(feature: Feature | undefined): unknown {
  return (feature?.geometry as { coordinates?: unknown } | undefined)?.coordinates;
}

/** Positions as a Store reads them, against the positions given (within the rounding of the screen) */
function expectPositions(actual: unknown, expected: readonly LngLat[]): void {
  const positions = actual as number[][];
  expect(positions).toHaveLength(expected.length);
  positions.forEach((position, i) => {
    expect(position[0]).toBeCloseTo(expected[i]?.[0] as number, 9);
    expect(position[1]).toBeCloseTo(expected[i]?.[1] as number, 9);
  });
}

/** A mouse or drag event at a position, as the normalizer gives it to the input router */
function event<T extends MouseNormalizedEvent | DragNormalizedEvent>(
  engine: Engine,
  type: T['type'],
  at: LngLat,
  start: LngLat = at,
): T {
  const point = engine.map.project(at);
  const from = engine.map.project(start);
  const inert = {
    preventDefault: () => {},
    stopPropagation: () => {},
    button: 0,
    buttons: type === 'click' || type === 'dblclick' ? 0 : 1,
    clientX: point.x,
    clientY: point.y,
  };
  return {
    type,
    point: { x: point.x, y: point.y },
    lngLat: { lng: at[0], lat: at[1] },
    originalEvent: inert as unknown as MouseEvent,
    modifiers: { shift: false, ctrl: false, alt: false, meta: false },
    dragStartPoint: { x: from.x, y: from.y },
    dragStartLngLat: { lng: start[0], lat: start[1] },
  } as unknown as T;
}

/** Clicks at positions, one after another */
function clicks(view: Opened, ...at: LngLat[]): void {
  const input = createSyntheticInput(view.engine);
  for (const p of at) input.click(p);
}

/** A double click as the browser gives it: two clicks at one place, then the double click */
function doubleClick(view: Opened, at: LngLat): void {
  const router = view.engine.inputRouter;
  router.dispatch(event<MouseNormalizedEvent>(view.engine, 'mousemove', at));
  router.dispatch(event<MouseNormalizedEvent>(view.engine, 'click', at));
  router.dispatch(event<MouseNormalizedEvent>(view.engine, 'click', at));
  router.dispatch(event<MouseNormalizedEvent>(view.engine, 'dblclick', at));
}

const P: LngLat = [0.1, 0.2];
const Q: LngLat = [0.5, 0.2];
const R: LngLat = [0.5, 0.6];

describe.each(STORE_KINDS)('the shapes the drawing modes finish over %s', (_, makeStore) => {
  it('places a point with a click, in one document.changed, and selects it (DR-1)', () => {
    const view = open(makeStore());
    expect(view.draw.setMode('draw_point')).toBe(true);
    clicks(view, P);
    expect(view.changes).toHaveLength(1);
    const [point] = created(view, view.changes);
    expect(point?.type).toBe('Point');
    expect(point?.geometry).toEqual({ type: 'Point', coordinates: P });
    expect(view.draw.getMode()).toBe('select');
    expect(view.draw.selection.get()).toEqual({ type: 'feature', ids: [point?.id] });
  });

  it('finishes a line with Enter, in one document.changed, and selects it (DR-2)', () => {
    const view = open(makeStore());
    view.draw.setMode('draw_line');
    clicks(view, P, Q, R);
    expect(view.changes).toHaveLength(0);
    createSyntheticInput(view.engine).key('Enter');
    expect(view.changes).toHaveLength(1);
    const [line] = created(view, view.changes);
    expect(line?.type).toBe('LineString');
    expect(line?.geometry.type).toBe('LineString');
    expectPositions(coordinatesOf(line), [P, Q, R]);
    expect(view.draw.getMode()).toBe('select');
    expect(view.draw.selection.get()).toEqual({ type: 'feature', ids: [line?.id] });
  });

  it('finishes a line with a double click on its last vertex, in one document.changed (DR-2)', () => {
    const view = open(makeStore());
    view.draw.setMode('draw_line');
    clicks(view, P, Q);
    doubleClick(view, R);
    expect(view.changes).toHaveLength(1);
    const [line] = created(view, view.changes);
    expect(line?.geometry.type).toBe('LineString');
    expectPositions(coordinatesOf(line), [P, Q, R]);
    expect(view.draw.getMode()).toBe('select');
  });

  it('finishes an area with a click on its first vertex, in one document.changed (DR-2)', () => {
    const view = open(makeStore());
    view.draw.setMode('draw_polygon');
    clicks(view, P, Q, R, P);
    expect(view.changes).toHaveLength(1);
    const [area] = created(view, view.changes);
    expect(area?.type).toBe('Polygon');
    expect(area?.geometry.type).toBe('Polygon');
    expectPositions((coordinatesOf(area) as unknown[])[0], [P, Q, R, P]);
    expect((coordinatesOf(area) as unknown[]).length).toBe(1);
    expect(view.draw.getMode()).toBe('select');
    expect(view.draw.selection.get()).toEqual({ type: 'feature', ids: [area?.id] });
  });

  it('places a circle by its center and a point of its edge, in one document.changed (DR-3)', () => {
    const view = open(makeStore());
    view.draw.setMode('draw_circle');
    clicks(view, P, Q);
    expect(view.changes).toHaveLength(1);
    const [shape] = created(view, view.changes);
    expect(shape?.type).toBe('Circle');
    expect(shape?.geometry).toEqual({ type: 'Point', coordinates: P });
    // Its radius reaches the second click
    const radius = shape?.properties['maplibre-gl-draw:radiusMeters'] as number;
    const distance = haversineDistanceMeters(P, Q);
    expect(Math.abs(radius - distance)).toBeLessThan(distance * 0.001);
    expect(view.draw.getMode()).toBe('select');
    expect(view.draw.selection.get()).toEqual({ type: 'feature', ids: [shape?.id] });
  });

  it('draws a freehand stroke with a drag, in one document.changed, and stays (DR-4)', () => {
    const view = open(makeStore());
    view.draw.setMode('draw_freehand');
    const router = view.engine.inputRouter;
    const { engine } = view;
    router.dispatch(event<MouseNormalizedEvent>(engine, 'mousemove', P));
    router.dispatch(event<MouseNormalizedEvent>(engine, 'mousedown', P));
    router.dispatch(event<DragNormalizedEvent>(engine, 'dragstart', P, P));
    router.dispatch(event<DragNormalizedEvent>(engine, 'dragmove', Q, P));
    expect(view.changes).toHaveLength(0);
    router.dispatch(event<DragNormalizedEvent>(engine, 'dragend', R, P));
    expect(view.changes).toHaveLength(1);
    const [stroke] = created(view, view.changes);
    expect(stroke?.type).toBe('Freehand');
    expect(stroke?.geometry.type).toBe('LineString');
    expectPositions(coordinatesOf(stroke), [P, Q, R]);
    expect(view.draw.getMode()).toBe('draw_freehand');
    expect(view.draw.selection.get().ids).toEqual([]);
  });

  it('asks the application for an image and writes nothing (DR-5)', () => {
    const view = open(makeStore());
    const requested: unknown[] = [];
    view.draw.on('image.requested', (payload) => requested.push(payload));
    view.draw.setMode('draw_image');
    vi.runAllTimers();
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatchObject({ layerId: 'l' });
    expect(view.changes).toHaveLength(0);
    expect(view.draw.getMode()).toBe('select');
  });
});
