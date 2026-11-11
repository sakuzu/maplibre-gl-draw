// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A page of the Tabane format as a page of the tables
 *
 * The columns of a page read are the columns of a feature (`columns.ts`), and they are taken
 * as columns: the points of the geometry are the coordinates of its children, the types, the
 * styles and the attributes are taken as they are. What is made here is what the columns of a
 * page leave to the reader: the ids as text (from their runs), the keys as text (the key of
 * each row of a page that writes them, or else its head and the numbers of its rows), the
 * hashes of the ids, the flags, the bbox of every row (it depends on the system of
 * the coordinates of the reader), and the fills of the rows that draw a ring around their
 * point (they depend on the types of the reader). The fills of the polygons are copied from the
 * cache of their triangles that follows the page in its file (`triangles.ts`) when it fits the
 * rows, and made otherwise.
 *
 * A pure module: it depends on nothing outside `/table` but its error and `@sakuzu/tabane`, so it
 * runs in a Worker as well.
 */

import type { Page, PointRowRings, RowRead, RowShape, RowShapeColumn } from '@sakuzu/kasane';
import {
  INT8_FORMS,
  type PageData,
  type PageWhole,
  ROW_FLAG_DELETED,
  RowCacheWriter,
  rowRingsOfPoint,
  type ShapeColumn,
  type ShapeForm,
} from '@sakuzu/kasane/render';
import {
  type CoordinateDimensions,
  type CoordinateSystem,
  copyCoordinates,
  dimsWithin,
  hashUtf8,
  idColumn,
  keyColumn,
  planarCoordinates,
  readValue,
  strideOf,
  type TabaneCache,
  type TabaneRowBlock,
  type TabaneShapeColumn,
  tabaneFlagOf,
} from '@sakuzu/tabane';
import { DrawError } from '../../shared/draw-error.js';
import { circleRowRings } from '../circle-rings.js';
import {
  FEATURE_COLUMN_LAYOUT,
  GEOMETRY_COLUMN,
  PROPERTIES_COLUMN,
  ROW_FLAG_HIDDEN,
  ROW_FLAG_LOCKED,
  STYLE_COLUMN,
  TYPE_COLUMN,
} from '../feature-row-columns.js';
import { FEATURE_CACHES, FILL_TRIANGLES, fillTrianglesFit } from '../fill-triangles.js';
import { WIDE_VERTICES } from '../row-geometry.js';
import type { TableGeometry } from '../types.js';
import { featureColumnsOf, geometryTypeOf, stylesOf, typesOf } from './columns.js';
import { type CachedFills, FILL_TRIANGLES_CACHE, readFillTrianglesCache } from './triangles.js';

/**
 * The options of {@link toPage}
 *
 * @experimental
 */
export interface ToPageOptions {
  /**
   * The dimensions of the coordinates of the layer (those of the page when omitted); a page of
   * fewer dimensions gets NaN for the others, one of more is refused
   */
  readonly dimensions?: CoordinateDimensions;
  /** The system of the coordinates of the bbox (the plane when omitted) */
  readonly coordinateSystem?: CoordinateSystem;
  /** The rings the rows of some types draw around their point (the Circles when omitted) */
  readonly rings?: PointRowRings;
  /**
   * The caches that follow the page in its file (those of its part, `TabaneBlockFile.caches`
   * whose `part` is the number of the page plus one): the triangles of its polygons are
   * copied from the one of the triangles when it fits the rows, and made when there is none or it
   * does not fit. A cache of another name is not read
   */
  readonly caches?: readonly TabaneCache[];
}

/** The first coordinate of a row of a child of a geometry (its end is the first of the next row) */
function vertexStart(child: ShapeForm, row: number): number {
  let first = row;
  const levels = child.offsets;
  if (levels) for (let k = 0; k < levels.length; k++) first = levels[k][first];
  return first;
}

/**
 * The geometry of the shapes of a page, its points with the coordinates of `dims`: the
 * points of each form are the coordinates of a child, the form of each row its child (null for a
 * page without the column)
 */
function geometryOf(
  column: TabaneShapeColumn | null,
  dims: CoordinateDimensions,
): ShapeColumn | null {
  if (column === null) return null;
  const from = column.dimensions;
  if (!dimsWithin(from, dims))
    throw new DrawError('invalid-input', `Tabane: coordinates of ${from} in a layer of ${dims}`);
  const stride = strideOf(dims);
  const children: TableGeometry[] = column.forms.map((form) => {
    const type = geometryTypeOf(form.name, form.depth);
    let coords = form.points;
    if (from !== dims) {
      const count = coords.length / strideOf(from);
      coords = new Float64Array(count * stride);
      copyCoordinates(form.points, from, 0, count, coords, dims, 0);
    }
    return form.offsets.length > 0
      ? { type, coords, dimensions: dims, offsets: [...form.offsets] }
      : { type, coords, dimensions: dims };
  });
  return {
    // The form of each row in one byte, but past 127 forms
    types: column.forms.length > INT8_FORMS ? column.formIndex : Int8Array.from(column.formIndex),
    offsets: column.formRow,
    children,
  };
}

/**
 * A page as a page of the tables (for `FeatureTablesWriter.addPages`), its columns
 * taken as they are
 *
 * @throws `DrawError` with the code `invalid-input` when the page has a dimension the layer
 *   does not, or is not one of features: a column that is not one of `TABANE_FEATURE_COLUMNS` or
 *   of another kind, a row without a type, a geometry of another name or depth, a style that is
 *   not an object
 * @experimental
 */
export function toPage(rowBlock: TabaneRowBlock, options: ToPageOptions = {}): Page {
  return pageDataOfTabane(rowBlock, options);
}

