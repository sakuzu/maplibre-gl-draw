// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the failure of the boolean operations
 *
 * When polygon-clipping still throws after the retry on the grid, the operation throws a
 * GeometryError with a reason code instead of the library's internal message.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

/** The message polygon-clipping throws, and how many calls throw it (Infinity = all) */
const failure: { message: string | null; times: number } = { message: null, times: Infinity };

vi.mock('polygon-clipping', async (importOriginal) => {
  const actual = (await importOriginal()) as { default: Record<string, unknown> };
  const wrap =
    (name: string) =>
    (...args: unknown[]) => {
      if (failure.message !== null && failure.times > 0) {
        failure.times -= 1;
        throw new Error(failure.message);
      }
      return (actual.default[name] as (...a: unknown[]) => unknown)(...args);
    };
  return {
    default: {
      union: wrap('union'),
      difference: wrap('difference'),
      intersection: wrap('intersection'),
      xor: wrap('xor'),
    },
  };
});

const { difference, intersection, normalizeArea, union, unionAll } = await import('./boolean.js');
const { buffer } = await import('./buffer.js');
const { GeometryError } = await import('./errors.js');
const geometry = await import('./index.js');

const square = [
  [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
    [0, 0],
  ],
] as [number, number][][];
const shifted = square.map((ring) => ring.map(([x, y]) => [x + 0.5, y] as [number, number]));

afterEach(() => {
  failure.message = null;
  failure.times = Infinity;
});

function captureError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the operation to throw');
}

describe('GeometryError from the boolean operations', () => {
  it.each([
    [
      'Unable to complete output ring starting at [0, 0]. Last matching segment found ends at [1, 1].',
      'engine-failure',
    ],
    ['Input geometry is not a valid Polygon or MultiPolygon', 'invalid-input'],
    ['Tried to create degenerate segment at [0, 0]', 'invalid-input'],
    [
      'Infinite loop when passing sweep line over endpoints (queue size too big).',
      'engine-failure',
    ],
    ['Unable to find segment #3 [0, 0] -> [1, 1] in SweepLine tree.', 'engine-failure'],
  ])('maps "%s" to the reason %s', (message, code) => {
    failure.message = message;
    const error = captureError(() => union(square, shifted));
    expect(error).toBeInstanceOf(GeometryError);
    expect(error).toBeInstanceOf(Error);
    const geometryError = error as InstanceType<typeof GeometryError>;
    expect(geometryError.code).toBe(code);
    expect(geometryError.operation).toBe('union');
    expect(geometryError.name).toBe('GeometryError');
    expect((geometryError.cause as Error).message).toBe(message);
  });

  it('names the operation that failed', () => {
    failure.message = 'Input geometry is not a valid Polygon or MultiPolygon';
    expect(
      (captureError(() => difference(square, shifted)) as { operation: string }).operation,
    ).toBe('difference');
    expect(
      (captureError(() => intersection(square, shifted)) as { operation: string }).operation,
    ).toBe('intersection');
    expect((captureError(() => normalizeArea(square)) as { operation: string }).operation).toBe(
      'union',
    );
    expect(captureError(() => unionAll([square, shifted, square]))).toBeInstanceOf(GeometryError);
  });

  it('reaches the caller of the buffer as a GeometryError', () => {
    failure.message = 'Unable to complete output ring starting at [0, 0].';
    const error = captureError(() => buffer({ type: 'Polygon', coordinates: square }, 1000));
    expect(error).toBeInstanceOf(GeometryError);
  });

  it('does not wrap when the retry on the grid succeeds', () => {
    failure.message = 'Unable to complete output ring starting at [0, 0].';
    failure.times = 1;
    expect(union(square, shifted).length).toBe(1);
  });
});

describe('GeometryError from the public functions', () => {
  const polygonA = { type: 'Polygon' as const, coordinates: square };
  const polygonB = { type: 'Polygon' as const, coordinates: shifted };

  it('names the public function that failed, keeping the reason and the cause', () => {
    failure.message = 'Unable to complete output ring starting at [0, 0].';
    const cases: [string, () => unknown][] = [
      ['union', () => geometry.union([polygonA, polygonB])],
      ['intersection', () => geometry.intersection([polygonA, polygonB])],
      ['difference', () => geometry.difference(polygonA, [polygonB])],
      ['buffer', () => geometry.buffer(polygonA, 1000)],
      ['area', () => geometry.area(polygonA)],
      ['makeValid', () => geometry.makeValid(polygonA)],
      ['overlaps', () => geometry.overlaps(polygonA, polygonB)],
      ['contains', () => geometry.contains(polygonA, polygonA)],
      ['split', () => geometry.split(polygonA, { type: 'LineString', coordinates: [] })],
    ];
    for (const [name, run] of cases) {
      const error = captureError(run) as InstanceType<typeof GeometryError>;
      expect(error).toBeInstanceOf(GeometryError);
      expect(error.operation).toBe(name);
      expect(error.code).toBe('engine-failure');
      expect(error.message).toBe(`${name}: the boolean operation failed`);
      expect((error.cause as Error).message).toBe(failure.message);
    }
  });

  it('throws invalid-input for an input of the wrong shape', () => {
    const line = { type: 'LineString' as const, coordinates: [[0, 0] as [number, number]] };
    const cases: [string, () => unknown][] = [
      ['area', () => geometry.area(line as never)],
      ['union', () => geometry.union([polygonA, line as never])],
      ['distance', () => geometry.distance({} as never, [0, 0])],
      ['bbox', () => geometry.bbox({ type: 'Feature', geometry: null, properties: {} } as never)],
      ['bbox', () => geometry.bbox({ type: 'MultiPoint', coordinates: [] })],
      ['simplify', () => geometry.simplify(polygonA, Number.NaN)],
      ['along', () => geometry.along({ type: 'LineString', coordinates: [] }, 10)],
      ['circle', () => geometry.circle([0, 0], -1)],
    ];
    for (const [name, run] of cases) {
      const error = captureError(run) as InstanceType<typeof GeometryError>;
      expect(error).toBeInstanceOf(GeometryError);
      expect(error.code).toBe('invalid-input');
      expect(error.operation).toBe(name);
      expect(error.message.startsWith(`${name}: `)).toBe(true);
    }
  });
});
