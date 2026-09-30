// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests of drawing the following vertices (renderFollowedVertices) and the auxiliary handles
 * of the extensions
 *
 * Features that follow along when a shared vertex is moved are not selected, so they do not
 * take the path of the selection UI. This verifies that the separate path, which reads the
 * UI state raised only during a drag and draws in the following style, targets only the
 * correct features and vertices.
 */

import type { CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../store/memory.js';
import type { Coordinate, Feature, VertexRef } from '../../store/types.js';
import type { AuxiliaryHandleProvider } from './auxiliary-handles.js';
import { createSelectionScope } from './selection-scope.js';
import type { SelectionUIDrawerDeps } from './selection-ui-drawer.js';
import {
  renderFollowedVertices,
  renderGlobalAuxiliaryHandles,
  renderSelectionUI,
} from './selection-ui-drawer.js';

const ZOOM = 10;
const PROJECTION_DATA = {} as CustomRenderMethodInput['defaultProjectionData'];

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

let store: MemoryStore;
let drawn: Array<{ featureId: string; refs: VertexRef[] }>;
let deps: SelectionUIDrawerDeps;

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
  store.createFeature(square('f2', 10, 0));

  drawn = [];
  const selectionHandlesRenderer = {
    setTransform: vi.fn(),
    setProjectionData: vi.fn(),
    drawFollowedVertexHandles: (feature: Feature, refs: VertexRef[]) => {
      drawn.push({ featureId: feature.id, refs });
    },
  };
  const map = {
    project: (coord: Coordinate) => ({ x: coord[0], y: coord[1] }),
    unproject: (point: { x: number; y: number }) => ({ lng: point.x, lat: point.y }),
  } as unknown as MapLibreMap;

  deps = {
    selectionUIRenderer: null,
    selectionHandlesRenderer,
    pointInstanceRenderer: null,
    map,
  } as unknown as SelectionUIDrawerDeps;
});

describe('renderFollowedVertices', () => {
  const followed = [
    {
      featureId: 'f2',
      vertices: [
        { ring: 0, index: 0 },
        { ring: 0, index: 4 },
      ],
    },
  ];

  it('draws nothing when the UI state is null', () => {
    renderFollowedVertices(null, store, ZOOM, PROJECTION_DATA, deps);
    expect(drawn).toEqual([]);
  });

  it('draws nothing for an empty array either', () => {
    renderFollowedVertices([], store, ZOOM, PROJECTION_DATA, deps);
    expect(drawn).toEqual([]);
  });

  it('passes the following features and vertex references through as they are', () => {
    renderFollowedVertices(followed, store, ZOOM, PROJECTION_DATA, deps);
    expect(drawn).toEqual([{ featureId: 'f2', refs: followed[0].vertices }]);
  });

  it('does not draw deleted features', () => {
    store.deleteFeature('f2');
    renderFollowedVertices(followed, store, ZOOM, PROJECTION_DATA, deps);
    expect(drawn).toEqual([]);
  });

  it('does not draw hidden features', () => {
    store.updateFeature('f2', { visible: false });
    renderFollowedVertices(followed, store, ZOOM, PROJECTION_DATA, deps);
    expect(drawn).toEqual([]);
  });

  it('does not draw locally hidden features', () => {
    store.setLocallyHidden('f2', true);
    renderFollowedVertices(followed, store, ZOOM, PROJECTION_DATA, deps);
    expect(drawn).toEqual([]);
  });
});

describe('the auxiliary handles of the extensions', () => {
  let auxiliary: Coordinate[][];
  let auxDeps: SelectionUIDrawerDeps;

  const provider: AuxiliaryHandleProvider = {
    id: 'pins',
    getHandles: (feature) => [{ id: 'a', position: [feature.id === 'f2' ? 12 : 0, 3] }],
    getGlobalHandles: () => [{ id: 'g', position: [50, 50] }],
    onHandleDragStart: () => true,
    onHandleDragMove: () => {},
    onHandleDragEnd: () => {},
  };

  beforeEach(() => {
    auxiliary = [];
    const scope = createSelectionScope();
    scope.auxiliaryHandles.register(provider);
    const box = {
      topLeft: [10, 10],
      topRight: [20, 10],
      bottomRight: [20, 0],
      bottomLeft: [10, 0],
      center: [15, 5],
    };
    auxDeps = {
      ...deps,
      scope,
      map: {
        ...deps.map,
        getCanvas: () => ({ clientWidth: 100, clientHeight: 100 }),
      } as unknown as MapLibreMap,
      selectionUIRenderer: {
        setTransform: vi.fn(),
        setProjectionData: vi.fn(),
        draw: vi.fn(),
        computeCombinedFeatureBoundingBox: () => box,
        computeFeatureBoundingBox: () => box,
      },
      selectionHandlesRenderer: {
        ...deps.selectionHandlesRenderer,
        drawAllHandles: vi.fn(),
        drawAuxiliaryHandles: (positions: Coordinate[]) => auxiliary.push([...positions]),
      },
    } as unknown as SelectionUIDrawerDeps;
  });

  it('draws the handles of the selected feature with the other handles', () => {
    const feature = store.getFeature('f2') as Feature;
    renderSelectionUI([feature], ZOOM, PROJECTION_DATA, auxDeps, null);
    expect(auxiliary).toEqual([[[12, 3]]]);
  });

  it('hides them while another operation runs and while the selection is locked', () => {
    const feature = store.getFeature('f2') as Feature;
    renderSelectionUI([feature], ZOOM, PROJECTION_DATA, auxDeps, { operation: 'move' });
    renderSelectionUI([feature], ZOOM, PROJECTION_DATA, auxDeps, null, null, true);
    expect(auxiliary).toEqual([]);
    renderSelectionUI([feature], ZOOM, PROJECTION_DATA, auxDeps, { operation: 'auxiliary' });
    expect(auxiliary).toHaveLength(1);
  });

  it('draws the handles that belong to no feature', () => {
    renderGlobalAuxiliaryHandles(ZOOM, PROJECTION_DATA, auxDeps, null);
    expect(auxiliary).toEqual([[[50, 50]]]);
    renderGlobalAuxiliaryHandles(ZOOM, PROJECTION_DATA, auxDeps, { operation: 'vertex' });
    expect(auxiliary).toHaveLength(1);
  });
});
