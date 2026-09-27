// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the snapping replacement of InputRouter
 *
 * InputRouter is the single entry point for coordinates, so if the replacement here
 * works then every mode and the vertex drag support snapping. These tests verify that
 * click / mousemove / the drag events reach the mode with the snapped coordinates,
 * that a modifier key and snap: false let them pass through untouched, that a mode can
 * decline per input type via isSnapEnabledFor, and that the grabbed vertex is excluded
 * while a vertex is being dragged.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DisplayInteractions } from '../dataset/interaction.js';
import type { ModeContext, ModeHandler, SnapInputType } from '../modes/handler.js';
import type { ModeManager } from '../modes/manager.js';
import type { FeatureCoordinates } from '../shared/types/model.js';
import { geometryFromCoordinates } from '../shared/utils/coordinates.js';
import { createSnapService } from '../snapping/service.js';
import type { SnapContext, SnapService } from '../snapping/types.js';
import { MemoryStore } from '../store/memory.js';
import { RBushSpatialIndex } from '../store/spatial/spatial-index.js';
import type { Feature, Layer } from '../store/types.js';
import { createInputRouter } from './input-router.js';
import type {
  DragNormalizedEvent,
  MapClickEventPayload,
  MouseNormalizedEvent,
  NormalizedEvent,
  NormalizedEventMap,
} from './types.js';

const ZOOM = 14;
/** The longitude of one pixel at zoom 14 (= 360 / (512 * 2^14)) */
const DEG_PER_PIXEL_LNG = 360 / (512 * 2 ** ZOOM);

/** The vertex used as the snapping target */
const TARGET: [number, number] = [139.7, 35.68];

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

/** A mode handler that only records the events it receives */
class RecordingMode implements ModeHandler {
  modeName = 'select';
  clicks: MouseNormalizedEvent[] = [];
  moves: MouseNormalizedEvent[] = [];
  dragStarts: DragNormalizedEvent[] = [];
  dragMoves: DragNormalizedEvent[] = [];
  dragEnds: DragNormalizedEvent[] = [];
  downs: MouseNormalizedEvent[] = [];
  /** The value returned by getSnapPreference (used to tie-break equal snap candidates) */
  snapPreference: { featureId: string; datasetId?: string } | null = null;
  /**
   * Whether snapping is wanted per input type (by default unimplemented = snap for
   * every input type)
   *
   * Assigning it inside a test produces the case where the mode implements the hook.
   */
  isSnapEnabledFor?: (inputType: SnapInputType) => boolean;

  getSnapPreference(): { featureId: string; datasetId?: string } | null {
    return this.snapPreference;
  }

  onDragStart(event: DragNormalizedEvent): void {
    this.dragStarts.push(event);
  }
  onDragEnd(event: DragNormalizedEvent): void {
    this.dragEnds.push(event);
  }

  onClick(event: MouseNormalizedEvent): void {
    this.clicks.push(event);
  }
  onMouseMove(event: MouseNormalizedEvent): void {
    this.moves.push(event);
  }
  onDragMove(event: DragNormalizedEvent): void {
    this.dragMoves.push(event);
  }
  onMouseDown(event: MouseNormalizedEvent): undefined {
    this.downs.push(event);
    return undefined;
  }
}

let store: MemoryStore;
let spatialIndex: RBushSpatialIndex;
let normalizer: FakeNormalizer;
let mode: RecordingMode;
let snapService: SnapService;

function makeMouseEvent(
  type: MouseNormalizedEvent['type'],
  lng: number,
  lat: number,
  overrides: Partial<MouseNormalizedEvent> = {},
): MouseNormalizedEvent {
  return {
    type,
    point: { x: 10, y: 10 },
    lngLat: { lng, lat },
    originalEvent: { stopPropagation: () => {}, preventDefault: () => {} } as unknown as MouseEvent,
    modifiers: { shift: false, ctrl: false, alt: false, meta: false },
    ...overrides,
  };
}

