// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The document the built-in Store holds: the rows of the features in the tables of
 * `@sakuzu/kasane`, one table per layer, and the layers, the groups, the stacking order, the
 * embedded files and the metadata as frozen objects.
 *
 * The rows are held in these columns of the tables:
 *
 * - `type`: the type of the feature (`FeatureRowField` `type`)
 * - `geometry`: the positions, one shape per row, named by the GeoJSON type of the geometry
 *   (`Point` has depth 0, `LineString` and `MultiPoint` 1, `Polygon` and `MultiLineString` 2,
 *   `MultiPolygon` 3) in the dimensions of the table of its layer
 * - `style`: the whole style, one frozen object that the rows of the same style share, kept by
 *   the tables
 * - `properties`: the attributes, a key per attribute (`properties:<key>`)
 * - `hidden` and `locked`: flags; `visible` is read as the opposite of `hidden`
 *
 * The fixed fields of the tables are the place of a row: `parent` (a layer or a group) and `key`
 * (its `orderKey`). A group of rows is a group of the tables too, with its id, its layer as its
 * parent, its key and its `hidden` flag; the rest of a group is its frozen object here.
 *
 * The reference of a row is never taken from its id while the document is open: the id of a
 * deleted row is read from its reference until the document is cleared, and after it (a row whose
 * id comes back keeps its reference).
 *
 * Nothing here is shared between two documents: every document has its own tables, objects,
 * transactions and numbers of work.
 *
 * @internal
 */

import { createTables, type TableColumns } from '@sakuzu/kasane';
import type { FileData, Layer, Metadata } from '../../api/model.js';
import { createWorkCounts } from '../../shared/work-counts.js';
import { createChanges } from './changes.js';
import type { RowSpatialIndexing, StoreGroup } from './types.js';

/**
 * The columns of the rows of the features
 *
 * @internal
 */
export const ROW_COLUMNS: TableColumns = Object.freeze({
  type: 'value',
  geometry: 'shape',
  style: Object.freeze({ type: 'value', dictionary: 'tables' }),
  properties: 'struct',
  hidden: 'flag',
  locked: 'flag',
});

/**
 * The columns of the groups of rows, besides their fixed fields (`id`, `parent`, `key`)
 *
 * @internal
 */
export const GROUP_COLUMNS: TableColumns = Object.freeze({ hidden: 'flag' });

/** The bit of the state of a row that is not visible itself */
const STATE_HIDDEN = 1 << 7;
/** The bit of the state of a row whose group is not visible */
const STATE_GROUP_HIDDEN = 1 << 8;

/**
 * How the positions of the rows of a layer are held: the number of values of a position, and
 * what the third one is when there are three
 *
 * @internal
 */
export interface LayerPositions {
  readonly valuesPerPosition: 2 | 3 | 4;
  readonly thirdValue: 'height' | 'measure';
}

/** The positions of a layer given no options: longitude and latitude */
const PLANE_POSITIONS: LayerPositions = Object.freeze({
  valuesPerPosition: 2,
  thirdValue: 'height',
});

/**
 * The dimensions of the table of a layer whose positions are held so
 *
 * @internal
 */
export function dimensionsOfPositions(positions: LayerPositions): 'xy' | 'xyz' | 'xym' | 'xyzm' {
  if (positions.valuesPerPosition === 2) return 'xy';
  if (positions.valuesPerPosition === 4) return 'xyzm';
  return positions.thirdValue === 'measure' ? 'xym' : 'xyz';
}

/**
 * Opens an empty document
 *
 * @param spatialIndexing - How the boxes of the rows and the order of their spatial index are
 *   computed (the plane of the longitudes and latitudes when it is left out)
 * @internal
 */
export function openDocument(spatialIndexing?: RowSpatialIndexing) {
  /** How the positions of each layer are held, by the id of the layer */
  const layerPositions = new Map<string, LayerPositions>();
  const { tables, writer: rowWrites } = createTables({
    columns: ROW_COLUMNS,
    groupColumns: GROUP_COLUMNS,
    valueStates: Object.freeze({
      rowFlags: Object.freeze([Object.freeze({ column: 'hidden', states: STATE_HIDDEN })]),
      groupFlags: Object.freeze([Object.freeze({ column: 'hidden', states: STATE_GROUP_HIDDEN })]),
    }),
    hiddenMask: STATE_HIDDEN | STATE_GROUP_HIDDEN,
    dimensionsOf: (layerId) =>
      dimensionsOfPositions(layerPositions.get(layerId) ?? PLANE_POSITIONS),
    ...(spatialIndexing && { coordinateSystem: spatialIndexing }),
  });
  const counts = createWorkCounts();
  return {
    /** The reading side of the tables of the rows */
    rows: tables,
    /** The writing side of the tables of the rows */
    rowWrites,
    /** How the positions of each layer are held, by the id of the layer */
    layerPositions,
    /** The layers, by id */
    layers: new Map<string, Layer>(),
    /** The groups, by id */
    groups: new Map<string, StoreGroup>(),
    /** The embedded files, by id */
    files: new Map<string, FileData>(),
    /** The stacking order, from the back (a frozen array, replaced as a whole) */
    layerOrder: Object.freeze([]) as readonly string[],
    /** The metadata (a frozen object, replaced as a whole) */
    metadata: Object.freeze({}) as Metadata,
    /** The reference the next group is given in the tables */
    nextGroupRef: 1,
    /** The amounts of work done */
    counts,
    /** The transactions, the listeners, and the deleted rows kept for them */
    changes: createChanges(
      counts,
      rowWrites,
      (layerId) => (layerPositions.get(layerId) ?? PLANE_POSITIONS).valuesPerPosition,
    ),
  };
}

/**
 * The document the built-in Store holds
 *
 * @internal
 */
export type StoreDocument = ReturnType<typeof openDocument>;

/**
 * How the positions of the rows of a layer are held (those of a layer given no options when it
 * is not there)
 *
 * @internal
 */
export function positionsOf(document: StoreDocument, layerId: string): LayerPositions {
  return document.layerPositions.get(layerId) ?? PLANE_POSITIONS;
}

/**
 * The layer of the parent of a row: the parent when it is a layer, the layer of the group it
 * names otherwise (undefined for a row that is not there)
 *
 * @internal
 */
export function layerOfParent(document: StoreDocument, parent: unknown): string | undefined {
  if (typeof parent !== 'string') return undefined;
  if (document.layers.has(parent)) return parent;
  return document.groups.get(parent)?.layerId ?? parent;
}
