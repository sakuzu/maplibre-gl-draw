// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the built-in computation of moves, rotations and scalings, on arrays
 *
 * - A move keeps the offsets in meters, east and north, from `from` at `to`; it is not the
 *   difference of the longitudes and latitudes added (they differ at a high latitude)
 * - A rotation turns counterclockwise seen from above and leaves the center where it is; the
 *   rotations and the directions of the features follow the rules of the contract
 * - A scaling multiplies the distances on the ground; a factor of 1 changes nothing; a feature
 *   that keeps its shape moves by `sizeFactor`; the sizes follow the rules of the contract
 * - The heights and the measures are copied
 * - The features give the same results in any parts and in any order
 * - Every finite operation whose factors are above 0 is computed, near the poles and across the
 *   ±180 degree meridian too, and from 0.000001 to 1,000,000 alike
 * - Over a few hundred meters it gives nearly what the plane computations of the select mode
 *   give, and over a few hundred kilometers it does not
 */

import { describe, expect, it } from 'vitest';
import { computeResize, startResize } from '../../operations/resize.js';
import { computeRotation, startRotation } from '../../operations/rotate.js';
import type { Feature } from '../../store/types.js';
import type { BoundingBoxCoords } from '../../view/ui/selection-ui/index.js';
import type { TransformInput, TransformOperation, TransformOutput } from '../types/model.js';
import {
  acceptsBuiltInTransform,
  applyBuiltInTransform,
  createBuiltInTransform,
} from './enu-transform.js';
import { fromPlane, toPlane } from './mercator-plane.js';

// ----------------------------------------------------------------------------
// The arrays of an operation
// ----------------------------------------------------------------------------

/** One feature given to the computation */
interface TestFeature {
  readonly positions: readonly (readonly number[])[];
  readonly rotation?: number;
  readonly bearing?: number;
  readonly size?: number;
  readonly uniform?: boolean;
}

/** The values of the features after an operation */
interface TestResult {
  readonly positions: number[][][];
  readonly rotation: Float64Array | null;
  readonly bearing: Float64Array | null;
  readonly size: Float64Array | null;
}

/** The input of the features, `valuesPerPosition` numbers a position */
function inputOf(features: readonly TestFeature[], valuesPerPosition = 2): TransformInput {
  const starts = new Int32Array(features.length + 1);
  const numbers: number[] = [];
  features.forEach((feature, i) => {
    starts[i + 1] = (starts[i] as number) + feature.positions.length;
    for (const position of feature.positions) {
      for (let k = 0; k < valuesPerPosition; k++) numbers.push(position[k] as number);
    }
  });
  const column = (read: (feature: TestFeature) => number | undefined): Float64Array | null =>
    features.some((feature) => read(feature) !== undefined)
      ? Float64Array.from(features, (feature) => read(feature) ?? Number.NaN)
      : null;
  return {
    operationId: 7,
    featureCount: features.length,
    coordinates: Float64Array.from(numbers),
    valuesPerPosition,
    positionStarts: starts,
    rotationDegrees: column((feature) => feature.rotation),
    bearingDegrees: column((feature) => feature.bearing),
    size: column((feature) => feature.size),
    isScaledUniformly: features.some((feature) => feature.uniform)
      ? Uint8Array.from(features, (feature) => (feature.uniform ? 1 : 0))
      : null,
  };
}

/** Arrays of the lengths of those of the input, to be written */
function outputFor(input: TransformInput): TransformOutput {
  const like = (array: Float64Array | null) => (array ? new Float64Array(array.length) : null);
  return {
    coordinates: new Float64Array(input.coordinates.length),
    rotationDegrees: like(input.rotationDegrees),
    bearingDegrees: like(input.bearingDegrees),
    size: like(input.size),
  };
}

/** The positions of each feature in the coordinates of an output */
function positionsOf(input: TransformInput, coordinates: Float64Array): number[][][] {
  const stride = input.valuesPerPosition;
  const out: number[][][] = [];
  for (let i = 0; i < input.featureCount; i++) {
    const feature: number[][] = [];
    for (
      let p = input.positionStarts[i] as number;
      p < (input.positionStarts[i + 1] as number);
      p++
    ) {
      feature.push(Array.from(coordinates.subarray(p * stride, (p + 1) * stride)));
    }
    out.push(feature);
  }
  return out;
}

/** Computes an operation for the features */
function run(
  operation: TransformOperation,
  features: readonly TestFeature[],
  valuesPerPosition = 2,
): TestResult {
  expect(acceptsBuiltInTransform(operation)).toBe(true);
  const input = inputOf(features, valuesPerPosition);
  const output = outputFor(input);
  applyBuiltInTransform(operation, input, output);
  return {
    positions: positionsOf(input, output.coordinates),
    rotation: output.rotationDegrees,
    bearing: output.bearingDegrees,
    size: output.size,
  };
}

/** The positions of a single feature after an operation */
function moved(operation: TransformOperation, positions: readonly (readonly number[])[]) {
  return run(operation, [{ positions }]).positions[0] as number[][];
}