function makeDragEvent(
  type: DragNormalizedEvent['type'],
  lng: number,
  lat: number,
  overrides: Partial<DragNormalizedEvent> = {},
): DragNormalizedEvent {
  return {
    type,
    point: { x: 10, y: 10 },
    lngLat: { lng, lat },
    originalEvent: {} as unknown as MouseEvent,
    modifiers: { shift: false, ctrl: false, alt: false, meta: false },
    dragStartPoint: { x: 0, y: 0 },
    dragStartLngLat: { lng, lat },
    ...overrides,
  };
}

function makeDragMoveEvent(
  lng: number,
  lat: number,
  overrides: Partial<DragNormalizedEvent> = {},
): DragNormalizedEvent {
  return makeDragEvent('dragmove', lng, lat, overrides);
}

function addFeature(id: string, type: string, coordinates: FeatureCoordinates): void {
  const feature: Feature = {
    id,
    type,
    geometry: geometryFromCoordinates(type, coordinates),
    layerId: 'l1',
    groupId: undefined,
    properties: {},
    locked: false,
    visible: true,
    style: {},
  };
  store.createFeature(feature);
  const layer = store.getLayer('l1');
  if (layer) store.updateLayer('l1', { items: [...layer.items, id] });
  spatialIndex.insert(feature);
}

function startRouter(
  displayInteractions?: DisplayInteractions,
  notifyMapClick?: (payload: MapClickEventPayload) => void,
): ReturnType<typeof createInputRouter> {
  const map = { getZoom: () => ZOOM } as unknown as MapLibreMap;
  const modeManager = {
    getHandler: () => mode,
  } as unknown as ModeManager;
  const context = { store, map } as unknown as ModeContext;

  const router = createInputRouter({
    normalizer: normalizer as unknown as Parameters<typeof createInputRouter>[0]['normalizer'],
    modeManager,
    context,
    map,
    snapService,
    displayInteractions,
    notifyMapClick,
  });
  router.start();
  return router;
}

/** A fake that records only the calls to displayInteractions */
function makeRecordingInteractions(): DisplayInteractions & {
  clicks: number;
  moves: number;
  resets: number;
} {
  const rec = {
    clicks: 0,
    moves: 0,
    resets: 0,
    handleClick() {
      rec.clicks += 1;
    },
    handleMouseMove() {
      rec.moves += 1;
    },
    reset() {
      rec.resets += 1;
    },
  };
  return rec;
}

/** Coordinates the specified number of pixels away from the snapping target */
function nearTarget(pixels: number): { lng: number; lat: number } {
  return { lng: TARGET[0] + pixels * DEG_PER_PIXEL_LNG, lat: TARGET[1] };
}

function emit<K extends keyof NormalizedEventMap>(event: NormalizedEventMap[K]): void {
  normalizer.emit(event);
}

beforeEach(() => {
  store = new MemoryStore();
  spatialIndex = new RBushSpatialIndex();
  const layer: Layer = {
    id: 'l1',
    name: 'l1',
    visible: true,
    locked: false,
    opacity: 1,
    items: [],
    styleRule: undefined,
    metadata: undefined,
  };
  store.createLayer(layer);
  normalizer = new FakeNormalizer();
  mode = new RecordingMode();
  snapService = createSnapService({ store, spatialIndex });
});

