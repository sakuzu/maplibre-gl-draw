// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { Coordinate, Feature } from '../store/types.js';
import type { BoundingBoxCoords } from '../view/ui/selection-ui/index.js';
import { createSelectionExtensionRegistry } from '../view/ui/selection-ui/index.js';
import { computeRotation, getRotationDelta, startRotation } from './rotate.js';

/**
 * The latitude whose Mercator y equals a distance given in degrees of longitude
 *
 * The rotation happens in Web Mercator, so a point rotated from the east onto the meridian of
 * the center lands at the latitude whose Mercator y matches its former longitude offset.
 */
function latAtMercatorDegrees(degrees: number): number {
  const y = (degrees * Math.PI) / 180;
  return ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;
}

/** The Mercator y of a latitude, in degrees of longitude */
function mercatorDegrees(lat: number): number {
  return (Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * 180) / Math.PI;
}

/**
 * Creates a feature for the tests with the minimum set of fields
 */
function createFeature(
  overrides: Partial<Feature> & { id: string; type: string; coordinates: Feature['coordinates'] },
): Feature {
  return {
    layerId: 'layer-1',
    properties: {},
    locked: false,
    visible: true,
    ...overrides,
  } as Feature;
}

/**
 * Creates BoundingBoxCoords for the tests
 */
function createBBox(center: Coordinate): BoundingBoxCoords {
  return {
    topLeft: [center[0] - 1, center[1] + 1],
    topRight: [center[0] + 1, center[1] + 1],
    bottomRight: [center[0] + 1, center[1] - 1],
    bottomLeft: [center[0] - 1, center[1] - 1],
    center,
  };
}

describe('startRotation', () => {
  it('creates a state with the correct center, startAngle, initialCoordinates and initialRotations', () => {
    const center: Coordinate = [0, 0];
    const bbox = createBBox(center);
    const startLngLat = { lng: 1, lat: 0 };

    const feature = createFeature({
      id: 'f1',
      type: 'LineString',
      coordinates: [
        [1, 0],
        [2, 0],
      ] as Coordinate[],
    });

    const state = startRotation(startLngLat, bbox, [feature]);

    expect(state.center).toEqual(center);
    expect(state.startLngLat).toEqual(startLngLat);
    // center=[0,0], point={lng:1, lat:0} => dx=1*cos(0)=1, dy=0 => atan2(0,1)=0
    expect(state.startAngle).toBeCloseTo(0);
    expect(state.initialCoordinates.get('f1')).toEqual([
      [1, 0],
      [2, 0],
    ]);
    // A LineString has no rotation property, so initialRotations is empty
    expect(state.initialRotations.size).toBe(0);
  });

  it('stores the initial rotation angle for a feature that has a rotation property', () => {
    const center: Coordinate = [0, 0];
    const bbox = createBBox(center);
    const startLngLat = { lng: 1, lat: 0 };

    const imageFeature = createFeature({
      id: 'img1',
      type: 'Image',
      coordinates: [0, 0] as Coordinate,
      properties: {
        imageFileId: 'file1',
        imageWidth: 100,
        imageHeight: 100,
        createdZoom: 10,
        rotation: 45,
      },
    });

    const state = startRotation(startLngLat, bbox, [imageFeature]);

    expect(state.initialRotations.get('img1')).toBe(45);
  });

  it('stores an initial rotation of 0 for an Image feature whose rotation is not set', () => {
    const center: Coordinate = [0, 0];
    const bbox = createBBox(center);
    const startLngLat = { lng: 1, lat: 0 };

    const imageFeature = createFeature({
      id: 'img1',
      type: 'Image',
      coordinates: [0, 0] as Coordinate,
      properties: {
        imageFileId: 'file1',
        imageWidth: 100,
        imageHeight: 100,
        createdZoom: 10,
      },
    });

    const state = startRotation(startLngLat, bbox, [imageFeature]);

    expect(state.initialRotations.get('img1')).toBe(0);
  });

  it('creates a deep copy of the coordinates (it holds no reference to the original coordinates)', () => {
    const center: Coordinate = [0, 0];
    const bbox = createBBox(center);
    const coords: Coordinate[] = [
      [1, 0],
      [2, 0],
    ];
    const feature = createFeature({
      id: 'f1',
      type: 'LineString',
      coordinates: coords,
    });

    const state = startRotation({ lng: 1, lat: 0 }, bbox, [feature]);

    // Changing the original coordinates has no effect on initialCoordinates
    coords[0][0] = 999;
    const stored = state.initialCoordinates.get('f1') as Coordinate[];
    expect(stored[0][0]).toBe(1);
  });
});