// ----------------------------------------------------------------------------
// The east and the north on the ellipsoid, written here again to check against
// ----------------------------------------------------------------------------

const A = 6378137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const RAD = Math.PI / 180;

/** Earth-centred coordinates of a longitude and a latitude at height 0 */
function earth(lon: number, lat: number): [number, number, number] {
  const sinP = Math.sin(lat * RAD);
  const cosP = Math.cos(lat * RAD);
  const n = A / Math.sqrt(1 - E2 * sinP * sinP);
  return [n * cosP * Math.cos(lon * RAD), n * cosP * Math.sin(lon * RAD), n * (1 - E2) * sinP];
}

/** The offset of a position from a point, in meters east and north of the point */
function eastNorth(point: readonly number[], position: readonly number[]): [number, number] {
  const lon = (point[0] as number) * RAD;
  const lat = (point[1] as number) * RAD;
  const o = earth(point[0] as number, point[1] as number);
  const x = earth(position[0] as number, position[1] as number);
  const d = [x[0] - o[0], x[1] - o[1], x[2] - o[2]] as const;
  const east = -Math.sin(lon) * d[0] + Math.cos(lon) * d[1];
  const north =
    -Math.sin(lat) * Math.cos(lon) * d[0] -
    Math.sin(lat) * Math.sin(lon) * d[1] +
    Math.cos(lat) * d[2];
  return [east, north];
}

