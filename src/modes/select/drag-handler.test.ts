// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Behavior tests for the SelectMode drag handler
 *
 * The first half covers simultaneous movement of shared vertices
 * (options.topology.sharedVertexDrag). It verifies that, on a vertex drag in select mode, other
 * features that have a vertex exactly matching the dragged vertex (tolerance 0) follow along by
 * the same amount of movement. By default (with the option disabled) only the main feature moves,
 * as before. The second half covers the declaration of intermediate updates during a drag and
 * the commit in endDrag.
 *
 * Because SelectModeDragHandler is driven in the 3 stages startDrag / updateDrag / endDrag, the
 * drag sequences are assembled and invoked in the same manner as mode.test.ts (MemoryStore + a
 * mock map that maps longitude and latitude linearly).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DragNormalizedEvent } from '../../dispatcher/types.js';
import { destinationPoint, haversineDistanceMeters } from '../../geometry/distance.js';
import { DEFAULT_TOPOLOGY_CONFIG } from '../../shared/config/topology.js';
import { coordinatesOf as featureCoordinates } from '../../shared/utils/coordinates.js';
import type { SnapDisableKey } from '../../snapping/types.js';
import { DEFAULT_SNAP_OPTIONS } from '../../snapping/types.js';
import { MemoryStore } from '../../store/memory.js';
import { StoreSpatialIndex } from '../../store/spatial/store-spatial-index.js';
import type { Coordinate, Feature, StoreChange, VertexRef } from '../../store/types.js';
import type {
  AuxiliaryHandleHit,
  AuxiliaryHandleProvider,
} from '../../view/ui/auxiliary-handles.js';
import type { HandleHitResult } from '../../view/ui/handle-test.js';
import { computeSelectionBoundingBox, getSelectedFeatures } from '../../view/ui/helper.js';
import { createSelectionScope } from '../../view/ui/selection-scope.js';
import type { EngineModeContext } from '../handler.js';
import { SelectModeDragHandler } from './drag-handler.js';

// A polygon that is a translated unit square (a closed ring)
function square(id: string, minX: number, minY: number, size = 10): Feature {
  return {
    id,
    type: 'Polygon',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [minX, minY],
          [minX + size, minY],
          [minX + size, minY + size],
          [minX, minY + size],
          [minX, minY],
        ],
      ],
    },
    layerId: 'l1',
    groupId: undefined,
    properties: {},
    locked: false,
    visible: true,
    style: {},
  };
}

const NO_MODIFIERS = { shift: false, ctrl: false, alt: false, meta: false };

function dragEvent(lng: number, lat: number, start?: Coordinate): DragNormalizedEvent {
  return {
    type: 'dragstart',
    point: { x: lng * 10, y: -lat * 10 },
    lngLat: { lng, lat },
    originalEvent: {} as MouseEvent,
    modifiers: { ...NO_MODIFIERS },
    dragStartPoint: { x: lng * 10, y: -lat * 10 },
    dragStartLngLat: start ? { lng: start[0], lat: start[1] } : { lng, lat },
  };
}

// A mock that maps longitude and latitude naively and linearly (1 degree = 10px) + dragPan.
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
  return {
    dragPan,
    getCanvas: () => ({ style: { cursor: '' } }),
    getZoom: () => 10,
    triggerRepaint: vi.fn(),
    project: (lngLat: { lng: number; lat: number }) => ({
      x: lngLat.lng * 10,
      y: -lngLat.lat * 10,
    }),
    unproject: (p: { x: number; y: number }) => ({ lng: p.x / 10, lat: -p.y / 10 }),
  };
}

let store: MemoryStore;
let spatialIndex: StoreSpatialIndex;
/** The ids of the features the Store reported as updated (the index follows them) */
let indexUpdates: string[];
let map: ReturnType<typeof makeMap>;
let context: EngineModeContext;
let handler: SelectModeDragHandler;

function putFeature(feature: Feature): void {
  store.createFeature(feature);
}

function enableSharedVertexDrag(enabled: boolean): void {
  context.topology = { ...DEFAULT_TOPOLOGY_CONFIG, sharedVertexDrag: enabled };
}

/** Replace the snapping temporary-disable key (shared-vertex temporary disabling shares it) */
function setSnapDisableKey(disableKey: SnapDisableKey): void {
  context.snapOptions = { ...DEFAULT_SNAP_OPTIONS, disableKey };
}

/**
 * Start a vertex drag (modifier keys can be specified)
 */
function startVertexDrag(
  featureId: string,
  vertexRef: VertexRef,
  from: Coordinate,
  modifiers?: Partial<typeof NO_MODIFIERS>,
) {
  store.setSelection('feature', [featureId]);
  const bbox = computeSelectionBoundingBox(getSelectedFeatures(store));
  const hit: HandleHitResult = { type: 'vertex', featureId, vertexRef };
  const event = dragEvent(from[0], from[1]);
  if (modifiers) event.modifiers = { ...NO_MODIFIERS, ...modifiers };
  handler.startDrag(hit, event, context, bbox);
}

/**
 * Run one whole vertex drag (start -> move -> end)
 */
function dragVertex(
  featureId: string,
  vertexRef: VertexRef,
  from: Coordinate,
  to: Coordinate,
  modifiers?: Partial<typeof NO_MODIFIERS>,
) {
  startVertexDrag(featureId, vertexRef, from, modifiers);
  handler.updateDrag(dragEvent(to[0], to[1], from), context);
  handler.endDrag(context);
}

function coordinatesOf(id: string): unknown {
  return featureCoordinates(store.getFeature(id));
}

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
  spatialIndex = new StoreSpatialIndex(store);
  indexUpdates = [];
  store.subscribe((changes) => {
    for (const { id } of changes.features?.updated ?? []) indexUpdates.push(id);
  });
  map = makeMap();
  context = {
    store,
    spatialIndex,
    map,
    plugins: undefined,
    selectionScope: createSelectionScope(),
  } as unknown as EngineModeContext;
  handler = new SelectModeDragHandler();
});

