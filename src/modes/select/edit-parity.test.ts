// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the drags of the select mode leave, which a change of how a drag is shown while it goes on
 * must keep: each drag (a move, a rotation, a resize, a vertex, a radius; of one feature, of
 * several and of features selected in bulk) writes once let go in one transaction, notified as
 * one `document.changed`, and keeps the selection as it was (its features, or the features
 * selected in bulk); the vertices selected stay selected through a drag of their feature and of
 * themselves, and are let go by a move with the arrow keys; a drag cancelled writes nothing (the
 * shapes, and the rows of features selected in bulk, are as they were); a locked feature, a
 * read-only document and a hidden layer give nothing to drag.
 *
 * The drags go through the input router of an instance as the pointer gives them, and are read
 * from the instance: its events and the Store it reads. The shapes are read for the way they
 * moved (the direction, about how far), not for the numbers of the computation. The ids in the
 * names (MV-1, RT-1...) are the rows of the list of the edits of the select mode they hold.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Draw } from '../../api/draw.js';
import type { DocumentChange } from '../../api/events.js';
import { createDrawOnEngine } from '../../api/impl/create-draw.js';
import { createEngine, type Engine } from '../../api/impl/engine.js';
import type {
  DragNormalizedEvent,
  KeyNormalizedEvent,
  MouseNormalizedEvent,
} from '../../dispatcher/types.js';
import { destinationPoint } from '../../geometry/distance.js';
import { DEFAULT_SELECTION_CONFIG } from '../../shared/config/selection.js';
import { DrawStore } from '../../store/draw-store.js';
import type { Store } from '../../store/store.js';
import { TableContractStore } from '../../store/table-memory.js';
import type { Feature } from '../../store/types.js';
import {
  createMapStub,
  createSyntheticInput,
  planeMetersPerPixel,
  STORE_KINDS,
} from '../../test-utils.js';
import { computeRotateHandle } from '../../view/ui/handles.js';

type LngLat = [number, number];

/**
 * The margin of the frame of the selection, in degrees (1 degree is 100 px on the map stub, whose
 * scale near the equator lays 100 px on a degree)
 */
const MARGIN = DEFAULT_SELECTION_CONFIG.boundingBox.margin / 100;

/** A rectangle from its south-west corner to its north-east corner */
function rectangle(id: string, [w, s]: LngLat, [e, n]: LngLat, extra: Partial<Feature> = {}) {
  return {
    id,
    type: 'Polygon',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [w, s],
          [e, s],
          [e, n],
          [w, n],
          [w, s],
        ],
      ],
    },
    layerId: 'l',
    groupId: undefined,
    properties: {},
    style: {},
    visible: true,
    locked: false,
    ...extra,
  } as Feature;
}

/** A circle of a radius about a center, its radius handle toward the east */
function circle(id: string, center: LngLat, radiusMeters: number): Feature {
  return {
    id,
    type: 'Circle',
    geometry: { type: 'Point', coordinates: center },
    layerId: 'l',
    groupId: undefined,
    properties: {
      'maplibre-gl-draw:radiusMeters': radiusMeters,
      'maplibre-gl-draw:radiusHandleAngle': 90,
    },
    style: {},
    visible: true,
    locked: false,
  };
}

interface Opened {
  engine: Engine;
  draw: Draw;
  store: Store;
  /** The `document.changed` received, in their order */
  changes: DocumentChange[];
  /** The names of the events of the drags received, in their order */
  drags: Array<{ name: 'drag.started' | 'drag.ended'; cancelled?: boolean; kind: string }>;
}

const opened: Draw[] = [];

afterEach(() => {
  for (const draw of opened.splice(0)) draw.destroy();
  vi.useRealTimers();
});

