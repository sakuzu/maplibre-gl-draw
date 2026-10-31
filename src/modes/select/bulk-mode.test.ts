// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The select mode over features selected in bulk (11.3 of the design, F10): a press on one of
 * them drags them all, without narrowing the selection, by the state of their rows, and writes
 * them once let go; the handles of their frame rotate and resize them; a box over many rows
 * selects them in bulk; a cancelled box puts back the features selected in bulk before it; the
 * arrow keys move them by their moving set and write once a moment after the last press.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCoreBoxSelectionStrategies } from '../../dispatcher/hit-test/box-strategies.js';
import { BoxSelectionStrategyRegistry } from '../../dispatcher/hit-test/box-strategy.js';
import type { TopHit } from '../../dispatcher/hit-test/topmost.js';
import type {
  DragNormalizedEvent,
  KeyNormalizedEvent,
  MouseNormalizedEvent,
} from '../../dispatcher/types.js';
import { draggedRowsOf } from '../../feature-table/dragged-rows.js';
import { featureTablesInternals } from '../../feature-table/feature-tables.js';
import { STATE_MOVE_MASK, STATE_MOVE_SHIFT } from '../../feature-table/row-state.js';
import { BULK_SLICE_BUDGET_MS, BULK_SLICE_ROWS } from '../../operations/bulk-sliced.js';
import { DEFAULT_SELECTION_CONFIG } from '../../shared/config/selection.js';
import {
  applyMarginToBoundingBox,
  offsetOnTangentPlane,
  setScreenScaleFrame,
} from '../../shared/math/index.js';
import { DrawStore } from '../../store/draw-store.js';
import { TableContractStore } from '../../store/table-memory.js';
import type { Feature, StoreChange } from '../../store/types.js';
import { referenceTranslate } from '../../test-support/enu-reference.js';
import { planeMetersPerPixel, planeScaleFrame } from '../../test-utils.js';
import { bulkFrame } from '../../view/ui/handle-test.js';
import { computeResizeHandles, computeRotateHandle } from '../../view/ui/handles.js';
import { createSelectionScope } from '../../view/ui/selection-scope.js';
import type { EngineModeContext } from '../handler.js';
import { BULK_MOVE_SET, BULK_NUDGE_COMMIT_MS } from './bulk.js';
import { SelectMode } from './mode.js';

/** A square of one degree at (x, y) */
function square(id: string, x: number, y: number, extra: Partial<Feature> = {}): Feature {
  return {
    id,
    type: 'Polygon',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [x, y],
          [x + 1, y],
          [x + 1, y + 1],
          [x, y + 1],
          [x, y],
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
  };
}