describe('simultaneous movement of shared vertices: adjacent polygons', () => {
  beforeEach(() => {
    // Two polygons sharing the edge x = 10
    putFeature(square('f1', 0, 0));
    putFeature(square('f2', 10, 0));
    enableSharedVertexDrag(true);
  });

  it('a shared vertex drag makes the adjacent polygon follow with identical coordinates', () => {
    // Move the bottom-right [10,0] of f1 to [11,2]
    dragVertex('f1', { ring: 0, index: 1 }, [10, 0], [11, 2]);

    expect(coordinatesOf('f1')).toEqual([
      [
        [0, 0],
        [11, 2],
        [10, 10],
        [0, 10],
        [0, 0],
      ],
    ]);
    // [10,0] of f2 appears in 2 places: the first point (index 0) and the closing point
    // (index 4)
    expect(coordinatesOf('f2')).toEqual([
      [
        [11, 2],
        [20, 0],
        [20, 10],
        [10, 10],
        [11, 2],
      ],
    ]);
  });

  it('the features that followed move in the spatial index too', () => {
    dragVertex('f1', { ring: 0, index: 1 }, [10, 0], [11, 2]);
    expect(indexUpdates).toContain('f2');
    // f2 now reaches down to y = 2 only at x = 11; its old extent started at y = 0
    expect(spatialIndex.findInBounds({ minX: 19, minY: 0, maxX: 20, maxY: 1 })).toContain('f2');
    expect(spatialIndex.findInBounds({ minX: 10.2, minY: 1, maxX: 10.8, maxY: 1.5 })).toEqual(
      expect.arrayContaining(['f1', 'f2']),
    );
  });

  it('dragging a vertex that is not shared does not move the other features', () => {
    const before = coordinatesOf('f2');
    // The bottom-left [0,0] of f1 is not shared with f2
    dragVertex('f1', { ring: 0, index: 0 }, [0, 0], [1, 1]);
    expect(coordinatesOf('f2')).toEqual(before);
  });

  it('when the option is disabled only the main feature moves, as before', () => {
    enableSharedVertexDrag(false);
    const before = coordinatesOf('f2');
    dragVertex('f1', { ring: 0, index: 1 }, [10, 0], [11, 2]);

    expect(coordinatesOf('f1')).toEqual([
      [
        [0, 0],
        [11, 2],
        [10, 10],
        [0, 10],
        [0, 0],
      ],
    ]);
    expect(coordinatesOf('f2')).toEqual(before);
    expect(indexUpdates).not.toContain('f2');
  });

  it('not passing topology behaves as before too (disabled by default)', () => {
    context.topology = undefined;
    const before = coordinatesOf('f2');
    dragVertex('f1', { ring: 0, index: 1 }, [10, 0], [11, 2]);
    expect(coordinatesOf('f2')).toEqual(before);
  });
});

describe('simultaneous movement of shared vertices: first and last of a closed ring', () => {
  it('both the first point and the closing point of the follower move by the same amount', () => {
    putFeature(square('f1', 0, 0));
    // The first point of f2 (= its closing point) matches [10,10] of f1
    putFeature(square('f2', 10, 10));
    enableSharedVertexDrag(true);

    dragVertex('f1', { ring: 0, index: 2 }, [10, 10], [12, 13]);

    const rings = coordinatesOf('f2') as Coordinate[][];
    expect(rings[0][0]).toEqual([12, 13]);
    expect(rings[0][rings[0].length - 1]).toEqual([12, 13]);
    // The ring is still closed
    expect(rings[0][0]).toEqual(rings[0][rings[0].length - 1]);
  });

  it('the closing point of the main feature (dragging index 0) keeps the ring closed', () => {
    putFeature(square('f1', 0, 0));
    putFeature(square('f2', 10, 0));
    enableSharedVertexDrag(true);

    dragVertex('f1', { ring: 0, index: 0 }, [0, 0], [-1, -2]);

    const rings = coordinatesOf('f1') as Coordinate[][];
    expect(rings[0][0]).toEqual([-1, -2]);
    expect(rings[0][rings[0].length - 1]).toEqual([-1, -2]);
  });
});

describe('simultaneous movement of shared vertices: Multi geometries and rings', () => {
  it('vertices of a MultiPolygon part and of an inner ring (a hole) follow along', () => {
    putFeature(square('f1', 0, 0));
    const multi: Feature = {
      id: 'mp',
      type: 'MultiPolygon',
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          // part 0: has no shared vertex
          [
            [
              [100, 100],
              [110, 100],
              [110, 110],
              [100, 100],
            ],
          ],
          // part 1: both the outer ring (ring 0) and the inner ring (ring 1) have [10,0]
          [
            [
              [10, 0],
              [30, 0],
              [30, 20],
              [10, 0],
            ],
            [
              [10, 0],
              [15, 2],
              [15, 5],
              [10, 0],
            ],
          ],
        ],
      },
      layerId: 'l1',
      groupId: undefined,
      properties: {},
      locked: false,
      visible: true,
      style: {},
    };
    putFeature(multi);
    enableSharedVertexDrag(true);

    dragVertex('f1', { ring: 0, index: 1 }, [10, 0], [11, 2]);

    const parts = coordinatesOf('mp') as Coordinate[][][];
    // part 0 is unchanged
    expect(parts[0]).toEqual([
      [
        [100, 100],
        [110, 100],
        [110, 110],
        [100, 100],
      ],
    ]);
    // Both the outer and the inner ring of part 1 follow along, and both stay closed
    expect(parts[1][0][0]).toEqual([11, 2]);
    expect(parts[1][0][parts[1][0].length - 1]).toEqual([11, 2]);
    expect(parts[1][1][0]).toEqual([11, 2]);
    expect(parts[1][1][parts[1][1].length - 1]).toEqual([11, 2]);
  });

  it('a vertex of the second line of a MultiLineString follows along', () => {
    putFeature(square('f1', 0, 0));
    putFeature({
      id: 'ml',
      type: 'MultiLineString',
      geometry: {
        type: 'MultiLineString',
        coordinates: [
          [
            [50, 50],
            [60, 60],
          ],
          [
            [10, 0],
            [20, -10],
          ],
        ],
      },
      layerId: 'l1',
      groupId: undefined,
      properties: {},
      locked: false,
      visible: true,
      style: {},
    });
    enableSharedVertexDrag(true);

    dragVertex('f1', { ring: 0, index: 1 }, [10, 0], [11, 2]);

    expect(coordinatesOf('ml')).toEqual([
      [
        [50, 50],
        [60, 60],
      ],
      [
        [11, 2],
        [20, -10],
      ],
    ]);
  });

  it('when the main feature inner ring shares a coordinate with the outer ring, both move', () => {
    const donut: Feature = {
      id: 'donut',
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
          [
            [10, 0],
            [8, 2],
            [8, 4],
            [10, 0],
          ],
        ],
      },
      layerId: 'l1',
      groupId: undefined,
      properties: {},
      locked: false,
      visible: true,
      style: {},
    };
    putFeature(donut);
    enableSharedVertexDrag(true);

    dragVertex('donut', { ring: 0, index: 1 }, [10, 0], [11, 2]);

    const rings = coordinatesOf('donut') as Coordinate[][];
    expect(rings[0][1]).toEqual([11, 2]);
    expect(rings[1][0]).toEqual([11, 2]);
    expect(rings[1][rings[1].length - 1]).toEqual([11, 2]);
  });
});