/** The distance on the ground between two positions, in meters (on a sphere: for the sizes) */
function groundMeters(a: readonly number[], b: readonly number[]): number {
  const R = 6371008.8;
  const dLat = ((b[1] as number) - (a[1] as number)) * RAD;
  const dLon = ((b[0] as number) - (a[0] as number)) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a[1] as number) * RAD) * Math.cos((b[1] as number) * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** A random generator of a fixed seed (mulberry32) */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Whether two arrays of numbers have the same bits, entry by entry */
function sameBits(a: ArrayLike<number> | null, b: ArrayLike<number> | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

const TOKYO = [139.7, 35.68];

// ----------------------------------------------------------------------------
// Moves
// ----------------------------------------------------------------------------

describe('a move', () => {
  it('takes the point from to the point to', () => {
    const cases: Array<[number[], number[]]> = [
      [TOKYO, [141.35, 43.06]],
      [TOKYO, [139.75, 35.73]],
      [
        [-73.98, 40.75],
        [2.35, 48.85],
      ],
      [
        [0, -60],
        [170, 70],
      ],
    ];
    for (const [from, to] of cases) {
      const [position] = moved({ kind: 'translate', from, to }, [from]);
      expect(Math.abs((position?.[0] as number) - (to[0] as number))).toBeLessThan(1e-9);
      expect(Math.abs((position?.[1] as number) - (to[1] as number))).toBeLessThan(1e-9);
    }
  });

  it('keeps the offsets in meters east and north of from, at to', () => {
    const from = [10, 70];
    const to = [12, 10];
    const positions = [
      [10.03, 70.01],
      [9.98, 69.995],
      [10, 70.02],
    ];
    const after = moved({ kind: 'translate', from, to }, positions);
    positions.forEach((position, i) => {
      const [east, north] = eastNorth(from, position);
      const [east2, north2] = eastNorth(to, after[i] as number[]);
      expect(Math.abs(east2 - east)).toBeLessThan(1e-3);
      expect(Math.abs(north2 - north)).toBeLessThan(1e-3);
    });
  });

  it('is not the difference of the longitudes and latitudes added, at a high latitude', () => {
    const from = [10, 70];
    const to = [12, 10];
    const position = [10.03, 70.01];
    const [after] = moved({ kind: 'translate', from, to }, [position]);
    // The difference added: 0.03 degrees of longitude are about 1,140 m at 70 degrees and about
    // 3,290 m at 10 degrees
    const added = [position[0] + to[0] - from[0], position[1] + to[1] - from[1]];
    expect(groundMeters(after as number[], added)).toBeGreaterThan(1000);
    const [east] = eastNorth(from, position);
    const [eastAdded] = eastNorth(to, added);
    expect(Math.abs(eastAdded - east)).toBeGreaterThan(1000);
  });

  it('moves nothing for a move to the same point', () => {
    const positions = [
      [139.71, 35.69],
      [139.72, 35.7],
    ];
    expect(moved({ kind: 'translate', from: TOKYO, to: [...TOKYO] }, positions)).toEqual(positions);
  });
});

// ----------------------------------------------------------------------------
// Rotations
// ----------------------------------------------------------------------------

describe('a rotation', () => {
  it('turns counterclockwise seen from above, about a center that stays', () => {
    const center = TOKYO;
    // 500 m east of the center
    const east = [139.7 + 500 / (111320 * Math.cos(35.68 * RAD)), 35.68];
    // On the same parallel: about 500 m east, and 1.4 cm south of the east axis of the center
    const [e0, n0] = eastNorth(center, east);
    expect(e0).toBeGreaterThan(499);
    const after = moved({ kind: 'rotate', center, counterclockwiseDegrees: 90 }, [east, center]);
    const [e, n] = eastNorth(center, after[0] as number[]);
    // A quarter turn counterclockwise takes the east to the north: (e, n) to (-n, e)
    expect(Math.abs(e + n0)).toBeLessThan(1e-3);
    expect(Math.abs(n - e0)).toBeLessThan(1e-3);
    // The center stays, bit for bit
    expect(after[1]).toEqual(center);
    // A negative angle turns clockwise: the east goes to the south, (e, n) to (n, -e)
    const [back] = moved({ kind: 'rotate', center, counterclockwiseDegrees: -90 }, [east]);
    const [e2, n2] = eastNorth(center, back as number[]);
    expect(Math.abs(e2 - n0)).toBeLessThan(1e-3);
    expect(Math.abs(n2 + e0)).toBeLessThan(1e-3);
  });

  it('keeps the distances from the center, and brings the positions back after twelve turns of 30 degrees', () => {
    const center = [139.71, 35.69];
    const next = random(3);
    const positions = Array.from({ length: 20 }, () => [139.6 + next() * 0.2, 35.6 + next() * 0.2]);
    const operation: TransformOperation = { kind: 'rotate', center, counterclockwiseDegrees: 30 };
    let current = positions.map((position) => [...position]);
    for (let turn = 0; turn < 12; turn++) {
      const after = moved(operation, current);
      after.forEach((position, i) => {
        const [e, n] = eastNorth(center, current[i] as number[]);
        const [e2, n2] = eastNorth(center, position);
        expect(Math.abs(Math.hypot(e2, n2) - Math.hypot(e, n))).toBeLessThan(1e-3);
      });
      current = after;
    }
    current.forEach((position, i) => {
      expect(Math.abs((position[0] as number) - (positions[i]?.[0] as number))).toBeLessThan(1e-9);
      expect(Math.abs((position[1] as number) - (positions[i]?.[1] as number))).toBeLessThan(1e-9);
    });
  });

  it('adds its angle to the rotations, within [0, 360), a NaN counting as 0', () => {
    const at = { positions: [TOKYO] };
    const rotations = [10, Number.NaN, 350, -30, 720, 0];
    const result = run(
      { kind: 'rotate', center: TOKYO, counterclockwiseDegrees: 30 },
      rotations.map((rotation) => ({ ...at, rotation })),
    );
    expect(Array.from(result.rotation ?? [])).toEqual([40, 30, 20, 0, 30, 30]);
    const negative = run(
      { kind: 'rotate', center: TOKYO, counterclockwiseDegrees: -90 },
      [30, Number.NaN].map((rotation) => ({ ...at, rotation })),
    );
    expect(Array.from(negative.rotation ?? [])).toEqual([300, 270]);
    // An angle of 0 follows the same rules
    const none = run(
      { kind: 'rotate', center: TOKYO, counterclockwiseDegrees: 0 },
      [Number.NaN, 370].map((rotation) => ({ ...at, rotation })),
    );
    expect(Array.from(none.rotation ?? [])).toEqual([0, 10]);
  });

  it('takes its angle from the directions, within [0, 360), a NaN staying NaN', () => {
    const at = { positions: [TOKYO] };
    const result = run(
      { kind: 'rotate', center: TOKYO, counterclockwiseDegrees: 30 },
      [10, Number.NaN, 90, 30].map((bearing) => ({ ...at, bearing })),
    );
    const bearings = Array.from(result.bearing ?? []);
    expect(bearings[0]).toBe(340);
    expect(bearings[1]).toBeNaN();
    expect(bearings[2]).toBe(60);
    expect(bearings[3]).toBe(0);
    const half = run({ kind: 'rotate', center: TOKYO, counterclockwiseDegrees: 180 }, [
      { ...at, rotation: 270, bearing: 90 },
    ]);
    expect(half.rotation?.[0]).toBe(90);
    expect(half.bearing?.[0]).toBe(270);
  });

  it('leaves the sizes as they are, and a scaling leaves the rotations and the directions', () => {
    const feature = { positions: [TOKYO], rotation: 30, bearing: Number.NaN, size: 2 };
    const turned = run({ kind: 'rotate', center: TOKYO, counterclockwiseDegrees: 45 }, [feature]);
    expect(turned.size?.[0]).toBe(2);
    const scaled = run(
      { kind: 'scale', center: TOKYO, eastFactor: 2, northFactor: 3, sizeFactor: 4 },
      [{ ...feature, rotation: Number.NaN, bearing: 15 }],
    );
    expect(scaled.rotation?.[0]).toBeNaN();
    expect(scaled.bearing?.[0]).toBe(15);
    const movedFeature = run({ kind: 'translate', from: TOKYO, to: [139.8, 35.7] }, [feature]);
    expect(movedFeature.rotation?.[0]).toBe(30);
    expect(movedFeature.bearing?.[0]).toBeNaN();
    expect(movedFeature.size?.[0]).toBe(2);
  });
});

// ----------------------------------------------------------------------------
// Scalings
// ----------------------------------------------------------------------------

describe('a scaling', () => {
  it('multiplies the distances on the ground along the east and the north', () => {
    const center = TOKYO;
    // About 100 m east and 100 m north of the center
    const eastOf = [139.7 + 100 / (111320 * Math.cos(35.68 * RAD)), 35.68];
    const northOf = [139.7, 35.68 + 100 / 111000];
    const after = moved({ kind: 'scale', center, eastFactor: 2, northFactor: 3, sizeFactor: 1 }, [
      eastOf,
      northOf,
      center,
    ]);
    // Each offset (e, n) from the center goes to (2 e, 3 n)
    [eastOf, northOf].forEach((position, i) => {
      const [e0, n0] = eastNorth(center, position);
      const [e1, n1] = eastNorth(center, after[i] as number[]);
      expect(Math.abs(e1 - 2 * e0)).toBeLessThan(1e-3);
      expect(Math.abs(n1 - 3 * n0)).toBeLessThan(1e-3);
    });
    // The center stays, bit for bit
    expect(after[2]).toEqual(center);
  });

  it('changes nothing along an axis whose factor is 1, nor anything when all are 1', () => {
    const center = TOKYO;
    const position = [139.71, 35.69];
    const [after] = moved({ kind: 'scale', center, eastFactor: 1, northFactor: 2, sizeFactor: 1 }, [
      position,
    ]);
    const [e0, n0] = eastNorth(center, position);
    const [e1, n1] = eastNorth(center, after as number[]);
    expect(Math.abs(e1 - e0)).toBeLessThan(1e-3);
    expect(Math.abs(n1 - 2 * n0)).toBeLessThan(1e-3);
    const result = run({ kind: 'scale', center, eastFactor: 1, northFactor: 1, sizeFactor: 1 }, [
      { positions: [position], size: 5 },
    ]);
    expect(result.positions[0]).toEqual([position]);
    expect(result.size?.[0]).toBe(5);
  });

  it('moves a feature that keeps its shape by sizeFactor along both axes', () => {
    const center = TOKYO;
    const position = [139.71, 35.69];
    const operation: TransformOperation = {
      kind: 'scale',
      center,
      eastFactor: 2,
      northFactor: 1,
      sizeFactor: 3,
    };
    const result = run(operation, [
      { positions: [position], uniform: true },
      { positions: [position] },
    ]);
    const uniformly = moved(
      { kind: 'scale', center, eastFactor: 3, northFactor: 3, sizeFactor: 1 },
      [position],
    );
    expect(result.positions[0]).toEqual(uniformly);
    const stretched = moved(
      { kind: 'scale', center, eastFactor: 2, northFactor: 1, sizeFactor: 1 },
      [position],
    );
    expect(result.positions[1]).toEqual(stretched);
    // Factors of 1 along the east and the north move only the features that keep their shape
    const sizeOnly = run({ kind: 'scale', center, eastFactor: 1, northFactor: 1, sizeFactor: 2 }, [
      { positions: [position], uniform: true },
      { positions: [position] },
    ]);
    expect(sizeOnly.positions[0]).not.toEqual([position]);
    expect(sizeOnly.positions[1]).toEqual([position]);
  });

  it('multiplies the sizes by sizeFactor, a NaN counting as 1', () => {
    const at = { positions: [TOKYO] };
    const result = run(
      { kind: 'scale', center: TOKYO, eastFactor: 2, northFactor: 1, sizeFactor: 3 },
      [2, Number.NaN, 0.5].map((size) => ({ ...at, size })),
    );
    expect(Array.from(result.size ?? [])).toEqual([6, 3, 1.5]);
  });

  it('computes factors above 0 however small or large, without bringing them within a range', () => {
    const center = TOKYO;
    const position = [139.7001, 35.6801];
    const [e0, n0] = eastNorth(center, position);
    for (const factor of [0.000001, 1_000_000]) {
      const operation: TransformOperation = {
        kind: 'scale',
        center,
        eastFactor: factor,
        northFactor: factor,
        sizeFactor: factor,
      };
      expect(acceptsBuiltInTransform(operation)).toBe(true);
      const result = run(operation, [{ positions: [position], size: 2 }]);
      expect(result.size?.[0]).toBe(2 * factor);
      const after = result.positions[0]?.[0] as number[];
      expect(Number.isFinite(after[0])).toBe(true);
      expect(Number.isFinite(after[1])).toBe(true);
      if (factor < 1) {
        // About 1.5 cm × 0.000001 from the center: at the center within a micrometre
        const [e1, n1] = eastNorth(center, after);
        expect(Math.abs(e1 - e0 * factor)).toBeLessThan(1e-6);
        expect(Math.abs(n1 - n0 * factor)).toBeLessThan(1e-6);
      } else {
        // About 15 m × 1,000,000 from the center: the position is not where a range would have
        // put it (a factor of 1,000,000 kept as it is, not brought down)
        expect(groundMeters(center, after)).toBeGreaterThan(1_000_000);
      }
    }
  });
});

// ----------------------------------------------------------------------------
// The values copied, the parts and the order
// ----------------------------------------------------------------------------

describe('the values of the positions past the longitude and the latitude', () => {
  it('are copied as they are, with 3 values and with 4', () => {
    const operations: TransformOperation[] = [
      { kind: 'translate', from: TOKYO, to: [140, 36] },
      { kind: 'rotate', center: TOKYO, counterclockwiseDegrees: 45 },
      { kind: 'scale', center: TOKYO, eastFactor: 2, northFactor: 3, sizeFactor: 4 },
    ];
    for (const operation of operations) {
      const three = run(
        operation,
        [
          {
            positions: [
              [139.71, 35.61, 123.456],
              [139.72, 35.62, -0],
            ],
          },
        ],
        3,
      ).positions[0] as number[][];
      expect(three[0]?.[2]).toBe(123.456);
      expect(Object.is(three[1]?.[2], -0)).toBe(true);
      const four = run(
        operation,
        [
          {
            positions: [
              [139.71, 35.61, 10, 7],
              [139.72, 35.62, Number.NaN, -3.5],
            ],
          },
        ],
        4,
      ).positions[0] as number[][];
      expect(four[0]?.slice(2)).toEqual([10, 7]);
      expect(four[1]?.[2]).toBeNaN();
      expect(four[1]?.[3]).toBe(-3.5);
      expect(four[0]?.[0]).not.toBe(139.71);
    }
  });
});

describe('the parts and the order of the features', () => {
  it('give the same results, bit for bit, however the features are split and ordered', () => {
    const next = random(11);
    const features: TestFeature[] = Array.from({ length: 40 }, (_, i) => ({
      positions: Array.from({ length: 1 + Math.floor(next() * 6) }, () => [
        139 + next(),
        35 + next(),
        next() * 100,
      ]),
      rotation: i % 3 === 0 ? Number.NaN : next() * 720 - 360,
      bearing: i % 4 === 0 ? Number.NaN : next() * 360,
      size: i % 5 === 0 ? Number.NaN : next() * 10,
      uniform: i % 2 === 0,
    }));
    const operations: TransformOperation[] = [
      { kind: 'translate', from: [139.5, 35.5], to: [141, 43] },
      { kind: 'rotate', center: [139.5, 35.5], counterclockwiseDegrees: 37 },
      { kind: 'scale', center: [139.5, 35.5], eastFactor: 1.5, northFactor: 0.7, sizeFactor: 2 },
    ];
    for (const operation of operations) {
      const whole = run(operation, features, 3);
      // In parts of random sizes, the features of each part in a random order
      const order = features.map((_, i) => i);
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [order[i], order[j]] = [order[j] as number, order[i] as number];
      }
      let at = 0;
      while (at < order.length) {
        const length = 1 + Math.floor(next() * 9);
        const part = order.slice(at, at + length);
        at += length;
        const result = run(
          operation,
          part.map((i) => features[i] as TestFeature),
          3,
        );
        part.forEach((i, k) => {
          expect(
            sameBits(result.positions[k]?.flat() ?? [], whole.positions[i]?.flat() ?? []),
          ).toBe(true);
          expect(Object.is(result.rotation?.[k], whole.rotation?.[i])).toBe(true);
          expect(Object.is(result.bearing?.[k], whole.bearing?.[i])).toBe(true);
          expect(Object.is(result.size?.[k], whole.size?.[i])).toBe(true);
        });
      }
    }
  });
});

// ----------------------------------------------------------------------------
// What is accepted
// ----------------------------------------------------------------------------

describe('what it computes', () => {
  const rotate = (counterclockwiseDegrees: number, center = [0, 0]): TransformOperation => ({
    kind: 'rotate',
    center,
    counterclockwiseDegrees,
  });
  const scale = (eastFactor: number, northFactor = 1, sizeFactor = 1): TransformOperation => ({
    kind: 'scale',
    center: [0, 0],
    eastFactor,
    northFactor,
    sizeFactor,
  });

  it('takes every operation of finite numbers whose factors are above 0', () => {
    const taken: TransformOperation[] = [
      { kind: 'translate', from: [0, 90], to: [0, -90] },
      { kind: 'translate', from: [540, 0], to: [-720, 0] },
      { kind: 'translate', from: [0, 0, Number.NaN], to: [1, 1] },
      rotate(180),
      rotate(-180),
      rotate(1000),
      rotate(30, [10, 90]),
      scale(0.000001),
      scale(1_000_000),
      scale(1, 0.000001, 1_000_000),
      scale(Number.MIN_VALUE),
    ];
    for (const operation of taken) {
      expect(acceptsBuiltInTransform(operation), JSON.stringify(operation)).toBe(true);
    }
  });

  it('refuses the others', () => {
    const refused: TransformOperation[] = [
      { kind: 'translate', from: [Number.NaN, 0], to: [0, 0] },
      { kind: 'translate', from: [0, 0], to: [Number.POSITIVE_INFINITY, 0] },
      { kind: 'translate', from: [0], to: [0, 0] },
      rotate(Number.NaN),
      rotate(Number.POSITIVE_INFINITY),
      rotate(10, [0, Number.NaN]),
      scale(0),
      scale(-1),
      scale(1, -0.5),
      scale(1, 1, Number.POSITIVE_INFINITY),
      scale(Number.NaN),
      { kind: 'skew' } as unknown as TransformOperation,
    ];
    for (const operation of refused) {
      expect(acceptsBuiltInTransform(operation), String(operation.kind)).toBe(false);
    }
  });

  it('is called through the same members as a provider set on the instance', () => {
    const provider = createBuiltInTransform();
    expect(typeof provider.name).toBe('string');
    const operation: TransformOperation = rotate(90, TOKYO);
    expect(provider.accepts(operation)).toBe(true);
    const input = inputOf([{ positions: [[139.71, 35.68]], rotation: 0 }]);
    const output = outputFor(input);
    provider.apply(operation, input, output);
    const expected = outputFor(input);
    applyBuiltInTransform(operation, input, expected);
    expect(sameBits(output.coordinates, expected.coordinates)).toBe(true);
    expect(output.rotationDegrees?.[0]).toBe(90);
    // Two of them share nothing
    expect(createBuiltInTransform()).not.toBe(provider);
  });
});

// ----------------------------------------------------------------------------
// Near the poles and across the ±180 degree meridian
//
// These tests read "as the select mode does now" as: nothing finite is refused (the plane
// computations of the select mode refuse nothing), and the longitudes stay continuous, not
// brought within [-180, 180] (the select mode does not bring them back). The latitudes are not
// clamped to the limit of Web Mercator, as the plane computations do.
// ----------------------------------------------------------------------------

describe('near the poles and across the ±180 degree meridian', () => {
  it('refuses no finite operation and gives finite positions near the poles', () => {
    const operations: TransformOperation[] = [
      { kind: 'translate', from: [0, 89.9], to: [100, 89.95] },
      { kind: 'translate', from: [0, 90], to: [0, 80] },
      { kind: 'rotate', center: [0, 90], counterclockwiseDegrees: 30 },
      { kind: 'rotate', center: [10, -89.99], counterclockwiseDegrees: -45 },
      { kind: 'scale', center: [45, 90], eastFactor: 2, northFactor: 3, sizeFactor: 2 },
    ];
    const positions = [
      [10, 89],
      [45, 90],
      [-170, 89.999],
      [0, -90],
    ];
    for (const operation of operations) {
      for (const position of moved(operation, positions)) {
        expect(Number.isFinite(position[0]), JSON.stringify(operation)).toBe(true);
        expect(Number.isFinite(position[1]), JSON.stringify(operation)).toBe(true);
        expect(Math.abs(position[1] as number)).toBeLessThanOrEqual(90);
      }
    }
  });

  it('keeps a latitude past the one of Web Mercator, and turns about a pole', () => {
    const [north] = moved({ kind: 'translate', from: [0, 86], to: [1, 86] }, [[0, 86]]);
    expect(north?.[0]).toBeCloseTo(1, 9);
    expect(north?.[1]).toBeCloseTo(86, 9);
    const [turned] = moved({ kind: 'rotate', center: [0, 86], counterclockwiseDegrees: 30 }, [
      [10, 86.5],
    ]);
    expect(turned?.[1] as number).toBeGreaterThan(86);
    // About the north pole, a quarter turn counterclockwise seen from above adds 90 degrees of
    // longitude
    const [aboutPole] = moved({ kind: 'rotate', center: [0, 90], counterclockwiseDegrees: 90 }, [
      [10, 89],
    ]);
    expect(aboutPole?.[0]).toBeCloseTo(100, 9);
    expect(aboutPole?.[1]).toBeCloseTo(89, 9);
    // The pole turned with the rest stays at the pole
    const [pole] = moved({ kind: 'rotate', center: [10, 89], counterclockwiseDegrees: 0.000001 }, [
      [45, 90],
    ]);
    expect(Number.isFinite(pole?.[0])).toBe(true);
    expect(pole?.[1]).toBeCloseTo(90, 6);
  });

  it('keeps the longitudes of a feature across the ±180 degree meridian together, as the select mode does', () => {
    const line = [
      [179.95, 10],
      [179.99, 10],
      [180.02, 10],
    ];
    const after = moved({ kind: 'translate', from: [0, 10], to: [0.1, 10] }, line);
    // The select mode adds the difference: 180.05, 180.09 and 180.12, not brought back
    const added = line.map((position) => [(position[0] as number) + 0.1, position[1] as number]);
    after.forEach((position, i) => {
      expect(position[0]).toBeCloseTo(added[i]?.[0] as number, 6);
      expect(position[1]).toBeCloseTo(10, 6);
    });
    // A move across the meridian keeps the longitudes next to those it started from
    const [across] = moved({ kind: 'translate', from: [179.9, 0], to: [-179.9, 0] }, [[179.95, 0]]);
    expect(across?.[0]).toBeCloseTo(-179.85, 6);
    // A ring turned about a point on the meridian stays one ring, as the select mode turns it
    const ring = [
      [179.999, 0],
      [180.001, 0],
      [180.001, 0.002],
      [179.999, 0.002],
      [179.999, 0],
    ];
    const center = [180, 0.001];
    const turned = moved({ kind: 'rotate', center, counterclockwiseDegrees: 10 }, ring);
    const plane = mainRotation(center, 10, ring);
    // About 220 m across: within a meter of the plane of Web Mercator (which has no flattening)
    turned.forEach((position, i) => {
      expect(Math.abs((position[0] as number) - 180)).toBeLessThan(0.01);
      expect(groundMeters(position, plane[i] as number[])).toBeLessThan(1);
    });
    expect(turned[0]).toEqual(turned[4]);
    for (let i = 1; i < turned.length; i++) {
      expect(Math.abs((turned[i]?.[0] as number) - (turned[i - 1]?.[0] as number))).toBeLessThan(1);
    }
  });
});

// ----------------------------------------------------------------------------
// Against the plane computations of the select mode
// ----------------------------------------------------------------------------

/** A feature of the select mode for its computations */
function lineFeature(positions: readonly (readonly number[])[]): Feature {
  return {
    id: 'f',
    type: 'LineString',
    layerId: 'layer-1',
    geometry: { type: 'LineString', coordinates: positions.map((p) => [p[0], p[1]]) },
    properties: {},
    locked: false,
    visible: true,
    style: {},
  } as unknown as Feature;
}

/** The box of the select mode around positions */
function boxOf(positions: readonly (readonly number[])[]): BoundingBoxCoords {
  const lons = positions.map((p) => p[0] as number);
  const lats = positions.map((p) => p[1] as number);
  const west = Math.min(...lons);
  const east = Math.max(...lons);
  const south = Math.min(...lats);
  const north = Math.max(...lats);
  return {
    topLeft: [west, north],
    topRight: [east, north],
    bottomRight: [east, south],
    bottomLeft: [west, south],
    center: [(west + east) / 2, (south + north) / 2],
  };
}

/** The positions as the rotation handle of the select mode turns them about the box center */
function mainRotation(
  center: readonly number[],
  degrees: number,
  positions: readonly (readonly number[])[],
): number[][] {
  const box = { ...boxOf(positions), center: [center[0], center[1]] as [number, number] };
  const [cx, cy] = toPlane(box.center);
  const r = 0.001;
  const [startLng, startLat] = fromPlane(cx + r, cy);
  const theta = degrees * RAD;
  const [lng, lat] = fromPlane(cx + r * Math.cos(theta), cy + r * Math.sin(theta));
  const feature = lineFeature(positions);
  const state = startRotation({ lng: startLng, lat: startLat }, box, [feature]);
  const result = computeRotation(state, { lng, lat }, [feature]);
  return result.get('f')?.coordinates as number[][];
}

/** The positions as the south-east handle of the select mode scales them by k about the north-west */
function mainScaling(k: number, positions: readonly (readonly number[])[]): number[][] {
  const box = boxOf(positions);
  const anchor = toPlane(box.topLeft);
  const start = toPlane(box.bottomRight);
  const [lng, lat] = fromPlane(
    anchor[0] + k * (start[0] - anchor[0]),
    anchor[1] + k * (start[1] - anchor[1]),
  );
  const feature = lineFeature(positions);
  const state = startResize(
    'resize-se',
    { lng: box.bottomRight[0], lat: box.bottomRight[1] },
    box,
    [feature],
  );
  const result = computeResize(state, { lng, lat }, [feature]);
  return result.get('f')?.coordinates as number[][];
}

/** A grid of 5 × 5 positions about a point, `half` degrees each side */
function grid(center: readonly number[], half: number): number[][] {
  const out: number[][] = [];
  for (let i = -2; i <= 2; i++) {
    for (let j = -2; j <= 2; j++) {
      out.push([(center[0] as number) + (i * half) / 2, (center[1] as number) + (j * half) / 2]);
    }
  }
  return out;
}

/** The largest distance on the ground between the positions of two lists, in meters */
function largestGap(a: readonly (readonly number[])[], b: readonly (readonly number[])[]): number {
  return Math.max(...a.map((position, i) => groundMeters(position, b[i] as number[])));
}

/**
 * The largest gaps from the select mode, in meters, for a grid about Tokyo `half` degrees each
 * side: a rotation of 30 degrees about its center, a scaling by 2 about its north-west corner,
 * and a move by twice `half` north-east (the select mode adds the difference of the longitudes
 * and the latitudes)
 */
function gapsFromSelectMode(half: number): { rotation: number; scaling: number; move: number } {
  const positions = grid(TOKYO, half);
  const corner = [(TOKYO[0] as number) - half, (TOKYO[1] as number) + half];
  const to = [(TOKYO[0] as number) + 2 * half, (TOKYO[1] as number) + 2 * half];
  return {
    rotation: largestGap(
      moved({ kind: 'rotate', center: TOKYO, counterclockwiseDegrees: 30 }, positions),
      mainRotation(TOKYO, 30, positions),
    ),
    scaling: largestGap(
      moved(
        { kind: 'scale', center: corner, eastFactor: 2, northFactor: 2, sizeFactor: 2 },
        positions,
      ),
      mainScaling(2, positions),
    ),
    move: largestGap(
      moved({ kind: 'translate', from: TOKYO, to }, positions),
      positions.map((p) => [
        (p[0] as number) + (to[0] as number) - (TOKYO[0] as number),
        (p[1] as number) + (to[1] as number) - (TOKYO[1] as number),
      ]),
    ),
  };
}

describe('against the plane computations of the select mode', () => {
  it('gives nearly the same positions over a few hundred meters', () => {
    // 0.0015 degrees each side: about 270 m east to west. The gap of the rotation (about 0.5 m)
    // is the flattening of the earth, which the plane of Web Mercator does not have
    const gaps = gapsFromSelectMode(0.0015);
    expect(gaps.rotation).toBeLessThan(1);
    expect(gaps.scaling).toBeLessThan(0.1);
    expect(gaps.move).toBeLessThan(0.1);
  });

  it('gives other positions over a few hundred kilometers', () => {
    // 1.5 degrees each side: about 270 km east to west
    const gaps = gapsFromSelectMode(1.5);
    expect(gaps.rotation).toBeGreaterThan(1000);
    expect(gaps.scaling).toBeGreaterThan(1000);
    expect(gaps.move).toBeGreaterThan(1000);
  });
});

// ----------------------------------------------------------------------------
// The ends of the operations: the latitudes of the points, the ±180 degree meridian, the poles
// and the distances far from the center
// ----------------------------------------------------------------------------

describe('the ends of the operations', () => {
  it('refuses a point of an operation whose latitude is outside -90 to 90', () => {
    const refused: TransformOperation[] = [
      { kind: 'translate', from: [0, 90.000001], to: [0, 0] },
      { kind: 'translate', from: [0, 0], to: [0, -91] },
      { kind: 'rotate', center: [10, 95], counterclockwiseDegrees: 10 },
      { kind: 'scale', center: [10, -90.5], eastFactor: 2, northFactor: 2, sizeFactor: 2 },
    ];
    for (const operation of refused) {
      expect(acceptsBuiltInTransform(operation), JSON.stringify(operation)).toBe(false);
    }
    const taken: TransformOperation[] = [
      { kind: 'translate', from: [0, 90], to: [0, -90] },
      { kind: 'rotate', center: [10, -90], counterclockwiseDegrees: 10 },
    ];
    for (const operation of taken) {
      expect(acceptsBuiltInTransform(operation), JSON.stringify(operation)).toBe(true);
    }
  });

  it('moves the way the numbers of from and to say across the ±180 degree meridian', () => {
    // From 179.5 to 180.5: one degree east, across the meridian
    const [east] = moved({ kind: 'translate', from: [179.5, 0], to: [180.5, 0] }, [[179.6, 0]]);
    expect(east?.[0]).toBeCloseTo(180.6, 9);
    expect(east?.[1]).toBeCloseTo(0, 9);
    // From 179.5 to -179.5: 359 degrees west
    const [west] = moved({ kind: 'translate', from: [179.5, 0], to: [-179.5, 0] }, [[179.6, 0]]);
    expect(west?.[0]).toBeCloseTo(-179.4, 9);
    expect(west?.[1]).toBeCloseTo(0, 9);
  });

  it('carries a position over a pole to the other side of it, half a turn of longitude away', () => {
    // A move half a degree north from 89.5 carries a position at 89.8 over the north pole
    const [over] = moved({ kind: 'translate', from: [10, 89.5], to: [10, 90] }, [[10, 89.8]]);
    expect(over?.[1] as number).toBeLessThan(90);
    expect(over?.[1]).toBeCloseTo(89.7, 3);
    const turn = ((((over?.[0] as number) - 10) % 360) + 360) % 360;
    expect(turn).toBeCloseTo(180, 6);
  });

  it('scales the offsets in the plane of the center: far away the ground differs a little from the factor', () => {
    // 100 km east of the center along the equator, scaled by 2 along the east
    const lon = 100_000 / A / RAD;
    const [after] = moved(
      { kind: 'scale', center: [0, 0], eastFactor: 2, northFactor: 1, sizeFactor: 1 },
      [[lon, 0]],
    );
    expect(after?.[1]).toBeCloseTo(0, 9);
    const ground = (after?.[0] as number) * RAD * A;
    const gap = 200_000 - ground;
    expect(gap).toBeGreaterThan(0);
    expect(gap).toBeLessThan(50);
  });
});
