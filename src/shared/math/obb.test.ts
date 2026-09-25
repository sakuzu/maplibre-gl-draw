// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createOBB, distanceToOBB, getOBBAABB, getOBBCorners, pointInOBB } from './obb.js';

describe('createOBB', () => {
  it('the center coordinate is set correctly', () => {
    const obb = createOBB(10, 20, 4, 6, 0);
    expect(obb.center).toEqual([10, 20]);
  });

  it('the half width and half height are computed correctly', () => {
    const obb = createOBB(0, 0, 4, 6, 0);
    expect(obb.halfWidth).toBe(2);
    expect(obb.halfHeight).toBe(3);
  });

  it('the rotation angle is converted from degrees to radians', () => {
    const obb = createOBB(0, 0, 1, 1, 90);
    expect(obb.rotation).toBeCloseTo(Math.PI / 2);
  });

  it('a rotation angle of 0 becomes 0 radians', () => {
    const obb = createOBB(0, 0, 1, 1, 0);
    expect(obb.rotation).toBe(0);
  });

  it('a rotation angle of 180 becomes pi', () => {
    const obb = createOBB(0, 0, 1, 1, 180);
    expect(obb.rotation).toBeCloseTo(Math.PI);
  });
});

describe('pointInOBB', () => {
  const obb = createOBB(0, 0, 10, 6, 0);

  it('a point inside returns true', () => {
    expect(pointInOBB(obb, [0, 0])).toBe(true);
    expect(pointInOBB(obb, [3, 2])).toBe(true);
  });

  it('a point outside returns false', () => {
    expect(pointInOBB(obb, [10, 10])).toBe(false);
    expect(pointInOBB(obb, [6, 0])).toBe(false);
  });

  it('a point on the boundary returns true', () => {
    expect(pointInOBB(obb, [5, 0])).toBe(true);
    expect(pointInOBB(obb, [0, 3])).toBe(true);
  });

  it('the test is correct for a rotated OBB', () => {
    // An OBB rotated 45 degrees, with a half width of 5 and a half height of 5
    const rotatedOBB = createOBB(0, 0, 10, 10, 45);
    // (5,0) before the rotation is around (5*cos45, 5*sin45)=(3.54, 3.54) after it
    // (3, 3) should be inside
    expect(pointInOBB(rotatedOBB, [3, 3])).toBe(true);
    // (7, 0) should end up outside because of the rotation (it is on the axis, not the diagonal)
    // With a half width of 5 and a 45 degree rotation, the reach on the x axis is around
    // 5*cos45 + 5*sin45 = 7.07
    expect(pointInOBB(rotatedOBB, [7, 0])).toBe(true);
    expect(pointInOBB(rotatedOBB, [8, 0])).toBe(false);
  });
});

describe('distanceToOBB', () => {
  const obb = createOBB(0, 0, 10, 6, 0);

  it('a point inside returns a distance of 0', () => {
    expect(distanceToOBB(obb, [0, 0])).toBe(0);
    expect(distanceToOBB(obb, [3, 2])).toBe(0);
  });

  it('a point outside returns the correct distance', () => {
    // (8, 0) is a distance of 3 from the right edge because halfWidth=5
    expect(distanceToOBB(obb, [8, 0])).toBeCloseTo(3);
    // (0, 5) is a distance of 2 from the top edge because halfHeight=3
    expect(distanceToOBB(obb, [0, 5])).toBeCloseTo(2);
  });

  it('the distance from a corner is computed correctly', () => {
    // The distance from (8, 6) to the closest corner (5,3) = sqrt(9+9) = sqrt(18)
    expect(distanceToOBB(obb, [8, 6])).toBeCloseTo(Math.sqrt(18));
  });

  it('it is computed correctly for a rotated OBB too', () => {
    const rotatedOBB = createOBB(0, 0, 10, 6, 90);
    // 90 degree rotation: the original width direction becomes the Y axis and the height
    // direction becomes the X axis
    // A point inside
    expect(distanceToOBB(rotatedOBB, [0, 0])).toBe(0);
  });
});

describe('getOBBCorners', () => {
  it('with no rotation it returns the 4 vertices along the axes', () => {
    const obb = createOBB(5, 5, 4, 2, 0);
    const corners = getOBBCorners(obb);

    expect(corners).toHaveLength(4);
    // top-left
    expect(corners[0][0]).toBeCloseTo(3);
    expect(corners[0][1]).toBeCloseTo(4);
    // top-right
    expect(corners[1][0]).toBeCloseTo(7);
    expect(corners[1][1]).toBeCloseTo(4);
    // bottom-right
    expect(corners[2][0]).toBeCloseTo(7);
    expect(corners[2][1]).toBeCloseTo(6);
    // bottom-left
    expect(corners[3][0]).toBeCloseTo(3);
    expect(corners[3][1]).toBeCloseTo(6);
  });

  it('with a 90 degree rotation it returns vertices whose width and height are swapped', () => {
    const obb = createOBB(0, 0, 4, 2, 90);
    const corners = getOBBCorners(obb);

    // 90 degree rotation: (x,y) -> (-y,x)
    // top-left (-2,-1) -> (1, -2)
    expect(corners[0][0]).toBeCloseTo(1);
    expect(corners[0][1]).toBeCloseTo(-2);
    // top-right (2,-1) -> (1, 2)
    expect(corners[1][0]).toBeCloseTo(1);
    expect(corners[1][1]).toBeCloseTo(2);
    // bottom-right (2,1) -> (-1, 2)
    expect(corners[2][0]).toBeCloseTo(-1);
    expect(corners[2][1]).toBeCloseTo(2);
    // bottom-left (-2,1) -> (-1, -2)
    expect(corners[3][0]).toBeCloseTo(-1);
    expect(corners[3][1]).toBeCloseTo(-2);
  });
});

describe('getOBBAABB', () => {
  it('with no rotation it returns an AABB identical to the OBB', () => {
    const obb = createOBB(5, 5, 4, 2, 0);
    const aabb = getOBBAABB(obb);

    expect(aabb.minX).toBeCloseTo(3);
    expect(aabb.maxX).toBeCloseTo(7);
    expect(aabb.minY).toBeCloseTo(4);
    expect(aabb.maxY).toBeCloseTo(6);
  });

  it('a rotated OBB returns a larger AABB', () => {
    const obbNoRot = createOBB(0, 0, 4, 2, 0);
    const obbRot = createOBB(0, 0, 4, 2, 45);

    const aabbNoRot = getOBBAABB(obbNoRot);
    const aabbRot = getOBBAABB(obbRot);

    // The rotated AABB is larger than (or the same as) the unrotated one
    const widthNoRot = aabbNoRot.maxX - aabbNoRot.minX;
    const widthRot = aabbRot.maxX - aabbRot.minX;
    expect(widthRot).toBeGreaterThanOrEqual(widthNoRot);
  });

  it('the AABB of a square rotated 45 degrees is correct', () => {
    // A 2x2 square rotated 45 degrees
    const obb = createOBB(0, 0, 2, 2, 45);
    const aabb = getOBBAABB(obb);

    // The diagonal is sqrt(2), so the half width of the AABB is sqrt(2)
    expect(aabb.minX).toBeCloseTo(-Math.SQRT2);
    expect(aabb.maxX).toBeCloseTo(Math.SQRT2);
    expect(aabb.minY).toBeCloseTo(-Math.SQRT2);
    expect(aabb.maxY).toBeCloseTo(Math.SQRT2);
  });
});
