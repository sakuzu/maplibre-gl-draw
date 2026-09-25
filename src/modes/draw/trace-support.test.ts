// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the trace support of the drawing modes
 *
 * These verify readTraceAnchor, which reads an endpoint from a snapping result, and
 * computeTracePath, which derives the path between endpoints. The path is the shortest path of
 * the graph of the nearby edges, so it holds across different features and different origins
 * (the Store and data) as long as they are connected by a shared vertex. The verification of
 * the integration through the drawing modes is the responsibility of trace-mode.test.ts.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import { beforeEach, describe, expect, it } from 'vitest';
import type { MouseNormalizedEvent } from '../../dispatcher/types.js';
import type { SnapResult, SnapTarget } from '../../snapping/types.js';
import { MemoryStore } from '../../store/memory.js';
import { RBushSpatialIndex } from '../../store/spatial/spatial-index.js';
import type { BoundingBox, Coordinate, Feature, VertexRef } from '../../store/types.js';
import type { ModeContext } from '../handler.js';
import type { TraceAnchor } from './trace-support.js';
import { computeTracePath, readTraceAnchor } from './trace-support.js';

const ZOOM = 14;

/** A single-path polyline (4 vertices) */
const LINE: Coordinate[] = [
  [0, 0],
  [0.1, 0],
  [0.2, 0],
  [0.3, 0],
];

/** A polyline that shares the end point of LINE and extends to the east */
const NEXT: Coordinate[] = [
  [0.3, 0],
  [0.4, 0],
  [0.5, 0],
];

/** A polyline that is not connected to anything */
const FAR: Coordinate[] = [
  [1, 1],
  [1.1, 1],
];

let store: MemoryStore;
let spatialIndex: RBushSpatialIndex;
let datasets: Map<string, Feature[]>;
let snapResult: SnapResult | null;
let traceEnabled: boolean;
let displayTraceEnabled: boolean;
let context: ModeContext;

beforeEach(() => {
  store = new MemoryStore();
  store.createLayer({ id: 'l1', name: 'l1', visible: true, locked: false, opacity: 1, order: [] });
  spatialIndex = new RBushSpatialIndex();
  datasets = new Map();
  snapResult = null;
  traceEnabled = true;
  displayTraceEnabled = true;

  context = {
    map: { getZoom: () => ZOOM } as unknown as MapLibreMap,
    store,
    spatialIndex,
    get trace() {
      return { enabled: traceEnabled };
    },
    getSnapResult: () => snapResult,
    getDatasetFeature: (datasetId: string, featureId: string) =>
      datasets.get(datasetId)?.find((feature) => feature.id === featureId) ?? null,
    // Empty when snapping to data is disabled (the same as the production wiring)
    getDatasetTraceFeatures: (_bbox: BoundingBox) =>
      displayTraceEnabled ? [...datasets.values()].flat() : [],
  } as unknown as ModeContext;
});

/** Adds a polyline to the Store */
function addStoreLine(id: string, coordinates: Coordinate[], visible = true): void {
  const feature: Feature = {
    id,
    type: 'LineString',
    coordinates,
    layerId: 'l1',
    properties: {},
    locked: false,
    visible,
  };
  store.createFeature(feature);
  const layer = store.getLayer('l1');
  if (layer) store.updateLayer('l1', { order: [...layer.order, id] });
  spatialIndex.insert(feature);
}

/** Adds a polyline to a dataset */
function addDisplayLine(datasetId: string, id: string, coordinates: Coordinate[]): void {
  const feature: Feature = {
    id,
    type: 'LineString',
    coordinates,
    layerId: '',
    properties: {},
    locked: false,
    visible: true,
  };
  const features = datasets.get(datasetId) ?? [];
  features.push(feature);
  datasets.set(datasetId, features);
}

/** An endpoint snapped to a vertex */
function vertexAnchor(
  featureId: string,
  index: number,
  coordinates: Coordinate[],
  datasetId?: string,
): TraceAnchor {
  const anchor: TraceAnchor = {
    featureId,
    endpoint: { coordinate: coordinates[index], vertex: { ring: 0, index } },
  };
  if (datasetId !== undefined) anchor.datasetId = datasetId;
  return anchor;
}

/** An endpoint snapped to the middle of an edge */
function segmentAnchor(featureId: string, index: number, coordinate: Coordinate): TraceAnchor {
  const startRef: VertexRef = { ring: 0, index };
  const endRef: VertexRef = { ring: 0, index: index + 1 };
  return { featureId, endpoint: { coordinate, segment: { startRef, endRef } } };
}

/** A mouse event that has a snapping result */
function mouseEvent(coordinate: Coordinate): MouseNormalizedEvent {
  return { lngLat: { lng: coordinate[0], lat: coordinate[1] } } as MouseNormalizedEvent;
}

function makeSnapResult(coordinate: Coordinate, target: SnapTarget): SnapResult {
  return { lngLat: { lng: coordinate[0], lat: coordinate[1] }, target };
}

