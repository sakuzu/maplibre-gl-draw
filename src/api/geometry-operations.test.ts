// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the Geometry API (draw.geometry)
 *
 * Verifies the integration layer of the boolean editing operations
 * (union / subtract / intersect) and of the buffer. The geometric computation itself is
 * covered by the tests under src/geometry, so what is covered here is the resolution of
 * the targets (stacking order / locked / hidden), the granularity of the transactions,
 * the placement and inheritance of the result, the move of the selection, and the
 * emission of the events.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPointAtAngle } from '../geometry/angle.js';
import { unionAll } from '../geometry/boolean.js';
import { pointInPolygon } from '../geometry/predicates.js';
import type { AreaCoordinates } from '../geometry/types.js';
import { generateCirclePolygon } from '../shared/math/index.js';
import { coordinatesOf } from '../shared/utils/coordinates.js';
import type { GeometryAppliedPayload } from '../shared/utils/event-emitter.js';
import { EventEmitterImpl } from '../shared/utils/event-emitter.js';
import { MemoryStore } from '../store/memory.js';
import { StoreSpatialIndex } from '../store/spatial/store-spatial-index.js';
import type { Coordinate, Feature, FeatureInput, StateChanges } from '../store/types.js';
import type { GeometryOperations } from './geometry-operations.js';
import { createGeometryApi } from './geometry-operations.js';

/** The ids held by the spatial index derived from the Store, sorted */
function indexedIds(): string[] {
  return spatial.findInBounds({ minX: -180, minY: -90, maxX: 180, maxY: 90 }).sort();
}

/** An axis-aligned rectangular ring (Polygon coordinates). */
function square(minX: number, minY: number, maxX: number, maxY: number): Coordinate[][] {
  return [
    [
      [minX, minY],
      [maxX, minY],
      [maxX, maxY],
      [minX, maxY],
      [minX, minY],
    ],
  ];
}

let store: MemoryStore;
let spatial: StoreSpatialIndex;
let eventEmitter: EventEmitterImpl;
let geometry: GeometryOperations;
let idSeq: number;
let applied: GeometryAppliedPayload[];

function addFeature(input: FeatureInput & { id: string }): Feature {
  const feature: Feature = {
    layerId: 'l1',
    properties: {},
    locked: false,
    visible: true,
    ...input,
    style: input.style ?? {},
  };
  store.createFeature(feature);
  return feature;
}

/** A shorthand for adding a rectangular feature. */
function addSquare(
  id: string,
  bounds: [number, number, number, number],
  extra: Partial<Feature> = {},
): Feature {
  return addFeature({
    id,
    type: 'Polygon',
    geometry: { type: 'Polygon', coordinates: square(...bounds) },
    ...extra,
  });
}

/** The polygon coordinates of a result feature (accepts either Polygon or MultiPolygon). */
function areaOf(feature: Feature): AreaCoordinates {
  return coordinatesOf(feature) as AreaCoordinates;
}

beforeEach(() => {
  store = new MemoryStore();
  store.createLayer({ id: 'l1', name: 'l1', visible: true, locked: false, opacity: 1, items: [] });
  spatial = new StoreSpatialIndex(store);
  eventEmitter = new EventEmitterImpl();
  idSeq = 0;
  applied = [];
  eventEmitter.on('geometry.applied', (payload) => {
    applied.push(payload);
  });
  geometry = createGeometryApi({
    store,
    eventEmitter,
    generateFeatureId: () => `geo-${++idSeq}`,
  }).geometry;
});

describe('draw.geometry.union', () => {
  it('merges two overlapping Polygons into a single Polygon', () => {
    addSquare('a', [0, 0, 10, 10]);
    addSquare('b', [5, 0, 15, 10]);
    store.setSelection('feature', ['a', 'b']);

    const resultId = geometry.union();

    expect(resultId).toBe('geo-1');
    const result = store.getFeature('geo-1');
    expect(result?.type).toBe('Polygon');
    // It covers both areas and does not cover the outside
    expect(pointInPolygon([2, 5], areaOf(result!))).toBe(true);
    expect(pointInPolygon([7, 5], areaOf(result!))).toBe(true);
    expect(pointInPolygon([12, 5], areaOf(result!))).toBe(true);
    expect(pointInPolygon([20, 5], areaOf(result!))).toBe(false);
    // The inputs are deleted
    expect(store.getFeature('a')).toBeUndefined();
    expect(store.getFeature('b')).toBeUndefined();
  });

  it('makes the merge of two separate polygons a MultiPolygon', () => {
    addSquare('a', [0, 0, 10, 10]);
    addSquare('b', [20, 0, 30, 10]);
    store.setSelection('feature', ['a', 'b']);

    geometry.union();

    const result = store.getFeature('geo-1');
    expect(result?.type).toBe('MultiPolygon');
    expect((coordinatesOf(result!) as Coordinate[][][]).length).toBe(2);
    expect(pointInPolygon([5, 5], areaOf(result!))).toBe(true);
    expect(pointInPolygon([25, 5], areaOf(result!))).toBe(true);
    expect(pointInPolygon([15, 5], areaOf(result!))).toBe(false);
  });

  it('gathers deleting the inputs and creating the result into one transaction', () => {
    addSquare('a', [0, 0, 10, 10]);
    addSquare('b', [5, 0, 15, 10]);
    store.setSelection('feature', ['a', 'b']);

    const listener = vi.fn();
    store.subscribe(listener);
    geometry.union();

    expect(listener).toHaveBeenCalledTimes(1);
    const changes: StateChanges = listener.mock.calls[0][0];
    expect(changes.features?.created?.map((f) => f.id)).toEqual(['geo-1']);
    expect(changes.features?.deleted?.map((f) => f.id).sort()).toEqual(['a', 'b']);
  });

  it('removes the inputs from the spatial index and adds the result', () => {
    addSquare('a', [0, 0, 10, 10]);
    addSquare('b', [5, 0, 15, 10]);
    store.setSelection('feature', ['a', 'b']);

    geometry.union();

    expect(indexedIds()).toEqual(['geo-1']);
  });

  it('moves the selection to the result feature', () => {
    addSquare('a', [0, 0, 10, 10]);
    addSquare('b', [5, 0, 15, 10]);
    store.setSelection('feature', ['a', 'b']);

    geometry.union();

    expect(store.getSelection()).toEqual({ type: 'feature', ids: ['geo-1'] });
  });

  it('merges the given targets regardless of the selection when ids are explicit', () => {
    addSquare('a', [0, 0, 10, 10]);
    addSquare('b', [5, 0, 15, 10]);
    addSquare('c', [40, 40, 50, 50]);
    store.setSelection('feature', ['c']);

    geometry.union(['a', 'b']);

    expect(store.getFeature('c')).toBeDefined();
    expect(store.getFeature('a')).toBeUndefined();
    expect(store.getFeature('geo-1')).toBeDefined();
  });
});