describe('Snapping of InputRouter', () => {
  it('click reaches the mode with the snapped coordinates', () => {
    addFeature('p1', 'Point', TARGET);
    startRouter();

    emit(makeMouseEvent('click', nearTarget(4).lng, nearTarget(4).lat));

    expect(mode.clicks).toHaveLength(1);
    expect(mode.clicks[0].lngLat).toEqual({ lng: TARGET[0], lat: TARGET[1] });
  });

  it('mousemove and dragmove also arrive with the snapped coordinates', () => {
    addFeature('p1', 'Point', TARGET);
    startRouter();

    emit(makeMouseEvent('mousemove', nearTarget(3).lng, nearTarget(3).lat));
    normalizer.emit(makeDragMoveEvent(nearTarget(3).lng, nearTarget(3).lat));

    expect(mode.moves[0].lngLat).toEqual({ lng: TARGET[0], lat: TARGET[1] });
    expect(mode.dragMoves[0].lngLat).toEqual({ lng: TARGET[0], lat: TARGET[1] });
  });

  it('dragstart and dragend also arrive with the snapped coordinates', () => {
    addFeature('p1', 'Point', TARGET);
    startRouter();

    const cursor = nearTarget(3);
    normalizer.emit(makeDragEvent('dragstart', cursor.lng, cursor.lat));
    normalizer.emit(makeDragEvent('dragend', cursor.lng, cursor.lat));

    expect(mode.dragStarts[0].lngLat).toEqual({ lng: TARGET[0], lat: TARGET[1] });
    expect(mode.dragEnds[0].lngLat).toEqual({ lng: TARGET[0], lat: TARGET[1] });
  });

  it('does not snap to the feature being moved during a move drag (no pull-back)', () => {
    addFeature('p1', 'Point', TARGET);
    startRouter();
    store.setDragState({ operation: 'move', movingFeatureIds: ['p1'] });

    const cursor = nearTarget(3);
    normalizer.emit(makeDragMoveEvent(cursor.lng, cursor.lat));

    expect(mode.dragMoves[0].lngLat).toEqual(cursor);
  });

  it('snaps to features that are not being moved even during a move drag', () => {
    addFeature('p1', 'Point', TARGET);
    addFeature('p2', 'Point', [TARGET[0] + 0.05, TARGET[1]]);
    startRouter();
    store.setDragState({ operation: 'move', movingFeatureIds: ['p2'] });

    const cursor = nearTarget(3);
    normalizer.emit(makeDragMoveEvent(cursor.lng, cursor.lat));

    expect(mode.dragMoves[0].lngLat).toEqual({ lng: TARGET[0], lat: TARGET[1] });
  });

  it('snaps to the nearest point on an edge when over that edge', () => {
    addFeature('line', 'LineString', [
      [TARGET[0], TARGET[1] - 0.01],
      [TARGET[0], TARGET[1] + 0.01],
    ]);
    startRouter();

    const cursor = nearTarget(4);
    emit(makeMouseEvent('click', cursor.lng, cursor.lat));

    expect(mode.clicks[0].lngLat.lng).toBeCloseTo(TARGET[0], 12);
    expect(mode.clicks[0].lngLat.lat).toBeCloseTo(cursor.lat, 12);
  });

  it('arrives with the original coordinates outside the tolerance', () => {
    addFeature('p1', 'Point', TARGET);
    startRouter();

    const cursor = nearTarget(30);
    emit(makeMouseEvent('click', cursor.lng, cursor.lat));

    expect(mode.clicks[0].lngLat).toEqual(cursor);
  });

  it('does not snap while the modifier key (Alt) is held down', () => {
    addFeature('p1', 'Point', TARGET);
    startRouter();

    const cursor = nearTarget(2);
    emit(
      makeMouseEvent('click', cursor.lng, cursor.lat, {
        modifiers: { shift: false, ctrl: false, alt: true, meta: false },
      }),
    );

    expect(mode.clicks[0].lngLat).toEqual(cursor);
  });

  it('an event with snap: false is not passed through snapping', () => {
    addFeature('p1', 'Point', TARGET);
    startRouter();

    const cursor = nearTarget(2);
    emit(makeMouseEvent('click', cursor.lng, cursor.lat, { snap: false }));

    expect(mode.clicks[0].lngLat).toEqual(cursor);
    // Since snapping was not run, the result is not updated either
    expect(snapService.getResult()).toBeNull();
  });

  it('only the input types the mode declined via isSnapEnabledFor pass untouched', () => {
    addFeature('p1', 'Point', TARGET);
    startRouter();
    // The same declaration as freehand (no snapping only in the middle of a stroke)
    mode.isSnapEnabledFor = (inputType) => inputType !== 'dragmove';

    const cursor = nearTarget(3);
    normalizer.emit(makeDragEvent('dragstart', cursor.lng, cursor.lat));
    normalizer.emit(makeDragMoveEvent(cursor.lng, cursor.lat));
    normalizer.emit(makeDragEvent('dragend', cursor.lng, cursor.lat));
    emit(makeMouseEvent('click', cursor.lng, cursor.lat));

    expect(mode.dragMoves[0].lngLat).toEqual(cursor);
    expect(mode.dragStarts[0].lngLat).toEqual({ lng: TARGET[0], lat: TARGET[1] });
    expect(mode.dragEnds[0].lngLat).toEqual({ lng: TARGET[0], lat: TARGET[1] });
    expect(mode.clicks[0].lngLat).toEqual({ lng: TARGET[0], lat: TARGET[1] });
  });

  it('a mode that does not implement isSnapEnabledFor snaps for every type (default)', () => {
    addFeature('p1', 'Point', TARGET);
    startRouter();

    const cursor = nearTarget(3);
    normalizer.emit(makeDragMoveEvent(cursor.lng, cursor.lat));

    expect(mode.isSnapEnabledFor).toBeUndefined();
    expect(mode.dragMoves[0].lngLat).toEqual({ lng: TARGET[0], lat: TARGET[1] });
  });

  it('the getSnapPreference of the mode reaches the provider as preferFeature', () => {
    const seen: Array<SnapContext['preferFeature']> = [];
    snapService.register({
      name: 'spy',
      candidates: (_bbox, ctx) => {
        seen.push(ctx.preferFeature);
        return [];
      },
    });
    startRouter();

    // It is not carried while there is no feature to prefer
    emit(makeMouseEvent('click', TARGET[0], TARGET[1]));
    expect(seen[0]).toBeUndefined();

    mode.snapPreference = { featureId: 'f1', datasetId: 'data' };
    emit(makeMouseEvent('click', TARGET[0], TARGET[1]));

    expect(seen[1]).toEqual({ featureId: 'f1', datasetId: 'data' });
  });

  it('can be stopped by the equivalent of draw.snapping.setEnabled(false)', () => {
    addFeature('p1', 'Point', TARGET);
    startRouter();
    snapService.setEnabled(false);

    const cursor = nearTarget(2);
    emit(makeMouseEvent('click', cursor.lng, cursor.lat));

    expect(mode.clicks[0].lngLat).toEqual(cursor);
  });

  it('the coordinates are left as-is when snapService is not passed', () => {
    addFeature('p1', 'Point', TARGET);
    const map = { getZoom: () => ZOOM } as unknown as MapLibreMap;
    const router = createInputRouter({
      normalizer: normalizer as unknown as Parameters<typeof createInputRouter>[0]['normalizer'],
      modeManager: { getHandler: () => mode } as unknown as ModeManager,
      context: { store, map } as unknown as ModeContext,
      map,
    });
    router.start();

    const cursor = nearTarget(2);
    emit(makeMouseEvent('click', cursor.lng, cursor.lat));

    expect(mode.clicks[0].lngLat).toEqual(cursor);
  });

  it('excludes the grabbed vertex during a vertex drag and snaps to other ones', () => {
    // The grabbed vertex (index 0) and a vertex 40 pixels away (index 1)
    const other: [number, number] = [TARGET[0] + 40 * DEG_PER_PIXEL_LNG, TARGET[1]];
    addFeature('line', 'LineString', [TARGET, other]);
    startRouter();

    store.setDragState({
      operation: 'vertex',
      activeFeatureId: 'line',
      activeVertex: { ring: 0, index: 0 },
    });

    // Right next to the grabbed vertex: it does not snap to itself
    const nearSelf = nearTarget(1);
    normalizer.emit(makeDragMoveEvent(nearSelf.lng, nearSelf.lat));
    expect(mode.dragMoves[0].lngLat).toEqual(nearSelf);

    // Near the vertex on the other side: it does snap to that one (a vertex of the
    // same feature stays a candidate so that a ring can be closed)
    const nearOther = nearTarget(36);
    normalizer.emit(makeDragMoveEvent(nearOther.lng, nearOther.lat));
    expect(mode.dragMoves[1].lngLat).toEqual({ lng: other[0], lat: other[1] });
  });
});

