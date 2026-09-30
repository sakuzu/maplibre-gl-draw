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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HitTestResult } from '../../dispatcher/hit-test/strategies/base.js';
import type {
  DragNormalizedEvent,
  KeyNormalizedEvent,
  MouseNormalizedEvent,
} from '../../dispatcher/types.js';
import { coordinatesOf } from '../../shared/utils/coordinates.js';
import { MemoryStore } from '../../store/memory.js';
import type { Feature } from '../../store/types.js';
import type { AuxiliaryHandleProvider } from '../../view/ui/auxiliary-handles.js';
import { createSelectionScope } from '../../view/ui/selection-scope.js';
import type { EngineModeContext } from '../handler.js';
import { SelectMode } from './mode.js';

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
  return {
    dragPan,
    getCanvas: () => ({ style: { cursor: '' } }),
    getZoom: () => 10,
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

let store: MemoryStore;
let map: ReturnType<typeof makeMap>;
let hit: HitTestResult | null;
let context: EngineModeContext;
let mode: SelectMode;

beforeEach(() => {
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
  store.createFeature(polygon('f1', 'l1'));
  map = makeMap();
  hit = null;
  context = {
    store,
    map,
    hitTestService: { hitTest: () => hit },
    // A stub for the unified z traversal (it returns only Store features). Select mode looks at
    // this rather than at hitTestService.hitTest.
    hitTestTopmost: () => (hit ? { kind: 'store', feature: hit.feature } : null),
    plugins: undefined,
    selectionScope: createSelectionScope(),
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

describe('clearing the selection in SelectMode.onStop', () => {
  it('a normal mode switch (to drawing, etc.) clears the selection', () => {
    store.setSelection('feature', ['f1']);
    store.setMode('draw_line');
    mode.onStop();
    expect(store.getSelection()).toEqual({ type: null, ids: [] });
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
      getGlobalHandles: () => [{ id: 'g1', position: [5, 5] }],
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
      getHandles: () => [{ id: 'h1', position: [5, 5] }],
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
    return (coordinatesOf(store.getFeature('f1')!) as number[][][])[0][0];
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

  it('returns a box selection to the selection it started from', () => {
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
    return { ...dragEvent(), type, point: { x: lng * 10, y: -lat * 10 }, lngLat: { lng, lat } };
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
  it('a frame that selects the same features does not change the selection again', () => {
    context.spatialIndex = { findNear: () => [], findInBounds: () => ['f1'] };
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
  });
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
    store.setSelection('feature', ['f1']);
    const right = arrow('ArrowRight');
    mode.onKeyDown(right.event);
    // The mock map draws 1 degree as 10 pixels
    expect(firstVertex()).toEqual([0.1, 0]);
    expect(right.preventDefault).toHaveBeenCalled();

    mode.onKeyDown(arrow('ArrowUp', true).event);
    expect(firstVertex()[1]).toBeCloseTo(1);
  });

  it('leaves the key to the map without a selection or while the feature is locked', () => {
    const empty = arrow('ArrowLeft');
    mode.onKeyDown(empty.event);
    expect(empty.preventDefault).not.toHaveBeenCalled();

    store.setSelection('feature', ['f1']);
    store.updateFeature('f1', { locked: true });
    const locked = arrow('ArrowLeft');
    mode.onKeyDown(locked.event);
    expect(locked.preventDefault).not.toHaveBeenCalled();
    expect(firstVertex()).toEqual([0, 0]);
  });

  it('consumes a double click on a feature (no zoom) and leaves one on the empty map', () => {
    const onFeature = { ...mouseEvent(), type: 'dblclick' as const };
    const preventOnFeature = vi.fn();
    onFeature.originalEvent = { preventDefault: preventOnFeature } as unknown as MouseEvent;
    hit = { feature: store.getFeature('f1')!, distance: 0 };
    mode.onDoubleClick(onFeature);
    expect(preventOnFeature).toHaveBeenCalled();

    const onMap = { ...mouseEvent(), type: 'dblclick' as const };
    const preventOnMap = vi.fn();
    onMap.originalEvent = { preventDefault: preventOnMap } as unknown as MouseEvent;
    hit = null;
    mode.onDoubleClick(onMap);
    expect(preventOnMap).not.toHaveBeenCalled();
  });
});
