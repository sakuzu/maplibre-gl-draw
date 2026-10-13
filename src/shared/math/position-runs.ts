// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Runs of positions read where they are held, and shapes made of them
 *
 * A precise test of a shape (a hit, for one) reads its positions one at a time. The positions of
 * a feature are arrays of `[lng, lat]`; the positions of a row held as columns are a typed array
 * of coordinates. A run reads either where it is, so one test reads both without copying.
 */

import type { Coordinate } from '../types/model.js';

/**
 * A run of positions (the vertices of a line or a ring, or points)
 *
 * @internal
 */
export interface PositionRun {
  /** The number of positions */
  readonly length: number;
  /** The longitude of position `i` */
  x(i: number): number;
  /** The latitude of position `i` */
  y(i: number): number;
}

/**
 * A run of the positions of a feature (arrays of `[lng, lat]`)
 *
 * @internal
 */
export class CoordinateRun implements PositionRun {
  constructor(readonly coords: readonly Coordinate[]) {}

  get length(): number {
    return this.coords.length;
  }

  x(i: number): number {
    return this.coords[i][0];
  }

  y(i: number): number {
    return this.coords[i][1];
  }
}

/**
 * A run of positions of a column of coordinates (`stride` numbers per position)
 *
 * @internal
 */
export class ColumnRun implements PositionRun {
  /**
   * @param coords The coordinates of the column
   * @param start The first position of the run
   * @param length The number of positions
   * @param stride The numbers of a position
   */
  constructor(
    readonly coords: Float64Array,
    readonly start: number,
    readonly length: number,
    readonly stride: number,
  ) {}

  x(i: number): number {
    return this.coords[(this.start + i) * this.stride];
  }

  y(i: number): number {
    return this.coords[(this.start + i) * this.stride + 1];
  }
}

/**
 * A shape as a precise test reads it: its parts, each a list of runs
 *
 * - A Point: one part of one run of one position; a MultiPoint: one part of one run of its points
 * - A LineString: one part of one run; a MultiLineString: one part, one run per line
 * - A Polygon: one part, one run per ring (the outer ring first); a MultiPolygon: one part per
 *   polygon
 *
 * @internal
 */
export interface HitShape {
  /** The parts */
  readonly parts: ReadonlyArray<readonly PositionRun[]>;
  /** The radius of a Circle, in meters (its center is the one position of its only part) */
  readonly radiusMeters?: number;
}

/**
 * The shape of the coordinates of a geometry type, as runs over its arrays
 *
 * @param type The type of the geometry (`Point`, `LineString`, `Polygon` and their `Multi`)
 * @param coordinates Its coordinates
 * @internal
 */
export function shapeOfCoordinates(type: string, coordinates: unknown): HitShape {
  switch (type) {
    case 'Point':
      return { parts: [[new CoordinateRun([coordinates as Coordinate])]] };
    case 'MultiPoint':
    case 'LineString':
      return { parts: [[new CoordinateRun(coordinates as Coordinate[])]] };
    case 'Polygon':
    case 'MultiLineString':
      return { parts: [(coordinates as Coordinate[][]).map((run) => new CoordinateRun(run))] };
    case 'MultiPolygon':
      return {
        parts: (coordinates as Coordinate[][][]).map((rings) =>
          rings.map((ring) => new CoordinateRun(ring)),
        ),
      };
    default:
      return { parts: [] };
  }
}
