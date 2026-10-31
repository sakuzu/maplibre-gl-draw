// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The scaling of a resize drag as an edit, and what the drag writes over its features
 *
 * - The anchor across from the handle stays, and the factors keep the handle on the pointer in
 *   the east, north and up frame of the anchor: along the axes the handle moves along for most
 *   features, and the distance from the anchor for the ones that keep their shape (a Circle and
 *   its radius)
 * - No factor is below 0.1
 * - A frame thinner than a pixel along an axis is not stretched along it, and a frame of 5 m is
 *   at zoom 22
 * - The positions are scaled as the reference scales them (computed apart, in float64), the
 *   parts of the Multi geometries kept; a pole gives no NaN
 */

import type { MultiLineString, Point, Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import { metersPerPixelAtZoom } from '../shared/math/index.js';
import { DRAW_PROPERTY_KEYS } from '../shared/properties.js';
import type { BoundingBoxCoords } from '../shared/types/selection-box.js';
import { DEFAULT_TRANSFORMS } from '../store/feature-edits.js';
import type { Feature } from '../store/types.js';
import { referenceEnuOffset, referenceScale } from '../test-support/enu-reference.js';
import { scaleEditOf, startScale } from './scale.js';
import { transformedUpdates, transformStartOf } from './transform-features.js';

/** About 0.1 mm, in degrees */
const TOLERANCE = 1e-9;
const RADIUS = DRAW_PROPERTY_KEYS.radiusMeters;

/** A box of 0.2 degrees around Tokyo */
const BOX: BoundingBoxCoords = {
  topLeft: [139.6, 35.78],
  topRight: [139.8, 35.78],
  bottomRight: [139.8, 35.58],
  bottomLeft: [139.6, 35.58],
  center: [139.7, 35.68],
};

function feature(type: string, geometry: Feature['geometry'], properties = {}): Feature {
  return {
    id: type,
    type,
    geometry,
    layerId: 'l1',
    groupId: undefined,
    properties,
    locked: false,
    visible: true,
    style: {},
  } as Feature;
}

function expectNear(actual: readonly number[], expected: readonly number[]): void {
  expect(Math.abs((actual[0] as number) - (expected[0] as number))).toBeLessThan(TOLERANCE);
  expect(Math.abs((actual[1] as number) - (expected[1] as number))).toBeLessThan(TOLERANCE);
}

describe('the factors of a resize drag', () => {
  it('keeps the handle on the pointer along the axes, the anchor across from the handle', () => {
    const anchor: [number, number] = [139.6, 35.78];
    const handle: [number, number] = [139.8, 35.58];
    const pointer: [number, number] = [139.9, 35.5];
    const state = startScale('resize-se', { lng: handle[0], lat: handle[1] }, BOX);
    const edit = scaleEditOf(state, { lng: pointer[0], lat: pointer[1] });
    expect(edit.center).toEqual(anchor);
    const [he, hn] = referenceEnuOffset(anchor, handle);
    const [pe, pn] = referenceEnuOffset(anchor, pointer);
    expect(Math.abs(edit.eastFactor - pe / he)).toBeLessThan(1e-12);
    expect(Math.abs(edit.northFactor - pn / hn)).toBeLessThan(1e-12);
    expect(Math.abs(edit.sizeFactor - Math.hypot(pe, pn) / Math.hypot(he, hn))).toBeLessThan(1e-12);
  });

  it('moves only the axis of a handle on a side', () => {
    const state = startScale('resize-e', { lng: 139.8, lat: 35.68 }, BOX);
    const edit = scaleEditOf(state, { lng: 139.9, lat: 35.7 });
    expect(edit.center).toEqual([139.6, 35.68]);
    expect(edit.northFactor).toBe(1);
    expect(edit.eastFactor).toBeGreaterThan(1.4);
  });

  it('keeps every factor at 0.1 or more', () => {
    const state = startScale('resize-se', { lng: 139.8, lat: 35.58 }, BOX);
    const edit = scaleEditOf(state, { lng: 139.0, lat: 36.5 });
    expect(edit.eastFactor).toBe(0.1);
    expect(edit.northFactor).toBe(0.1);
    const near = scaleEditOf(state, { lng: 139.6, lat: 35.78 });
    expect(near.sizeFactor).toBe(0.1);
  });

  it('stretches a frame of 5 m at zoom 22, and leaves it alone at zoom 10', () => {
    const small: BoundingBoxCoords = {
      topLeft: [139, 35.00005],
      topRight: [139.00005, 35.00005],
      bottomLeft: [139, 35],
      bottomRight: [139.00005, 35],
      center: [139.000025, 35.000025],
    };
    const start = { lng: 139.00005, lat: 35.000025 };
    const pointer = { lng: 139.0001, lat: 35.000025 };
    const atZoom = (zoom: number) => (lngLat: [number, number]) =>
      metersPerPixelAtZoom(lngLat[1], zoom);
    const close = scaleEditOf(startScale('resize-e', start, small, atZoom(22)), pointer);
    expect(Math.abs(close.eastFactor - 2)).toBeLessThan(1e-6);
    const far = scaleEditOf(startScale('resize-e', start, small, atZoom(10)), pointer);
    expect(far.eastFactor).toBe(1);
  });
});

describe('what a resize drag writes', () => {
  it('scales a Polygon along the axes as the reference does', () => {
    const ring = [
      [139.6, 35.58],
      [139.8, 35.58],
      [139.8, 35.78],
      [139.6, 35.78],
      [139.6, 35.58],
    ];
    const polygon = feature('Polygon', { type: 'Polygon', coordinates: [ring] });
    const state = startScale('resize-se', { lng: 139.8, lat: 35.58 }, BOX);
    const edit = scaleEditOf(state, { lng: 139.95, lat: 35.5 });
    const updates = transformedUpdates(
      DEFAULT_TRANSFORMS,
      edit,
      transformStartOf(polygon),
      polygon,
    );
    const moved = ((updates as Partial<Feature>).geometry as Polygon).coordinates[0];
    ring.forEach((position, i) => {
      expectNear(
        moved?.[i] as number[],
        referenceScale(
          position,
          edit.center as [number, number],
          edit.eastFactor,
          edit.northFactor,
        ),
      );
    });
    // The anchor stays
    expect(moved?.[3]).toEqual([139.6, 35.78]);
  });

  it('scales a Circle and its radius by the distance from the anchor', () => {
    const circle = feature(
      'Circle',
      { type: 'Point', coordinates: [139.7, 35.68] },
      { [RADIUS]: 1000 },
    );
    const state = startScale('resize-se', { lng: 139.8, lat: 35.58 }, BOX);
    const edit = scaleEditOf(state, { lng: 139.9, lat: 35.5 });
    const updates = transformedUpdates(DEFAULT_TRANSFORMS, edit, transformStartOf(circle), circle);
    expectNear(
      ((updates as Partial<Feature>).geometry as Point).coordinates,
      referenceScale(
        [139.7, 35.68],
        edit.center as [number, number],
        edit.sizeFactor,
        edit.sizeFactor,
      ),
    );
    expect(updates?.properties?.[RADIUS]).toBe(1000 * edit.sizeFactor);
  });

  it('scales every part of a MultiLineString and keeps the nesting depth', () => {
    const parts = [
      [
        [139.61, 35.6],
        [139.65, 35.65],
      ],
      [
        [139.7, 35.7],
        [139.75, 35.72],
        [139.79, 35.77],
      ],
    ];
    const multi = feature('MultiLineString', { type: 'MultiLineString', coordinates: parts });
    const state = startScale('resize-nw', { lng: 139.6, lat: 35.78 }, BOX);
    const edit = scaleEditOf(state, { lng: 139.5, lat: 35.9 });
    const updates = transformedUpdates(DEFAULT_TRANSFORMS, edit, transformStartOf(multi), multi);
    const moved = ((updates as Partial<Feature>).geometry as MultiLineString).coordinates;
    expect(moved.map((part) => part.length)).toEqual([2, 3]);
    parts.forEach((part, p) => {
      part.forEach((position, i) => {
        expectNear(
          moved[p]?.[i] as number[],
          referenceScale(
            position,
            edit.center as [number, number],
            edit.eastFactor,
            edit.northFactor,
          ),
        );
      });
    });
  });

  it('computes at a latitude of 90 degrees without producing NaN', () => {
    const box: BoundingBoxCoords = {
      topLeft: [0, 10],
      topRight: [10, 10],
      bottomRight: [10, 0],
      bottomLeft: [0, 0],
      center: [5, 5],
    };
    const ring = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ];
    const polygon = feature('Polygon', { type: 'Polygon', coordinates: [ring] });
    const edit = scaleEditOf(startScale('resize-se', { lng: 10, lat: 0 }, box), {
      lng: 20,
      lat: 90,
    });
    const updates = transformedUpdates(
      DEFAULT_TRANSFORMS,
      edit,
      transformStartOf(polygon),
      polygon,
    );
    for (const [lng, lat] of ((updates as Partial<Feature>).geometry as Polygon).coordinates[0] ??
      []) {
      expect(Number.isFinite(lng)).toBe(true);
      expect(Number.isFinite(lat)).toBe(true);
    }
  });
});