describe('draw.geometry.subtract', () => {
  it('makes a Polygon with a hole when the inner polygon is subtracted', () => {
    addSquare('outer', [0, 0, 30, 30]);
    addSquare('inner', [10, 10, 20, 20]);
    store.setSelection('feature', ['outer', 'inner']);

    geometry.subtract();

    const result = store.getFeature('geo-1');
    expect(result?.type).toBe('Polygon');
    // Two rings: the outer ring plus the inner ring
    expect((coordinatesOf(result!) as Coordinate[][]).length).toBe(2);
    expect(pointInPolygon([5, 5], areaOf(result!))).toBe(true);
    expect(pointInPolygon([15, 15], areaOf(result!))).toBe(false);
  });

  it('makes the backmost one the side being subtracted from when the argument is omitted', () => {
    // The head of order is the backmost. outer is the backmost, so it is outer - inner
    addSquare('outer', [0, 0, 10, 10]);
    addSquare('cutter', [5, 0, 15, 10]);
    store.setSelection('feature', ['cutter', 'outer']);

    geometry.subtract();

    const result = store.getFeature('geo-1');
    expect(pointInPolygon([2, 5], areaOf(result!))).toBe(true);
    expect(pointInPolygon([7, 5], areaOf(result!))).toBe(false);
    expect(pointInPolygon([12, 5], areaOf(result!))).toBe(false);
  });

  it('subtracts from the given polygon regardless of the stacking order with targetId', () => {
    addSquare('back', [0, 0, 10, 10]);
    addSquare('front', [5, 0, 15, 10]);
    store.setSelection('feature', ['back', 'front']);

    // The default would be back - front, but front is given as the target
    geometry.subtract('front');

    const result = store.getFeature('geo-1');
    expect(pointInPolygon([12, 5], areaOf(result!))).toBe(true);
    expect(pointInPolygon([7, 5], areaOf(result!))).toBe(false);
    expect(pointInPolygon([2, 5], areaOf(result!))).toBe(false);
  });

  it('keeps the inputs and reports through an event when everything is subtracted away', () => {
    addSquare('small', [5, 5, 6, 6]);
    addSquare('big', [0, 0, 10, 10]);
    store.setSelection('feature', ['small', 'big']);

    const resultId = geometry.subtract('small', ['small', 'big']);

    expect(resultId).toBeNull();
    expect(store.getFeature('small')).toBeDefined();
    expect(store.getFeature('big')).toBeDefined();
    expect(applied).toEqual([
      {
        operation: 'subtract',
        inputIds: ['small', 'big'],
        resultId: null,
        resultIds: [],
        status: 'empty',
      },
    ]);
  });
});

describe('draw.geometry.intersect', () => {
  it('keeps only the common part', () => {
    addSquare('a', [0, 0, 10, 10]);
    addSquare('b', [5, 0, 15, 10]);
    store.setSelection('feature', ['a', 'b']);

    geometry.intersect();

    const result = store.getFeature('geo-1');
    expect(result?.type).toBe('Polygon');
    expect(pointInPolygon([7, 5], areaOf(result!))).toBe(true);
    expect(pointInPolygon([2, 5], areaOf(result!))).toBe(false);
    expect(pointInPolygon([12, 5], areaOf(result!))).toBe(false);
  });

  it('keeps the inputs and reports the empty result by event when they do not overlap', () => {
    addSquare('a', [0, 0, 10, 10]);
    addSquare('b', [20, 0, 30, 10]);
    store.setSelection('feature', ['a', 'b']);

    const listener = vi.fn();
    store.subscribe(listener);
    const resultId = geometry.intersect();

    expect(resultId).toBeNull();
    expect(store.getFeature('a')).toBeDefined();
    expect(store.getFeature('b')).toBeDefined();
    // The Store is not changed at all
    expect(listener).not.toHaveBeenCalled();
    expect(applied).toEqual([
      {
        operation: 'intersect',
        inputIds: ['a', 'b'],
        resultId: null,
        resultIds: [],
        status: 'empty',
      },
    ]);
  });
});

describe('the draw.geometry.applied event', () => {
  it('reports the operation name, the input IDs and the result IDs', () => {
    addSquare('a', [0, 0, 10, 10]);
    addSquare('b', [5, 0, 15, 10]);
    store.setSelection('feature', ['a', 'b']);

    geometry.union();

    expect(applied).toEqual([
      {
        operation: 'union',
        inputIds: ['a', 'b'],
        resultId: 'geo-1',
        resultIds: ['geo-1'],
        status: 'applied',
      },
    ]);
  });

  it('orders inputIds by the stacking order (the last one is the foremost)', () => {
    addSquare('back', [0, 0, 10, 10]);
    addSquare('front', [5, 0, 15, 10]);
    // The order of the selection is unrelated to the stacking order
    store.setSelection('feature', ['front', 'back']);

    geometry.union();

    expect(applied[0].inputIds).toEqual(['back', 'front']);
  });

  it('emits no event when nothing was done', () => {
    addSquare('a', [0, 0, 10, 10]);
    store.setSelection('feature', ['a']);

    expect(geometry.union()).toBeNull();
    expect(applied).toEqual([]);
  });
});