describe('computeRotation', () => {
  it('LineString: rotates the coordinates around the center', () => {
    // Tested on the equator
    const center: Coordinate = [0, 0];
    const bbox = createBBox(center);
    const startLngLat = { lng: 1, lat: 0 };

    const feature = createFeature({
      id: 'f1',
      type: 'LineString',
      coordinates: [
        [1, 0],
        [2, 0],
      ] as Coordinate[],
    });

    const state = startRotation(startLngLat, bbox, [feature]);

    // A 90 degree rotation: startAngle=0, so currentAngle is set to become pi/2
    // center=[0,0], currentLngLat={lng:0, lat:1} => dx=0, dy=1 => atan2(1,0)=π/2
    const currentLngLat = { lng: 0, lat: 1 };
    const result = computeRotation(state, currentLngLat, [feature]);

    const rotated = result.get('f1');
    expect(rotated).toBeDefined();
    const coords = rotated!.coordinates as Coordinate[];

    // [1,0] rotated by 90 degrees => [0, about 1] (1 degree of Mercator y)
    expect(coords[0][0]).toBeCloseTo(0, 9);
    expect(coords[0][1]).toBeCloseTo(latAtMercatorDegrees(1), 9);

    // [2,0] rotated by 90 degrees => [0, about 2]
    expect(coords[1][0]).toBeCloseTo(0, 9);
    expect(coords[1][1]).toBeCloseTo(latAtMercatorDegrees(2), 9);

    // A LineString has no rotation property
    expect(rotated!.rotation).toBeUndefined();
  });

  it('a single Image feature: the coordinates are not changed and only the rotation property is updated', () => {
    const center: Coordinate = [0, 0];
    const bbox = createBBox(center);
    const startLngLat = { lng: 1, lat: 0 };

    const imageFeature = createFeature({
      id: 'img1',
      type: 'Image',
      coordinates: [5, 5] as Coordinate,
      properties: {
        imageFileId: 'file1',
        imageWidth: 100,
        imageHeight: 100,
        createdZoom: 10,
        rotation: 10,
      },
    });

    const state = startRotation(startLngLat, bbox, [imageFeature]);

    // A 90 degree rotation
    const currentLngLat = { lng: 0, lat: 1 };
    const result = computeRotation(state, currentLngLat, [imageFeature]);

    const rotated = result.get('img1');
    expect(rotated).toBeDefined();

    // The coordinates of an Image in a single selection do not change
    expect(rotated!.coordinates).toEqual([5, 5]);

    // rotation = initialRotation(10) + deltaAngleDeg(90) = 100
    expect(rotated!.rotation).toBeCloseTo(100, 5);
  });

  it('several features (an Image and a LineString): both the coordinates and the rotation of the Image are changed', () => {
    const center: Coordinate = [0, 0];
    const bbox = createBBox(center);
    const startLngLat = { lng: 1, lat: 0 };

    const imageFeature = createFeature({
      id: 'img1',
      type: 'Image',
      coordinates: [1, 0] as Coordinate,
      properties: {
        imageFileId: 'file1',
        imageWidth: 100,
        imageHeight: 100,
        createdZoom: 10,
        rotation: 0,
      },
    });

    const lineFeature = createFeature({
      id: 'line1',
      type: 'LineString',
      coordinates: [
        [2, 0],
        [3, 0],
      ] as Coordinate[],
    });

    const state = startRotation(startLngLat, bbox, [imageFeature, lineFeature]);

    // A 90 degree rotation
    const currentLngLat = { lng: 0, lat: 1 };
    const result = computeRotation(state, currentLngLat, [imageFeature, lineFeature]);

    // The Image feature: it is a multiple selection, so the coordinates rotate too
    const imgResult = result.get('img1');
    expect(imgResult).toBeDefined();
    const imgCoords = imgResult!.coordinates as Coordinate;
    expect(imgCoords[0]).toBeCloseTo(0, 9);
    expect(imgCoords[1]).toBeCloseTo(latAtMercatorDegrees(1), 9);
    expect(imgResult!.rotation).toBeCloseTo(90, 5);

    // The LineString feature: the coordinates rotate
    const lineResult = result.get('line1');
    expect(lineResult).toBeDefined();
    const lineCoords = lineResult!.coordinates as Coordinate[];
    expect(lineCoords[0][0]).toBeCloseTo(0, 9);
    expect(lineCoords[0][1]).toBeCloseTo(latAtMercatorDegrees(2), 9);
    expect(lineResult!.rotation).toBeUndefined();
  });

  it('a 0 degree rotation: the coordinates do not change', () => {
    const center: Coordinate = [0, 0];
    const bbox = createBBox(center);
    const startLngLat = { lng: 1, lat: 0 };

    const feature = createFeature({
      id: 'f1',
      type: 'LineString',
      coordinates: [
        [1, 2],
        [3, 4],
      ] as Coordinate[],
    });

    const state = startRotation(startLngLat, bbox, [feature]);

    // The same position as the start => deltaAngle=0
    const currentLngLat = { lng: 1, lat: 0 };
    const result = computeRotation(state, currentLngLat, [feature]);

    const rotated = result.get('f1');
    expect(rotated).toBeDefined();
    const coords = rotated!.coordinates as Coordinate[];
    expect(coords[0][0]).toBeCloseTo(1, 5);
    expect(coords[0][1]).toBeCloseTo(2, 5);
    expect(coords[1][0]).toBeCloseTo(3, 5);
    expect(coords[1][1]).toBeCloseTo(4, 5);
  });

  it('rotates a Polygon (a nested array of coordinates) correctly', () => {
    const center: Coordinate = [0, 0];
    const bbox = createBBox(center);
    const startLngLat = { lng: 1, lat: 0 };

    const feature = createFeature({
      id: 'poly1',
      type: 'Polygon',
      coordinates: [
        [
          [1, 0],
          [0, 1],
          [-1, 0],
        ],
      ] as Coordinate[][],
    });

    const state = startRotation(startLngLat, bbox, [feature]);

    // A 90 degree rotation
    const currentLngLat = { lng: 0, lat: 1 };
    const result = computeRotation(state, currentLngLat, [feature]);

    const rotated = result.get('poly1');
    expect(rotated).toBeDefined();
    const coords = rotated!.coordinates as Coordinate[][];
    // [1,0] => [0, about 1]
    expect(coords[0][0][0]).toBeCloseTo(0, 9);
    expect(coords[0][0][1]).toBeCloseTo(latAtMercatorDegrees(1), 9);
    // [0,1] => [about -1, 0]
    expect(coords[0][1][0]).toBeCloseTo(-mercatorDegrees(1), 9);
    expect(coords[0][1][1]).toBeCloseTo(0, 9);
    // [-1,0] => [0, about -1]
    expect(coords[0][2][0]).toBeCloseTo(0, 9);
    expect(coords[0][2][1]).toBeCloseTo(latAtMercatorDegrees(-1), 9);
  });

  it('rotates in Web Mercator at a non-zero latitude, as the map shows it', () => {
    // Tested at a latitude of 45 degrees
    const center: Coordinate = [0, 45];
    const bbox = createBBox(center);

    // startLngLat is set to the east of the center
    const startLngLat = { lng: 1, lat: 45 };

    const feature = createFeature({
      id: 'f1',
      type: 'LineString',
      coordinates: [[1, 45]] as Coordinate[],
    });

    const state = startRotation(startLngLat, bbox, [feature]);
    expect(state.startAngle).toBeCloseTo(0, 9);

    // Due north of the center is a rotation of 90 degrees
    const result = computeRotation(state, { lng: 0, lat: 46 }, [feature]);
    const coords = result.get('f1')!.coordinates as Coordinate[];

    // [1, 45] lands on the meridian of the center, 1 degree of Mercator y north of it
    expect(coords[0][0]).toBeCloseTo(0, 9);
    expect(coords[0][1]).toBeCloseTo(latAtMercatorDegrees(mercatorDegrees(45) + 1), 9);
  });

  it('keeps the shape of a large feature on the map', () => {
    const center: Coordinate = [10, 60];
    const bbox = createBBox(center);
    const square = [
      [5, 57],
      [15, 57],
      [15, 63],
      [5, 63],
    ] as Coordinate[];
    const feature = createFeature({ id: 'sq', type: 'LineString', coordinates: square });

    /** The side lengths and diagonals as the map shows them (in Mercator) */
    const shape = (coords: Coordinate[]) => {
      const plane = coords.map(([lng, lat]) => [lng, mercatorDegrees(lat)]);
      const lengths: number[] = [];
      for (let i = 0; i < plane.length; i++) {
        for (let j = i + 1; j < plane.length; j++) {
          lengths.push(Math.hypot(plane[i][0] - plane[j][0], plane[i][1] - plane[j][1]));
        }
      }
      return lengths;
    };

    // A rotation of 60 degrees
    const state = startRotation({ lng: 20, lat: 60 }, bbox, [feature]);
    const cy = mercatorDegrees(60);
    const target = {
      lng: 10 + 10 * Math.cos(Math.PI / 3),
      lat: latAtMercatorDegrees(cy + 10 * Math.sin(Math.PI / 3)),
    };
    const rotated = computeRotation(state, target, [feature]).get('sq')!
      .coordinates as Coordinate[];

    const before = shape(square);
    const after = shape(rotated);
    before.forEach((length, i) => {
      expect(after[i]).toBeCloseTo(length, 9);
    });
  });

  it('rotates a feature at a pole without producing NaN', () => {
    const center: Coordinate = [0, 89];
    const bbox = createBBox(center);
    const feature = createFeature({
      id: 'p',
      type: 'LineString',
      coordinates: [
        [1, 90],
        [2, -90],
      ] as Coordinate[],
    });
    const state = startRotation({ lng: 1, lat: 90 }, bbox, [feature]);
    const result = computeRotation(state, { lng: -1, lat: 90 }, [feature]);
    for (const [lng, lat] of result.get('p')!.coordinates as Coordinate[]) {
      expect(Number.isFinite(lng)).toBe(true);
      expect(Number.isFinite(lat)).toBe(true);
    }
  });

  it('skips a feature that is not in initialCoordinates', () => {
    const center: Coordinate = [0, 0];
    const bbox = createBBox(center);
    const startLngLat = { lng: 1, lat: 0 };

    const feature1 = createFeature({
      id: 'f1',
      type: 'LineString',
      coordinates: [[1, 0]] as Coordinate[],
    });

    const state = startRotation(startLngLat, bbox, [feature1]);

    // Add a feature that is not contained in the state
    const feature2 = createFeature({
      id: 'f2',
      type: 'LineString',
      coordinates: [[2, 0]] as Coordinate[],
    });

    const result = computeRotation(state, { lng: 0, lat: 1 }, [feature1, feature2]);

    expect(result.has('f1')).toBe(true);
    expect(result.has('f2')).toBe(false);
  });
});