describe('delivery to datasets is narrowed by the mode', () => {
  // A click in a drawing mode places a vertex, and if that same click were delivered
  // as a click on the data the host application's "click to select" would fire by
  // mistake while drawing (the root of the bug where starting to draw a circle on top
  // of a huge polygon of data covers the whole screen with the selection highlight).

  it('delivers click / mousemove in select mode', () => {
    const rec = makeRecordingInteractions();
    startRouter(rec);

    emit(makeMouseEvent('click', TARGET[0], TARGET[1]));
    emit(makeMouseEvent('mousemove', TARGET[0], TARGET[1]));

    expect(rec.clicks).toBe(1);
    expect(rec.moves).toBe(1);
    expect(rec.resets).toBe(0);
  });

  it('does not deliver click in a drawing mode, and mousemove discards the hover', () => {
    const rec = makeRecordingInteractions();
    mode.modeName = 'draw_circle';
    startRouter(rec);

    emit(makeMouseEvent('click', TARGET[0], TARGET[1]));
    emit(makeMouseEvent('mousemove', TARGET[0], TARGET[1]));

    expect(rec.clicks).toBe(0);
    expect(rec.moves).toBe(0);
    expect(rec.resets).toBe(1);
  });

  it('does not deliver for a custom mode either unless it is select', () => {
    const rec = makeRecordingInteractions();
    mode.modeName = 'draw_text';
    startRouter(rec);

    emit(makeMouseEvent('click', TARGET[0], TARGET[1]));

    expect(rec.clicks).toBe(0);
  });
});