describe('the handling of a Circle', () => {
  it('operates on the same 64-segment polygon as the rendering and keeps no radiusMeters', () => {
    const center: Coordinate = [0, 0];
    const radiusMeters = 1000;
    addFeature({
      id: 'circle',
      type: 'Circle',
      geometry: { type: 'Point', coordinates: center },
      properties: {
        'maplibre-gl-draw:radiusMeters': radiusMeters,
        'maplibre-gl-draw:radiusHandleAngle': 135,
        name: '円',
      },
    });
    addSquare('far', [20, 20, 30, 30]);
    store.setSelection('feature', ['circle', 'far']);

    geometry.union();

    const result = store.getFeature('geo-1');
    expect(result?.type).toBe('MultiPolygon');
    // It matches the result that went through the same generateCirclePolygon as the
    // rendering (64 segments by default)
    const expected = unionAll([
      [generateCirclePolygon(center, radiusMeters)],
      square(20, 20, 30, 30),
    ]);
    expect(coordinatesOf(result)).toEqual(expected);
    // The part that came from the circle stays at 64 segments (65 points with the
    // closing point)
    expect((coordinatesOf(result!) as Coordinate[][][])[0][0]).toHaveLength(65);
    // The parametric properties that came from the circle are lost
    expect(result?.properties['maplibre-gl-draw:radiusMeters']).toBeUndefined();
    expect(result?.properties['maplibre-gl-draw:radiusHandleAngle']).toBeUndefined();
  });

  it('does not include a Circle without a radius among the targets', () => {
    addFeature({
      id: 'circle',
      type: 'Circle',
      geometry: { type: 'Point', coordinates: [0, 0] },
      properties: {},
    });
    addSquare('a', [0, 0, 10, 10]);
    store.setSelection('feature', ['circle', 'a']);

    expect(geometry.union()).toBeNull();
    expect(store.getFeature('a')).toBeDefined();
  });
});

describe('narrowing down the targets', () => {
  it('does nothing when there are fewer than two targets', () => {
    addSquare('a', [0, 0, 10, 10]);
    store.setSelection('feature', ['a']);

    expect(geometry.union()).toBeNull();
    expect(geometry.subtract()).toBeNull();
    expect(geometry.intersect()).toBeNull();
    expect(store.getFeature('a')).toBeDefined();
  });

  it('does nothing when there is no selection', () => {
    addSquare('a', [0, 0, 10, 10]);
    addSquare('b', [5, 0, 15, 10]);

    expect(geometry.union()).toBeNull();
    expect(store.getFeature('a')).toBeDefined();
  });

  it('drops a feature that is not of a polygon kind from the targets', () => {
    addSquare('a', [0, 0, 10, 10]);
    addFeature({
      id: 'line',
      type: 'LineString',
      geometry: {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [10, 10],
        ],
      },
    });
    store.setSelection('feature', ['a', 'line']);

    expect(geometry.union()).toBeNull();
    expect(store.getFeature('line')).toBeDefined();
  });

  it('drops a locked feature from the targets', () => {
    addSquare('a', [0, 0, 10, 10]);
    addSquare('b', [5, 0, 15, 10], { locked: true });
    addSquare('c', [8, 0, 18, 10]);
    store.setSelection('feature', ['a', 'b', 'c']);

    geometry.union();

    // b is locked, so it remains, and only a and c are merged
    expect(store.getFeature('b')).toBeDefined();
    expect(store.getFeature('a')).toBeUndefined();
    expect(store.getFeature('c')).toBeUndefined();
    expect(applied[0].inputIds).toEqual(['a', 'c']);
  });

  it('also drops a feature that inherits the lock of its layer from the targets', () => {
    store.createLayer({
      id: 'locked',
      name: 'locked',
      visible: true,
      locked: true,
      opacity: 1,
      items: [],
    });
    addSquare('a', [0, 0, 10, 10]);
    addSquare('b', [5, 0, 15, 10], { layerId: 'locked' });
    store.setSelection('feature', ['a', 'b']);

    expect(geometry.union()).toBeNull();
    expect(store.getFeature('a')).toBeDefined();
    expect(store.getFeature('b')).toBeDefined();
  });

  it('drops a hidden feature from the targets', () => {
    addSquare('a', [0, 0, 10, 10]);
    addSquare('b', [5, 0, 15, 10], { visible: false });
    store.setSelection('feature', ['a', 'b']);

    expect(geometry.union(['a', 'b'])).toBeNull();
    expect(store.getFeature('b')).toBeDefined();
  });

  it('drops a locally hidden feature from the targets', () => {
    addSquare('a', [0, 0, 10, 10]);
    addSquare('b', [5, 0, 15, 10]);
    store.setLocallyHidden('b', true);

    expect(geometry.union(['a', 'b'])).toBeNull();
    expect(store.getFeature('b')).toBeDefined();
  });

  it('does nothing while readOnly', () => {
    addSquare('a', [0, 0, 10, 10]);
    addSquare('b', [5, 0, 15, 10]);
    store.setSelection('feature', ['a', 'b']);
    store.setReadOnly(true);

    expect(geometry.union()).toBeNull();
    expect(store.getFeature('a')).toBeDefined();
    expect(indexedIds()).toEqual(['a', 'b']);
  });
});

