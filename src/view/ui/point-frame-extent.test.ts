// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests of the extent of the selection box of a point
 *
 * For the frame of a zero-area point, only the dimensions change with the extent (half
 * width, half height) that can be registered per type. That the special treatment of zero
 * area (no resize / rotate handles, move inside the frame) does not change is pinned here.
 *
 * The registration for 'Point' goes into the selection scope of one draw instance created in
 * this file. It is registered only once, and the value it returns is replaced for each test.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SELECTION_CONFIG } from '../../shared/config/selection.js';
import type { CoordinateTransform } from '../../shared/math/index.js';
import type { Feature } from '../../store/types.js';
import { computeFeatureGeoBoundingBox } from './bounds.js';
import { hitTestHandles } from './handle-test.js';
import { createSelectionScope } from './selection-scope.js';
import type { PointFrameExtent } from './selection-ui/index.js';

/** A planar transform where 1 degree = 100px (for the tests) */
const transform: CoordinateTransform = {
  project: (lngLat) => ({ x: lngLat[0] * 100, y: -lngLat[1] * 100 }),
  unproject: (point) => ({ lng: point.x / 100, lat: -point.y / 100 }),
};

const MARGIN = DEFAULT_SELECTION_CONFIG.boundingBox.margin;
/** The default half width and half height of the frame (DEFAULT_POINT_FRAME_SIZE / 2) */
const DEFAULT_HALF = 6;

/** The extent that the Point type returns (replaced for each test) */
let extent: PointFrameExtent | null = null;
const scope = createSelectionScope();
scope.extensions.registerPointFrameExtent('Point', () => extent);

beforeEach(() => {
  extent = null;
});

function makeFeature(partial: Pick<Feature, 'type' | 'geometry'>): Feature {
  return {
    id: 'f1',
    layerId: 'l1',
    groupId: undefined,
    properties: {},
    locked: false,
    visible: true,
    style: {},
    ...partial,
  };
}

const pointFeature = (): Feature =>
  makeFeature({ type: 'Point', geometry: { type: 'Point', coordinates: [0, 0] } });

/** Take out the half width and half height of the frame in screen pixels */
function framePx(feature: Feature): { halfWidth: number; halfHeight: number } {
  const bbox = computeFeatureGeoBoundingBox(
    feature,
    transform,
    DEFAULT_SELECTION_CONFIG,
    scope.extensions,
  );
  if (!bbox) throw new Error('bbox cannot be computed');
  const topLeft = transform.project(bbox.topLeft);
  const bottomRight = transform.project(bbox.bottomRight);
  return {
    halfWidth: (bottomRight.x - topLeft.x) / 2,
    halfHeight: (bottomRight.y - topLeft.y) / 2,
  };
}

function hit(x: number, y: number, feature: Feature) {
  return hitTestHandles({ x, y }, [feature], transform, DEFAULT_SELECTION_CONFIG, 14, scope);
}

describe('resolving the extent of the selection box of a point', () => {
  it('keeps the former 12px square + margin for a type with no provider registered', () => {
    // There is no registration for MultiPoint (with a single point it takes the zero-area path)
    const frame = framePx(
      makeFeature({
        type: 'MultiPoint',
        geometry: { type: 'MultiPoint', coordinates: [[10, 20]] },
      }),
    );

    expect(frame.halfWidth).toBeCloseTo(DEFAULT_HALF + MARGIN, 6);
    expect(frame.halfHeight).toBeCloseTo(DEFAULT_HALF + MARGIN, 6);
  });

  it('keeps the former 12px square + margin for a type that returns null too', () => {
    const frame = framePx(pointFeature());

    expect(frame.halfWidth).toBeCloseTo(DEFAULT_HALF + MARGIN, 6);
    expect(frame.halfHeight).toBeCloseTo(DEFAULT_HALF + MARGIN, 6);
  });

  it('changes only the frame dimensions when an extent is returned (anisotropy allowed)', () => {
    extent = { halfWidth: 30, halfHeight: 20 };
    const frame = framePx(pointFeature());

    expect(frame.halfWidth).toBeCloseTo(30 + MARGIN, 6);
    expect(frame.halfHeight).toBeCloseTo(20 + MARGIN, 6);
  });

  it('degrades non-finite and negative values to the default', () => {
    extent = { halfWidth: Number.NaN, halfHeight: 20 };
    expect(framePx(pointFeature()).halfHeight).toBeCloseTo(DEFAULT_HALF + MARGIN, 6);

    extent = { halfWidth: 30, halfHeight: -5 };
    expect(framePx(pointFeature()).halfWidth).toBeCloseTo(DEFAULT_HALF + MARGIN, 6);
  });
});