describe('notification of a click in select mode (the source of draw.map.click)', () => {
  // A read-only notification for a host application that needs "a click anywhere on
  // the map" (placing a comment pin, for instance). Unlike display.click, it does not
  // fall silent depending on whether a feature was hit.

  it('fires with the raw coordinates in select mode whether or not anything is hit', () => {
    const notified: MapClickEventPayload[] = [];
    addFeature('p1', 'Point', TARGET);
    startRouter(undefined, (payload) => notified.push(payload));

    emit(makeMouseEvent('click', nearTarget(4).lng, nearTarget(4).lat));

    expect(notified).toHaveLength(1);
    // The mode receives the post-snap coordinates, but the notification carries the
    // raw coordinates from before snapping
    expect(mode.clicks[0].lngLat).toEqual({ lng: TARGET[0], lat: TARGET[1] });
    expect(notified[0].lngLat).toEqual([nearTarget(4).lng, nearTarget(4).lat]);
    expect(notified[0].point).toEqual({ x: 10, y: 10 });
  });

  it('does not fire in a drawing mode', () => {
    const notified: MapClickEventPayload[] = [];
    mode.modeName = 'draw_circle';
    startRouter(undefined, (payload) => notified.push(payload));

    emit(makeMouseEvent('click', TARGET[0], TARGET[1]));

    expect(notified).toHaveLength(0);
  });
});