describe('the inheritance and placement of the result', () => {
  it('inherits the style and the properties from the foremost input', () => {
    addSquare('back', [0, 0, 10, 10], {
      style: { fillColor: '#ff0000' },
      properties: { name: '背面', backOnly: 1 },
    });
    addSquare('front', [5, 0, 15, 10], {
      style: { fillColor: '#0000ff' },
      properties: { name: '前面' },
    });
    store.setSelection('feature', ['back', 'front']);

    geometry.union();

    const result = store.getFeature('geo-1');
    expect(result?.style).toEqual({ fillColor: '#0000ff' });
    expect(result?.properties).toEqual({ name: '前面' });
  });

  it('places the result in the same layer and the same z position as the foremost input', () => {
    store.createLayer({
      id: 'l2',
      name: 'l2',
      visible: true,
      locked: false,
      opacity: 1,
      items: [],
    });
    addSquare('bottom', [40, 40, 50, 50]);
    addSquare('a', [0, 0, 10, 10]);
    addSquare('b', [5, 0, 15, 10]);
    addSquare('top', [60, 60, 70, 70]);
    store.setSelection('feature', ['a', 'b']);

    geometry.union();

    const result = store.getFeature('geo-1');
    expect(result?.layerId).toBe('l1');
    // It goes into the position a / b occupied (right after bottom)
    expect(store.getLayer('l1')?.items).toEqual(['bottom', 'geo-1', 'top']);
  });

  it('goes into the layer of the foremost input when the inputs span several layers', () => {
    store.createLayer({
      id: 'l2',
      name: 'l2',
      visible: true,
      locked: false,
      opacity: 1,
      items: [],
    });
    // The layer order is l1 then l2, so l2 is the one in front
    addSquare('a', [0, 0, 10, 10]);
    addSquare('b', [5, 0, 15, 10], { layerId: 'l2' });
    store.setSelection('feature', ['a', 'b']);

    geometry.union();

    expect(store.getFeature('geo-1')?.layerId).toBe('l2');
    expect(store.getLayer('l1')?.items).toEqual([]);
    expect(store.getLayer('l2')?.items).toEqual(['geo-1']);
  });

  it('puts the result in the same group when the foremost input is a member of a group', () => {
    addSquare('a', [0, 0, 10, 10]);
    addSquare('b', [5, 0, 15, 10]);
    addSquare('other', [40, 40, 50, 50]);
    store.createGroup({
      id: 'g1',
      layerId: 'l1',
      name: 'g1',
      featureIds: ['a', 'b', 'other'],
      locked: false,
      visible: true,
    });
    store.setSelection('feature', ['a', 'b']);

    geometry.union();

    const result = store.getFeature('geo-1');
    expect(result?.groupId).toBe('g1');
    expect(store.getGroup('g1')?.featureIds).toEqual(['geo-1', 'other']);
  });
});

/** A shorthand for adding a line feature. */
function addLine(id: string, coordinates: Coordinate[], extra: Partial<Feature> = {}): Feature {
  return addFeature({
    id,
    type: 'LineString',
    geometry: { type: 'LineString', coordinates: coordinates },
    ...extra,
  });
}