describe('simultaneous movement of shared vertices: excluding locked and hidden', () => {
  beforeEach(() => {
    putFeature(square('f1', 0, 0));
    enableSharedVertexDrag(true);
  });

  it('a locked feature does not follow along', () => {
    putFeature({ ...square('f2', 10, 0), locked: true });
    const before = coordinatesOf('f2');
    dragVertex('f1', { ring: 0, index: 1 }, [10, 0], [11, 2]);
    expect(coordinatesOf('f2')).toEqual(before);
  });

  it('a feature whose layer is locked does not follow along (effective lock)', () => {
    store.createLayer({
      id: 'locked-layer',
      name: 'locked',
      visible: true,
      locked: true,
      opacity: 1,
      items: [],
      styleRule: undefined,
      metadata: undefined,
    });
    putFeature({ ...square('f2', 10, 0), layerId: 'locked-layer' });
    const before = coordinatesOf('f2');
    dragVertex('f1', { ring: 0, index: 1 }, [10, 0], [11, 2]);
    expect(coordinatesOf('f2')).toEqual(before);
  });

  it('a feature whose group is locked does not follow along (effective lock)', () => {
    putFeature(square('f2', 10, 0));
    store.createGroup({
      id: 'g1',
      layerId: 'l1',
      name: 'g1',
      featureIds: [],
      visible: true,
      locked: true,
    });
    store.updateFeature('f2', { groupId: 'g1' });
    const before = coordinatesOf('f2');
    dragVertex('f1', { ring: 0, index: 1 }, [10, 0], [11, 2]);
    expect(coordinatesOf('f2')).toEqual(before);
  });

  it('a hidden feature does not follow along', () => {
    putFeature({ ...square('f2', 10, 0), visible: false });
    const before = coordinatesOf('f2');
    dragVertex('f1', { ring: 0, index: 1 }, [10, 0], [11, 2]);
    expect(coordinatesOf('f2')).toEqual(before);
  });

  it('a locally hidden feature does not follow along', () => {
    putFeature(square('f2', 10, 0));
    store.setLocallyHidden('f2', true);
    const before = coordinatesOf('f2');
    dragVertex('f1', { ring: 0, index: 1 }, [10, 0], [11, 2]);
    expect(coordinatesOf('f2')).toEqual(before);
  });

  it('a feature on a hidden layer does not follow along', () => {
    store.createLayer({
      id: 'hidden-layer',
      name: 'hidden',
      visible: false,
      locked: false,
      opacity: 1,
      items: [],
      styleRule: undefined,
      metadata: undefined,
    });
    putFeature({ ...square('f2', 10, 0), layerId: 'hidden-layer' });
    const before = coordinatesOf('f2');
    dragVertex('f1', { ring: 0, index: 1 }, [10, 0], [11, 2]);
    expect(coordinatesOf('f2')).toEqual(before);
  });
});

describe('simultaneous movement of shared vertices: geometries out of scope', () => {
  it('a Circle, which has no vertex movement, does not follow even at the same coordinate', () => {
    putFeature(square('f1', 0, 0));
    putFeature({
      id: 'c1',
      type: 'Circle',
      geometry: { type: 'Point', coordinates: [10, 0] },
      layerId: 'l1',
      groupId: undefined,
      properties: { 'maplibre-gl-draw:radiusMeters': 1000 },
      locked: false,
      visible: true,
      style: {},
    });
    enableSharedVertexDrag(true);

    dragVertex('f1', { ring: 0, index: 1 }, [10, 0], [11, 2]);

    expect(coordinatesOf('c1')).toEqual([10, 0]);
    expect(indexUpdates).not.toContain('c1');
  });
});

describe('simultaneous movement of shared vertices: commit transaction granularity', () => {
  beforeEach(() => {
    putFeature(square('f1', 0, 0));
    putFeature(square('f2', 10, 0));
    enableSharedVertexDrag(true);
  });

  it('on commit, the updates of the 2 features ride on a single StoreChange', () => {
    const batches: StoreChange[] = [];
    store.subscribe((changes) => {
      if (changes.features?.updated) batches.push(changes);
    });

    dragVertex('f1', { ring: 0, index: 1 }, [10, 0], [11, 2]);

    // A drag frame moves both in one notification too; the commit is the one without
    // intermediate updates
    const combined = batches.filter((changes) => {
      const updated = changes.features?.updated ?? [];
      const ids = new Set(updated.map((u) => u.id));
      return ids.has('f1') && ids.has('f2') && updated.every((u) => !u.isIntermediate);
    });
    expect(combined).toHaveLength(1);
    // The commit batch is emitted last (in endDrag)
    expect(batches[batches.length - 1]).toBe(combined[0]);
  });

  it('even with the option disabled, one commit batch follows the intermediate updates', () => {
    enableSharedVertexDrag(false);
    const batches: StoreChange[] = [];
    store.subscribe((changes) => {
      if (changes.features?.updated) batches.push(changes);
    });

    dragVertex('f1', { ring: 0, index: 1 }, [10, 0], [11, 2]);

    // One during the drag (intermediate) and one commit in endDrag
    expect(batches).toHaveLength(2);
    expect(batches[0].features?.updated?.map((u) => u.id)).toEqual(['f1']);
    expect(batches[0].features?.updated?.[0].isIntermediate).toBe(true);
    expect(batches[1].features?.updated?.map((u) => u.id)).toEqual(['f1']);
    expect(batches[1].features?.updated?.[0].isIntermediate).toBeUndefined();
  });
});

describe('simultaneous movement of shared vertices: temporary disabling by modifier key', () => {
  beforeEach(() => {
    // Two polygons sharing the edge x = 10
    putFeature(square('f1', 0, 0));
    putFeature(square('f2', 10, 0));
    enableSharedVertexDrag(true);
  });

  it('by default (disableKey = alt) starting with Alt held down suppresses following', () => {
    const before = coordinatesOf('f2');
    dragVertex('f1', { ring: 0, index: 1 }, [10, 0], [11, 2], { alt: true });

    expect(coordinatesOf('f1')).toEqual([
      [
        [0, 0],
        [11, 2],
        [10, 10],
        [0, 10],
        [0, 0],
      ],
    ]);
    expect(coordinatesOf('f2')).toEqual(before);
  });

  it('a modifier key other than the disable key (Shift) still follows along', () => {
    dragVertex('f1', { ring: 0, index: 1 }, [10, 0], [11, 2], { shift: true });
    expect(coordinatesOf('f2')).not.toEqual(featureCoordinates(square('f2', 10, 0)));
  });

  it('changing disableKey makes that key the temporary disable key', () => {
    setSnapDisableKey('shift');
    const before = coordinatesOf('f2');

    dragVertex('f1', { ring: 0, index: 1 }, [10, 0], [11, 2], { shift: true });
    expect(coordinatesOf('f2')).toEqual(before);
  });

  it('after changing disableKey, Alt no longer disables temporarily', () => {
    setSnapDisableKey('shift');
    dragVertex('f1', { ring: 0, index: 1 }, [10, 0], [11, 2], { alt: true });
    expect(coordinatesOf('f2')).not.toEqual(featureCoordinates(square('f2', 10, 0)));
  });

  it("when disableKey is 'none', no modifier key disables it", () => {
    setSnapDisableKey('none');
    dragVertex('f1', { ring: 0, index: 1 }, [10, 0], [11, 2], { alt: true });
    expect(coordinatesOf('f2')).not.toEqual(featureCoordinates(square('f2', 10, 0)));
  });

  it('the decision happens only once at drag start (pressing mid-drag does not change it)', () => {
    startVertexDrag('f1', { ring: 0, index: 1 }, [10, 0]);
    const moveEvent = dragEvent(11, 2, [10, 0]);
    moveEvent.modifiers = { ...NO_MODIFIERS, alt: true };
    handler.updateDrag(moveEvent, context);
    handler.endDrag(context);

    // The follower set determined at the start keeps being used as-is
    expect(coordinatesOf('f2')).toEqual([
      [
        [11, 2],
        [20, 0],
        [20, 10],
        [10, 10],
        [11, 2],
      ],
    ]);
  });

  it('releasing mid-drag does not stop it (with Alt held at the start it stays solitary)', () => {
    const before = coordinatesOf('f2');
    startVertexDrag('f1', { ring: 0, index: 1 }, [10, 0], { alt: true });
    handler.updateDrag(dragEvent(11, 2, [10, 0]), context);
    handler.endDrag(context);

    expect(coordinatesOf('f2')).toEqual(before);
  });
});