describe('holding input that originates from the pointer', () => {
  // While the keyboard is determining the coordinates, as with a numeric input panel,
  // interruption by the real pointer is stopped. Synthetic input (dispatch) and the
  // camera operations of the map are not stopped.

  it('the click / mousemove / dblclick of the pointer do not reach the mode while held', () => {
    const router = startRouter();
    router.setPointerHold(true);

    emit(makeMouseEvent('click', TARGET[0], TARGET[1]));
    emit(makeMouseEvent('mousemove', TARGET[0], TARGET[1]));
    emit(makeMouseEvent('dblclick', TARGET[0], TARGET[1]));

    expect(router.isPointerHeld()).toBe(true);
    expect(mode.clicks).toHaveLength(0);
    expect(mode.moves).toHaveLength(0);
  });

  it('synthetic input arrives even while held', () => {
    const router = startRouter();
    router.setPointerHold(true);

    router.dispatch(makeMouseEvent('mousemove', TARGET[0], TARGET[1]));
    router.dispatch(makeMouseEvent('click', TARGET[0], TARGET[1]));

    expect(mode.moves).toHaveLength(1);
    expect(mode.clicks).toHaveLength(1);
  });

  it('pointer input comes back once the hold is released', () => {
    const router = startRouter();

    router.setPointerHold(true);
    emit(makeMouseEvent('click', TARGET[0], TARGET[1]));
    expect(mode.clicks).toHaveLength(0);

    router.setPointerHold(false);
    emit(makeMouseEvent('click', TARGET[0], TARGET[1]));

    expect(router.isPointerHeld()).toBe(false);
    expect(mode.clicks).toHaveLength(1);
  });

  it('mousedown and drag events pass through as before while held (camera not killed)', () => {
    const router = startRouter();
    router.setPointerHold(true);

    emit(makeMouseEvent('mousedown', TARGET[0], TARGET[1]));
    emit(makeDragMoveEvent(TARGET[0], TARGET[1]));

    expect(mode.downs).toHaveLength(1);
    expect(mode.dragMoves).toHaveLength(1);
  });

  it('is not held by default', () => {
    const router = startRouter();

    expect(router.isPointerHeld()).toBe(false);
  });
});

describe('cancel of a press (dragcancel)', () => {
  // A second finger or a cancelled touch ends a press without a release. The mode gets
  // onDragCancel, not onDragEnd, with the coordinates untouched by snapping, and the
  // pointer hold never stops it.

  it('reaches onDragCancel of the mode without going through snapping', () => {
    const cancels: DragNormalizedEvent[] = [];
    Object.assign(mode, {
      onDragCancel(event: DragNormalizedEvent): void {
        cancels.push(event);
      },
    });
    const router = startRouter();
    router.setPointerHold(true);

    const near = nearTarget(4);
    emit(makeDragEvent('dragcancel', near.lng, near.lat, { pointerType: 'touch' }));

    expect(cancels).toHaveLength(1);
    expect(cancels[0].lngLat).toEqual(near);
    expect(cancels[0].pointerType).toBe('touch');
    expect(mode.dragEnds).toHaveLength(0);
  });

  it('is ignored by a mode that does not implement onDragCancel', () => {
    startRouter();

    expect(() => emit(makeDragEvent('dragcancel', TARGET[0], TARGET[1]))).not.toThrow();
    expect(mode.dragEnds).toHaveLength(0);
  });
});

describe('a press the mode takes', () => {
  function consumePress(originalEvent: MouseEvent | TouchEvent): {
    stopped: number;
    prevented: number;
  } {
    Object.assign(mode, { onMouseDown: () => true });
    startRouter();
    const calls = { stopped: 0, prevented: 0 };
    Object.assign(originalEvent, {
      stopPropagation: () => {
        calls.stopped += 1;
      },
      preventDefault: () => {
        calls.prevented += 1;
      },
    });
    emit(makeMouseEvent('mousedown', TARGET[0], TARGET[1], { originalEvent }));
    return calls;
  }

  it('prevents the default action of a mouse press', () => {
    expect(consumePress({} as MouseEvent)).toEqual({ stopped: 1, prevented: 1 });
  });

  it('leaves the default action of a touch alone (MapLibre listens to it passively)', () => {
    const touch = { touches: [] } as unknown as TouchEvent;
    expect(consumePress(touch)).toEqual({ stopped: 1, prevented: 0 });
  });
});
