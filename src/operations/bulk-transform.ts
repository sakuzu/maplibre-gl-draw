// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Moving, rotating and resizing the features selected in bulk, written once on their rows
 *
 * The values are computed as the drags of features selected one by one compute them (`move.ts`,
 * `rotate.ts`, `resize.ts`), with the same functions on the same values in float64, so the rows
 * end where the same features moved one by one end. What is different: the position keeps its
 * values after `x` and `y` (an elevation, a measure), which a feature does not hold; and a row
 * is not made a feature, but where a type of an extension computes its own resize.
 *
 * The rows are written by kind (the geometry alone, with a rotation, with a scale, with a radius,
 * with the values of an extension), each kind one write of the fields it changes, the writes
 * made in one transaction (one change, one step of the history). The kinds are made apart from
 * their write (`translationKinds`, `rotationKinds`, `resizeKinds`), so that a drag let go writes
 * them in steps (`bulk-sliced.ts`).
 */

import type { BulkOperation, BulkRowReader } from '../feature-table/bulk-plan.js';
import { livePlaceOf } from '../feature-table/bulk-rows.js';
import { featureTablesInternals } from '../feature-table/feature-tables.js';
import { TableSelection } from '../feature-table/selection.js';
import type { HandleType } from '../shared/config/constants.js';
import { drawPropertyKey, readDrawProperty } from '../shared/properties.js';
import type { BoundingBoxCoords } from '../shared/types/selection-box.js';
import { geometryFromCoordinates } from '../shared/utils/coordinates.js';
import type { Store } from '../store/store.js';
import type { FeatureCoordinates, RowField } from '../store/types.js';
import { rowsLocked } from './bulk-selection.js';
import {
  computeResize,
  computeResizeFactors,
  type ResizeExtensions,
  type ResizeFactors,
  scaleCoordinate,
  startResize,
} from './resize.js';
import { type RotateExtensions, rotateCoordinate } from './rotate.js';

const ROTATION_KEY = drawPropertyKey('rotation');
const SCALE_KEY = drawPropertyKey('scale');
const RADIUS_KEY = drawPropertyKey('radiusMeters');

/**
 * The positions of a geometry mapped by their `x` and `y`, the values after them kept
 *
 * @internal
 */
export function mapPositions(
  coordinates: unknown,
  map: (x: number, y: number) => readonly [number, number],
): unknown {
  if (!Array.isArray(coordinates)) return coordinates;
  if (typeof coordinates[0] === 'number') {
    const [x, y] = map(coordinates[0] as number, coordinates[1] as number);
    return coordinates.length > 2 ? [x, y, ...coordinates.slice(2)] : [x, y];
  }
  return coordinates.map((child) => mapPositions(child, map));
}

/** The geometry of a row mapped by the `x` and `y` of its positions (undefined for none) */
function mappedGeometry(
  read: BulkRowReader,
  map: (x: number, y: number) => readonly [number, number],
): unknown {
  const geometry = read.geometry() as { type: string; coordinates: unknown } | undefined;
  if (!geometry) return undefined;
  return { type: geometry.type, coordinates: mapPositions(geometry.coordinates, map) };
}

/**
 * The writes of an operation on features selected in bulk, by kind of row: the rows of a kind
 * (ascending) and the operation that writes them
 *
 * @internal
 */
export type BulkKinds = ReadonlyArray<{
  readonly rows: readonly number[];
  readonly op: BulkOperation;
}>;

/**
 * Writes the kinds of rows of an operation, in one transaction
 *
 * @internal
 */
export function writeKinds(store: Store, rows: TableSelection, kinds: BulkKinds): boolean {
  // A locked feature refuses the whole of it, as a drag does not start then
  if (rows.count === 0 || rowsLocked(store, rows)) return false;
  let written = false;
  store.transact(() => {
    for (const kind of kinds) {
      if (kind.rows.length === 0) continue;
      if (store.applyBulk(kind.op, TableSelection.of([...kind.rows]))) written = true;
    }
  });
  return written;
}

/**
 * Moves the features selected in bulk by a translation in degrees, as a move drag does
 *
 * @returns false when nothing is written, or the move is refused
 * @internal
 */
export function translateBulkSelection(
  store: Store,
  dx: number,
  dy: number,
  rows: TableSelection | null = store.getSelectedRows(),
): boolean {
  if (!rows) return false;
  return writeKinds(store, rows, translationKinds(rows, dx, dy));
}

/**
 * The writes of a move of features selected in bulk by a translation in degrees
 *
 * @internal
 */