/** A map that maps degrees linearly (1 degree = 10 px, y down) */
function makeMap() {
  const dragPan = {
    enabled: true,
    disable: vi.fn(() => {
      dragPan.enabled = false;
    }),
    enable: vi.fn(() => {
      dragPan.enabled = true;
    }),
    isEnabled: () => dragPan.enabled,
  };
  const map = {
    dragPan,
    getCanvas: () => ({ style: { cursor: '' } }),
    getZoom: () => 6,
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

/** The scale of the plane of the map (1 degree = 10 px) */
const PLANE = { metersPerPixel: planeMetersPerPixel(10) };

const NO_MODIFIERS = { shift: false, ctrl: false, alt: false, meta: false };

function drag(
  type: 'dragstart' | 'dragmove' | 'dragend',
  lng: number,
  lat: number,
  start: [number, number],
  shift = false,
): DragNormalizedEvent {
  return {
    type,
    point: { x: lng * 10, y: -lat * 10 },
    lngLat: { lng, lat },
    originalEvent: {} as MouseEvent,
    modifiers: { ...NO_MODIFIERS, shift },
    dragStartPoint: { x: start[0] * 10, y: -start[1] * 10 },
    dragStartLngLat: { lng: start[0], lat: start[1] },
  };
}

function key(name: string): KeyNormalizedEvent {
  return {
    type: 'keydown',
    key: name,
    modifiers: { ...NO_MODIFIERS },
    originalEvent: { preventDefault: vi.fn() } as unknown as KeyboardEvent,
  } as KeyNormalizedEvent;
}

let store: DrawStore;
let mode: SelectMode;
let context: EngineModeContext;
let top: TopHit | null;
let emitted: Array<[string, unknown]>;
let changes: StoreChange[];
const ids = Array.from({ length: 6 }, (_, i) => `f${i}`);

beforeEach(() => {
  store = new DrawStore(new TableContractStore(), { holdLimit: 3 });
  store.createLayer({
    id: 'l',
    name: 'l',
    visible: true,
    locked: false,
    opacity: 1,
    kind: 'table',
    styleRule: undefined,
    metadata: undefined,
  });
  store.transact(() => {
    ids.forEach((id, i) => {
      store.createFeature(square(id, i * 2, 0));
    });
  });
  top = null;
  emitted = [];
  const registry = new BoxSelectionStrategyRegistry();
  for (const strategy of createCoreBoxSelectionStrategies()) registry.register(strategy);
  context = {
    store,
    map: makeMap(),
    hitTestTopmost: () => top,
    plugins: undefined,
    selectionScope: createSelectionScope(),
    selectionStyle: DEFAULT_SELECTION_CONFIG,
    boxSelectionRegistry: registry,
    spatialIndex: { findInBounds: () => [] },
    eventEmitter: { emit: (name: string, payload: unknown) => emitted.push([name, payload]) },
  } as unknown as EngineModeContext;
  mode = new SelectMode();
  mode.onStart(context);
  changes = [];
  store.subscribe((change) => changes.push(change));
});

afterEach(() => {
  vi.useRealTimers();
});

/** The row hit at a feature (as the hit test of rows answers) */
function rowHit(id: string): TopHit {
  return {
    kind: 'row',
    layerId: 'l',
    id,
    handle: store.tables?.findRow(id) as number,
    locked: false,
    distancePx: () => 0,
  };
}

/** The first position of each feature */
function corners(): number[][] {
  return ids.map((id) => {
    const feature = store.tables?.get('l')?.getRow(store.tables.findRow(id) as number);
    return ((feature as Feature).geometry as { coordinates: number[][][] }).coordinates[0][0];
  });
}

/** The move of the drags of the tests: from (6.5, 0.5) to (8.5, 1.5) */
const DRAG_FROM: [number, number] = [6.5, 0.5];
const DRAG_TO: [number, number] = [8.5, 1.5];

/** Positions near the ones expected (about 0.1 mm; a longitude a whole number of turns off) */
function expectNear(
  actual: readonly (readonly number[])[],
  expected: readonly (readonly number[])[],
): void {
  expect(actual.length).toBe(expected.length);
  actual.forEach((position, i) => {
    const dx = (position[0] as number) - (expected[i]?.[0] as number);
    expect(Math.abs(dx - 360 * Math.round(dx / 360))).toBeLessThan(1e-9);
    expect(Math.abs((position[1] as number) - (expected[i]?.[1] as number))).toBeLessThan(1e-9);
  });
}

/** The moving set of the row of a feature */
function movingSetOf(id: string): number {
  const internals = featureTablesInternals(store.tables);
  const place = internals?.placeOf(store.tables?.findRow(id) as number);
  return place ? (place.group.state[place.row] & STATE_MOVE_MASK) >> STATE_MOVE_SHIFT : -1;
}

/** The frame of the features selected in bulk with its margin, as its handles stand on it */
function marginedFrame() {
  const bulk = store.getSelection().bulk;
  const frame = bulkFrame(bulk?.bbox as [number, number, number, number]);
  return {
    ...applyMarginToBoundingBox(frame, DEFAULT_SELECTION_CONFIG.box.margin, PLANE),
    center: frame.center,
  };
}

describe('the select mode over features selected in bulk', () => {
  it('drags them all from a press on one of them, by their moving set, and writes them once', () => {
    store.setSelection('feature', ids);
    expect(store.getSelection().bulk?.count).toBe(6);
    const before = corners();
    top = rowHit('f3');
    expect(
      mode.onMouseDown({
        ...drag('dragstart', 6.5, 0.5, [6.5, 0.5]),
        type: 'mousedown',
      } as unknown as MouseNormalizedEvent),
    ).toBe(true);
    mode.onDragStart(drag('dragstart', 6.5, 0.5, [6.5, 0.5]));
    // The selection is not narrowed to the feature pressed
    expect(store.getSelection().bulk?.count).toBe(6);
    expect(emitted[0][0]).toBe('drag.started');
    expect(emitted[0][1]).toMatchObject({ kind: 'feature', featureIds: [] });
    expect((emitted[0][1] as { bulk?: unknown }).bulk).toBe(store.getSelection().bulk);
    expect(ids.map(movingSetOf)).toEqual(ids.map(() => BULK_MOVE_SET));
    const count = changes.length;
    mode.onDragMove(drag('dragmove', 8.5, 1.5, [6.5, 0.5]));
    const states = featureTablesInternals(store.tables)?.states;
    expect(states?.transform(BULK_MOVE_SET)).toEqual({
      kind: 'translate',
      from: DRAG_FROM,
      to: DRAG_TO,
    });
    // Nothing is written while it is dragged
    expect(corners()).toEqual(before);
    expect(changes.slice(count).some((change) => change.rows)).toBe(false);
    mode.onDragEnd(drag('dragend', 8.5, 1.5, [6.5, 0.5]));
    const moved = before.map((position) => referenceTranslate(position, DRAG_FROM, DRAG_TO));
    expectNear(corners(), moved);
    expect(ids.map(movingSetOf)).toEqual(ids.map(() => 0));
    expect(states?.transform(BULK_MOVE_SET)).toBeNull();
    const written = changes.slice(count).filter((change) => change.rows);
    expect(written).toHaveLength(1);
    expect(written[0].previousValues).toBeDefined();
    expect(emitted.some(([name]) => name === 'drag.ended')).toBe(true);
    // The extent of the corners of the squares moved
    const bounds = store.getSelection().bulk?.bbox as number[];
    const movedCorners = ids.flatMap((_, i) =>
      [
        [i * 2, 0],
        [i * 2 + 1, 0],
        [i * 2 + 1, 1],
        [i * 2, 1],
      ].map((position) => referenceTranslate(position, DRAG_FROM, DRAG_TO)),
    );
    const xs = movedCorners.map((position) => position[0]);
    const ys = movedCorners.map((position) => position[1]);
    expectNear(
      [bounds.slice(0, 2), bounds.slice(2)],
      [
        [Math.min(...xs), Math.min(...ys)],
        [Math.max(...xs), Math.max(...ys)],
      ],
    );
  });

  it('writes many of them in steps once let go, and announces the end of the drag after the last', () => {
    // More rows than a step writes, and a clock that spends the time of a step at each slice
    const more = Array.from({ length: BULK_SLICE_ROWS + 10 }, (_, i) => `m${i}`);
    store.transact(() => {
      more.forEach((id, i) => {
        store.createFeature(square(id, i * 2, 10));
      });
    });
    vi.useFakeTimers();
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += BULK_SLICE_BUDGET_MS));
    store.setSelection('feature', [...ids, ...more]);
    top = rowHit('f3');
    mode.onMouseDown({
      ...drag('dragstart', 6.5, 0.5, [6.5, 0.5]),
      type: 'mousedown',
    } as unknown as MouseNormalizedEvent);
    mode.onDragStart(drag('dragstart', 6.5, 0.5, [6.5, 0.5]));
    mode.onDragMove(drag('dragmove', 8.5, 1.5, [6.5, 0.5]));
    mode.onDragEnd(drag('dragend', 8.5, 1.5, [6.5, 0.5]));
    // The first rows are written and leave the moving set; the others are still drawn moved by it
    const states = featureTablesInternals(store.tables)?.states;
    expect(store.slicedWritePending).toBe(true);
    expect(ids.map(movingSetOf)).toEqual(ids.map(() => 0));
    expect(movingSetOf(more[more.length - 1])).toBe(BULK_MOVE_SET);
    expect(states?.transform(BULK_MOVE_SET)?.kind).toBe('translate');
    expect(emitted.some(([name]) => name === 'drag.ended')).toBe(false);
    vi.runAllTimers();
    expect(store.slicedWritePending).toBe(false);
    expect(movingSetOf(more[more.length - 1])).toBe(0);
    expect(states?.transform(BULK_MOVE_SET)).toBeNull();
    expect(emitted.filter(([name]) => name === 'drag.ended')).toHaveLength(1);
    const last = store.tables
      ?.get('l')
      ?.getRow(store.tables.findRow(more[more.length - 1]) as number);
    expectNear(
      [((last as Feature).geometry as { coordinates: number[][][] }).coordinates[0][0] as number[]],
      [referenceTranslate([(more.length - 1) * 2, 10], DRAG_FROM, DRAG_TO)],
    );
    vi.restoreAllMocks();
  });

  it('resizes and rotates them from the handles of their frame', () => {
    store.setSelection('feature', ids);
    const before = corners();
    const ne = computeResizeHandles(marginedFrame()).find((handle) => handle.type === 'resize-ne');
    const [x, y] = (ne as { position: [number, number] }).position;
    mode.onDragStart(drag('dragstart', x, y, [x, y]));
    expect(store.getDragState()?.operation).toBe('resize');
    mode.onDragMove(drag('dragmove', x + 1, y, [x, y]));
    expect(featureTablesInternals(store.tables)?.states.transform(BULK_MOVE_SET)).not.toBeNull();
    mode.onDragEnd(drag('dragend', x + 1, y, [x, y]));
    const after = corners();
    // The west side is the anchor: it stays, the others move east
    expect(after[0][0]).toBeCloseTo(before[0][0], 9);
    expect(after[5][0]).toBeGreaterThan(before[5][0]);
    expect(featureTablesInternals(store.tables)?.states.transform(BULK_MOVE_SET)).toBeNull();

    const rotate = computeRotateHandle(
      marginedFrame(),
      DEFAULT_SELECTION_CONFIG.rotateHandle.distance,
      PLANE,
    ).position;
    mode.onDragStart(drag('dragstart', rotate[0], rotate[1], rotate as [number, number]));
    expect(store.getDragState()?.operation).toBe('rotate');
    const center = store.getSelection().bulk?.bbox as number[];
    mode.onDragMove(
      drag(
        'dragmove',
        (center[0] + center[2]) / 2 + 3,
        (center[1] + center[3]) / 2,
        rotate as [number, number],
      ),
    );
    mode.onDragEnd(
      drag(
        'dragend',
        (center[0] + center[2]) / 2 + 3,
        (center[1] + center[3]) / 2,
        rotate as [number, number],
      ),
    );
    expect(corners()).not.toEqual(after);
  });

  it('writes the features turned and scaled by their values where the drag drew them', () => {
    // An image without a scale nor a rotation yet, and a type of an extension with a scale and a
    // rotation
    const point = (id: string, type: string, x: number, properties = {}): Feature => ({
      ...square(id, 0, 0),
      type,
      geometry: { type: 'Point', coordinates: [x, 0.5] },
      properties,
    });
    store.transact(() => {
      store.createFeature(point('img', 'Image', 13, { 'maplibre-gl-draw:imageFileId': 'i' }));
      store.createFeature(
        point('card', 'Card', 15, {
          'maplibre-gl-draw:scale': 1,
          'maplibre-gl-draw:rotation': 0,
        }),
      );
    });
    const tables = store.tables as NonNullable<typeof store.tables>;
    const handleOf = (id: string) => tables.findRow(id) as number;
    const read = (id: string) => tables.get('l')?.getRow(handleOf(id)) as Feature;
    const at = (feature: Feature) => (feature.geometry as { coordinates: number[] }).coordinates;
    store.setSelection('feature', [...ids, 'img', 'card']);

    // A resize from a corner: the image and the card keep their shape and scale by their values
    const ne = computeResizeHandles(marginedFrame()).find((handle) => handle.type === 'resize-ne');
    const [x, y] = (ne as { position: [number, number] }).position;
    const before = new Map(['img', 'card'].map((id) => [id, read(id)]));
    mode.onDragStart(drag('dragstart', x, y, [x, y]));
    mode.onDragMove(drag('dragmove', x + 3, y + 2, [x, y]));
    let dragged = draggedRowsOf(tables);
    const drawnAt = new Map(
      ['img', 'card'].map((id) => [
        id,
        {
          position: dragged?.position(handleOf(id), at(before.get(id) as Feature)),
          scale: dragged?.scale(handleOf(id)),
        },
      ]),
    );
    mode.onDragEnd(drag('dragend', x + 3, y + 2, [x, y]));
    for (const id of ['img', 'card']) {
      const after = read(id);
      const drawn = drawnAt.get(id);
      expect(at(after)[0]).toBeCloseTo(drawn?.position?.[0] as number, 9);
      expect(at(after)[1]).toBeCloseTo(drawn?.position?.[1] as number, 9);
      expect(after.properties['maplibre-gl-draw:scale']).toBeCloseTo(drawn?.scale as number, 9);
      expect(drawn?.scale).not.toBe(1);
    }

    // A rotation: the card turns by its rotation
    const rotate = computeRotateHandle(
      marginedFrame(),
      DEFAULT_SELECTION_CONFIG.rotateHandle.distance,
      PLANE,
    ).position;
    const center = store.getSelection().bulk?.bbox as number[];
    const to: [number, number] = [(center[0] + center[2]) / 2 + 3, (center[1] + center[3]) / 2];
    mode.onDragStart(drag('dragstart', rotate[0], rotate[1], rotate as [number, number]));
    mode.onDragMove(drag('dragmove', to[0], to[1], rotate as [number, number]));
    dragged = draggedRowsOf(tables);
    const turned = dragged?.rotation(handleOf('card'));
    expect(turned).not.toBe(0);
    mode.onDragEnd(drag('dragend', to[0], to[1], rotate as [number, number]));
    // Its rotation of 0 takes the angle, within [0, 360)
    expect(read('card').properties['maplibre-gl-draw:rotation']).toBeCloseTo(
      ((turned as number) + 360) % 360,
      9,
    );
    // A square has no rotation of its own: it turns by its coordinates
    expect(draggedRowsOf(tables)).toBeNull();
  });

  it('starts no drag while a feature selected is locked, and keeps the selection', () => {
    store.updateFeature('f2', { locked: true });
    store.setSelection('feature', ids);
    top = rowHit('f3');
    mode.onDragStart(drag('dragstart', 6.5, 0.5, [6.5, 0.5]));
    expect(store.getDragState()).toBeNull();
    expect(store.getSelection().bulk?.count).toBe(6);
  });

  it('selects the rows of a box in bulk, and puts back the features selected in bulk on a cancel', () => {
    mode.onDragStart(drag('dragstart', -1, -1, [-1, -1], true));
    mode.onDragMove(drag('dragmove', 9.5, 1.5, [-1, -1], true));
    mode.onDragEnd(drag('dragend', 9.5, 1.5, [-1, -1], true));
    // Rows 0 to 4 are inside, row 4 [8, 9] too; row 5 [10, 11] is out
    expect(store.getSelection().bulk?.count).toBe(5);
    const kept = store.getSelection();
    mode.onDragStart(drag('dragstart', -1, -1, [-1, -1], true));
    mode.onDragMove(drag('dragmove', 1.5, 1.5, [-1, -1], true));
    mode.onDragCancel();
    expect(store.getSelection().bulk?.count).toBe(kept.bulk?.count);
    // A small box opens what it selects
    mode.onDragStart(drag('dragstart', -1, -1, [-1, -1], true));
    mode.onDragMove(drag('dragmove', 3.5, 1.5, [-1, -1], true));
    mode.onDragEnd(drag('dragend', 3.5, 1.5, [-1, -1], true));
    expect(store.getSelection()).toEqual({ type: 'feature', ids: ['f0', 'f1'] });
  });

  it('moves them by the arrow keys, written once a moment after the last press', () => {
    vi.useFakeTimers();
    store.setSelection('feature', ids);
    const before = corners();
    const count = changes.length;
    for (let i = 0; i < 5; i++) mode.onKeyDown(key('ArrowRight'));
    expect(corners()).toEqual(before);
    // One move from the center of the frame, five presses to the east: five pixels of the scale
    // of the frame on the ground there
    const shown = featureTablesInternals(store.tables)?.states.transform(BULK_MOVE_SET);
    expect(shown?.kind).toBe('translate');
    if (shown?.kind !== 'translate') return;
    const from = shown.from as [number, number];
    const east = offsetOnTangentPlane(from, 5 * PLANE.metersPerPixel(from), 0)[0] - from[0];
    expect((shown.to[0] as number) - from[0]).toBeCloseTo(east, 9);
    expect(shown.to[1]).toBe(shown.from[1]);
    vi.advanceTimersByTime(BULK_NUDGE_COMMIT_MS + 10);
    expect(corners()[0][0]).toBeCloseTo(before[0][0] + east, 9);
    expect(changes.slice(count).filter((change) => change.rows)).toHaveLength(1);
    expect(ids.map(movingSetOf)).toEqual(ids.map(() => 0));
  });
});