describe('the set of handles of a point does not change with the extent', () => {
  const rotateY = -(MARGIN + DEFAULT_SELECTION_CONFIG.rotateHandle.distance);

  it('no extent: anywhere in the frame is move, no resize / rotate appears', () => {
    const feature = pointFeature();

    expect(hit(0, 0, feature)?.type).toBe('move');
    // Inside the corner of the frame (where a resize handle would sit for a feature with area)
    expect(hit(15, -15, feature)?.type).toBe('move');
    // Even where a rotate handle would sit, rotate is not returned (it is outside the frame)
    expect(hit(0, rotateY, feature)).toBeNull();
    // Outside the frame (6 + 10 = 16px) nothing is hit
    expect(hit(18, 0, feature)).toBeNull();
  });

  it('with an extent: the frame grows, but the handles that appear stay move only', () => {
    extent = { halfWidth: 30, halfHeight: 20 };
    const feature = pointFeature();

    expect(hit(0, 0, feature)?.type).toBe('move');
    expect(hit(39, -29, feature)?.type).toBe('move');
    expect(hit(-39, 29, feature)?.type).toBe('move');
    expect(hit(0, rotateY, feature)?.type).toBe('move');
    // Positions that used to be outside the frame can be grabbed (using the real size)
    expect(hit(18, 0, feature)?.type).toBe('move');
    // Outside the frame (30 + 10 = 40px / 20 + 10 = 30px) nothing is hit
    expect(hit(42, 0, feature)).toBeNull();
    expect(hit(0, -32, feature)).toBeNull();
  });
});

describe('the outline of the selection box of a point', () => {
  /** A diamond 40 px from its middle, the screen point (100, -100) of [1, 1] */
  scope.extensions.registerPointFrameOutline('Turned', () => [
    { x: 100, y: -140 },
    { x: 140, y: -100 },
    { x: 100, y: -60 },
    { x: 60, y: -100 },
  ]);
  const turned = (): Feature =>
    makeFeature({ type: 'Turned', geometry: { type: 'Point', coordinates: [1, 1] } });

  it('draws the frame along the outline, every edge moved out by the margin', () => {
    const bbox = computeFeatureGeoBoundingBox(
      turned(),
      transform,
      DEFAULT_SELECTION_CONFIG,
      scope.extensions,
    );
    if (!bbox) throw new Error('bbox cannot be computed');
    const top = transform.project(bbox.topLeft);
    const right = transform.project(bbox.topRight);
    // The edges of the diamond are turned by 45 degrees, so its tips move by MARGIN * sqrt(2)
    expect(top.x).toBeCloseTo(100);
    expect(top.y).toBeCloseTo(-100 - (40 + MARGIN * Math.SQRT2));
    expect(right.x).toBeCloseTo(100 + 40 + MARGIN * Math.SQRT2);
    expect(right.y).toBeCloseTo(-100);
  });

  it('grabs the inside of the outline as a move, and no resize or rotate', () => {
    const feature = turned();
    expect(hit(100, -100, feature)?.type).toBe('move');
    expect(hit(100, -140, feature)?.type).toBe('move');
    // The corner of the square around the diamond is outside it
    expect(hit(135, -135, feature)).toBeNull();
  });
});
