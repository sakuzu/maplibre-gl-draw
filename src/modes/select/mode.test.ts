// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Behavior tests for the interaction lock in SelectMode's onMouseDown /
 * onDragStart
 *
 * While the interaction lock is on, dragPan is not disabled even when a feature / handle is hit,
 * and the drag is passed straight through to the map pan (the pan does not die even when
 * dragging from on top of a feature). When not locked, dragPan is disabled and the event is
 * consumed, as before. Because selection by click is handled separately by onClick, only the
 * effects of onMouseDown / onDragStart on dragPan and on the selection are verified here.
 */

import type { Polygon } from 'geojson';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HitTestResult } from '../../dispatcher/hit-test/strategies/base.js';
import type { TopHit } from '../../dispatcher/hit-test/topmost.js';
import type {
  DragNormalizedEvent,
  KeyNormalizedEvent,
  MouseNormalizedEvent,
} from '../../dispatcher/types.js';
import { STATE_BULK } from '../../feature-table/feature-row-states.js';
import { featureTablesInternals } from '../../feature-table/feature-tables.js';
import { DEFAULT_SELECTION_CONFIG } from '../../shared/config/selection.js';
import { offsetOnTangentPlane, setScreenScaleFrame } from '../../shared/math/index.js';
import { coordinatesOf } from '../../shared/utils/coordinates.js';
import { RenderedShapes } from '../../sketches/rendered-shapes.js';
import type { Store } from '../../store/store.js';
import type { Feature, StoreChange } from '../../store/types.js';
import { referenceTranslate } from '../../test-support/enu-reference.js';
import {
  createSketches,
  planeMetersPerPixel,
  planeScaleFrame,
  STORE_KINDS,
} from '../../test-utils.js';
import type { AuxiliaryHandleProvider } from '../../view/ui/auxiliary-handles.js';
import { createSelectionScope } from '../../view/ui/selection-scope.js';
import type { EngineModeContext } from '../handler.js';
import { SelectMode } from './mode.js';
import { NUDGE_COMMIT_MS } from './nudge.js';