describe('getRotationDelta', () => {
  it('returns the difference between the angle at the start and the current angle in radians', () => {
    const center: Coordinate = [0, 0];
    const bbox = createBBox(center);
    const startLngLat = { lng: 1, lat: 0 };

    const feature = createFeature({
      id: 'f1',
      type: 'LineString',
      coordinates: [[1, 0]] as Coordinate[],
    });

    const state = startRotation(startLngLat, bbox, [feature]);

    // center=[0,0] => startAngle = atan2(0, 1) = 0
    // currentAngle = atan2(1, 0) = π/2
    const delta = getRotationDelta(state, { lng: 0, lat: 1 });
    expect(delta).toBeCloseTo(Math.PI / 2, 5);
  });

  it('returns a negative value for a rotation in the reverse direction', () => {
    const center: Coordinate = [0, 0];
    const bbox = createBBox(center);
    const startLngLat = { lng: 0, lat: 1 };

    const feature = createFeature({
      id: 'f1',
      type: 'LineString',
      coordinates: [[1, 0]] as Coordinate[],
    });

    const state = startRotation(startLngLat, bbox, [feature]);

    // startAngle = atan2(1, 0) = π/2
    // currentAngle = atan2(0, 1) = 0
    // delta = 0 - π/2 = -π/2
    const delta = getRotationDelta(state, { lng: 1, lat: 0 });
    expect(delta).toBeCloseTo(-Math.PI / 2, 5);
  });

  it('returns 0 for the same position', () => {
    const center: Coordinate = [0, 0];
    const bbox = createBBox(center);
    const startLngLat = { lng: 1, lat: 1 };

    const feature = createFeature({
      id: 'f1',
      type: 'LineString',
      coordinates: [[1, 0]] as Coordinate[],
    });

    const state = startRotation(startLngLat, bbox, [feature]);

    const delta = getRotationDelta(state, { lng: 1, lat: 1 });
    expect(delta).toBeCloseTo(0, 5);
  });
});

