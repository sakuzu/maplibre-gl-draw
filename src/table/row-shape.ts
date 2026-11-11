// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The shape of one row as the rows are built and written (`RowGeometry`)
 *
 * A value of a `shape` column is a shape of Tabane (`TabaneShape`): points nested as deep as the
 * shape, with the name of its form. The builder of the row blocks and the writes of the rows in
 * place read it the same way: its points in one array, and the sizes of its levels. Keeping both
 * on these functions keeps the caches of a row written in place the ones the builder would have
 * made.
 *
 * The points of a row have the dimensions of its table (`CoordinateDimensions`): a point shorter
 * than them gets NaN for the values it does not have, and a longer one is refused rather than
 * cut.
 *
 * A pure module: it depends on nothing but `@sakuzu/tabane` and the error of the tables, so it
 * runs in a Worker as well.
 */

import {
  type CoordinateDimensions,
  copyCoordinates,
  strideOf,
  type TabanePoint,
  type TabaneShape,
} from '@sakuzu/tabane';
import { KasaneError } from './kasane-error.js';
import type { RowShape } from './row-read-type.js';
import type { ShapeForm } from './shape-reader.js';

/**
 * The depth of a shape: the number of its levels of lists of points (0 for one point)
 *
 * @internal
 */
export type ShapeDepth = 0 | 1 | 2 | 3;

/**
 * The shape of one row: its points and the sizes of its levels
 *
 * @internal
 */
export interface RowGeometry {
  /** The name of the form of the shape */
  readonly type: string;
  /** The depth of the shape */
  readonly depth: ShapeDepth;
  /** The dimensions of the points */
  readonly dims: CoordinateDimensions;
  /** The number of values of a point */
  readonly stride: number;
  /** The points (`stride` values each) */
  readonly coords: Float64Array;
  /**
   * The sizes of the lists of points at depth 2 and 3: the number of points of each (none at depth
   * 0 and 1)
   */
  readonly parts: readonly number[];
  /** The number of lists of points of each list of lists, at depth 3 */
  readonly polygons: readonly number[];
}

/** Whether a value is a depth of a shape */
function isShapeDepth(depth: unknown): depth is ShapeDepth {
  return depth === 0 || depth === 1 || depth === 2 || depth === 3;
}

/**
 * Whether a value is a shape: an object with the depth of one (what the points hold is read when
 * it is made a row, `rowGeometryOfShape`)
 *
 * @internal
 */
export function isShapeValue(value: unknown): value is TabaneShape {
  return typeof value === 'object' && value !== null && 'depth' in value && 'points' in value;
}

/**
 * The shape of a row from a shape value, its points read as points of dimensions: a point of
 * fewer values gets NaN for the others, the values of a point are those of the dimensions in
 * their order (`[x, y, m]` for `xym`)
 *
 * @param column The name of the column of the shape (for the message of an error)
 * @param dims The dimensions of the points (`xy` when omitted)
 * @throws `KasaneError` with the code `invalid-input` when the depth is not one of a shape, or
 *   when a point has more values than the dimensions
 * @internal
 */
export function rowGeometryOfShape(
  shape: TabaneShape,
  column: string,
  dims: CoordinateDimensions = 'xy',
): RowGeometry {
  const depth = shape.depth as unknown;
  if (!isShapeDepth(depth)) {
    throw new KasaneError(
      'invalid-input',
      `RowBlockBuilder: a ${shape.name} ${column} cannot be a row`,
    );
  }
  const stride = strideOf(dims);
  const points: number[] = [];
  const push =
    stride === 2
      ? (point: TabanePoint): void => {
          if (point.length > 2) throw pointTooLong(point, dims);
          points.push(Number(point[0]), Number(point[1]));
        }
      : (point: TabanePoint): void => {
          if (point.length > stride) throw pointTooLong(point, dims);
          for (let k = 0; k < stride; k++) {
            points.push(k < point.length ? Number(point[k]) : Number.NaN);
          }
        };
  const parts: number[] = [];
  const polygons: number[] = [];
  switch (depth) {
    case 0:
      push(shape.points as TabanePoint);
      break;
    case 1:
      for (const point of shape.points as readonly TabanePoint[]) push(point);
      break;
    case 2:
      for (const list of shape.points as readonly (readonly TabanePoint[])[]) {
        for (const point of list) push(point);
        parts.push(list.length);
      }
      break;
    case 3:
      for (const lists of shape.points as readonly (readonly (readonly TabanePoint[])[])[]) {
        for (const list of lists) {
          for (const point of list) push(point);
          parts.push(list.length);
        }
        polygons.push(lists.length);
      }
      break;
  }
  return {
    type: shape.name,
    depth,
    dims,
    stride,
    coords: Float64Array.from(points),
    parts,
    polygons,
  };
}