describe('draw.geometry.buffer', () => {
  it('turns a positive line buffer into a polygon, keeps the input, selects the result', () => {
    addLine('line', [
      [0, 0],
      [0.01, 0],
    ]);
    store.setSelection('feature', ['line']);

    const resultIds = geometry.buffer({ distanceMeters: 100 });

    expect(resultIds).toEqual(['geo-1']);
    const result = store.getFeature('geo-1');
    expect(result?.type).toBe('Polygon');
    // The inside of the band (on the line and 90 m north) is included, and the outside
    // (110 m north) is not
    expect(pointInPolygon([0.005, 0], areaOf(result!))).toBe(true);
    expect(pointInPolygon(getPointAtAngle([0.005, 0], 90, 0), areaOf(result!))).toBe(true);
    expect(pointInPolygon(getPointAtAngle([0.005, 0], 110, 0), areaOf(result!))).toBe(false);
    // The input remains
    expect(store.getFeature('line')).toBeDefined();
    expect(store.getSelection()).toEqual({ type: 'feature', ids: ['geo-1'] });
    expect(indexedIds()).toEqual(['geo-1', 'line']);
  });

  it('keeps the width of the band in meters at a high latitude', () => {
    // Latitude 60 degrees. One degree of longitude is half as long as at the equator, but
    // the offsets are scaled at the latitude of each vertex, so the width does not change
    addLine('line', [
      [0, 60],
      [0.01, 60],
    ]);

    geometry.buffer(['line'], { distanceMeters: 100 });

    const result = store.getFeature('geo-1');
    expect(pointInPolygon(getPointAtAngle([0.005, 60], 90, 0), areaOf(result!))).toBe(true);
    expect(pointInPolygon(getPointAtAngle([0.005, 60], 110, 0), areaOf(result!))).toBe(false);
  });

  it('makes the buffer of a point a circle', () => {
    addFeature({ id: 'p', type: 'Point', geometry: { type: 'Point', coordinates: [0, 0] } });

    geometry.buffer(['p'], { distanceMeters: 200 });

    const result = store.getFeature('geo-1');
    expect(result?.type).toBe('Polygon');
    expect(pointInPolygon(getPointAtAngle([0, 0], 190, 45), areaOf(result!))).toBe(true);
    expect(pointInPolygon(getPointAtAngle([0, 0], 210, 45), areaOf(result!))).toBe(false);
  });

  it('makes the result a MultiPolygon for an input with separate parts', () => {
    addFeature({
      id: 'points',
      type: 'MultiPoint',
      geometry: {
        type: 'MultiPoint',
        coordinates: [
          [0, 0],
          [1, 0],
        ],
      },
    });

    geometry.buffer(['points'], { distanceMeters: 100 });

    const result = store.getFeature('geo-1');
    expect(result?.type).toBe('MultiPolygon');
    expect((coordinatesOf(result!) as Coordinate[][][]).length).toBe(2);
  });

  it('allows the number of segments to be specified', () => {
    addFeature({ id: 'p', type: 'Point', geometry: { type: 'Point', coordinates: [0, 0] } });

    geometry.buffer(['p'], { distanceMeters: 100, segments: 8 });

    const result = store.getFeature('geo-1');
    // A circle of 8 segments (9 points with the closing point)
    expect((coordinatesOf(result!) as Coordinate[][])[0]).toHaveLength(9);
  });

  it('normalizes a number of segments that is not usable', () => {
    addFeature({ id: 'p', type: 'Point', geometry: { type: 'Point', coordinates: [0, 0] } });
    addFeature({ id: 'q', type: 'Point', geometry: { type: 'Point', coordinates: [1, 0] } });

    // NaN falls back to the default and Infinity is capped, instead of an empty result or
    // a loop that never ends
    geometry.buffer(['p'], { distanceMeters: 100, segments: Number.NaN });
    geometry.buffer(['q'], { distanceMeters: 100, segments: Number.POSITIVE_INFINITY });

    expect((coordinatesOf(store.getFeature('geo-1')!) as Coordinate[][])[0]).toHaveLength(65);
    expect((coordinatesOf(store.getFeature('geo-2')!) as Coordinate[][])[0]).toHaveLength(1025);
  });

  it('creates nothing for an input out of scope (a buffer reaching a pole)', () => {
    addFeature({ id: 'p', type: 'Point', geometry: { type: 'Point', coordinates: [0, 89.9999] } });
    const listener = vi.fn();
    eventEmitter.on('geometry.applied', listener);

    expect(geometry.buffer(['p'], { distanceMeters: 100 })).toEqual([]);
    expect(store.getFeature('geo-1')).toBeUndefined();
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ status: 'empty' }));
  });

  it('creates a result per input and gathers them into one transaction', () => {
    addLine('a', [
      [0, 0],
      [0.01, 0],
    ]);
    addLine('b', [
      [0, 1],
      [0.01, 1],
    ]);
    store.setSelection('feature', ['a', 'b']);

    const listener = vi.fn();
    store.subscribe(listener);
    const resultIds = geometry.buffer({ distanceMeters: 100 });

    expect(resultIds).toEqual(['geo-1', 'geo-2']);
    // A granularity where one undo removes every result (the subscriber receives a single
    // StateChanges)
    expect(listener).toHaveBeenCalledTimes(1);
    const changes: StateChanges = listener.mock.calls[0][0];
    expect(changes.features?.created?.map((f) => f.id)).toEqual(['geo-1', 'geo-2']);
    expect(changes.features?.deleted).toBeUndefined();
    // The selection moves to every result
    expect(store.getSelection()).toEqual({ type: 'feature', ids: ['geo-1', 'geo-2'] });
    expect(indexedIds()).toEqual(['a', 'b', 'geo-1', 'geo-2']);
  });

  it('does nothing when the distance is 0 or not finite', () => {
    addLine('line', [
      [0, 0],
      [0.01, 0],
    ]);
    store.setSelection('feature', ['line']);

    const listener = vi.fn();
    store.subscribe(listener);

    expect(geometry.buffer({ distanceMeters: 0 })).toEqual([]);
    expect(geometry.buffer({ distanceMeters: Number.NaN })).toEqual([]);
    expect(geometry.buffer({ distanceMeters: Number.POSITIVE_INFINITY })).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
    expect(applied).toEqual([]);
  });

  it('does nothing while readOnly', () => {
    addLine('line', [
      [0, 0],
      [0.01, 0],
    ]);
    store.setSelection('feature', ['line']);
    store.setReadOnly(true);

    expect(geometry.buffer({ distanceMeters: 100 })).toEqual([]);
    expect(indexedIds()).toEqual(['line']);
    expect(applied).toEqual([]);
  });
});

describe('a negative value for draw.geometry.buffer', () => {
  it('shrinks a polygon with a negative buffer', () => {
    // Shrinks a square of 0.01 degrees, about 1113 m, by 100 m
    addSquare('area', [0, 0, 0.01, 0.01]);

    const resultIds = geometry.buffer(['area'], { distanceMeters: -100 });

    expect(resultIds).toEqual(['geo-1']);
    const result = store.getFeature('geo-1');
    // The center remains, and everything within 100 m of the boundary disappears
    expect(pointInPolygon([0.005, 0.005], areaOf(result!))).toBe(true);
    expect(pointInPolygon(getPointAtAngle([0.005, 0], 50, 0), areaOf(result!))).toBe(false);
    expect(store.getFeature('area')).toBeDefined();
  });

  it('skips a negative value applied to a point or a line', () => {
    addFeature({ id: 'p', type: 'Point', geometry: { type: 'Point', coordinates: [0, 0] } });
    addLine('line', [
      [0, 1],
      [0.01, 1],
    ]);
    addSquare('area', [0, 2, 0.01, 2.01]);
    store.setSelection('feature', ['p', 'line', 'area']);

    const resultIds = geometry.buffer({ distanceMeters: -100 });

    // Only the polygon has a result
    expect(resultIds).toEqual(['geo-1']);
    expect(applied[0].inputIds).toEqual(['area']);
    expect(store.getLayer('l1')?.items).toEqual(['p', 'line', 'area', 'geo-1']);
  });

  it('changes nothing and reports status empty when every input was skipped', () => {
    addFeature({ id: 'p', type: 'Point', geometry: { type: 'Point', coordinates: [0, 0] } });
    addLine('line', [
      [0, 1],
      [0.01, 1],
    ]);
    store.setSelection('feature', ['p', 'line']);

    const listener = vi.fn();
    store.subscribe(listener);
    const resultIds = geometry.buffer({ distanceMeters: -100 });

    expect(resultIds).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
    expect(applied).toEqual([
      {
        operation: 'buffer',
        inputIds: ['p', 'line'],
        resultId: null,
        resultIds: [],
        status: 'empty',
      },
    ]);
  });
});