describe('simultaneous movement of shared vertices: follower highlight (UI state)', () => {
  beforeEach(() => {
    putFeature(square('f1', 0, 0));
    putFeature(square('f2', 10, 0));
    enableSharedVertexDrag(true);
  });

  it('starting the drag puts the following vertices into the UI state', () => {
    startVertexDrag('f1', { ring: 0, index: 1 }, [10, 0]);

    // [10,0] of f2 appears in 2 places: the first point (index 0) and the closing point
    // (index 4)
    expect(store.getFollowedVertices()).toEqual([
      {
        featureId: 'f2',
        vertices: [
          { ring: 0, index: 0 },
          { ring: 0, index: 4 },
        ],
      },
    ]);
  });

  it('it goes back to null when the drag ends', () => {
    dragVertex('f1', { ring: 0, index: 1 }, [10, 0], [11, 2]);
    expect(store.getFollowedVertices()).toBeNull();
  });

  it('it is cleared by reset (aborting the drag) as well', () => {
    startVertexDrag('f1', { ring: 0, index: 1 }, [10, 0]);
    expect(store.getFollowedVertices()).not.toBeNull();

    handler.reset(store);
    expect(store.getFollowedVertices()).toBeNull();
  });

  it('it stays null on a drag where no feature follows along', () => {
    startVertexDrag('f1', { ring: 0, index: 0 }, [0, 0]);
    expect(store.getFollowedVertices()).toBeNull();
  });

  it('it stays null when temporarily disabled by a modifier key', () => {
    startVertexDrag('f1', { ring: 0, index: 1 }, [10, 0], { alt: true });
    expect(store.getFollowedVertices()).toBeNull();
  });

  it('it stays null when the option is disabled', () => {
    enableSharedVertexDrag(false);
    startVertexDrag('f1', { ring: 0, index: 1 }, [10, 0]);
    expect(store.getFollowedVertices()).toBeNull();
  });

  it('writing the UI state is notified as uiStateChanged', () => {
    const uiChanges: StoreChange[] = [];
    store.subscribe((changes) => {
      if (changes.uiStateChanged) uiChanges.push(changes);
    });

    startVertexDrag('f1', { ring: 0, index: 1 }, [10, 0]);
    expect(uiChanges.length).toBeGreaterThan(0);
  });

  it('the UI state is held as a copy (rewriting it does not affect the actual followers)', () => {
    startVertexDrag('f1', { ring: 0, index: 1 }, [10, 0]);
    // Even after emptying the array used for the highlight, it still works because the
    // VertexState used for following is a separate thing
    const followed = store.getFollowedVertices();
    if (followed) followed[0].vertices.length = 0;

    handler.updateDrag(dragEvent(11, 2, [10, 0]), context);
    handler.endDrag(context);

    expect(coordinatesOf('f2')).toEqual([
      [
        [11, 2],
        [20, 0],
        [20, 10],
        [10, 10],
        [11, 2],
      ],
    ]);
  });
});