describe('readTraceAnchor', () => {
  it('reads an endpoint from a vertex snap target', () => {
    snapResult = makeSnapResult(LINE[1], {
      kind: 'vertex',
      featureId: 'f1',
      vertex: { ring: 0, index: 1 },
    });

    const anchor = readTraceAnchor(context, mouseEvent(LINE[1]));

    expect(anchor?.featureId).toBe('f1');
    expect(anchor?.datasetId).toBeUndefined();
    expect(anchor?.endpoint.vertex).toEqual({ ring: 0, index: 1 });
  });

  it('also reads datasetId for a vertex from a dataset', () => {
    snapResult = makeSnapResult(LINE[1], {
      kind: 'vertex',
      featureId: 'f1',
      datasetId: 'data',
      vertex: { ring: 0, index: 1 },
    });

    expect(readTraceAnchor(context, mouseEvent(LINE[1]))?.datasetId).toBe('data');
  });

  it('reads datasetId for an edge from a dataset as well', () => {
    const middle: Coordinate = [0.05, 0];
    snapResult = makeSnapResult(middle, {
      kind: 'edge',
      featureId: 'f1',
      datasetId: 'data',
      segment: {
        start: LINE[0],
        end: LINE[1],
        startRef: { ring: 0, index: 0 },
        endRef: { ring: 0, index: 1 },
      },
    });

    const anchor = readTraceAnchor(context, mouseEvent(middle));

    expect(anchor?.datasetId).toBe('data');
    expect(anchor?.endpoint.segment).toEqual({
      startRef: { ring: 0, index: 0 },
      endRef: { ring: 0, index: 1 },
    });
  });

  it('does not read when tracing is disabled', () => {
    traceEnabled = false;
    snapResult = makeSnapResult(LINE[1], {
      kind: 'vertex',
      featureId: 'f1',
      vertex: { ring: 0, index: 1 },
    });

    expect(readTraceAnchor(context, mouseEvent(LINE[1]))).toBeNull();
  });
});

describe('computeTracePath', () => {
  it('holds between vertices of the same feature', () => {
    addStoreLine('f1', LINE);

    const path = computeTracePath(
      context,
      vertexAnchor('f1', 0, LINE),
      vertexAnchor('f1', 3, LINE),
    );

    expect(path).toEqual([LINE[1], LINE[2]]);
  });

  it('holds across different features as long as they are connected by a shared vertex', () => {
    addStoreLine('f1', LINE);
    addStoreLine('f2', NEXT);

    const path = computeTracePath(
      context,
      vertexAnchor('f1', 0, LINE),
      vertexAnchor('f2', 2, NEXT),
    );

    expect(path).toEqual([LINE[1], LINE[2], LINE[3], NEXT[1]]);
  });

  it('holds across a feature of the Store and a feature of data', () => {
    addStoreLine('f1', LINE);
    addDisplayLine('data', 'd1', NEXT);

    const path = computeTracePath(
      context,
      vertexAnchor('f1', 0, LINE),
      vertexAnchor('d1', 2, NEXT, 'data'),
    );

    expect(path).toEqual([LINE[1], LINE[2], LINE[3], NEXT[1]]);
  });

  it('holds between data of different datasets', () => {
    addDisplayLine('data', 'd1', LINE);
    addDisplayLine('other', 'd2', NEXT);

    const path = computeTracePath(
      context,
      vertexAnchor('d1', 0, LINE, 'data'),
      vertexAnchor('d2', 2, NEXT, 'other'),
    );

    expect(path).toEqual([LINE[1], LINE[2], LINE[3], NEXT[1]]);
  });

  it('does not connect to the data side when data is not used as material', () => {
    addStoreLine('f1', LINE);
    addDisplayLine('data', 'd1', NEXT);
    displayTraceEnabled = false;

    expect(
      computeTracePath(context, vertexAnchor('f1', 0, LINE), vertexAnchor('d1', 2, NEXT, 'data')),
    ).toBeNull();
  });

  it('does not hold between features that are not connected', () => {
    addStoreLine('f1', LINE);
    addStoreLine('f3', FAR);

    expect(
      computeTracePath(context, vertexAnchor('f1', 0, LINE), vertexAnchor('f3', 1, FAR)),
    ).toBeNull();
  });

  it('does not use a hidden feature as material', () => {
    addStoreLine('f1', LINE);
    addStoreLine('f2', NEXT, false);

    expect(
      computeTracePath(context, vertexAnchor('f1', 0, LINE), vertexAnchor('f2', 2, NEXT)),
    ).toBeNull();
  });

  it('holds from an endpoint snapped to the middle of an edge as well', () => {
    addStoreLine('f1', LINE);

    const path = computeTracePath(
      context,
      segmentAnchor('f1', 0, [0.05, 0]),
      vertexAnchor('f1', 3, LINE),
    );

    expect(path).toEqual([LINE[1], LINE[2]]);
  });

  it('inserts nothing when the two points are on the same edge', () => {
    addStoreLine('f1', LINE);

    const path = computeTracePath(
      context,
      segmentAnchor('f1', 0, [0.02, 0]),
      segmentAnchor('f1', 0, [0.08, 0]),
    );

    expect(path).toEqual([]);
  });

  it('does not hold when the feature of an endpoint cannot be looked up', () => {
    addStoreLine('f1', LINE);

    // The coordinates of both ends of an edge can only be resolved from the feature
    expect(
      computeTracePath(
        context,
        segmentAnchor('missing', 0, [0.05, 0]),
        vertexAnchor('f1', 3, LINE),
      ),
    ).toBeNull();
  });

  it('does not hold when even one of the endpoints is missing', () => {
    addStoreLine('f1', LINE);

    expect(computeTracePath(context, null, vertexAnchor('f1', 3, LINE))).toBeNull();
    expect(computeTracePath(context, vertexAnchor('f1', 0, LINE), null)).toBeNull();
  });
});