describe('the special case of a Circle for draw.geometry.buffer', () => {
  it('increases radiusMeters while staying a Circle', () => {
    addFeature({
      id: 'circle',
      type: 'Circle',
      geometry: { type: 'Point', coordinates: [0, 0] },
      properties: {
        'maplibre-gl-draw:radiusMeters': 1000,
        'maplibre-gl-draw:radiusHandleAngle': 135,
        name: '円',
      },
      style: { fillColor: '#00ff00' },
    });

    const resultIds = geometry.buffer(['circle'], { distanceMeters: 500 });

    expect(resultIds).toEqual(['geo-1']);
    const result = store.getFeature('geo-1');
    expect(result?.type).toBe('Circle');
    expect(coordinatesOf(result)).toEqual([0, 0]);
    // It keeps the parametric nature (the Circle-specific properties carry over too)
    expect(result?.properties).toEqual({
      'maplibre-gl-draw:radiusMeters': 1500,
      'maplibre-gl-draw:radiusHandleAngle': 135,
      name: '円',
    });
    expect(result?.style).toEqual({ fillColor: '#00ff00' });
  });

  it('decreases radiusMeters for a negative value', () => {
    addFeature({
      id: 'circle',
      type: 'Circle',
      geometry: { type: 'Point', coordinates: [0, 0] },
      properties: { 'maplibre-gl-draw:radiusMeters': 1000 },
    });

    geometry.buffer(['circle'], { distanceMeters: -400 });

    expect(store.getFeature('geo-1')?.properties['maplibre-gl-draw:radiusMeters']).toBe(600);
  });

  it('treats a shrink that takes the radius to 0 or less as empty', () => {
    addFeature({
      id: 'circle',
      type: 'Circle',
      geometry: { type: 'Point', coordinates: [0, 0] },
      properties: { 'maplibre-gl-draw:radiusMeters': 1000 },
    });
    store.setSelection('feature', ['circle']);

    const listener = vi.fn();
    store.subscribe(listener);
    const resultIds = geometry.buffer({ distanceMeters: -1000 });

    expect(resultIds).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
    expect(applied[0].status).toBe('empty');
  });

  it('drops a Circle without a radius from the targets', () => {
    addFeature({
      id: 'circle',
      type: 'Circle',
      geometry: { type: 'Point', coordinates: [0, 0] },
      properties: {},
    });
    store.setSelection('feature', ['circle']);

    expect(geometry.buffer({ distanceMeters: 100 })).toEqual([]);
    expect(applied).toEqual([]);
  });
});

describe('narrowing down the targets of draw.geometry.buffer', () => {
  it('excludes the kinds that are not targets', () => {
    addFeature({
      id: 'freehand',
      type: 'Freehand',
      geometry: {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [0.01, 0],
        ],
      },
    });
    addFeature({ id: 'image', type: 'Image', geometry: { type: 'Point', coordinates: [0, 1] } });
    addLine('line', [
      [0, 2],
      [0.01, 2],
    ]);
    store.setSelection('feature', ['freehand', 'image', 'line']);

    const resultIds = geometry.buffer({ distanceMeters: 100 });

    expect(resultIds).toEqual(['geo-1']);
    expect(applied[0].inputIds).toEqual(['line']);
  });

  it('emits no event either when there is no target', () => {
    addFeature({ id: 'image', type: 'Image', geometry: { type: 'Point', coordinates: [0, 0] } });
    store.setSelection('feature', ['image']);

    expect(geometry.buffer({ distanceMeters: 100 })).toEqual([]);
    expect(applied).toEqual([]);
  });

  it('does nothing when there is no selection', () => {
    addLine('line', [
      [0, 0],
      [0.01, 0],
    ]);

    expect(geometry.buffer({ distanceMeters: 100 })).toEqual([]);
  });

  it('drops a locked or hidden feature from the targets', () => {
    addLine(
      'locked',
      [
        [0, 0],
        [0.01, 0],
      ],
      { locked: true },
    );
    addLine(
      'hidden',
      [
        [0, 1],
        [0.01, 1],
      ],
      { visible: false },
    );
    addLine('local', [
      [0, 2],
      [0.01, 2],
    ]);
    addLine('ok', [
      [0, 3],
      [0.01, 3],
    ]);
    store.setLocallyHidden('local', true);

    const resultIds = geometry.buffer(['locked', 'hidden', 'local', 'ok'], {
      distanceMeters: 100,
    });

    expect(resultIds).toEqual(['geo-1']);
    expect(applied[0].inputIds).toEqual(['ok']);
  });
});

describe('the inheritance and placement of draw.geometry.buffer', () => {
  it('places the result in the same layer as the input, right in front of it', () => {
    addSquare('bottom', [40, 40, 50, 50]);
    addLine('target', [
      [0, 0],
      [0.01, 0],
    ]);
    addSquare('top', [60, 60, 70, 70]);

    geometry.buffer(['target'], { distanceMeters: 100 });

    expect(store.getFeature('geo-1')?.layerId).toBe('l1');
    expect(store.getLayer('l1')?.items).toEqual(['bottom', 'target', 'geo-1', 'top']);
  });

  it('places each result right in front of its own input even with several inputs', () => {
    addLine('a', [
      [0, 0],
      [0.01, 0],
    ]);
    addLine('b', [
      [0, 1],
      [0.01, 1],
    ]);

    geometry.buffer(['a', 'b'], { distanceMeters: 100 });

    expect(store.getLayer('l1')?.items).toEqual(['a', 'geo-1', 'b', 'geo-2']);
  });

  it('puts the result in the same group when the input is a member of a group', () => {
    addLine('target', [
      [0, 0],
      [0.01, 0],
    ]);
    addSquare('other', [40, 40, 50, 50]);
    store.createGroup({
      id: 'g1',
      layerId: 'l1',
      name: 'g1',
      featureIds: ['target', 'other'],
      locked: false,
      visible: true,
    });

    geometry.buffer(['target'], { distanceMeters: 100 });

    expect(store.getFeature('geo-1')?.groupId).toBe('g1');
    expect(store.getGroup('g1')?.featureIds).toEqual(['target', 'geo-1', 'other']);
  });

  it('carries the style and properties over from the input and drops Circle properties', () => {
    addSquare('area', [0, 0, 0.01, 0.01], {
      style: { fillColor: '#ff0000' },
      // A result that fell to a polygon has no notion of a radius, so no Circle-specific
      // property is kept
      properties: {
        name: '面',
        'maplibre-gl-draw:radiusMeters': 500,
        'maplibre-gl-draw:radiusHandleAngle': 90,
      },
    });

    geometry.buffer(['area'], { distanceMeters: 100 });

    const result = store.getFeature('geo-1');
    expect(result?.style).toEqual({ fillColor: '#ff0000' });
    expect(result?.properties).toEqual({ name: '面' });
  });

  it('reports the input and result IDs paired up in the applied event', () => {
    addLine('a', [
      [0, 0],
      [0.01, 0],
    ]);
    addLine('b', [
      [0, 1],
      [0.01, 1],
    ]);
    store.setSelection('feature', ['b', 'a']);

    geometry.buffer({ distanceMeters: 100 });

    expect(applied).toEqual([
      {
        operation: 'buffer',
        // inputIds is in stacking order (the last one is the foremost). resultIds[i] is
        // the result of inputIds[i]
        inputIds: ['a', 'b'],
        resultId: 'geo-1',
        resultIds: ['geo-1', 'geo-2'],
        status: 'applied',
      },
    ]);
  });
});