export function translationKinds(rows: TableSelection, dx: number, dy: number): BulkKinds {
  return [
    {
      rows: Array.from(rows.handles),
      op: {
        kind: 'rows',
        fields: ['geometry'],
        write: (_handle, read) => {
          const geometry = mappedGeometry(read, (x, y) => [x + dx, y + dy]);
          return geometry === undefined ? null : [geometry];
        },
      },
    },
  ];
}

/**
 * Rotates the features selected in bulk around a center by an angle in the transform plane, as
 * a rotate drag of many features does: the coordinates turn, and a feature that has a rotation
 * (an image, a type of an extension that scales, one with a rotation in its properties) takes
 * the angle too
 *
 * @param deltaAngle The angle in radians, counterclockwise
 * @returns false when nothing is written, or the rotation is refused
 * @internal
 */
export function rotateBulkSelection(
  store: Store,
  center: [number, number],
  deltaAngle: number,
  extensions?: RotateExtensions,
  rows: TableSelection | null = store.getSelectedRows(),
): boolean {
  if (!rows) return false;
  const kinds = rotationKinds(store, center, deltaAngle, extensions, rows);
  return kinds !== null && writeKinds(store, rows, kinds);
}

/**
 * The writes of a rotation of features selected in bulk (null without rows)
 *
 * @internal
 */
export function rotationKinds(
  store: Store,
  center: [number, number],
  deltaAngle: number,
  extensions: RotateExtensions | undefined,
  rows: TableSelection,
): BulkKinds | null {
  const internals = featureTablesInternals(store.tables);
  if (!internals) return null;
  const rotate = (x: number, y: number) => rotateCoordinate([x, y], center, deltaAngle);
  const deltaDeg = (deltaAngle * 180) / Math.PI;
  const plain: number[] = [];
  const turned: number[] = [];
  for (const handle of rows.handles) {
    const place = livePlaceOf(internals, handle);
    if (!place) continue;
    const view = store.tables?.get(place.layer.layerId);
    const type = view?.getRowType(handle);
    const byProperty =
      type === 'Image' ||
      (type !== null && type !== undefined && extensions?.getResizeStrategy(type) === 'scale') ||
      view?.getRowValue(handle, ROTATION_KEY) !== undefined;
    (byProperty ? turned : plain).push(handle);
  }
  return [
    {
      rows: plain,
      op: {
        kind: 'rows',
        fields: ['geometry'],
        write: (_handle, read) => {
          const geometry = mappedGeometry(read, rotate);
          return geometry === undefined ? null : [geometry];
        },
      },
    },
    {
      rows: turned,
      op: {
        kind: 'rows',
        fields: ['geometry', `property:${ROTATION_KEY}`],
        write: (_handle, read) => {
          const geometry = mappedGeometry(read, rotate);
          if (geometry === undefined) return null;
          const initial = readDrawProperty(
            { [ROTATION_KEY]: read.value(ROTATION_KEY) },
            'rotation',
          );
          return [geometry, (initial ?? 0) + deltaDeg];
        },
      },
    },
  ];
}

/**
 * Resizes the features selected in bulk from a handle of their frame, as a resize drag of many
 * features does: a Circle and a feature that has a scale scale the same in x and y (the radius
 * and the scale with them), a type of an extension with its own resize computes it, and the
 * others scale along the axes
 *
 * @param handle The handle dragged
 * @param bbox The frame at the start of the drag
 * @param startLngLat The pointer at the start
 * @param currentLngLat The pointer now
 * @param minAxisExtent The extent below which the frame is not stretched along an axis (Web
 *   Mercator world units)
 * @returns false when nothing is written, or the resize is refused
 * @internal
 */
export function resizeBulkSelection(
  store: Store,
  resize: {
    readonly handle: HandleType;
    readonly bbox: BoundingBoxCoords;
    readonly startLngLat: { lng: number; lat: number };
    readonly currentLngLat: { lng: number; lat: number };
    readonly minAxisExtent?: number;
  },
  extensions?: ResizeExtensions,
  rows: TableSelection | null = store.getSelectedRows(),
): boolean {
  if (!rows) return false;
  const kinds = resizeKinds(store, resize, extensions, rows);
  return kinds !== null && writeKinds(store, rows, kinds);
}

/**
 * The writes of a resize of features selected in bulk (null without rows)
 *
 * @internal
 */