describe('intermediate updates during a drag and the commit in endDrag', () => {
  type FeatureUpdate = NonNullable<NonNullable<StoreChange['features']>['updated']>[number];

  let batches: StoreChange[];

  /** Start collecting and recording only the batches that contain features.updated */
  function watchFeatureBatches(): void {
    batches = [];
    store.subscribe((changes) => {
      if (changes.features?.updated) batches.push(changes);
    });
  }

  function updatesOf(changes: StoreChange): FeatureUpdate[] {
    return changes.features?.updated ?? [];
  }

  /** The commit batches (batches where not a single entry carries isIntermediate) */
  function commitBatches(): StoreChange[] {
    return batches.filter((changes) => updatesOf(changes).every((u) => !u.isIntermediate));
  }

  /** Start a move drag */
  function startMoveDrag(featureIds: string[], from: Coordinate): void {
    store.setSelection('feature', featureIds);
    const bbox = computeSelectionBoundingBox(getSelectedFeatures(store));
    handler.startDrag({ type: 'move' }, dragEvent(from[0], from[1]), context, bbox);
  }

  /** Start a radius change drag on a Circle */
  function startRadiusDrag(featureId: string, from: Coordinate): void {
    store.setSelection('feature', [featureId]);
    const bbox = computeSelectionBoundingBox(getSelectedFeatures(store));
    handler.startDrag({ type: 'radius', featureId }, dragEvent(from[0], from[1]), context, bbox);
  }

  beforeEach(() => {
    putFeature(square('f1', 0, 0));
  });

  it('a move drag DragState carries the moving features (used for snap self-exclusion)', () => {
    putFeature(square('f2', 20, 0));

    startMoveDrag(['f1', 'f2'], [0, 0]);

    expect(store.getDragState()).toEqual({
      operation: 'move',
      movingFeatureIds: ['f1', 'f2'],
    });

    handler.endDrag(context);
    expect(store.getDragState()).toBeNull();
  });

  it('updates partway through a vertex drag carry isIntermediate', () => {
    watchFeatureBatches();

    startVertexDrag('f1', { ring: 0, index: 1 }, [10, 0]);
    handler.updateDrag(dragEvent(11, 2, [10, 0]), context);

    expect(batches).toHaveLength(1);
    expect(updatesOf(batches[0])[0].isIntermediate).toBe(true);
  });

  it('endDrag issues the commit update (without the flag) exactly once', () => {
    watchFeatureBatches();

    startVertexDrag('f1', { ring: 0, index: 1 }, [10, 0]);
    handler.updateDrag(dragEvent(11, 2, [10, 0]), context);
    handler.updateDrag(dragEvent(12, 3, [10, 0]), context);
    handler.endDrag(context);

    const commits = commitBatches();
    expect(commits).toHaveLength(1);
    // The commit is emitted last (before the drag.ended signal) in one transaction
    expect(batches[batches.length - 1]).toBe(commits[0]);
    expect(updatesOf(commits[0]).map((u) => u.id)).toEqual(['f1']);
  });

  it('the committed coordinates match the last moved position', () => {
    watchFeatureBatches();

    startVertexDrag('f1', { ring: 0, index: 1 }, [10, 0]);
    handler.updateDrag(dragEvent(11, 2, [10, 0]), context);
    handler.updateDrag(dragEvent(12, 3, [10, 0]), context);
    handler.endDrag(context);

    const expected = [
      [
        [0, 0],
        [12, 3],
        [10, 10],
        [0, 10],
        [0, 0],
      ],
    ];
    expect(featureCoordinates(updatesOf(commitBatches()[0])[0].feature)).toEqual(expected);
    expect(coordinatesOf('f1')).toEqual(expected);
  });

  it('a drag that ends without ever moving emits no commit', () => {
    watchFeatureBatches();

    startVertexDrag('f1', { ring: 0, index: 1 }, [10, 0]);
    handler.endDrag(context);

    expect(batches).toHaveLength(0);
  });

  it('a move drag also goes intermediate -> commit, with several features in 1 transaction', () => {
    putFeature(square('f2', 100, 100));
    watchFeatureBatches();

    startMoveDrag(['f1', 'f2'], [0, 0]);
    handler.updateDrag(dragEvent(3, 4, [0, 0]), context);
    handler.endDrag(context);

    // One drag frame is one batch of intermediates for both; the commit is both in 1 batch
    const commits = commitBatches();
    expect(commits).toHaveLength(1);
    expect(updatesOf(commits[0]).map((u) => u.id)).toEqual(['f1', 'f2']);
    const intermediates = batches.filter((c) => updatesOf(c).some((u) => u.isIntermediate));
    expect(intermediates).toHaveLength(1);
    expect(updatesOf(intermediates[0]).map((u) => u.id)).toEqual(['f1', 'f2']);
    expect(coordinatesOf('f1')).toEqual(featureCoordinates(square('f1', 3, 4)));
    expect(coordinatesOf('f2')).toEqual(featureCoordinates(square('f2', 103, 104)));
  });

  it('a radius drag goes intermediate -> commit, the committed value is the last radius', () => {
    putFeature({
      id: 'c1',
      type: 'Circle',
      geometry: { type: 'Point', coordinates: [0, 0] },
      layerId: 'l1',
      groupId: undefined,
      properties: { 'maplibre-gl-draw:radiusMeters': 1000 },
      locked: false,
      visible: true,
      style: {},
    });
    watchFeatureBatches();

    startRadiusDrag('c1', [0, 0]);
    handler.updateDrag(dragEvent(1, 0, [0, 0]), context);
    handler.updateDrag(dragEvent(2, 0, [0, 0]), context);
    handler.endDrag(context);

    const intermediates = batches.filter((c) => updatesOf(c).some((u) => u.isIntermediate));
    expect(intermediates).toHaveLength(2);

    const commits = commitBatches();
    expect(commits).toHaveLength(1);
    const committed = updatesOf(commits[0])[0];
    expect(committed.id).toBe('c1');
    const radiusMeters = store.getFeature('c1')?.properties['maplibre-gl-draw:radiusMeters'];
    expect(committed.feature.properties['maplibre-gl-draw:radiusMeters']).toBe(radiusMeters);
    // The radius for a position 2 degrees away from the center (not still 1000)
    expect(radiusMeters).toBeGreaterThan(200000);
  });

  it('the radius handle lands on the pointer at a high latitude (60 deg, 100 km, 45 deg)', () => {
    const center: Coordinate = [10, 60];
    putFeature({
      id: 'c1',
      type: 'Circle',
      geometry: { type: 'Point', coordinates: center },
      layerId: 'l1',
      groupId: undefined,
      properties: { 'maplibre-gl-draw:radiusMeters': 1000 },
      locked: false,
      visible: true,
      style: {},
    });
    const pointer = destinationPoint(center, 100_000, 45);

    startRadiusDrag('c1', center);
    handler.updateDrag(dragEvent(pointer[0], pointer[1], center), context);
    handler.endDrag(context);

    const properties = store.getFeature('c1')?.properties ?? {};
    const handle = destinationPoint(
      center,
      properties['maplibre-gl-draw:radiusMeters'] as number,
      properties['maplibre-gl-draw:radiusHandleAngle'] as number,
    );
    expect(haversineDistanceMeters(handle, pointer)).toBeLessThan(1);
  });

  it('shared-vertex followers ride on the same commit transaction', () => {
    putFeature(square('f2', 10, 0));
    enableSharedVertexDrag(true);
    watchFeatureBatches();

    dragVertex('f1', { ring: 0, index: 1 }, [10, 0], [11, 2]);

    const commits = commitBatches();
    expect(commits).toHaveLength(1);
    expect(new Set(updatesOf(commits[0]).map((u) => u.id))).toEqual(new Set(['f1', 'f2']));
  });

  describe('an abort that never reaches a commit (abortIntermediateUpdates)', () => {
    let abortSpy: ReturnType<typeof vi.fn<(ids: string[]) => void>>;

    beforeEach(() => {
      abortSpy = vi.fn<(ids: string[]) => void>();
      (
        store as unknown as { abortIntermediateUpdates?: (ids: string[]) => void }
      ).abortIntermediateUpdates = abortSpy;
    });

    it('a reset that does not go through endDrag notifies the discard', () => {
      startVertexDrag('f1', { ring: 0, index: 1 }, [10, 0]);
      handler.updateDrag(dragEvent(11, 2, [10, 0]), context);

      handler.reset(store);

      expect(abortSpy).toHaveBeenCalledTimes(1);
      expect(abortSpy).toHaveBeenCalledWith(['f1']);
    });

    it('after committing in endDrag it does not notify a discard', () => {
      startVertexDrag('f1', { ring: 0, index: 1 }, [10, 0]);
      handler.updateDrag(dragEvent(11, 2, [10, 0]), context);
      handler.endDrag(context);

      expect(abortSpy).not.toHaveBeenCalled();
    });

    it('a reset without a drag notifies nothing', () => {
      handler.reset(store);

      expect(abortSpy).not.toHaveBeenCalled();
    });
  });
});