describe('draw.geometry.split', () => {
  it('splits the polygon in two and replaces it, from the selected polygon and line', () => {
    addSquare('area', [0, 0, 10, 10]);
    addLine('cut', [
      [-1, 5],
      [11, 5],
    ]);
    store.setSelection('feature', ['area', 'cut']);

    const resultIds = geometry.split();

    expect(resultIds).toEqual(['geo-1', 'geo-2']);
    // The original polygon disappears, and the cutting line remains
    expect(store.getFeature('area')).toBeUndefined();
    expect(store.getFeature('cut')).toBeDefined();

    const first = store.getFeature('geo-1');
    const second = store.getFeature('geo-2');
    expect(first?.type).toBe('Polygon');
    expect(second?.type).toBe('Polygon');
    // It is split into an upper and a lower part (which comes first follows the traversal
    // order of the geometry module)
    const lower = [first, second].filter((f) => pointInPolygon([5, 2], areaOf(f!)));
    const upper = [first, second].filter((f) => pointInPolygon([5, 8], areaOf(f!)));
    expect(lower).toHaveLength(1);
    expect(upper).toHaveLength(1);
    expect(lower[0]?.id).not.toBe(upper[0]?.id);
  });

  it('splits with the given polygon and line regardless of selection when IDs are given', () => {
    addSquare('area', [0, 0, 10, 10]);
    addLine('cut', [
      [-1, 5],
      [11, 5],
    ]);
    addSquare('other', [40, 40, 50, 50]);
    store.setSelection('feature', ['other']);

    const resultIds = geometry.split('area', 'cut');

    expect(resultIds).toHaveLength(2);
    expect(store.getFeature('other')).toBeDefined();
  });

  it('gathers deleting the input and creating the results into one transaction', () => {
    addSquare('area', [0, 0, 10, 10]);
    addLine('cut', [
      [-1, 5],
      [11, 5],
    ]);
    store.setSelection('feature', ['area', 'cut']);

    const listener = vi.fn();
    store.subscribe(listener);
    geometry.split();

    expect(listener).toHaveBeenCalledTimes(1);
    const changes: StateChanges = listener.mock.calls[0][0];
    expect(changes.features?.created?.map((f) => f.id)).toEqual(['geo-1', 'geo-2']);
    expect(changes.features?.deleted?.map((f) => f.id)).toEqual(['area']);
  });

  it('removes the original polygon from the spatial index and adds the results', () => {
    addSquare('area', [0, 0, 10, 10]);
    addLine('cut', [
      [-1, 5],
      [11, 5],
    ]);

    geometry.split('area', 'cut');

    expect(indexedIds()).toEqual(['cut', 'geo-1', 'geo-2']);
  });

  it('moves the selection to the result features', () => {
    addSquare('area', [0, 0, 10, 10]);
    addLine('cut', [
      [-1, 5],
      [11, 5],
    ]);
    store.setSelection('feature', ['area', 'cut']);

    geometry.split();

    expect(store.getSelection()).toEqual({ type: 'feature', ids: ['geo-1', 'geo-2'] });
  });

  it('places the results where the original was, keeping the order, style and properties', () => {
    addSquare('bottom', [40, 40, 50, 50]);
    addSquare('area', [0, 0, 10, 10], {
      style: { fillColor: '#ff0000' },
      properties: { name: '区画', 'maplibre-gl-draw:radiusMeters': 500 },
    });
    addSquare('top', [60, 60, 70, 70]);
    addLine('cut', [
      [-1, 5],
      [11, 5],
    ]);

    geometry.split('area', 'cut');

    expect(store.getLayer('l1')?.items).toEqual(['bottom', 'geo-1', 'geo-2', 'top', 'cut']);
    for (const id of ['geo-1', 'geo-2']) {
      expect(store.getFeature(id)?.style).toEqual({ fillColor: '#ff0000' });
      // No Circle-specific property is kept in a result that fell to a polygon
      expect(store.getFeature(id)?.properties).toEqual({ name: '区画' });
    }
  });

  it('puts the results in the same group when the original polygon is a member of a group', () => {
    addSquare('area', [0, 0, 10, 10]);
    addSquare('other', [40, 40, 50, 50]);
    addLine('cut', [
      [-1, 5],
      [11, 5],
    ]);
    store.createGroup({
      id: 'g1',
      layerId: 'l1',
      name: 'g1',
      featureIds: ['area', 'other'],
      locked: false,
      visible: true,
    });

    geometry.split('area', 'cut');

    expect(store.getFeature('geo-1')?.groupId).toBe('g1');
    expect(store.getGroup('g1')?.featureIds).toEqual(['geo-1', 'geo-2', 'other']);
  });

  it('leaves the hole in one of the parts when a polygon with a hole is cut', () => {
    addFeature({
      id: 'donut',
      type: 'Polygon',
      geometry: { type: 'Polygon', coordinates: [...square(0, 0, 10, 10), ...square(4, 4, 6, 6)] },
    });
    addLine('cut', [
      [-1, 9],
      [11, 9],
    ]);

    const resultIds = geometry.split('donut', 'cut');

    expect(resultIds).toHaveLength(2);
    const rings = resultIds.map(
      (id) => (coordinatesOf(store.getFeature(id)!) as Coordinate[][]).length,
    );
    expect(rings.sort()).toEqual([1, 2]);
  });

  it('keeps the uncut part as one feature too when only one part of a MultiPolygon is cut', () => {
    addFeature({
      id: 'islands',
      type: 'MultiPolygon',
      geometry: {
        type: 'MultiPolygon',
        coordinates: [square(0, 0, 10, 10), square(20, 0, 30, 10)],
      },
    });
    addLine('cut', [
      [-1, 5],
      [11, 5],
    ]);

    const resultIds = geometry.split('islands', 'cut');

    expect(resultIds).toHaveLength(3);
    expect(store.getFeature('islands')).toBeUndefined();
  });

  it('splits into three or more parts for a line that crosses several times', () => {
    addSquare('area', [0, 0, 10, 10]);
    addLine('cut', [
      [-1, 3],
      [11, 3],
      [11, 7],
      [-1, 7],
    ]);

    expect(geometry.split('area', 'cut')).toHaveLength(3);
  });

  it('cuts with a MultiLineString one line at a time, in order', () => {
    addSquare('area', [0, 0, 10, 10]);
    addFeature({
      id: 'cut',
      type: 'MultiLineString',
      geometry: {
        type: 'MultiLineString',
        coordinates: [
          [
            [-1, 5],
            [11, 5],
          ],
          [
            [5, -1],
            [5, 11],
          ],
        ],
      },
    });

    expect(geometry.split('area', 'cut')).toHaveLength(4);
  });

  it('cuts a Circle as a polygon as well', () => {
    addFeature({
      id: 'circle',
      type: 'Circle',
      geometry: { type: 'Point', coordinates: [0, 0] },
      properties: { 'maplibre-gl-draw:radiusMeters': 1000 },
    });
    addLine('cut', [
      [-1, 0],
      [1, 0],
    ]);

    const resultIds = geometry.split('circle', 'cut');

    expect(resultIds).toHaveLength(2);
    // It falls to a polygon, so the radius is lost
    expect(store.getFeature(resultIds[0])?.type).toBe('Polygon');
    expect(store.getFeature(resultIds[0])?.properties).toEqual({});
  });

  it('changes nothing and reports an empty result for a line that does not cut through', () => {
    addSquare('area', [0, 0, 10, 10]);
    addLine('cut', [
      [-1, 5],
      [5, 5],
    ]);
    store.setSelection('feature', ['area', 'cut']);

    const listener = vi.fn();
    store.subscribe(listener);

    expect(geometry.split()).toEqual([]);
    expect(store.getFeature('area')).toBeDefined();
    expect(listener).not.toHaveBeenCalled();
    expect(applied).toEqual([
      {
        operation: 'split',
        inputIds: ['area', 'cut'],
        resultId: null,
        resultIds: [],
        status: 'empty',
      },
    ]);
  });

  it('reports the IDs of the polygon and the line and the results in the applied event', () => {
    addSquare('area', [0, 0, 10, 10]);
    addLine('cut', [
      [-1, 5],
      [11, 5],
    ]);

    geometry.split('area', 'cut');

    expect(applied).toEqual([
      {
        operation: 'split',
        inputIds: ['area', 'cut'],
        resultId: 'geo-1',
        resultIds: ['geo-1', 'geo-2'],
        status: 'applied',
      },
    ]);
  });

  it('does nothing when the polygon or the line does not resolve to exactly one', () => {
    addSquare('a', [0, 0, 10, 10]);
    addSquare('b', [20, 0, 30, 10]);
    addLine('cut', [
      [-1, 5],
      [31, 5],
    ]);

    // Two polygons
    store.setSelection('feature', ['a', 'b', 'cut']);
    expect(geometry.split()).toEqual([]);

    // No line
    store.setSelection('feature', ['a']);
    expect(geometry.split()).toEqual([]);

    // Nothing is selected
    store.setSelection('feature', []);
    expect(geometry.split()).toEqual([]);

    expect(applied).toEqual([]);
    expect(store.getFeature('a')).toBeDefined();
  });

  it('drops a locked or hidden feature from the targets', () => {
    addSquare('area', [0, 0, 10, 10], { locked: true });
    addLine('cut', [
      [-1, 5],
      [11, 5],
    ]);

    expect(geometry.split('area', 'cut')).toEqual([]);

    store.updateFeature('area', { locked: false });
    store.setLocallyHidden('area', true);
    expect(geometry.split('area', 'cut')).toEqual([]);

    store.setLocallyHidden('area', false);
    expect(geometry.split('area', 'cut')).toHaveLength(2);
  });

  it('does nothing even when something other than a polygon or a line is given', () => {
    addSquare('area', [0, 0, 10, 10]);
    addFeature({ id: 'point', type: 'Point', geometry: { type: 'Point', coordinates: [5, 5] } });
    addLine('cut', [
      [-1, 5],
      [11, 5],
    ]);

    expect(geometry.split('point', 'cut')).toEqual([]);
    expect(geometry.split('area', 'point')).toEqual([]);
    expect(store.getFeature('area')).toBeDefined();
  });

  it('does nothing while readOnly', () => {
    addSquare('area', [0, 0, 10, 10]);
    addLine('cut', [
      [-1, 5],
      [11, 5],
    ]);
    store.setReadOnly(true);

    expect(geometry.split('area', 'cut')).toEqual([]);
    expect(store.getFeature('area')).toBeDefined();
    expect(indexedIds()).toEqual(['area', 'cut']);
    expect(applied).toEqual([]);
  });
});