describe('custom types registered with the scale strategy', () => {
  it('rotate through the rotation property of the draw instance that registered them', () => {
    const extensions = createSelectionExtensionRegistry();
    extensions.registerResizeStrategy('CustomWidget', 'scale');

    const center: Coordinate = [0, 0];
    const bbox = createBBox(center);
    const startLngLat = { lng: 1, lat: 0 };

    // No rotation property yet: the registration alone makes it rotate by property
    const customFeature = createFeature({
      id: 'cw1',
      type: 'CustomWidget',
      coordinates: [1, 0] as Coordinate,
      properties: {},
    });

    const state = startRotation(startLngLat, bbox, [customFeature], extensions);
    expect(state.initialRotations.get('cw1')).toBe(0);

    // For a single selection the coordinates are not changed and only rotation is updated
    const currentLngLat = { lng: 0, lat: 1 };
    const result = computeRotation(state, currentLngLat, [customFeature]);
    const rotated = result.get('cw1');
    expect(rotated).toBeDefined();
    expect(rotated!.coordinates).toEqual([1, 0]);
    expect(rotated!.rotation).toBeCloseTo(90, 5);
  });

  it('do not rotate by property in another draw instance that did not register them', () => {
    const registering = createSelectionExtensionRegistry();
    registering.registerResizeStrategy('CustomWidget', 'scale');
    const other = createSelectionExtensionRegistry();

    const feature = createFeature({
      id: 'cw2',
      type: 'CustomWidget',
      coordinates: [1, 0] as Coordinate,
      properties: {},
    });
    const state = startRotation({ lng: 1, lat: 0 }, createBBox([0, 0]), [feature], other);

    expect(state.initialRotations.has('cw2')).toBe(false);
  });

  it('also treats an unregistered type with rotation in properties as supporting rotation', () => {
    const center: Coordinate = [0, 0];
    const bbox = createBBox(center);
    const startLngLat = { lng: 1, lat: 0 };

    const feature = createFeature({
      id: 'unregistered1',
      type: 'UnregisteredType',
      coordinates: [1, 0] as Coordinate,
      properties: { rotation: 15 },
    });

    const state = startRotation(startLngLat, bbox, [feature]);

    expect(state.initialRotations.get('unregistered1')).toBe(15);
  });

  it('treats an unregistered type without rotation in properties as not supporting rotation', () => {
    const center: Coordinate = [0, 0];
    const bbox = createBBox(center);
    const startLngLat = { lng: 1, lat: 0 };

    const feature = createFeature({
      id: 'plain1',
      type: 'SomeOtherType',
      coordinates: [[1, 0]] as Coordinate[],
      properties: {},
    });

    const state = startRotation(startLngLat, bbox, [feature]);

    expect(state.initialRotations.has('plain1')).toBe(false);
  });
});

