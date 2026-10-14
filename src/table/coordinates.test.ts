// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The dimensions of the coordinates and the system of coordinates of the plane
 */

import { describe, expect, it } from 'vitest';
import {
  copyCoordinates,
  dimsWithin,
  isCoordinateDims,
  planarCoordinates,
  planarRowBox,
  sortKeyOf,
  strideOf,
  unionDims,
} from './coordinates.js';
import { buildPackedRTree } from './packed-rtree.js';

describe('the dimensions of the coordinates', () => {
  it('have the strides of their values', () => {
    expect([strideOf('xy'), strideOf('xyz'), strideOf('xym'), strideOf('xyzm')]).toEqual([
      2, 3, 3, 4,
    ]);
    expect(strideOf(undefined)).toBe(2);
    expect(['xy', 'xyz', 'xym', 'xyzm'].every(isCoordinateDims)).toBe(true);
    expect([2, 'xz', 'XYZ', null].some(isCoordinateDims)).toBe(false);
  });

  it('hold one another when every dimension of one is in the other', () => {
    expect(dimsWithin('xy', 'xyz')).toBe(true);
    expect(dimsWithin('xyz', 'xyzm')).toBe(true);
    expect(dimsWithin('xym', 'xyzm')).toBe(true);
    expect(dimsWithin('xyz', 'xym')).toBe(false);
    expect(dimsWithin('xyzm', 'xyz')).toBe(false);
    expect(unionDims('xyz', 'xym')).toBe('xyzm');
    expect(unionDims('xy', 'xym')).toBe('xym');
    expect(unionDims('xy', 'xy')).toBe('xy');
  });

  it('copy coordinates into more dimensions, the missing ones NaN, each in its place', () => {
    const xym = Float64Array.of(1, 2, 10, 3, 4, 20);
    const out = new Float64Array(8);
    copyCoordinates(xym, 'xym', 0, 2, out, 'xyzm', 0);
    expect(Array.from(out)).toEqual([1, 2, Number.NaN, 10, 3, 4, Number.NaN, 20]);
    const xy = new Float64Array(2);
    copyCoordinates(Float64Array.of(5, 6, 7), 'xyz', 0, 1, new Float64Array(3), 'xyz', 0);
    expect(() => copyCoordinates(Float64Array.of(5, 6, 7), 'xyz', 0, 1, xy, 'xy', 0)).toThrow(
      /xyz cannot be written as xy/,
    );
  });
});

describe('the plane', () => {
  it('makes the bbox of x and y, NaN for none or a NaN x or y, whatever the other values', () => {
    const out = new Float64Array(8);
    planarRowBox(Float64Array.of(1, 5, 99, 3, 2, -99), 3, 0, 2, out, 4);
    expect(Array.from(out.subarray(4))).toEqual([1, 2, 3, 5]);
    planarRowBox(Float64Array.of(1, 5, Number.NaN, 3, 2, Number.NaN), 3, 0, 2, out, 0);
    expect(Array.from(out.subarray(0, 4))).toEqual([1, 2, 3, 5]);
    planarRowBox(Float64Array.of(1, Number.NaN), 2, 0, 1, out, 0);
    expect(out.subarray(0, 4).every(Number.isNaN)).toBe(true);
    planarRowBox(Float64Array.of(), 2, 0, 0, out, 4);
    expect(out.subarray(4).every(Number.isNaN)).toBe(true);
  });

  it('orders the leaves of the index by the Hilbert curve, or by the key of a system', () => {
    expect(sortKeyOf(planarCoordinates)).toBeUndefined();
    const bounds = new Float64Array(40 * 4);
    for (let i = 0; i < 40; i++) bounds.set([i, 0, i, 0], i * 4);
    const system = { rowBox: planarRowBox, sortKey: (x: number) => -x };
    const tree = buildPackedRTree(bounds, 4, sortKeyOf(system));
    expect(Array.from(tree.indices.subarray(0, 40))).toEqual(
      Array.from({ length: 40 }, (_, i) => 39 - i),
    );
  });
});