/** The error of a point of more values than the dimensions of the points */
function pointTooLong(point: TabanePoint, dims: CoordinateDimensions): KasaneError {
  return new KasaneError(
    'invalid-input',
    `RowBlockBuilder: a position of ${point.length} values does not fit coordinates of ${dims}`,
  );
}

/**
 * The offsets from a list of points to its first point, over every list of a shape of depth 2
 * or 3
 *
 * @internal
 */
export function ringOffsetsOf(geometry: RowGeometry): Int32Array {
  const offsets = new Int32Array(geometry.parts.length + 1);
  for (let i = 0; i < geometry.parts.length; i++) offsets[i + 1] = offsets[i] + geometry.parts[i];
  return offsets;
}

/** The offset arrays of the shape of one row, as a form of one row holds them */
function offsetsOf(geometry: RowGeometry): Int32Array[] {
  switch (geometry.depth) {
    case 0:
      return [];
    case 1:
      return [Int32Array.of(0, geometry.coords.length / geometry.stride)];
    case 2:
      return [Int32Array.of(0, geometry.parts.length), ringOffsetsOf(geometry)];
    case 3: {
      const lists = new Int32Array(geometry.polygons.length + 1);
      for (let p = 0; p < geometry.polygons.length; p++) {
        lists[p + 1] = lists[p] + geometry.polygons[p];
      }
      return [Int32Array.of(0, geometry.polygons.length), lists, ringOffsetsOf(geometry)];
    }
  }
}

/**
 * A form of one row holding the shape of a row (its points copied)
 *
 * @internal
 */
export function singleRowForm(geometry: RowGeometry): ShapeForm {
  const coords = geometry.coords.slice();
  if (geometry.depth === 0) return { type: geometry.type, coords, dimensions: geometry.dims };
  return { type: geometry.type, coords, dimensions: geometry.dims, offsets: offsetsOf(geometry) };
}

/**
 * The shape of a row as a row reads it: a column of the one row, its points not copied
 *
 * @internal
 */
export function rowShapeOf(geometry: RowGeometry): RowShape {
  const { coords, stride } = geometry;
  return { column: { type: geometry.type, coords, stride, offsets: offsetsOf(geometry) }, at: 0 };
}

/**
 * The shape of one row of a form, as the shape of a row (its points copied)
 *
 * @param column The form
 * @param at The row in the form
 * @param dims The dimensions of the points of the shape (those of the form when omitted): a
 *   dimension the form does not have is NaN
 * @throws when the form has a dimension that `dims` does not
 * @internal
 */
export function rowGeometryOfColumn(
  column: {
    readonly type: string;
    readonly coords: Float64Array;
    readonly dimensions?: CoordinateDimensions;
    readonly offsets?: readonly Int32Array[];
  },
  at: number,
  dims: CoordinateDimensions = column.dimensions ?? 'xy',
): RowGeometry {
  const o = column.offsets ?? [];
  let first = at;
  let end = at + 1;
  for (const level of o) {
    first = level[first];
    end = level[end];
  }
  const stride = strideOf(dims);
  const coords = new Float64Array((end - first) * stride);
  copyCoordinates(column.coords, column.dimensions ?? 'xy', first, end - first, coords, dims, 0);
  const parts: number[] = [];
  const polygons: number[] = [];
  if (o.length === 2) {
    for (let r = o[0][at]; r < o[0][at + 1]; r++) parts.push(o[1][r + 1] - o[1][r]);
  } else if (o.length === 3) {
    for (let p = o[0][at]; p < o[0][at + 1]; p++) {
      polygons.push(o[1][p + 1] - o[1][p]);
      for (let r = o[1][p]; r < o[1][p + 1]; r++) parts.push(o[2][r + 1] - o[2][r]);
    }
  }
  return {
    type: column.type,
    depth: o.length as ShapeDepth,
    dims,
    stride,
    coords,
    parts,
    polygons,
  };
}