/**
 * A page as a page with every column, as the tables read it
 *
 * @internal
 */
export function pageDataOfTabane(rowBlock: TabaneRowBlock, options: ToPageOptions = {}): PageData {
  const n = rowBlock.length;
  const columns = featureColumnsOf(rowBlock);
  const dims = options.dimensions ?? columns.geometry?.dimensions ?? 'xy';
  const system = options.coordinateSystem ?? planarCoordinates;
  const rings = options.rings ? rowRingsOfPoint(options.rings) : circleRowRings;
  const geometry = geometryOf(columns.geometry, dims);
  const stride = strideOf(dims);
  const { typeNames, types } = typesOf(columns.type, n);
  const { styleDictionary, styles } = stylesOf(columns.style, n);
  const properties = columns.properties;

  const ids = idColumn(rowBlock);
  const idHashes = new Uint32Array(n);
  for (let r = 0; r < n; r++) idHashes[r] = hashUtf8(ids, r);

  // The flag columns are taken as they are, a bit each
  const flags = new Uint8Array(n);
  for (let r = 0; r < n; r++) {
    flags[r] =
      (tabaneFlagOf(columns.hidden, r) ? ROW_FLAG_HIDDEN : 0) |
      (tabaneFlagOf(columns.locked, r) ? ROW_FLAG_LOCKED : 0) |
      (tabaneFlagOf(rowBlock.deleted, r) ? ROW_FLAG_DELETED : 0);
  }

  // What the rings and the caches read of a row: its type, its attributes and its shape
  const columnOf = new Map<string, number>();
  properties.keys.forEach((key, c) => {
    columnOf.set(key, c);
  });
  const drawsRing = typeNames.map((t) => rings.draws(t));
  const shapeColumns: RowShapeColumn[] = (geometry?.children ?? []).map((child) => ({
    type: child.type,
    coords: child.coords,
    stride,
    offsets: child.offsets ?? [],
  }));
  let at = 0;
  const read: RowRead = {
    handle: -1,
    get type() {
      return typeNames[types[at]];
    },
    value: (key) => {
      const k = columnOf.get(key);
      return k === undefined ? undefined : readValue(properties.columns[k], at);
    },
    shape: (): RowShape | null => {
      const c = geometry ? geometry.types[at] : -1;
      return c < 0 || !geometry ? null : { column: shapeColumns[c], at: geometry.offsets[at] };
    },
  };

  // The triangles of the polygons kept with the block, copied when they fit every row: the
  // number of vertices kept with them is the one of the fill of the row too
  const file = options.caches?.find((c) => c.name === FILL_TRIANGLES_CACHE);
  let fills: CachedFills | null = file
    ? readFillTrianglesCache(file.content, n, columns.geometry)
    : null;
  if (fills) {
    for (at = 0; at < n; at++) {
      if (fills.vertices[at] < 0) continue;
      const kept = fills.indices.subarray(fills.offsets[at], fills.offsets[at + 1]);
      if (!fillTrianglesFit(read, null, kept, fills.vertices[at])) {
        fills = null;
        break;
      }
    }
  }

  const rowBounds = new Float64Array(n * 4);
  const caches = FEATURE_CACHES.map((cache) => new RowCacheWriter(cache.name, cache.width, n));
  let vertexCount = 0;
  for (at = 0; at < n; at++) {
    const r = at;
    const c = geometry ? geometry.types[r] : -1;
    if (c < 0 || !geometry) {
      rowBounds.fill(Number.NaN, r * 4, r * 4 + 4);
      for (const cache of caches) cache.skip(r);
      continue;
    }
    const child = geometry.children[c];
    const row = geometry.offsets[r];
    const first = vertexStart(child, row);
    const end = vertexStart(child, row + 1);
    let ring: Float64Array | null = null;
    if (child.type === 'Point' && drawsRing[types[r]]) {
      ring = rings.ringOf(read);
      vertexCount += ring ? ring.length / 2 : 1;
      if (ring) system.rowBox(ring, 2, 0, ring.length / 2, rowBounds, r * 4);
      else system.rowBox(child.coords, stride, first, end, rowBounds, r * 4);
    } else {
      vertexCount += end - first;
      system.rowBox(child.coords, stride, first, end, rowBounds, r * 4);
    }
    for (let k = 0; k < caches.length; k++) {
      const cache = FEATURE_CACHES[k];
      if (fills && cache === FILL_TRIANGLES && fills.vertices[r] >= 0) {
        const from = fills.offsets[r];
        const to = fills.offsets[r + 1];
        caches[k].put(r, fills.indices, from, to, fills.vertices[r] >= WIDE_VERTICES);
      } else {
        caches[k].put(r, cache.build(read, ring));
      }
    }
  }

  const shapes: Array<ShapeColumn | null> = FEATURE_COLUMN_LAYOUT.shapes.map(() => null);
  shapes[GEOMETRY_COLUMN] = geometry;
  const wholes: Array<PageWhole | null> = FEATURE_COLUMN_LAYOUT.wholes.map(() => null);
  wholes[TYPE_COLUMN] = { indexes: types, values: typeNames };
  wholes[STYLE_COLUMN] = { indexes: styles, dictionary: styleDictionary };
  const keyed = FEATURE_COLUMN_LAYOUT.keyed.map(() => null as typeof properties | null);
  keyed[PROPERTIES_COLUMN] = properties.keys.length > 0 ? properties : null;
  return {
    length: n,
    handles: new Int32Array(n).fill(-1),
    ids,
    idHashes,
    shapes,
    wholes,
    keyed,
    keys: keyColumn(rowBlock),
    groups: new Int32Array(n).fill(-1),
    flags,
    rowBounds,
    caches: caches.map((cache) => cache.finish()),
    vertexCount,
  };
}