describe('a feature that disappears during a drag', () => {
  beforeEach(() => {
    putFeature(square('f1', 0, 0));
    putFeature(square('f2', 100, 100));
  });

  function startMoveDrag(featureIds: string[], from: Coordinate): void {
    store.setSelection('feature', featureIds);
    const bbox = computeSelectionBoundingBox(getSelectedFeatures(store));
    handler.startDrag({ type: 'move' }, dragEvent(from[0], from[1]), context, bbox);
  }

  function expectDragCleanedUp(): void {
    expect(map.dragPan.isEnabled()).toBe(true);
    expect(store.getDragState()).toBeNull();
    expect(handler.isActive()).toBe(false);
  }

  it('endDrag commits the features that remain and does not throw', () => {
    startMoveDrag(['f1', 'f2'], [0, 0]);
    handler.updateDrag(dragEvent(3, 4, [0, 0]), context);
    store.deleteFeature('f2');

    expect(() => handler.endDrag(context)).not.toThrow();

    expect(coordinatesOf('f1')).toEqual(featureCoordinates(square('f1', 3, 4)));
    expect(store.getFeature('f2')).toBeUndefined();
    expectDragCleanedUp();
  });

  it('the commit contains only the features that remain', () => {
    const committed: string[][] = [];
    startMoveDrag(['f1', 'f2'], [0, 0]);
    handler.updateDrag(dragEvent(3, 4, [0, 0]), context);
    store.deleteFeature('f2');
    store.subscribe((changes) => {
      const updated = changes.features?.updated ?? [];
      if (updated.length > 0 && updated.every((u) => !u.isIntermediate)) {
        committed.push(updated.map((u) => u.id));
      }
    });

    handler.endDrag(context);

    expect(committed).toEqual([['f1']]);
  });

  it('the intermediate state of a vanished feature is discarded, not committed', () => {
    const abortSpy = vi.fn<(ids: string[]) => void>();
    (
      store as unknown as { abortIntermediateUpdates?: (ids: string[]) => void }
    ).abortIntermediateUpdates = abortSpy;

    startVertexDrag('f1', { ring: 0, index: 1 }, [10, 0]);
    handler.updateDrag(dragEvent(11, 2, [10, 0]), context);
    store.deleteFeature('f1');

    expect(() => handler.endDrag(context)).not.toThrow();

    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(abortSpy).toHaveBeenCalledWith(['f1']);
    expectDragCleanedUp();
  });

  it('updates after the feature vanished and endDrag do not throw (radius)', () => {
    putFeature({
      id: 'c1',
      type: 'Circle',
      geometry: { type: 'Point', coordinates: [0, 0] },
      layerId: 'l1',
      groupId: undefined,
      properties: { 'maplibre-gl-draw:radiusMeters': 1000 },
      locked: false,
      visible: true,
      style: {},
    });
    store.setSelection('feature', ['c1']);
    const bbox = computeSelectionBoundingBox(getSelectedFeatures(store));
    handler.startDrag({ type: 'radius', featureId: 'c1' }, dragEvent(0, 0), context, bbox);
    handler.updateDrag(dragEvent(1, 0, [0, 0]), context);
    store.deleteFeature('c1');

    expect(() => handler.updateDrag(dragEvent(2, 0, [0, 0]), context)).not.toThrow();
    expect(() => handler.endDrag(context)).not.toThrow();
    expectDragCleanedUp();
  });

  it('updates after a feature vanished do not throw (resize and rotate)', () => {
    for (const type of ['resize', 'rotate'] as const) {
      startMoveDrag(['f1', 'f2'], [0, 0]);
      handler.endDrag(context);
      store.setSelection('feature', ['f1', 'f2']);
      const bbox = computeSelectionBoundingBox(getSelectedFeatures(store));
      const hit: HandleHitResult = type === 'resize' ? { type, handle: 'resize-se' } : { type };
      handler.startDrag(hit, dragEvent(110, 100), context, bbox);
      handler.updateDrag(dragEvent(120, 90, [110, 100]), context);
      store.deleteFeature('f2');

      expect(() => handler.updateDrag(dragEvent(130, 80, [110, 100]), context)).not.toThrow();
      expect(() => handler.endDrag(context)).not.toThrow();
      expectDragCleanedUp();
      putFeature(square('f2', 100, 100));
    }
  });

  it('endDrag cleans up even when the commit throws', () => {
    startMoveDrag(['f1'], [0, 0]);
    handler.updateDrag(dragEvent(3, 4, [0, 0]), context);
    const transact = store.transact.bind(store);
    store.transact = () => {
      throw new Error('store failure');
    };

    expect(() => handler.endDrag(context)).toThrow('store failure');

    store.transact = transact;
    expectDragCleanedUp();
  });
});