describe('computeRotation on the Multi variants (preservation of the part structure)', () => {
  it('rotates every part and every ring of a MultiPolygon and keeps the nested structure', () => {
    const center: Coordinate = [0, 0];
    const bbox = createBBox(center);
    // The start angle is 0 degrees and the current angle is 90 degrees -> a 90 degree
    // counter-clockwise rotation
    const startLngLat = { lng: 1, lat: 0 };

    const feature = createFeature({
      id: 'mpoly',
      type: 'MultiPolygon',
      coordinates: [
        [
          [
            [1, 0],
            [2, 0],
          ],
        ],
        [
          [
            [0, 1],
            [0, 2],
          ],
        ],
      ] as Coordinate[][][],
    });

    const state = startRotation(startLngLat, bbox, [feature]);
    const result = computeRotation(state, { lng: 0, lat: 1 }, [feature]);
    const coords = result.get('mpoly')?.coordinates as number[][][][];

    // The nested structure (2 parts / 1 ring / 2 vertices) is kept
    expect(coords).toHaveLength(2);
    expect(coords[0]).toHaveLength(1);
    expect(coords[0][0]).toHaveLength(2);

    // A 90 degree rotation takes [1,0] near [0,1], and [0,1] near [-1,0] (in Mercator)
    expect(coords[0][0][0][0]).toBeCloseTo(0, 9);
    expect(coords[0][0][0][1]).toBeCloseTo(latAtMercatorDegrees(1), 9);
    expect(coords[1][0][0][0]).toBeCloseTo(-mercatorDegrees(1), 9);
    expect(coords[1][0][0][1]).toBeCloseTo(0, 9);
  });
});