export function resizeKinds(
  store: Store,
  resize: Parameters<typeof resizeBulkSelection>[1],
  extensions: ResizeExtensions | undefined,
  rows: TableSelection,
): BulkKinds | null {
  const internals = featureTablesInternals(store.tables);
  const tables = store.tables;
  if (!internals || !tables) return null;
  const state = startResize(
    resize.handle,
    resize.startLngLat,
    resize.bbox,
    [],
    extensions,
    resize.minAxisExtent ?? 0,
  );
  const factors: ResizeFactors = computeResizeFactors(state, resize.currentLngLat);
  const { anchor, uniformScale, scaleX, scaleY } = factors;
  const byAxes = (x: number, y: number) => scaleCoordinate([x, y], anchor, scaleX, scaleY);
  const uniform = (x: number, y: number) =>
    scaleCoordinate([x, y], anchor, uniformScale, uniformScale);
  const kinds = {
    axes: [] as number[],
    scale: [] as number[],
    circle: [] as number[],
    custom: [] as number[],
  };
  for (const handle of rows.handles) {
    const place = livePlaceOf(internals, handle);
    if (!place) continue;
    const view = tables.get(place.layer.layerId);
    const type = view?.getRowType(handle) ?? null;
    if (type !== null && extensions?.getCustomResizeCalculator(type)) {
      kinds.custom.push(handle);
      continue;
    }
    const strategy = type === null ? undefined : extensions?.getResizeStrategy(type);
    const scaled =
      strategy === 'scale' ||
      (strategy !== 'coordinates' &&
        (type === 'Image' || view?.getRowValue(handle, SCALE_KEY) !== undefined));
    if (scaled) kinds.scale.push(handle);
    else if (type === 'Circle') kinds.circle.push(handle);
    else kinds.axes.push(handle);
  }
  const geometryBy =
    (map: (x: number, y: number) => readonly [number, number]) =>
    (_handle: number, read: BulkRowReader) => {
      const geometry = mappedGeometry(read, map);
      return geometry === undefined ? null : [geometry];
    };
  return [
    { rows: kinds.axes, op: { kind: 'rows', fields: ['geometry'], write: geometryBy(byAxes) } },
    {
      rows: kinds.scale,
      op: {
        kind: 'rows',
        fields: ['geometry', `property:${SCALE_KEY}`],
        write: (_handle, read) => {
          const geometry = mappedGeometry(read, uniform);
          if (geometry === undefined) return null;
          const initial = readDrawProperty({ [SCALE_KEY]: read.value(SCALE_KEY) }, 'scale');
          return [geometry, (initial ?? 1) * uniformScale];
        },
      },
    },
    {
      rows: kinds.circle,
      op: {
        kind: 'rows',
        fields: ['geometry', `property:${RADIUS_KEY}`],
        write: (_handle, read) => {
          const geometry = mappedGeometry(read, uniform);
          if (geometry === undefined) return null;
          const initial = readDrawProperty(
            { [RADIUS_KEY]: read.value(RADIUS_KEY) },
            'radiusMeters',
          );
          return [geometry, (initial ?? 0) * uniformScale];
        },
      },
    },
    {
      rows: kinds.custom,
      op: customResize(store, resize, extensions),
    },
  ];
}

/**
 * The resize of rows of a type of an extension that computes its own: each row is made a feature
 * and resized as a resize drag resizes it (its coordinates, its width and its height)
 */
function customResize(
  store: Store,
  resize: Parameters<typeof resizeBulkSelection>[1],
  extensions?: ResizeExtensions,
): BulkOperation {
  const fields: RowField[] = [
    'geometry',
    'property:width',
    'property:height',
    `property:${SCALE_KEY}`,
    `property:${RADIUS_KEY}`,
  ];
  return {
    kind: 'rows',
    fields,
    write: (handle, read) => {
      const feature = store.tables?.get(read.place.layer.layerId)?.getRow(handle);
      if (!feature) return null;
      const state = startResize(
        resize.handle,
        resize.startLngLat,
        resize.bbox,
        [feature],
        extensions,
        resize.minAxisExtent ?? 0,
      );
      const result = computeResize(state, resize.currentLngLat, [feature], extensions).get(
        feature.id,
      );
      if (!result) return null;
      return [
        geometryFromCoordinates(feature.type, result.coordinates as FeatureCoordinates),
        result.width ?? read.value('width'),
        result.height ?? read.value('height'),
        result.scale ?? read.value(SCALE_KEY),
        feature.type === 'Circle' && result.radiusMeters !== undefined
          ? result.radiusMeters
          : read.value(RADIUS_KEY),
      ];
    },
  };
}