/** An instance over a Store with a layer `l` of the features given */
function open(store: Store, features: readonly Feature[]): Opened {
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
  store.transact(() => {
    for (const feature of features) store.createFeature(feature);
  });
  const engine = createEngine(
    createMapStub().map,
    { store, initDefaultLayer: false },
    { deferDefaultMode: true },
  );
  const draw = createDrawOnEngine(engine, { store, initDefaultLayer: false });
  engine.enterDefaultMode();
  opened.push(draw);
  const changes: DocumentChange[] = [];
  const drags: Opened['drags'] = [];
  draw.on('document.changed', (change) => changes.push(change));
  draw.on('drag.started', ({ kind }) => drags.push({ name: 'drag.started', kind }));
  draw.on('drag.ended', ({ kind, cancelled }) =>
    drags.push({ name: 'drag.ended', kind, cancelled }),
  );
  return { engine, draw, store, changes, drags };
}

/** A Store of rows that selects more than 3 features in bulk */
function bulkStore(): Store {
  return new DrawStore(new TableContractStore(), { holdLimit: 3 });
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
    buttons: 1,
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

/** The press and the moves of a drag from a position to another, not let go */
function pressAndMove({ engine }: Opened, from: LngLat, to: LngLat): void {
  const router = engine.inputRouter;
  router.dispatch(event<MouseNormalizedEvent>(engine, 'mousemove', from));
  router.dispatch(event<MouseNormalizedEvent>(engine, 'mousedown', from));
  router.dispatch(event<DragNormalizedEvent>(engine, 'dragstart', from, from));
  const middle: LngLat = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
  router.dispatch(event<DragNormalizedEvent>(engine, 'dragmove', middle, from));
  router.dispatch(event<DragNormalizedEvent>(engine, 'dragmove', to, from));
}

/**
 * A drag from a position to another, let go there; the `document.changed` received once let go
 * (the writes of a release written in steps included)
 */
function drag(view: Opened, from: LngLat, to: LngLat): DocumentChange[] {
  pressAndMove(view, from, to);
  const count = view.changes.length;
  view.engine.inputRouter.dispatch(event<DragNormalizedEvent>(view.engine, 'dragend', to, from));
  vi.runAllTimers();
  return view.changes.slice(count);
}

/** How a drag is cancelled: Escape (the key, or the cancel the normalizer makes of it) or a pointercancel */
type Cancel = 'Escape' | 'dragcancel';

/** A drag from a position to another, cancelled there; the `document.changed` received from the press */
function cancelledDrag(view: Opened, from: LngLat, to: LngLat, cancel: Cancel): DocumentChange[] {
  const count = view.changes.length;
  pressAndMove(view, from, to);
  const router = view.engine.inputRouter;
  if (cancel === 'Escape') {
    router.dispatch({
      type: 'keydown',
      key: 'Escape',
      code: 'Escape',
      modifiers: { shift: false, ctrl: false, alt: false, meta: false },
      originalEvent: { preventDefault: () => {}, stopPropagation: () => {} },
    } as unknown as KeyNormalizedEvent);
  } else {
    router.dispatch(event<DragNormalizedEvent>(view.engine, 'dragcancel', to, from));
  }
  vi.runAllTimers();
  return view.changes.slice(count);
}

/** The features a `document.changed` updated, by their ids */
function updatedIds(change: DocumentChange | undefined): string[] {
  return (change?.features?.updated ?? []).map((entry) => entry.id).sort();
}

/** The positions of the outer ring of a polygon (or the point of a circle) as the Store reads it */
function ringOf(store: Store, id: string): number[][] {
  const geometry = store.getFeature(id)?.geometry as
    | { type: 'Polygon'; coordinates: number[][][] }
    | { type: 'Point'; coordinates: number[] };
  return geometry.type === 'Point' ? [geometry.coordinates] : (geometry.coordinates[0] ?? []);
}

/** The box of a feature as `[west, south, east, north]` */
function boxOf(store: Store, id: string): [number, number, number, number] {
  const ring = ringOf(store, id);
  const xs = ring.map((p) => p[0] as number);
  const ys = ring.map((p) => p[1] as number);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** The middle of the box of a feature */
function centerOf(store: Store, id: string): LngLat {
  const [w, s, e, n] = boxOf(store, id);
  return [(w + e) / 2, (s + n) / 2];
}

/** The rotation handle of the frame of a box (its margin included) */
function rotateHandleOf([w, s, e, n]: readonly number[]): LngLat {
  const margined = {
    topLeft: [w - MARGIN, n + MARGIN] as LngLat,
    topRight: [e + MARGIN, n + MARGIN] as LngLat,
    bottomRight: [e + MARGIN, s - MARGIN] as LngLat,
    bottomLeft: [w - MARGIN, s - MARGIN] as LngLat,
    center: [(w + e) / 2, (s + n) / 2] as LngLat,
  };
  const handle = computeRotateHandle(margined, DEFAULT_SELECTION_CONFIG.rotateHandle.distance, {
    metersPerPixel: planeMetersPerPixel(100),
  });
  return handle.position as LngLat;
}

/** The south-east resize handle of the frame of a box (its margin included) */
function southEastHandleOf([, s, e]: readonly number[]): LngLat {
  return [e + MARGIN, s - MARGIN];
}

/** Selects features with clicks (Shift for the ones after the first) */
function select(view: Opened, ...at: LngLat[]): void {
  const input = createSyntheticInput(view.engine);
  at.forEach((p, i) => {
    input.click(p, { modifiers: { shift: i > 0 } });
  });
}

// A rectangle wider than tall, and a square east of it
const A = (extra: Partial<Feature> = {}) => rectangle('a', [-0.8, -0.2], [0, 0.2], extra);
const B = (extra: Partial<Feature> = {}) => rectangle('b', [0.4, -0.2], [0.8, 0.2], extra);
const IN_A: LngLat = [-0.4, 0];
const IN_B: LngLat = [0.6, 0];

describe.each(STORE_KINDS)('the drags of the select mode over %s', (_, makeStore) => {
  describe('move (MV-1)', () => {
    it('writes a feature moved once let go, as one document.changed, and keeps it selected', () => {
      const view = open(makeStore(), [A(), B()]);
      select(view, IN_A);
      const before = centerOf(view.store, 'a');
      const changes = drag(view, IN_A, [IN_A[0] + 0.3, IN_A[1] + 0.2]);
      expect(changes).toHaveLength(1);
      expect(updatedIds(changes[0])).toEqual(['a']);
      expect(changes[0]?.features?.updated?.[0]?.isIntermediate).toBeFalsy();
      // Moved east and north by about as far as the pointer
      const after = centerOf(view.store, 'a');
      expect(after[0] - before[0]).toBeCloseTo(0.3, 2);
      expect(after[1] - before[1]).toBeCloseTo(0.2, 2);
      expect(view.draw.selection.get()).toEqual({ type: 'feature', ids: ['a'] });
      expect(view.drags).toEqual([
        { name: 'drag.started', kind: 'feature' },
        { name: 'drag.ended', kind: 'feature', cancelled: false },
      ]);
    });

    it('writes several features moved in one document.changed, and keeps them selected', () => {
      const view = open(makeStore(), [A(), B()]);
      select(view, IN_A, IN_B);
      const changes = drag(view, IN_B, [IN_B[0], IN_B[1] - 0.3]);
      expect(changes).toHaveLength(1);
      expect(updatedIds(changes[0])).toEqual(['a', 'b']);
      expect(centerOf(view.store, 'a')[1]).toBeCloseTo(-0.3, 2);
      expect(centerOf(view.store, 'b')[1]).toBeCloseTo(-0.3, 2);
      expect(view.draw.selection.get()).toEqual({ type: 'feature', ids: ['a', 'b'] });
    });
  });

  describe('rotation (RT-1, RT-2, RT-3)', () => {
    it('turns a feature from the rotation handle once let go, in one document.changed (RT-1)', () => {
      const view = open(makeStore(), [A(), B()]);
      select(view, IN_A);
      const center = centerOf(view.store, 'a');
      const handle = rotateHandleOf(boxOf(view.store, 'a'));
      // A quarter turn clockwise: the handle above the middle taken to its east
      const changes = drag(view, handle, [center[0] + 0.5, center[1]]);
      expect(changes).toHaveLength(1);
      expect(updatedIds(changes[0])).toEqual(['a']);
      expect(view.drags.map(({ kind }) => kind)).toEqual(['handle', 'handle']);
      // The rectangle wider than tall is now taller than wide, about the same middle
      const [w, s, e, n] = boxOf(view.store, 'a');
      expect(n - s).toBeGreaterThan(e - w);
      expect(centerOf(view.store, 'a')[0]).toBeCloseTo(center[0], 2);
      expect(centerOf(view.store, 'a')[1]).toBeCloseTo(center[1], 2);
      expect(view.draw.selection.get()).toEqual({ type: 'feature', ids: ['a'] });
    });

    it('turns the rotation of a feature that has one, in one document.changed (RT-2)', () => {
      const view = open(makeStore(), [A({ properties: { 'maplibre-gl-draw:rotation': 0 } })]);
      select(view, IN_A);
      const center = centerOf(view.store, 'a');
      const changes = drag(view, rotateHandleOf(boxOf(view.store, 'a')), [
        center[0] + 0.5,
        center[1],
      ]);
      expect(changes).toHaveLength(1);
      expect(updatedIds(changes[0])).toEqual(['a']);
      expect(view.drags.map(({ kind }) => kind)).toEqual(['handle', 'handle']);
      expect(view.store.getFeature('a')?.properties['maplibre-gl-draw:rotation']).not.toBe(0);
      expect(view.draw.selection.get()).toEqual({ type: 'feature', ids: ['a'] });
    });

    it('turns several features of different types in one document.changed (RT-3)', () => {
      const view = open(makeStore(), [
        A(),
        B({ properties: { 'maplibre-gl-draw:rotation': 0 } }),
        circle('c', [0.2, -0.6], 5_000),
      ]);
      select(view, IN_A, IN_B, [0.2, -0.6]);
      const box = [-0.8, -0.6 - 0.05, 0.8, 0.2];
      const before = ['a', 'b', 'c'].map((id) => ringOf(view.store, id));
      const changes = drag(view, rotateHandleOf(box), [0.5, -0.2]);
      expect(changes).toHaveLength(1);
      expect(updatedIds(changes[0])).toEqual(['a', 'b', 'c']);
      expect(view.drags.map(({ kind }) => kind)).toEqual(['handle', 'handle']);
      expect(['a', 'b', 'c'].map((id) => ringOf(view.store, id))).not.toEqual(before);
      expect(view.draw.selection.get()).toEqual({ type: 'feature', ids: ['a', 'b', 'c'] });
    });
  });

  describe('resize (RS-1, RS-2, RS-3)', () => {
    it('stretches a feature from a corner once let go, in one document.changed (RS-1)', () => {
      const view = open(makeStore(), [A(), B()]);
      select(view, IN_A);
      const [w, s, e, n] = boxOf(view.store, 'a');
      const northWest = ringOf(view.store, 'a').findIndex(([x, y]) => x === w && y === n);
      const handle = southEastHandleOf([w, s, e, n]);
      const changes = drag(view, handle, [handle[0] - 0.2, handle[1] - 0.2]);
      expect(changes).toHaveLength(1);
      expect(updatedIds(changes[0])).toEqual(['a']);
      expect(view.drags.map(({ kind }) => kind)).toEqual(['handle', 'handle']);
      // The north-west corner stays; the east side comes west, the south side goes south
      const after = boxOf(view.store, 'a');
      const corner = ringOf(view.store, 'a')[northWest] ?? [];
      expect(corner[0]).toBeCloseTo(w, 6);
      expect(corner[1]).toBeCloseTo(n, 6);
      expect(after[0]).toBeCloseTo(w, 6);
      expect(after[2]).toBeLessThan(e);
      expect(after[1]).toBeLessThan(s);
      expect(view.draw.selection.get()).toEqual({ type: 'feature', ids: ['a'] });
    });

    it('scales the scale of a feature that has one, in one document.changed (RS-2)', () => {
      const view = open(makeStore(), [A({ properties: { 'maplibre-gl-draw:scale': 1 } })]);
      select(view, IN_A);
      const handle = southEastHandleOf(boxOf(view.store, 'a'));
      const changes = drag(view, handle, [handle[0] + 0.4, handle[1] - 0.4]);
      expect(changes).toHaveLength(1);
      expect(updatedIds(changes[0])).toEqual(['a']);
      expect(view.drags.map(({ kind }) => kind)).toEqual(['handle', 'handle']);
      expect(view.store.getFeature('a')?.properties['maplibre-gl-draw:scale']).toBeGreaterThan(1);
      expect(view.draw.selection.get()).toEqual({ type: 'feature', ids: ['a'] });
    });

    it('scales the radius of a circle, in one document.changed (RS-3)', () => {
      const radius = 30_000;
      const view = open(makeStore(), [circle('c', [0, 0], radius)]);
      select(view, [0, 0]);
      const east = destinationPoint([0, 0], radius, 90)[0];
      const north = destinationPoint([0, 0], radius, 0)[1];
      const handle = southEastHandleOf([-east, -north, east, north]);
      const changes = drag(view, handle, [handle[0] + 0.3, handle[1] - 0.3]);
      expect(changes).toHaveLength(1);
      expect(updatedIds(changes[0])).toEqual(['c']);
      expect(view.drags.map(({ kind }) => kind)).toEqual(['handle', 'handle']);
      // The north-west corner of its frame stays: the center goes south-east
      expect(ringOf(view.store, 'c')[0]?.[0]).toBeGreaterThan(0);
      expect(ringOf(view.store, 'c')[0]?.[1]).toBeLessThan(0);
      expect(
        view.store.getFeature('c')?.properties['maplibre-gl-draw:radiusMeters'],
      ).toBeGreaterThan(radius);
      expect(view.draw.selection.get()).toEqual({ type: 'feature', ids: ['c'] });
    });
  });

  describe('vertices and the radius (VX-1, VX-3, RD-1)', () => {
    it('writes a vertex dragged once let go, in one document.changed (VX-1)', () => {
      const view = open(makeStore(), [A(), B()]);
      select(view, IN_A);
      const changes = drag(view, [0, 0.2], [0.2, 0.5]);
      expect(changes).toHaveLength(1);
      expect(updatedIds(changes[0])).toEqual(['a']);
      expect(view.drags.map(({ kind }) => kind)).toEqual(['vertex', 'vertex']);
      // The vertex is under the pointer, the others stay
      const ring = ringOf(view.store, 'a');
      expect(ring[2]?.[0]).toBeCloseTo(0.2, 2);
      expect(ring[2]?.[1]).toBeCloseTo(0.5, 2);
      expect(ring[0]).toEqual([-0.8, -0.2]);
      expect(view.draw.selection.get()).toEqual({ type: 'feature', ids: ['a'] });
    });

    it('writes the features that share the vertex dragged in the same document.changed (VX-3)', () => {
      const view = open(makeStore(), [A(), rectangle('d', [0, 0.2], [0.3, 0.5])]);
      view.draw.options.update({ topology: { sharedVertexDrag: true } });
      select(view, IN_A);
      const changes = drag(view, [0, 0.2], [0.1, 0.1]);
      expect(changes).toHaveLength(1);
      expect(updatedIds(changes[0])).toEqual(['a', 'd']);
      expect(ringOf(view.store, 'd')[0]?.[0]).toBeCloseTo(0.1, 2);
      expect(ringOf(view.store, 'd')[0]?.[1]).toBeCloseTo(0.1, 2);
      expect(view.draw.selection.get()).toEqual({ type: 'feature', ids: ['a'] });
    });

    it('writes the radius of a circle dragged once let go, in one document.changed (RD-1)', () => {
      const radius = 30_000;
      const view = open(makeStore(), [circle('c', [0, 0], radius)]);
      select(view, [0, 0]);
      const handle = destinationPoint([0, 0], radius, 90) as LngLat;
      const changes = drag(view, handle, [handle[0] + 0.3, handle[1]]);
      expect(changes).toHaveLength(1);
      expect(updatedIds(changes[0])).toEqual(['c']);
      expect(view.drags.map(({ kind }) => kind)).toEqual(['handle', 'handle']);
      expect(
        view.store.getFeature('c')?.properties['maplibre-gl-draw:radiusMeters'],
      ).toBeGreaterThan(radius);
      expect(view.draw.selection.get()).toEqual({ type: 'feature', ids: ['c'] });
    });
  });

  describe('the vertices selected (MV-4, VX-2, NG-3)', () => {
    const corners = [
      { ring: 0, index: 1 },
      { ring: 0, index: 2 },
    ];

    it('keeps the vertices selected through a move of their feature (MV-4)', () => {
      const view = open(makeStore(), [A(), B()]);
      select(view, IN_A);
      expect(view.draw.vertexSelection.set('a', corners)).toBe(true);
      const changes = drag(view, IN_A, [IN_A[0] + 0.2, IN_A[1]]);
      expect(changes).toHaveLength(1);
      expect(centerOf(view.store, 'a')[0]).toBeCloseTo(-0.2, 2);
      expect(view.draw.vertexSelection.get()).toEqual({ featureId: 'a', vertices: corners });
    });

    it('moves every vertex selected with one of them, and keeps them selected (VX-2)', () => {
      const view = open(makeStore(), [A(), B()]);
      select(view, IN_A);
      view.draw.vertexSelection.set('a', corners);
      const changes = drag(view, [0, 0.2], [0.1, 0.4]);
      expect(changes).toHaveLength(1);
      const ring = ringOf(view.store, 'a');
      // Both moved the same way: east and north
      expect(ring[1]?.[0]).toBeCloseTo(0.1, 2);
      expect(ring[1]?.[1]).toBeCloseTo(0, 2);
      expect(ring[2]?.[0]).toBeCloseTo(0.1, 2);
      expect(ring[2]?.[1]).toBeCloseTo(0.4, 2);
      expect(ring[0]).toEqual([-0.8, -0.2]);
      expect(view.draw.vertexSelection.get()).toEqual({ featureId: 'a', vertices: corners });
    });

    it('moves the whole feature with an arrow key, and lets go of its vertices (NG-3)', () => {
      const view = open(makeStore(), [A(), B()]);
      select(view, IN_A);
      view.draw.vertexSelection.set('a', corners);
      const before = centerOf(view.store, 'a');
      createSyntheticInput(view.engine).key('ArrowRight');
      vi.runAllTimers();
      const after = centerOf(view.store, 'a');
      expect(after[0]).toBeGreaterThan(before[0]);
      expect(ringOf(view.store, 'a')[0]?.[0]).toBeGreaterThan(-0.8);
      expect(view.draw.vertexSelection.get()).toBeNull();
      expect(view.draw.selection.get()).toEqual({ type: 'feature', ids: ['a'] });
    });
  });

  describe('a drag cancelled with Escape writes nothing', () => {
    const cases: Array<[string, (view: Opened) => [LngLat, LngLat]]> = [
      ['a move (MV-1)', () => [IN_A, [IN_A[0] + 0.3, IN_A[1] + 0.2]]],
      ['a rotation (RT-1)', (view) => [rotateHandleOf(boxOf(view.store, 'a')), [0.2, 0]]],
      [
        'a resize (RS-1)',
        (view) => {
          const handle = southEastHandleOf(boxOf(view.store, 'a'));
          return [handle, [handle[0] + 0.3, handle[1] - 0.3]];
        },
      ],
      [
        'a vertex (VX-1)',
        () => [
          [0, 0.2],
          [0.2, 0.5],
        ],
      ],
    ];
    for (const [name, path] of cases) {
      for (const cancel of ['Escape', 'dragcancel'] as const) {
        it(`${name}, by ${cancel === 'Escape' ? 'the key' : 'the cancel of the pointer'}`, () => {
          const view = open(makeStore(), [A(), B()]);
          select(view, IN_A);
          const before = view.store.getFeature('a');
          const [from, to] = path(view);
          cancelledDrag(view, from, to, cancel);
          expect(view.store.getFeature('a')?.geometry).toEqual(before?.geometry);
          expect(view.store.getFeature('a')?.properties).toEqual(before?.properties);
          expect(view.drags[view.drags.length - 1]).toMatchObject({
            name: 'drag.ended',
            cancelled: true,
          });
          expect(view.draw.selection.get()).toEqual({ type: 'feature', ids: ['a'] });
        });
      }
    }
  });

  describe('what gives nothing to drag', () => {
    it('a locked feature', () => {
      const view = open(makeStore(), [A({ locked: true }), B()]);
      select(view, IN_A);
      const before = view.store.getFeature('a')?.geometry;
      const changes = drag(view, IN_A, [IN_A[0] + 0.3, IN_A[1]]);
      expect(changes).toHaveLength(0);
      expect(view.store.getFeature('a')?.geometry).toEqual(before);
      expect(view.drags).toEqual([]);
    });

    it('a read-only document', () => {
      const view = open(makeStore(), [A(), B()]);
      select(view, IN_A);
      view.draw.setReadOnly(true);
      const before = view.store.getFeature('a')?.geometry;
      const changes = drag(view, IN_A, [IN_A[0] + 0.3, IN_A[1]]);
      expect(changes).toHaveLength(0);
      expect(view.store.getFeature('a')?.geometry).toEqual(before);
      expect(view.drags).toEqual([]);
    });

    it('a feature of a hidden layer', () => {
      const view = open(makeStore(), [A(), B()]);
      view.draw.layers.update('l', { visible: false });
      select(view, IN_A);
      expect(view.draw.selection.get().ids).toEqual([]);
      const before = view.store.getFeature('a')?.geometry;
      const changes = drag(view, IN_A, [IN_A[0] + 0.3, IN_A[1]]);
      expect(changes).toHaveLength(0);
      expect(view.store.getFeature('a')?.geometry).toEqual(before);
      expect(view.drags).toEqual([]);
    });
  });
});

describe('the drags of features selected in bulk (MV-3, RT-4, RS-5)', () => {
  /** Six squares in a row along the equator, more than the Store of rows selects one by one */
  const squares = Array.from({ length: 6 }, (_, i) =>
    rectangle(`f${i}`, [-0.9 + i * 0.3, -0.1], [-0.8 + i * 0.3, 0]),
  );
  const ids = squares.map((feature) => feature.id);

  function openBulk(): Opened {
    const view = open(bulkStore(), squares);
    view.draw.selection.set('feature', ids);
    expect(view.draw.selection.get().bulk?.count).toBe(6);
    return view;
  }

  /** The box of the features selected in bulk */
  function boundsOf(view: Opened): readonly number[] {
    return view.draw.selection.get().bulk?.bounds ?? [];
  }

  /** The first corner of each square, as its row reads it */
  function corners(view: Opened): number[][] {
    return ids.map((id) => ringOf(view.store, id)[0] ?? []);
  }

  it('writes a move once let go, in one document.changed, and keeps them selected in bulk (MV-3)', () => {
    const view = openBulk();
    const before = corners(view);
    const changes = drag(view, [-0.85, -0.05], [-0.65, 0.15]);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.rows).toBeDefined();
    // Every one moved east and north by about as far as the pointer
    corners(view).forEach(([x, y], i) => {
      expect((x as number) - (before[i]?.[0] as number)).toBeCloseTo(0.2, 2);
      expect((y as number) - (before[i]?.[1] as number)).toBeCloseTo(0.2, 2);
    });
    expect(view.draw.selection.get().bulk?.count).toBe(6);
    expect(view.drags).toEqual([
      { name: 'drag.started', kind: 'feature' },
      { name: 'drag.ended', kind: 'feature', cancelled: false },
    ]);
  });

  it('writes a rotation once let go, in one document.changed, and keeps them selected in bulk (RT-4)', () => {
    const view = openBulk();
    const before = corners(view);
    const changes = drag(view, rotateHandleOf(boundsOf(view)), [0.5, -0.4]);
    expect(changes).toHaveLength(1);
    expect(corners(view)).not.toEqual(before);
    expect(view.draw.selection.get().bulk?.count).toBe(6);
    expect(view.drags.map(({ kind }) => kind)).toEqual(['handle', 'handle']);
  });

  it('writes a resize once let go, in one document.changed, and keeps them selected in bulk (RS-5)', () => {
    const view = openBulk();
    const before = corners(view);
    const handle = southEastHandleOf(boundsOf(view));
    const changes = drag(view, handle, [handle[0] + 0.3, handle[1]]);
    expect(changes).toHaveLength(1);
    // The west side stays, the others go east
    const after = corners(view);
    expect(after[0]?.[0]).toBeCloseTo(before[0]?.[0] as number, 6);
    expect(after[5]?.[0]).toBeGreaterThan(before[5]?.[0] as number);
    expect(view.draw.selection.get().bulk?.count).toBe(6);
  });

  const bulkDrags: Array<[string, (view: Opened) => [LngLat, LngLat]]> = [
    [
      'a move (MV-3)',
      () => [
        [-0.85, -0.05],
        [-0.65, 0.15],
      ],
    ],
    ['a rotation (RT-4)', (view) => [rotateHandleOf(boundsOf(view)), [0.5, -0.4]]],
    [
      'a resize (RS-5)',
      (view) => {
        const handle = southEastHandleOf(boundsOf(view));
        return [handle, [handle[0] + 0.3, handle[1]]];
      },
    ],
  ];
  for (const [name, path] of bulkDrags) {
    for (const cancel of ['Escape', 'dragcancel'] as const) {
      it(`writes nothing of ${name} cancelled by ${cancel === 'Escape' ? 'the key Escape' : 'the cancel of the pointer'}`, () => {
        const view = openBulk();
        const before = corners(view);
        const [from, to] = path(view);
        const changes = cancelledDrag(view, from, to, cancel);
        expect(changes).toHaveLength(0);
        expect(corners(view)).toEqual(before);
        expect(view.drags[view.drags.length - 1]).toMatchObject({
          name: 'drag.ended',
          cancelled: true,
        });
        expect(view.draw.selection.get().bulk?.count).toBe(6);
      });
    }
  }

  it('gives nothing to drag while one of them is locked', () => {
    const view = open(bulkStore(), [
      ...squares.slice(0, 5),
      { ...squares[5], locked: true } as Feature,
    ]);
    view.draw.selection.set('feature', ids);
    expect(view.draw.selection.get().bulk?.count).toBe(6);
    const before = corners(view);
    const changes = drag(view, [-0.85, -0.05], [-0.65, 0.15]);
    expect(changes).toHaveLength(0);
    expect(corners(view)).toEqual(before);
    expect(view.drags).toEqual([]);
  });
});