describe('drag delegation for auxiliary handles', () => {
  const HIT: AuxiliaryHandleHit = { providerId: 'p1', handleId: 'h1', featureId: 'f1' };

  type DragCallback = (event: DragNormalizedEvent) => void;

  let onHandleDragStart: ReturnType<typeof vi.fn<AuxiliaryHandleProvider['onHandleDragStart']>>;
  let onHandleDragMove: ReturnType<typeof vi.fn<DragCallback>>;
  let onHandleDragEnd: ReturnType<typeof vi.fn<DragCallback>>;

  /** Register a provider, specifying whether it accepts the delegation */
  function registerProvider(accept: boolean, id = 'p1'): void {
    onHandleDragStart = vi.fn<AuxiliaryHandleProvider['onHandleDragStart']>(() => accept);
    onHandleDragMove = vi.fn<DragCallback>();
    onHandleDragEnd = vi.fn<DragCallback>();
    context.selectionScope.auxiliaryHandles.register({
      id,
      getHandles: () => [],
      onHandleDragStart,
      onHandleDragMove,
      onHandleDragEnd,
    });
  }

  /** Start an auxiliary handle drag */
  function startAuxiliaryDrag(from: Coordinate, hit: AuxiliaryHandleHit = HIT): void {
    store.setSelection('feature', ['f1']);
    const bbox = computeSelectionBoundingBox(getSelectedFeatures(store));
    const hitResult: HandleHitResult = {
      type: 'auxiliary',
      featureId: hit.featureId,
      auxiliary: hit,
    };
    handler.startDrag(hitResult, dragEvent(from[0], from[1]), context, bbox);
  }

  beforeEach(() => {
    putFeature(square('f1', 0, 0));
  });

  afterEach(() => {
    context.selectionScope.auxiliaryHandles.clear();
  });

  describe('when the delegation is accepted', () => {
    beforeEach(() => {
      registerProvider(true);
    });

    it('it does not announce drag.started / drag.ended (kept off the editing scope)', () => {
      const emit = vi.fn();
      const contextWithPlugins = {
        ...context,
        eventEmitter: { emit, on: vi.fn(), off: vi.fn() },
      };
      store.setSelection('feature', ['f1']);
      const bbox = computeSelectionBoundingBox(getSelectedFeatures(store));
      handler.startDrag(
        { type: 'auxiliary', featureId: 'f1', auxiliary: HIT },
        dragEvent(5, 5),
        contextWithPlugins,
        bbox,
      );
      handler.endDrag(contextWithPlugins, dragEvent(6, 6));

      expect(onHandleDragEnd).toHaveBeenCalledTimes(1);
      const signals = emit.mock.calls.map((call) => call[0]);
      expect(signals).not.toContain('drag.started');
      expect(signals).not.toContain('drag.ended');
    });

    it('the hit information and the start event are passed to the provider', () => {
      startAuxiliaryDrag([5, 5]);

      expect(onHandleDragStart).toHaveBeenCalledTimes(1);
      const [hit, event] = onHandleDragStart.mock.calls[0];
      expect(hit).toEqual(HIT);
      expect(event.lngLat).toEqual({ lng: 5, lat: 5 });
    });

    it('it is managed as a drag operation and dragPan is stopped', () => {
      startAuxiliaryDrag([5, 5]);

      expect(handler.isActive()).toBe(true);
      expect(store.getDragState()).toEqual({ operation: 'auxiliary' });
      expect(map.dragPan.isEnabled()).toBe(false);
    });

    it('subsequent moves are forwarded to the provider', () => {
      startAuxiliaryDrag([5, 5]);
      handler.updateDrag(dragEvent(6, 7, [5, 5]), context);
      handler.updateDrag(dragEvent(8, 9, [5, 5]), context);

      expect(onHandleDragMove).toHaveBeenCalledTimes(2);
      expect(onHandleDragMove.mock.calls[1][0].lngLat).toEqual({ lng: 8, lat: 9 });
    });

    it('end is forwarded to the provider and the cleanup matches an existing drag', () => {
      startAuxiliaryDrag([5, 5]);
      handler.updateDrag(dragEvent(6, 7, [5, 5]), context);
      const endEvent = dragEvent(8, 9, [5, 5]);
      handler.endDrag(context, endEvent);

      expect(onHandleDragEnd).toHaveBeenCalledTimes(1);
      expect(onHandleDragEnd.mock.calls[0][0]).toBe(endEvent);
      expect(handler.isActive()).toBe(false);
      expect(store.getDragState()).toBeNull();
      expect(map.dragPan.isEnabled()).toBe(true);
    });

    it('on a path with no end event it delivers end using the last move', () => {
      startAuxiliaryDrag([5, 5]);
      const moveEvent = dragEvent(6, 7, [5, 5]);
      handler.updateDrag(moveEvent, context);
      handler.endDrag(context);

      expect(onHandleDragEnd).toHaveBeenCalledTimes(1);
      expect(onHandleDragEnd.mock.calls[0][0]).toBe(moveEvent);
    });

    it('end is delivered exactly once on an abort (reset) as well', () => {
      startAuxiliaryDrag([5, 5]);
      handler.reset(store);

      expect(onHandleDragEnd).toHaveBeenCalledTimes(1);
      expect(handler.isActive()).toBe(false);
    });

    it('a reset after endDrag does not deliver end twice', () => {
      startAuxiliaryDrag([5, 5]);
      handler.endDrag(context);
      handler.reset(store);

      expect(onHandleDragEnd).toHaveBeenCalledTimes(1);
    });

    it('core writes nothing to the Store (the provider owns the meaning of coordinates)', () => {
      const batches: StoreChange[] = [];
      store.subscribe((changes) => {
        if (changes.features?.updated) batches.push(changes);
      });

      startAuxiliaryDrag([5, 5]);
      handler.updateDrag(dragEvent(6, 7, [5, 5]), context);
      handler.endDrag(context);

      expect(batches).toHaveLength(0);
      expect(coordinatesOf('f1')).toEqual(featureCoordinates(square('f1', 0, 0)));
    });
  });

  describe('when the delegation is refused', () => {
    beforeEach(() => {
      registerProvider(false);
    });

    it('it starts no drag and does not stop dragPan either', () => {
      startAuxiliaryDrag([5, 5]);

      expect(onHandleDragStart).toHaveBeenCalledTimes(1);
      expect(handler.isActive()).toBe(false);
      expect(store.getDragState()).toBeNull();
      expect(map.dragPan.isEnabled()).toBe(true);
    });

    it('subsequent move / end are not forwarded to the provider', () => {
      startAuxiliaryDrag([5, 5]);
      handler.updateDrag(dragEvent(6, 7, [5, 5]), context);
      handler.endDrag(context);

      expect(onHandleDragMove).not.toHaveBeenCalled();
      expect(onHandleDragEnd).not.toHaveBeenCalled();
    });
  });

  describe('the gates before delegation (readOnly / interaction lock / feature lock)', () => {
    beforeEach(() => {
      registerProvider(true);
    });

    it('while readOnly the provider is not queried', () => {
      store.setReadOnly(true);
      startAuxiliaryDrag([5, 5]);

      expect(onHandleDragStart).not.toHaveBeenCalled();
      expect(handler.isActive()).toBe(false);
    });

    it('while the interaction lock is on the provider is not queried', () => {
      store.setInteractionLock(true);
      startAuxiliaryDrag([5, 5]);

      expect(onHandleDragStart).not.toHaveBeenCalled();
      expect(handler.isActive()).toBe(false);
    });

    it('on a locked feature the provider is not queried', () => {
      store.updateFeature('f1', { locked: true });
      startAuxiliaryDrag([5, 5]);

      expect(onHandleDragStart).not.toHaveBeenCalled();
      expect(handler.isActive()).toBe(false);
    });

    it('it is not queried when the layer it belongs to is locked either (effective lock)', () => {
      store.updateLayer('l1', { locked: true });
      startAuxiliaryDrag([5, 5]);

      expect(onHandleDragStart).not.toHaveBeenCalled();
      expect(handler.isActive()).toBe(false);
    });
  });

  describe('when no provider is found', () => {
    it('an unregistered providerId does not start a drag', () => {
      registerProvider(true, 'other');
      startAuxiliaryDrag([5, 5]);

      expect(onHandleDragStart).not.toHaveBeenCalled();
      expect(handler.isActive()).toBe(false);
      expect(map.dragPan.isEnabled()).toBe(true);
    });

    it('when not a single provider is registered the existing path is unchanged', () => {
      // A normal drag with no auxiliary handle hit works as before
      dragVertex('f1', { ring: 0, index: 1 }, [10, 0], [11, 2]);

      expect(coordinatesOf('f1')).toEqual([
        [
          [0, 0],
          [11, 2],
          [10, 10],
          [0, 10],
          [0, 0],
        ],
      ]);
      expect(map.dragPan.isEnabled()).toBe(true);
    });
  });
});