describe.each(STORE_KINDS)('on %s', (_kind, createStore) => {
  /** Whether the Store holds its features as rows */
  const rows = createStore().tables !== undefined;

  function polygon(id: string, layerId: string): Feature {
    return {
      groupId: undefined,
      id,
      type: 'Polygon',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
            [0, 0],
          ],
        ],
      },
      layerId,
      properties: {},
      locked: false,
      visible: true,
      style: {},
    };
  }

  // A mock that maps longitude and latitude naively and linearly (1 degree = 10px), recording the
  // calls to dragPan.
  function makeMap() {
    const dragPan = {
      enabled: true,
      disable: vi.fn(function (this: { enabled: boolean }) {
        dragPan.enabled = false;
      }),
      enable: vi.fn(function (this: { enabled: boolean }) {
        dragPan.enabled = true;
      }),
      isEnabled: () => dragPan.enabled,
    };
    const map = {
      dragPan,
      getCanvas: () => ({ style: { cursor: '' } }),
      getZoom: () => 10,
      getBearing: () => 0,
      triggerRepaint: vi.fn(),
      project: (lngLat: [number, number] | { lng: number; lat: number }) => {
        const lng = Array.isArray(lngLat) ? lngLat[0] : lngLat.lng;
        const lat = Array.isArray(lngLat) ? lngLat[1] : lngLat.lat;
        return { x: lng * 10, y: -lat * 10 };
      },
      unproject: (p: [number, number] | { x: number; y: number }) => {
        const x = Array.isArray(p) ? p[0] : p.x;
        const y = Array.isArray(p) ? p[1] : p.y;
        return { lng: x / 10, lat: -y / 10 };
      },
    };
    setScreenScaleFrame(map as never, planeScaleFrame(10));
    return map;
  }

  const NO_MODIFIERS = { shift: false, ctrl: false, alt: false, meta: false };

  // The screen coordinate of the polygon center (5,5).
  function mouseEvent(shift = false): MouseNormalizedEvent {
    return {
      type: 'mousedown',
      point: { x: 50, y: -50 },
      lngLat: { lng: 5, lat: 5 },
      originalEvent: {} as MouseEvent,
      modifiers: { ...NO_MODIFIERS, shift },
    };
  }

  function dragEvent(): DragNormalizedEvent {
    return {
      type: 'dragstart',
      point: { x: 50, y: -50 },
      lngLat: { lng: 5, lat: 5 },
      originalEvent: {} as MouseEvent,
      modifiers: { ...NO_MODIFIERS },
      dragStartPoint: { x: 50, y: -50 },
      dragStartLngLat: { lng: 5, lat: 5 },
    };
  }

  let store: Store;
  let map: ReturnType<typeof makeMap>;
  let hit: HitTestResult | null;
  /** A row held as columns the hit returns, before the features of the Store */
  let rowTop: TopHit | null;
  /** Whether each hit asked for the feature of the row it hits */
  let holds: boolean[];
  let context: EngineModeContext;
  let mode: SelectMode;

  beforeEach(() => {
    store = createStore();
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
    store.createFeature(polygon('f1', 'l1'));
    map = makeMap();
    hit = null;
    rowTop = null;
    holds = [];
    const shapes = new RenderedShapes(store);
    context = {
      store,
      shapes,
      sketches: createSketches(store, shapes),
      map,
      hitTestService: { hitTest: () => hit },
      // A stub for the unified z traversal (it returns only Store features). Select mode looks at
      // this rather than at hitTestService.hitTest.
      hitTestTopmost: (_point: unknown, options?: { asFeature?: boolean }) => {
        holds.push(options?.asFeature === true);
        if (rowTop) return rowTop;
        return hit ? { kind: 'store', feature: hit.feature } : null;
      },
      plugins: undefined,
      selectionScope: createSelectionScope(),
      selectionStyle: DEFAULT_SELECTION_CONFIG,
    } as unknown as EngineModeContext;
    mode = new SelectMode();
    mode.onStart(context);
  });

  describe('SelectMode.onMouseDown interaction lock', () => {
    it('unlocked: a feature hit disables dragPan and consumes the event (control)', () => {
      hit = { feature: store.getFeature('f1')!, distance: 0 };
      const consumed = mode.onMouseDown(mouseEvent());
      expect(consumed).toBe(true);
      expect(map.dragPan.disable).toHaveBeenCalled();
    });

    it('locked: a feature hit neither disables dragPan nor consumes the event (pan through)', () => {
      store.setInteractionLock(true);
      hit = { feature: store.getFeature('f1')!, distance: 0 };
      const consumed = mode.onMouseDown(mouseEvent());
      expect(consumed).toBe(false);
      expect(map.dragPan.disable).not.toHaveBeenCalled();
      expect(map.dragPan.isEnabled()).toBe(true);
    });

    it('locked: a hit inside the bbox of a selected feature does not disable dragPan', () => {
      store.setSelection('feature', ['f1']);
      store.setInteractionLock(true);
      // Being inside the selection box (bbox), when unlocked it takes the path that disables
      // dragPan and consumes the event.
      const consumed = mode.onMouseDown(mouseEvent());
      expect(consumed).toBe(false);
      expect(map.dragPan.disable).not.toHaveBeenCalled();
    });

    it('Shift box selection disables dragPan even when locked (existing behavior kept)', () => {
      store.setInteractionLock(true);
      const consumed = mode.onMouseDown(mouseEvent(true));
      expect(consumed).toBe(false);
      expect(map.dragPan.disable).toHaveBeenCalled();
    });
  });

  describe('SelectMode: a press on a row held as columns', () => {
    const row = (locked: boolean): TopHit => ({
      kind: 'row',
      layerId: 'l1',
      id: 'r1',
      handle: 0,
      locked,
      distancePx: () => 0,
    });

    it('stops the pan of the map, locked or not, without making a feature of the row', () => {
      for (const locked of [false, true]) {
        map.dragPan.enable();
        rowTop = row(locked);
        expect(mode.onMouseDown(mouseEvent())).toBe(true);
        expect(map.dragPan.isEnabled()).toBe(false);
      }
      expect(holds.every((hold) => !hold)).toBe(true);
    });

    it('asks the hit of a press that drags for the feature of the row it hits', () => {
      hit = { feature: store.getFeature('f1') as Feature, distance: 0 };
      mode.onDragStart(dragEvent());
      expect(holds).toContain(true);
    });
  });

  describe('SelectMode.onDragStart interaction lock', () => {
    it('unlocked: a feature hit selects it and starts a move drag (control)', () => {
      hit = { feature: store.getFeature('f1')!, distance: 0 };
      mode.onDragStart(dragEvent());
      expect(store.getSelection()).toEqual({ type: 'feature', ids: ['f1'] });
      // Starting a move drag disables dragPan.
      expect(map.dragPan.disable).toHaveBeenCalled();
    });

    it('locked: a feature hit changes no selection and starts no drag (pan through)', () => {
      store.setInteractionLock(true);
      hit = { feature: store.getFeature('f1')!, distance: 0 };
      mode.onDragStart(dragEvent());
      expect(store.getSelection()).toEqual({ type: null, ids: [] });
      expect(map.dragPan.disable).not.toHaveBeenCalled();
      expect(map.dragPan.isEnabled()).toBe(true);
    });
  });

  describe('SelectMode.getDragTargets: what the drag a press starts will change', () => {
    /** A start of a drag pressed at a position of the map (1 degree = 10 px) */
    function pressAt(lng: number, lat: number, shift = false): DragNormalizedEvent {
      const point = { x: lng * 10, y: -lat * 10 };
      return {
        ...dragEvent(),
        point,
        lngLat: { lng, lat },
        dragStartPoint: point,
        dragStartLngLat: { lng, lat },
        modifiers: { ...NO_MODIFIERS, shift },
      };
    }

    /** What the drag state records of what the drag changes (null without a drag) */
    function recorded() {
      const state = store.getDragState();
      if (!state) return null;
      const { operation: _operation, rotateInfo: _rotateInfo, ...targets } = state;
      return targets;
    }

    it('answers the features a press on a feature moves, and changes nothing to answer', () => {
      hit = { feature: store.getFeature('f1') as Feature, distance: 0 };

      const targets = mode.getDragTargets(pressAt(5, 5));

      expect(targets).toEqual({ movingFeatureIds: ['f1'] });
      expect(store.getSelection()).toEqual({ type: null, ids: [] });
      expect(store.getDragState()).toBeNull();
      expect(map.dragPan.disable).not.toHaveBeenCalled();
      expect(holds).toEqual([false]);

      mode.onDragStart(pressAt(5, 5));
      expect(recorded()).toEqual(targets);
    });

    it('answers what the drag of each handle of the selection records once it starts', () => {
      store.setSelection('feature', ['f1']);
      hit = { feature: store.getFeature('f1') as Feature, distance: 0 };
      // A vertex and the inside of the frame
      const presses: [number, number][] = [
        [0, 0],
        [5, 5],
      ];
      const answers = presses.map(([lng, lat]) => {
        const targets = mode.getDragTargets(pressAt(lng, lat));
        mode.onDragStart(pressAt(lng, lat));
        const record = recorded();
        mode.onDragCancel();
        expect(record).toEqual(targets);
        return targets;
      });

      expect(answers).toEqual([
        // The vertex and the edges it starts and ends (by the vertex each starts from)
        {
          activeFeatureId: 'f1',
          activeVertex: { ring: 0, index: 0 },
          activeEdges: [
            { ring: 0, index: 0 },
            { ring: 0, index: 3 },
          ],
        },
        { movingFeatureIds: ['f1'] },
      ]);
    });

    it('answers the edge a midpoint is on, which its drag splits with the vertex it adds', () => {
      store.setSelection('feature', ['f1']);
      hit = { feature: store.getFeature('f1') as Feature, distance: 0 };

      // Before the drag adds its vertex: the edge from the vertex 0 to the vertex 1, which stays
      // a candidate with the edges after it
      expect(mode.getDragTargets(pressAt(5, 0))).toEqual({
        activeFeatureId: 'f1',
        activeEdges: [{ ring: 0, index: 0 }],
      });

      // Once it is added: the vertex 1 and the two edges it splits the edge into
      mode.onDragStart(pressAt(5, 0));
      expect(recorded()).toEqual({
        activeFeatureId: 'f1',
        activeVertex: { ring: 0, index: 1 },
        activeEdges: [
          { ring: 0, index: 0 },
          { ring: 0, index: 1 },
        ],
      });
    });

    it('answers a row held as columns by its id, without holding it', () => {
      rowTop = {
        kind: 'row',
        layerId: 'l1',
        id: 'r1',
        handle: 0,
        locked: false,
        distancePx: () => 0,
      };

      expect(mode.getDragTargets(pressAt(5, 5))).toEqual({
        movingFeatureIds: ['r1'],
      });
      expect(holds).toEqual([false]);
    });

    it('answers nothing for a box selection, under the interaction lock and on the empty map', () => {
      hit = { feature: store.getFeature('f1') as Feature, distance: 0 };
      expect(mode.getDragTargets(pressAt(5, 5, true))).toBeNull();

      store.setInteractionLock(true);
      expect(mode.getDragTargets(pressAt(5, 5))).toBeNull();
      store.setInteractionLock(false);

      hit = null;
      expect(mode.getDragTargets(pressAt(50, 50))).toBeNull();
    });

    it('answers nothing for a handle on no feature, without asking its provider', () => {
      const onHandleDragStart = vi.fn(() => true);
      context.selectionScope.auxiliaryHandles.register({
        id: 'p1',
        getHandles: () => [],
        getGlobalHandles: () => [{ kind: 'resize', id: 'g1', position: [5, 5] }],
        onHandleDragStart,
        onHandleDragMove: () => {},
        onHandleDragEnd: () => {},
      });
      try {
        expect(mode.getDragTargets(pressAt(5, 5))).toEqual({});
        expect(onHandleDragStart).not.toHaveBeenCalled();

        mode.onDragStart(pressAt(5, 5));
        expect(recorded()).toEqual({});
      } finally {
        context.selectionScope.auxiliaryHandles.clear();
      }
    });
  });

  describe('clearing the selection in SelectMode.onStop', () => {
    it('a normal mode switch (to drawing, etc.) clears the selection', () => {
      store.setSelection('feature', ['f1']);
      store.setMode('drawLine');
      mode.onStop();
      expect(store.getSelection()).toEqual({ type: null, ids: [] });
    });
  });

  describe('SelectMode: the inputs it snaps', () => {
    it('snaps the drags only (a hover and a click are not snapped and draw no indicator)', () => {
      const select = new SelectMode();
      expect(select.isSnapEnabledFor('dragstart')).toBe(true);
      expect(select.isSnapEnabledFor('dragmove')).toBe(true);
      expect(select.isSnapEnabledFor('dragend')).toBe(true);
      expect(select.isSnapEnabledFor('mousemove')).toBe(false);
      expect(select.isSnapEnabledFor('click')).toBe(false);
    });
  });

  describe('selection-independent auxiliary handles in SelectMode', () => {
    let onHandleDragStart: ReturnType<typeof vi.fn<AuxiliaryHandleProvider['onHandleDragStart']>>;

    /** A provider that always shows a handle at the polygon center (5,5) */
    function registerProvider(accept = true): void {
      onHandleDragStart = vi.fn<AuxiliaryHandleProvider['onHandleDragStart']>(() => accept);
      context.selectionScope.auxiliaryHandles.register({
        id: 'p1',
        getHandles: () => [],
        getGlobalHandles: () => [{ kind: 'resize', id: 'g1', position: [5, 5] }],
        onHandleDragStart,
        onHandleDragMove: () => {},
        onHandleDragEnd: () => {},
      });
    }

    afterEach(() => {
      context.selectionScope.auxiliaryHandles.clear();
    });

    it('onMouseDown stops dragPan and consumes the event even with an empty selection', () => {
      registerProvider();

      expect(mode.onMouseDown(mouseEvent())).toBe(true);
      expect(map.dragPan.disable).toHaveBeenCalled();
      expect(store.getSelection().type).toBeNull();
    });

    it('onDragStart delegates to the provider (the selection does not change)', () => {
      registerProvider();

      mode.onDragStart(dragEvent());

      expect(onHandleDragStart).toHaveBeenCalledTimes(1);
      expect(onHandleDragStart.mock.calls[0][0]).toEqual({
        providerId: 'p1',
        handleId: 'g1',
        featureId: '',
        global: true,
      });
      expect(store.getSelection().type).toBeNull();
    });

    it('while readOnly onMouseDown does not grab (because no drag would start)', () => {
      registerProvider();
      store.setReadOnly(true);

      expect(mode.onMouseDown(mouseEvent())).toBe(false);
      expect(map.dragPan.disable).not.toHaveBeenCalled();
    });

    it('away from the handle it takes the usual path (no grab without a feature hit)', () => {
      registerProvider();

      expect(mode.onMouseDown({ ...mouseEvent(), point: { x: 500, y: -500 } })).toBe(false);
      expect(map.dragPan.disable).not.toHaveBeenCalled();
    });

    it('with no provider implementing getGlobalHandles the usual path is unchanged', () => {
      context.selectionScope.auxiliaryHandles.register({
        id: 'selection-only',
        getHandles: () => [{ kind: 'resize', id: 'h1', position: [5, 5] }],
        onHandleDragStart: () => true,
        onHandleDragMove: () => {},
        onHandleDragEnd: () => {},
      });

      expect(mode.onMouseDown(mouseEvent())).toBe(false);
      expect(map.dragPan.disable).not.toHaveBeenCalled();
    });
  });

  describe('SelectMode.onDragCancel (a second finger ends the press)', () => {
    function dragAt(type: DragNormalizedEvent['type'], lng: number, lat: number) {
      return {
        ...dragEvent(),
        type,
        point: { x: lng * 10, y: -lat * 10 },
        lngLat: { lng, lat },
        pointerType: 'touch' as const,
      };
    }

    function firstVertex(): number[] {
      return (coordinatesOf(context.shapes.get('f1')!) as number[][][])[0][0];
    }

    it('abandons a move drag: no drag state is left, dragPan comes back, later moves do nothing', () => {
      hit = { feature: store.getFeature('f1')!, distance: 0 };
      mode.onMouseDown(mouseEvent());
      mode.onDragStart(dragAt('dragstart', 5, 5));
      mode.onDragMove(dragAt('dragmove', 6, 5));
      expect(firstVertex()).not.toEqual([0, 0]);
      expect(store.getDragState()).not.toBeNull();
      expect(map.dragPan.isEnabled()).toBe(false);

      mode.onDragCancel();

      expect(store.getDragState()).toBeNull();
      expect(map.dragPan.isEnabled()).toBe(true);
      // The drag does not hang: the moves that follow no longer move the feature
      const afterCancel = firstVertex();
      mode.onDragMove(dragAt('dragmove', 9, 5));
      mode.onDragEnd(dragAt('dragend', 9, 5));
      expect(firstVertex()).toEqual(afterCancel);
    });

    it('gives dragPan back after a press that disabled it and never became a drag', () => {
      hit = { feature: store.getFeature('f1')!, distance: 0 };
      mode.onMouseDown(mouseEvent());
      expect(map.dragPan.isEnabled()).toBe(false);

      mode.onDragCancel();

      expect(map.dragPan.isEnabled()).toBe(true);
    });

    // A Store of rows marks the rows in the box while it is drawn and selects them when it is
    // let go: the selection does not follow the box (see below)
    it.skipIf(rows)('returns a box selection to the selection it started from', () => {
      context.spatialIndex = { findNear: () => [], findInBounds: () => [] };
      store.setSelection('feature', ['f1']);
      mode.onDragStart({
        ...dragAt('dragstart', 20, 20),
        modifiers: { ...NO_MODIFIERS, shift: true },
      });
      mode.onDragMove(dragAt('dragmove', 30, 30));
      expect(store.getSelection()).toEqual({ type: null, ids: [] });

      mode.onDragCancel();

      expect(store.getBoxSelection()).toBeNull();
      expect(store.getSelection()).toEqual({ type: 'feature', ids: ['f1'] });
      expect(map.dragPan.isEnabled()).toBe(true);
    });
  });

  describe('SelectMode: cancelling a drag', () => {
    function dragAt(type: DragNormalizedEvent['type'], lng: number, lat: number) {
      return {
        ...dragEvent(),
        type,
        point: { x: lng * 10, y: -lat * 10 },
        lngLat: { lng, lat },
      };
    }

    function key(k: string): KeyNormalizedEvent {
      return {
        type: 'keydown',
        key: k,
        code: k,
        modifiers: { ...NO_MODIFIERS },
        originalEvent: { preventDefault: vi.fn() } as unknown as KeyboardEvent,
      };
    }

    it('returns the dragged feature to where it started', () => {
      const before = coordinatesOf(store.getFeature('f1')!);
      hit = { feature: store.getFeature('f1')!, distance: 0 };
      mode.onMouseDown(mouseEvent());
      mode.onDragStart(dragAt('dragstart', 5, 5));
      mode.onDragMove(dragAt('dragmove', 8, 7));

      mode.onDragCancel();

      expect(coordinatesOf(store.getFeature('f1')!)).toEqual(before);
    });

    it('a synthetic Escape during a drag cancels the drag and keeps the selection', () => {
      const before = coordinatesOf(store.getFeature('f1')!);
      hit = { feature: store.getFeature('f1')!, distance: 0 };
      mode.onMouseDown(mouseEvent());
      mode.onDragStart(dragAt('dragstart', 5, 5));
      mode.onDragMove(dragAt('dragmove', 8, 7));

      mode.onKeyDown(key('Escape'));

      expect(coordinatesOf(store.getFeature('f1')!)).toEqual(before);
      expect(store.getSelection()).toEqual({ type: 'feature', ids: ['f1'] });
      expect(store.getDragState()).toBeNull();
      // The release that follows commits nothing
      mode.onDragEnd(dragAt('dragend', 9, 9));
      expect(coordinatesOf(store.getFeature('f1')!)).toEqual(before);
    });
  });

  describe('SelectMode: box selection frames', () => {
    it.skipIf(rows)(
      'a frame that selects the same features does not change the selection again',
      () => {
        context.spatialIndex = {
          findNear: () => [],
          findInBounds: () => ['f1'],
        };
        context.boxSelectionRegistry = {
          get: () => ({ intersects: () => true }),
        } as unknown as EngineModeContext['boxSelectionRegistry'];
        const changes: unknown[] = [];
        store.subscribe((c) => {
          if (c.selection) changes.push(c.selection);
        });
        const shiftDrag = (type: DragNormalizedEvent['type'], lng: number, lat: number) => ({
          ...dragEvent(),
          type,
          point: { x: lng * 10, y: -lat * 10 },
          lngLat: { lng, lat },
          dragStartPoint: { x: -10, y: 10 },
          modifiers: { ...NO_MODIFIERS, shift: true },
        });

        mode.onDragStart(shiftDrag('dragstart', 11, 11));
        mode.onDragMove(shiftDrag('dragmove', 12, 12));
        mode.onDragMove(shiftDrag('dragmove', 13, 13));
        mode.onDragMove(shiftDrag('dragmove', 14, 14));

        expect(changes).toHaveLength(1);
        expect(store.getSelection()).toEqual({ type: 'feature', ids: ['f1'] });
      },
    );
  });

  describe('SelectMode: arrow keys and double clicks', () => {
    function arrow(k: string, shift = false) {
      const preventDefault = vi.fn();
      const event: KeyNormalizedEvent = {
        type: 'keydown',
        key: k,
        code: k,
        modifiers: { ...NO_MODIFIERS, shift },
        originalEvent: { preventDefault } as unknown as KeyboardEvent,
      };
      return { event, preventDefault };
    }

    function firstVertex(): number[] {
      return (coordinatesOf(store.getFeature('f1')!) as number[][][])[0][0];
    }

    it('moves the selection by one pixel (ten with Shift) and uses the key', () => {
      vi.useFakeTimers();
      store.setSelection('feature', ['f1']);
      // The press moves the features from the center of their frame, by a pixel of the scale of
      // the frame on the ground there (the mock map draws 1 degree as 10 pixels)
      const ring = (coordinatesOf(store.getFeature('f1') as Feature) as number[][][])[0] ?? [];
      const xs = ring.map((position) => position[0] as number);
      const ys = ring.map((position) => position[1] as number);
      const center: [number, number] = [
        (Math.min(...xs) + Math.max(...xs)) / 2,
        (Math.min(...ys) + Math.max(...ys)) / 2,
      ];
      const right = arrow('ArrowRight');
      const used = mode.onKeyDown(right.event);
      // Shown by a sketch, and written a moment after the last press
      expect(firstVertex()).toEqual([0, 0]);
      vi.advanceTimersByTime(NUDGE_COMMIT_MS + 10);
      const pressed = offsetOnTangentPlane(center, planeMetersPerPixel(10)(center), 0);
      const expected = referenceTranslate([0, 0], center, pressed);
      expect(Math.abs((firstVertex()[0] as number) - expected[0])).toBeLessThan(1e-9);
      expect(Math.abs((firstVertex()[1] as number) - expected[1])).toBeLessThan(1e-9);
      // The key is used (the input router prevents its default action)
      expect(used).toBe(true);

      mode.onKeyDown(arrow('ArrowUp', true).event);
      vi.advanceTimersByTime(NUDGE_COMMIT_MS + 10);
      expect(firstVertex()[1]).toBeCloseTo(1);
      vi.useRealTimers();
    });

    it('writes the presses of the arrow keys once, a moment after the last, as one change', () => {
      vi.useFakeTimers();
      store.setSelection('feature', ['f1']);
      const written: StoreChange[] = [];
      const stop = store.subscribe((change) => {
        if (change.features || change.rows) written.push(change);
      });
      for (let i = 0; i < 4; i++) mode.onKeyDown(arrow('ArrowRight').event);
      // Shown by a sketch of this client, the Store unwritten
      expect(firstVertex()).toEqual([0, 0]);
      expect(written).toHaveLength(0);
      expect(context.sketches.count()).toBe(1);
      expect(
        (context.shapes.get('f1')?.geometry as Polygon | undefined)?.coordinates[0]?.[0]?.[0],
      ).toBeGreaterThan(0);
      vi.advanceTimersByTime(NUDGE_COMMIT_MS - 50);
      mode.onKeyDown(arrow('ArrowRight').event);
      vi.advanceTimersByTime(NUDGE_COMMIT_MS - 50);
      expect(written).toHaveLength(0);
      vi.advanceTimersByTime(100);
      expect(written).toHaveLength(1);
      expect(firstVertex()[0]).toBeGreaterThan(0);
      expect(context.sketches.count()).toBe(0);
      stop();
      vi.useRealTimers();
    });

    it('writes the presses of the arrow keys once the selection changes or another key comes', () => {
      vi.useFakeTimers();
      store.setSelection('feature', ['f1']);
      mode.onKeyDown(arrow('ArrowRight').event);
      store.setSelection(null, []);
      const moved = firstVertex()[0] as number;
      expect(moved).toBeGreaterThan(0);
      expect(context.sketches.count()).toBe(0);

      store.setSelection('feature', ['f1']);
      mode.onKeyDown(arrow('ArrowRight').event);
      mode.onKeyDown(arrow('Shift').event);
      expect(firstVertex()[0]).toBeGreaterThan(moved);
      expect(context.sketches.count()).toBe(0);
      vi.useRealTimers();
    });

    it('leaves the key to the map without a selection or while the feature is locked', () => {
      expect(mode.onKeyDown(arrow('ArrowLeft').event)).toBe(false);

      store.setSelection('feature', ['f1']);
      store.updateFeature('f1', { locked: true });
      expect(mode.onKeyDown(arrow('ArrowLeft').event)).toBe(false);
      expect(firstVertex()).toEqual([0, 0]);
    });

    it('consumes a double click on a feature (no zoom) and leaves one on the empty map', () => {
      const onFeature = { ...mouseEvent(), type: 'dblclick' as const };
      const preventOnFeature = vi.fn();
      onFeature.originalEvent = {
        preventDefault: preventOnFeature,
      } as unknown as MouseEvent;
      hit = { feature: store.getFeature('f1')!, distance: 0 };
      mode.onDoubleClick(onFeature);
      expect(preventOnFeature).toHaveBeenCalled();

      const onMap = { ...mouseEvent(), type: 'dblclick' as const };
      const preventOnMap = vi.fn();
      onMap.originalEvent = {
        preventDefault: preventOnMap,
      } as unknown as MouseEvent;
      hit = null;
      mode.onDoubleClick(onMap);
      expect(preventOnMap).not.toHaveBeenCalled();
    });
  });

  describe.runIf(rows)('SelectMode: a box drawn over the rows of a Store of rows', () => {
    const shiftDrag = (type: DragNormalizedEvent['type'], lng: number, lat: number) => ({
      ...dragEvent(),
      type,
      point: { x: lng * 10, y: -lat * 10 },
      lngLat: { lng, lat },
      dragStartPoint: { x: -10, y: 10 },
      modifiers: { ...NO_MODIFIERS, shift: true },
    });
    const marked = (id: string): boolean => {
      const tables = store.tables;
      const handle = tables?.getRowRef(id) ?? -1;
      const place = featureTablesInternals(tables)?.placeOf(handle);
      return place ? (place.group.state[place.row] & STATE_BULK) !== 0 : false;
    };

    it('marks the rows in the box while it is drawn, and selects them when it is let go', () => {
      context.spatialIndex = { findNear: () => [], findInBounds: () => [] };
      context.boxSelectionRegistry = {
        get: () => ({ intersects: () => true }),
      } as unknown as EngineModeContext['boxSelectionRegistry'];
      mode.onDragStart(shiftDrag('dragstart', 11, 11));
      mode.onDragMove(shiftDrag('dragmove', 12, 12));
      expect(marked('f1')).toBe(true);
      expect(store.getSelection()).toEqual({ type: null, ids: [] });
      mode.onDragEnd(shiftDrag('dragend', 12, 12));
      expect(marked('f1')).toBe(false);
      expect(store.getSelection()).toEqual({ type: 'feature', ids: ['f1'] });
    });

    it('returns a box cancelled to the selection it started from, unmarked', () => {
      context.spatialIndex = { findNear: () => [], findInBounds: () => [] };
      context.boxSelectionRegistry = {
        get: () => ({ intersects: () => true }),
      } as unknown as EngineModeContext['boxSelectionRegistry'];
      mode.onDragStart(shiftDrag('dragstart', 11, 11));
      mode.onDragMove(shiftDrag('dragmove', 12, 12));
      expect(marked('f1')).toBe(true);
      mode.onDragCancel();
      expect(marked('f1')).toBe(false);
      expect(store.getBoxSelection()).toBeNull();
      expect(store.getSelection()).toEqual({ type: null, ids: [] });
    });
  });
});