describe('drag delegation for selection-independent auxiliary handles', () => {
  const GLOBAL_HIT: AuxiliaryHandleHit = {
    providerId: 'p1',
    handleId: 'g1',
    featureId: '',
    global: true,
  };

  type DragCallback = (event: DragNormalizedEvent) => void;

  let onHandleDragStart: ReturnType<typeof vi.fn<AuxiliaryHandleProvider['onHandleDragStart']>>;
  let onHandleDragMove: ReturnType<typeof vi.fn<DragCallback>>;
  let onHandleDragEnd: ReturnType<typeof vi.fn<DragCallback>>;

  function registerProvider(accept: boolean): void {
    onHandleDragStart = vi.fn<AuxiliaryHandleProvider['onHandleDragStart']>(() => accept);
    onHandleDragMove = vi.fn<DragCallback>();
    onHandleDragEnd = vi.fn<DragCallback>();
    context.selectionScope.auxiliaryHandles.register({
      id: 'p1',
      getHandles: () => [],
      getGlobalHandles: () => [{ id: 'g1', position: [5, 5] }],
      onHandleDragStart,
      onHandleDragMove,
      onHandleDragEnd,
    });
  }

  /** Start a drag with neither a selection nor a bbox */
  function startGlobalDrag(from: Coordinate): void {
    const hitResult: HandleHitResult = { type: 'auxiliary', auxiliary: GLOBAL_HIT };
    handler.startDrag(hitResult, dragEvent(from[0], from[1]), context, null);
  }

  beforeEach(() => {
    putFeature(square('f1', 0, 0));
  });

  afterEach(() => {
    context.selectionScope.auxiliaryHandles.clear();
  });

  it('it is delegated and managed as a drag even with an empty selection and no bbox', () => {
    registerProvider(true);
    startGlobalDrag([5, 5]);

    expect(onHandleDragStart).toHaveBeenCalledTimes(1);
    expect(onHandleDragStart.mock.calls[0][0]).toEqual(GLOBAL_HIT);
    expect(handler.isActive()).toBe(true);
    expect(store.getDragState()).toEqual({ operation: 'auxiliary' });
    expect(map.dragPan.isEnabled()).toBe(false);
    expect(store.getSelection().type).toBeNull();
  });

  it('move / end are forwarded to the same provider', () => {
    registerProvider(true);
    startGlobalDrag([5, 5]);
    handler.updateDrag(dragEvent(6, 6), context);
    handler.endDrag(context, dragEvent(7, 7));

    expect(onHandleDragMove).toHaveBeenCalledTimes(1);
    expect(onHandleDragMove.mock.calls[0][0].lngLat).toEqual({ lng: 6, lat: 6 });
    expect(onHandleDragEnd).toHaveBeenCalledTimes(1);
    expect(handler.isActive()).toBe(false);
    expect(map.dragPan.isEnabled()).toBe(true);
  });

  it('when the delegation is refused nothing starts (dragPan is not stopped either)', () => {
    registerProvider(false);
    startGlobalDrag([5, 5]);

    expect(handler.isActive()).toBe(false);
    expect(map.dragPan.isEnabled()).toBe(true);
    expect(store.getDragState()).toBeNull();
  });

  it('while readOnly the provider is not queried', () => {
    registerProvider(true);
    store.setReadOnly(true);
    startGlobalDrag([5, 5]);

    expect(onHandleDragStart).not.toHaveBeenCalled();
    expect(handler.isActive()).toBe(false);
  });

  it('while the interaction lock is on the provider is not queried', () => {
    registerProvider(true);
    store.setInteractionLock(true);
    startGlobalDrag([5, 5]);

    expect(onHandleDragStart).not.toHaveBeenCalled();
    expect(handler.isActive()).toBe(false);
  });

  it('it is unaffected by feature locks (because there is no feature it sits on)', () => {
    registerProvider(true);
    store.updateFeature('f1', { locked: true });
    store.setSelection('feature', ['f1']);
    startGlobalDrag([5, 5]);

    expect(onHandleDragStart).toHaveBeenCalledTimes(1);
    expect(handler.isActive()).toBe(true);
  });
});

describe('an aborted drag (cancel, mode switch, external change)', () => {
  function startMoveDrag(featureIds: string[], from: Coordinate, ctx = context): void {
    store.setSelection('feature', featureIds);
    const bbox = computeSelectionBoundingBox(getSelectedFeatures(store));
    handler.startDrag({ type: 'move' }, dragEvent(from[0], from[1]), ctx, bbox);
  }

  beforeEach(() => {
    putFeature(square('f1', 0, 0));
    putFeature(square('f2', 100, 100));
  });

  it('puts the features back where the drag started', () => {
    startMoveDrag(['f1', 'f2'], [0, 0]);
    handler.updateDrag(dragEvent(3, 4, [0, 0]), context);
    handler.updateDrag(dragEvent(5, 6, [0, 0]), context);

    handler.reset(store);

    expect(coordinatesOf('f1')).toEqual(featureCoordinates(square('f1', 0, 0)));
    expect(coordinatesOf('f2')).toEqual(featureCoordinates(square('f2', 100, 100)));
  });

  it('restores with an intermediate update before announcing the discard', () => {
    const calls: string[] = [];
    store.subscribe((changes) => {
      for (const u of changes.features?.updated ?? []) {
        calls.push(`${u.id}:${u.isIntermediate ? 'intermediate' : 'commit'}`);
      }
    });
    (
      store as unknown as { abortIntermediateUpdates?: (ids: string[]) => void }
    ).abortIntermediateUpdates = (ids) => calls.push(`abort:${ids.join(',')}`);

    startMoveDrag(['f1'], [0, 0]);
    handler.updateDrag(dragEvent(3, 4, [0, 0]), context);
    handler.reset(store);

    expect(calls).toEqual(['f1:intermediate', 'f1:intermediate', 'abort:f1']);
  });

  it('restores the properties a resize or radius drag changed', () => {
    putFeature({
      id: 'c1',
      type: 'Circle',
      geometry: { type: 'Point', coordinates: [0, 0] },
      layerId: 'l1',
      groupId: undefined,
      properties: { 'maplibre-gl-draw:radiusMeters': 1000 },
      locked: false,
      visible: true,
      style: {},
    });
    store.setSelection('feature', ['c1']);
    const bbox = computeSelectionBoundingBox(getSelectedFeatures(store));
    handler.startDrag({ type: 'radius', featureId: 'c1' }, dragEvent(0, 0), context, bbox);
    handler.updateDrag(dragEvent(1, 0, [0, 0]), context);

    handler.reset(store);

    expect(store.getFeature('c1')?.properties).toEqual({ 'maplibre-gl-draw:radiusMeters': 1000 });
  });

  it('leaves a feature that something else changed during the drag', () => {
    startMoveDrag(['f1', 'f2'], [0, 0]);
    handler.updateDrag(dragEvent(3, 4, [0, 0]), context);
    // An edit from outside lands on f2 while the drag is in progress
    store.updateFeature('f2', { geometry: square('f2', 50, 50).geometry });

    handler.reset(store);

    expect(coordinatesOf('f1')).toEqual(featureCoordinates(square('f1', 0, 0)));
    expect(coordinatesOf('f2')).toEqual(featureCoordinates(square('f2', 50, 50)));
  });

  it('pairs drag.started with drag.ended carrying the dragged features', () => {
    const emit = vi.fn();
    const withPlugins = {
      ...context,
      eventEmitter: { emit, on: vi.fn(), off: vi.fn() },
    };
    startMoveDrag(['f1'], [0, 0], withPlugins);
    handler.updateDrag(dragEvent(3, 4, [0, 0]), withPlugins);
    store.setSelection(null, []);

    handler.reset(store);
    handler.reset(store);

    const calls = emit.mock.calls.map((call) => [call[0], call[1]]);
    expect(calls).toEqual([
      ['drag.started', { kind: 'feature', featureIds: ['f1'] }],
      ['drag.ended', { kind: 'feature', featureIds: ['f1'], cancelled: true }],
    ]);
  });

  it('endDrag reports the dragged features even when the selection was cleared', () => {
    const emit = vi.fn();
    const withPlugins = {
      ...context,
      eventEmitter: { emit, on: vi.fn(), off: vi.fn() },
    };
    startMoveDrag(['f1'], [0, 0], withPlugins);
    handler.updateDrag(dragEvent(3, 4, [0, 0]), withPlugins);
    store.setSelection(null, []);

    handler.endDrag(withPlugins);

    expect(emit).toHaveBeenLastCalledWith('drag.ended', {
      kind: 'feature',
      featureIds: ['f1'],
      cancelled: false,
    });
    expect(coordinatesOf('f1')).toEqual(featureCoordinates(square('f1', 3, 4)));
  });
});
