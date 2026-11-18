// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The public types of the store entry that the built-in Store implements: the Store, its read
 * side, the tables of the rows, the values of rows and their geometries, and the options of the
 * built-in Store. The text of each declaration is that of the fixed declarations of the entry.
 */

import type {
  FeatureStyle,
  FeatureType,
  FileData,
  Group,
  Layer,
  Metadata,
} from '../../api/model.js';

/**
 * The Store with its writes: what the `store` option of `createDraw` takes, and what
 * `draw.getStore()` and the `store` of the context of an extension return.
 *
 * The instance reads and writes the document only through these members. It holds the features
 * as rows (`tables`, `createRows`, `createRowsFromPages`, `writeRows`), and the layers, the groups,
 * the stacking order, the files and the metadata as objects. The state of this client (the
 * selection, the editing, the selected vertices, the mode, read-only, the interaction lock and the
 * items hidden here) is kept by the instance, not by the Store.
 *
 * The Store reads and writes values and tells of their changes, and does nothing else:
 *
 * - It does not compute. A move, a rotation or a scaling is computed by the instance, and the
 *   Store is given the values it computed. So is a new key of the order of an item.
 * - It does not check read-only, the interaction lock, nor the locks of the features, groups and
 *   layers. The instance checks them before it calls the Store. A write made to the Store directly
 *   therefore applies whatever the state of this client is, and is drawn on a client that only
 *   views the document too. To a Store an instance uses, it is meant for one kind of write only:
 *   a change made outside the instance, written with the source `'remote'`
 *   (`store.transact(fn, 'remote')`), a large document opened from pages built in a Worker
 *   included. The source `'load'` is that of `draw.document.load`, which the instance writes. An
 *   edit of the user, and the writing back of the values a change had before, go through `draw`
 *   (`draw.features.restore`). A Store no instance uses (one made with {@link createStore} and
 *   not given to `createDraw`) takes writes of any source: a test writes to it with `'local'`
 *   in place of the edits of a user, say.
 * - A transaction of another source is not run inside a transaction (see
 *   {@link StoreView.transact}). The transactions of an instance (`draw.transact`) are
 *   transactions of its Store, so the same rule stops a write made directly inside an edit of
 *   the user, and an edit of the user inside a write made directly: a write made directly never
 *   takes the source of an edit of the user.
 * - It does nothing by itself, with one exception. It does not delete a group that has no member
 *   left, nor move the members of a group it deletes; the instance writes what follows from an
 *   edit, and a caller that writes to the Store directly writes it as well. The exception is a
 *   group given another layer (`updateGroup` with `layerId`): its members go with it, as they must
 *   stay in the layer of their group, and are listed as rows updated.
 *
 * A Store keeps the rules of {@link StoreView} and these:
 *
 * - Unique ids: the ids of the features (the rows) and the groups are unique together, as the
 *   `parent` of a row names a group or a layer; the ids of the layers are unique, and the Stores
 *   of the library refuse a layer whose id is that of a group and a group whose id is that of a
 *   layer. The ids of files are unique. A write that would take an id in use does not apply. The
 *   id of a deleted row that a {@link DeletedRowsToken} keeps stays in use until the token is let
 *   go of.
 * - Writes return whether they applied: true when the write changed the Store, false when it did
 *   not apply, changing nothing (an id in use, or a reason of the Store's own, such as a place to
 *   keep the document that is full). A write whose argument cannot apply (a row or an id that
 *   names nothing, a value of the wrong kind) may throw instead, storing nothing.
 * - A write of many rows or pages applies to all of them or to none. The rows of one write
 *   (`createRows`, `writeRows`) and of one read (`tables.readValues`) are those of one layer, so
 *   that their geometries have one number of values per position.
 * - The stacking order: `createLayer` adds the new layer at the front unless the order already
 *   holds it, `deleteLayer` takes it out, and no other write adds or removes entries. The change
 *   of a `createLayer` and of a `deleteLayer` always carries the change of the stacking order
 *   (`layers.orderChanged`), whether or not the order held the layer.
 *
 * The built-in Store is a plain object whose members do not depend on `this`, so it can be spread
 * into a new object that replaces some of them (see {@link createStore}). Its `tables` are what
 * the instance draws and hit tests the rows from: a Store of your own hands out those of a
 * built-in Store it wraps.
 */
export interface Store extends StoreView {}

/**
 * The read side of the Store: the document, and the subscription to its changes.
 *
 * What it returns and tells keeps these rules:
 *
 * - Returned objects are never changed afterwards. Callers treat what a getter returns or a change
 *   carries as read-only, and the Store never changes such an object: a change stores a new
 *   object. The arrays of values read from `tables` are new ones each time.
 * - The stacking order (`getLayerOrder()`) is part of the document. It may hold entries that are
 *   not layers (a dataset with `order: 'layerOrder'`, a separator of the application), and its
 *   entries are distinct non-empty strings.
 * - One change per outermost transaction: `subscribe` delivers one {@link StoreChange} per
 *   outermost `transact` (or per write outside one, with the source `'remote'`) that changed the
 *   document. The transactions inside another fold into the outermost one. The listeners are
 *   called when the outermost transaction ends, before `transact` returns, in the order they
 *   subscribed.
 * - An operation is always closed: a transaction that gives an `operationId` and is the last
 *   part of its operation (without `hasMoreParts`) is told as one change even when it changed
 *   nothing, so that every listener sees the operation end. An operation a caller leaves open is
 *   taken as ended at the next change with `reset`, or when the instance is destroyed.
 * - What a listener reads while a change is told is the document right after that change, and
 *   the values a change wrote are read from `tables` while it is told. A listener does not write
 *   to the Store while it is called: a write (or a `transact`) made then throws `DrawError` with
 *   the code `invalidState`. A listener that must write does so after the change has been told,
 *   in a task of its own:
 *
 *   ```ts
 *   store.subscribe((change) => {
 *     // Not here: the other listeners of this change are still being told
 *     queueMicrotask(() => {
 *       store.transact(() => writeWhatFollows(change), 'remote');
 *     });
 *   });
 *   ```
 *
 *   The events of the instance (`draw.on`, `draw.document.subscribe`) are told once the Store has
 *   told every one of its listeners, so their listeners can write (through `draw`, or to the
 *   Store).
 * - A change written to the Store directly is followed by the instance: an item deleted leaves the
 *   selection, the editing and the items this client hides (at the end of its operation, for an
 *   operation in parts), and a feature it changes is drawn as it is now.
 * - An optional field (`Layer.metadata`, `Layer.styleRule`) may be given as `null`: null is
 *   accepted and read as `undefined`.
 */
export interface StoreView {
  /**
   * The features of the document, as rows of columns, one table per layer: read their references,
   * ids, items and values without making a feature per row.
   */
  readonly tables: FeatureTables;
  /** A layer by id, or `undefined` */
  getLayer(id: string): Layer | undefined;
  /** Every layer, in no particular order */
  listLayers(): Layer[];
  /** The stacking order, from the back: the layers and the entries from outside the document */
  getLayerOrder(): readonly string[];
  /** A group by id, or `undefined` */
  getGroup(id: string): StoreGroup | undefined;
  /** Every group, in no particular order */
  listGroups(): StoreGroup[];
  /** An embedded file by id, or `undefined` */
  getFile(id: string): FileData | undefined;
  /** Every embedded file */
  listFiles(): FileData[];
  /** The title and the description */
  getMetadata(): Metadata;
}

/**
 * A group as the Store holds it: a `Group` of the main entry with the key of its place among the
 * items of its layer, which the main entry does not show. Its members are the rows whose `parent`
 * is its id, read from the table of its layer (`listGroupMembers`). A layer is held as a `Layer`
 * of the main entry, as it is; its items, in their order, are read from its table
 * (`tables.get(id).listItemRefs`).
 */
export interface StoreGroup extends Group {
  /** The key of its place among the items of its layer, as the `orderKey` of a row */
  orderKey: string;
}

/**
 * The reference of a row: a number the document gives a row the first time it sees its id, and
 * never changes while the document is open, whatever group, layer or place the row moves to. A
 * caller that keeps a value per row outside the row keys it by the reference.
 */
export type RowRef = number;

/**
 * A field of the values of a row of a feature, and the value each row has in it. A value that
 * breaks the rule of its field makes the whole write refused (see {@link Store}); a caller that
 * writes values that came from elsewhere checks them first with {@link validateRowValues}.
 *
 * - `type`: the type of the feature (`'Polygon'`, `'Circle'`, the name of a custom type), a
 *   non-empty string
 * - `geometry`: the positions; named so in the lists of fields (`LayerRowsChange.fields`,
 *   `readValues`), its values travel as a {@link GeometryColumn} (`RowValues.geometry`), never as
 *   values of `fields`. Its positions have the number of values of the layer
 *   (`tables.getValuesPerPosition`), every value a finite number, and the rings of its polygons
 *   are closed
 * - `visible`: true for a feature that is visible itself, as `Feature.visible`; a boolean
 * - `locked`: true for a feature that is locked; a boolean
 * - `style`: the whole style of the feature, an object (`{}` for none) whose values are strings
 *   and finite numbers; a key the library does not know is kept
 * - `style:<key>`: one key of the style (`style:fillColor`), a string or a finite number;
 *   writing `undefined` takes the key off. A caller that keeps or writes back what changed reads
 *   the keys written, not the whole object
 * - `properties:<key>`: one attribute of the feature, by its key (`properties:name`): a value
 *   JSON holds (a string, a finite number, a boolean, `null`, or arrays and plain objects of
 *   them), never a function; writing `undefined` takes the key off
 * - `parent`: the id of the group the feature is in, or of its layer when it is in no group, a
 *   string that names a group of the layer or the layer itself. It is one field for the two
 *   values `layerId` and `groupId` of a `Feature` of the main entry: a row whose `parent` names a
 *   group is in the layer of that group
 * - `orderKey`: the place of the feature among the items of its parent, a non-empty string. The
 *   items of a layer (its rows outside a group, and its groups) and the members of a group are
 *   drawn in the order of their keys, compared as strings of bytes, from the back; items whose
 *   keys are equal (two clients that put an item at the same place) are drawn in the order of
 *   their ids, compared the same way, so that every client draws them in the same order. The
 *   instance makes a new key between the keys of the items next to the place; a caller that
 *   writes to the Store directly makes one with {@link createOrderKeyBetween}, or writes one
 *   it read
 *
 * The deletion of rows is not a field: it is `deleted` of {@link RowValues}.
 */
export type FeatureRowField =
  | 'type'
  | 'geometry'
  | 'visible'
  | 'locked'
  | 'style'
  | `style:${string}`
  | 'parent'
  | 'orderKey'
  | `properties:${string}`;

/**
 * Values of rows: the rows by their references, the values of fields (one per row), their
 * geometries, and their deletion. Read from the rows (`tables.readValues`), they are the values
 * the rows have; written to them (`writeRows`), they put the values there.
 */
export interface RowValues {
  /** The rows */
  readonly rows: Int32Array;
  /**
   * The values of each field, one per row, entry `i` for row `i` (the field `geometry` is not
   * here: see `geometry`)
   */
  readonly fields: ReadonlyMap<FeatureRowField, readonly unknown[]>;
  /** The geometries of the rows, when they are read or written */
  readonly geometry?: GeometryColumn;
  /**
   * Non-zero for a row deleted, zero for a row not deleted (a row deleted and kept, written zero,
   * comes back at its place as it was); absent when the deletion is not read or written
   */
  readonly deleted?: Uint8Array;
}

/**
 * The geometries of rows as flat arrays, without an object per row: entry `i` of `types`,
 * `partStarts` is row `i`. Every geometry is read as parts made of rings made of positions: a
 * Point is one part of one ring of one position, a LineString one part of one ring, a Polygon one
 * part of its rings, and a Multi geometry one part per member.
 *
 * The rows of 100,000 polygons of six positions read so take one array of 600,000 positions and
 * three arrays of starts.
 */
export interface GeometryColumn {
  /** The type of the geometry of each row, as its index in {@link GEOMETRY_TYPES}; 255 for none */
  readonly types: Uint8Array;
  /**
   * The positions of every row, one after the other, `valuesPerPosition` numbers each: the
   * longitude and the latitude in degrees, then the height in meters or the measure when the layer
   * has them; the rings closed
   */
  readonly coordinates: Float64Array;
  /** The number of values of a position: 2, 3 or 4 */
  readonly valuesPerPosition: number;
  /** Where the parts of each row start, in parts (one more entry than there are rows) */
  readonly partStarts: Int32Array;
  /** Where the rings of each part start, in rings (one more entry than there are parts) */
  readonly ringStarts: Int32Array;
  /** Where the positions of each ring start, in positions (one more entry than there are rings) */
  readonly positionStarts: Int32Array;
}

/** The types of the geometries, by their index in {@link GeometryColumn.types}. */
export const GEOMETRY_TYPES: readonly [
  'Point',
  'LineString',
  'Polygon',
  'MultiPoint',
  'MultiLineString',
  'MultiPolygon',
] = Object.freeze([
  'Point',
  'LineString',
  'Polygon',
  'MultiPoint',
  'MultiLineString',
  'MultiPolygon',
] as const);

/** Items of a layer, in their order: rows outside a group, and groups. */
export interface ItemRefs {
  /** The kind of each item: 0 for a row, 1 for a group */
  readonly kinds: Uint8Array;
  /** The reference of each item: of its row, or of its group ({@link FeatureTables.findGroup}) */
  readonly refs: Int32Array;
}

/**
 * The features of a document held as rows: what the Store hands out as its `tables`, to read
 * without making a feature per row.
 */
export interface FeatureTables {
  /** The rows of a layer (undefined for a layer that holds no rows) */
  get(layerId: string): LayerTableView | undefined;
  /** The reference of the row of an id (undefined for an unknown id, or a deleted row) */
  getRowRef(id: string): RowRef | undefined;
  /**
   * The reference of the row of an id, a deleted row kept included, and whether it is deleted:
   * what a caller that brings deleted rows back by their ids reads. A deleted row is kept by a
   * {@link DeletedRowsToken}, and by the values of features of the main entry
   * (`FeatureValues`) that keep it (undefined for an id never seen, or let go of)
   */
  findRow(id: string):
    | {
        readonly ref: RowRef;
        readonly deleted: boolean;
      }
    | undefined;
  /** The id of the row of a reference (undefined for an unknown reference) */
  getRowId(ref: RowRef): string | undefined;
  /** The reference of a group by its id (undefined for an unknown group) */
  findGroup(id: string): number | undefined;
  /** The id of the group of a reference (undefined for an unknown reference) */
  getGroupId(groupRef: number): string | undefined;
  /**
   * The number of values of each position of the rows of a layer
   * ({@link LayerRowOptions.valuesPerPosition}), or undefined for a layer that is not there
   */
  getValuesPerPosition(layerId: string): 2 | 3 | 4 | undefined;
  /**
   * What the third value of the positions of a layer is ({@link LayerRowOptions.thirdValue}):
   * `height` or `measure` for a layer of 3 values, `height` for one of 4 (the fourth is the
   * measure), or undefined for a layer of 2 values or one that is not there
   */
  getThirdValue(layerId: string): 'height' | 'measure' | undefined;
  /**
   * Reads the references of the rows of layers, a batch at a time (the deleted rows left out);
   * read their values with `readValues` or {@link LayerTableView}.
   */
  scan(options?: TableScanOptions): RowCursor;
  /**
   * The values the fields given have now, for the rows given: only those fields are read, and the
   * geometries only when `geometry` is among them, as a {@link GeometryColumn}. With
   * `deleted: true`, the deletion is read as well (a row that is not there counting as deleted).
   * Written back, the values put the rows back as they are now.
   *
   * A deleted row that is kept (by a {@link DeletedRowsToken}, or by values of features of the
   * main entry, `FeatureValues`) is read too, by its reference: its fields give the values it had
   * when it was deleted, and `deleted` gives 1. A row that nothing keeps any more is not there.
   *
   * The rows are those of one layer, so that the geometries have one number of values per
   * position.
   *
   * @throws `DrawError` with the code `invalidInput` when the rows are in more than one layer
   */
  readValues(
    rows: Int32Array,
    fields: readonly FeatureRowField[],
    options?: {
      readonly deleted?: boolean;
    },
  ): RowValues;
}

/** The rows of one layer, read without making features. */
export interface LayerTableView {
  /** The layer */
  readonly layerId: string;
  /** The number of rows, deleted rows left out */
  readonly rowCount: number;
  /**
   * The references of the rows that are drawn (not hidden), whose box as drawn meets a box
   * `[west, south, east, north]`,
   * in the order of the layer (a hidden row is not drawn): what is drawn with the rows in view (a
   * label of each) reads, without a feature per row. The box as drawn is the box of the positions
   * of the row in the document, or for a type whose extent is worked out from its feature (an
   * Image, a Circle, a type that gives its `bbox`), the box it covers. The Store holds the
   * document: the sketches of an instance, which change no row, are not applied here
   * (`draw.rendered` reads a feature as it is drawn)
   */
  listDrawnRows(bbox: [number, number, number, number]): Int32Array;
  /** Changes whenever the rows drawn may have changed (added, hidden, shown, moved) */
  getDrawnRowsRevision(): number;
  /** The box of the positions of a row, `[west, south, east, north]` (null for none) */
  getRowBBox(ref: RowRef): [number, number, number, number] | null;
  /** The type of a row (null for a row not in this layer) */
  getRowType(ref: RowRef): FeatureType | null;
  /** The position of a row whose geometry is a Point (null for any other row) */
  getPointPosition(ref: RowRef): [number, number] | null;
  /** The value of one attribute of a row, read alone (undefined when it does not hold the key) */
  getRowProperty(ref: RowRef, key: string): unknown;
  /**
   * The style of a row, read alone: the object the rows of the same style share, frozen, read
   * without a copy (undefined for a row not in this layer)
   */
  getRowStyle(ref: RowRef): Readonly<FeatureStyle> | undefined;
  /** The references of `count` rows from the `start`-th one, in the order of the layer */
  listRowRefs(start: number, count: number): Int32Array;
  /**
   * The number of items of the layer: its rows outside a group, and its groups (a group is one
   * item, at the place of its members), deleted rows left out
   */
  readonly itemCount: number;
  /** `count` items from the `start`-th one, in the order of the layer */
  listItemRefs(start: number, count: number): ItemRefs;
  /** The number of the rows of a group in this layer (deleted rows left out) */
  countGroupMembers(groupRef: number): number;
  /**
   * The references of `count` rows of a group from the `start`-th one, in the order of the layer
   * (they follow each other at the place of the group)
   */
  listGroupMembers(groupRef: number, start: number, count: number): Int32Array;
}

/** What {@link FeatureTables.scan} reads. */
export interface TableScanOptions {
  /** The layers read, in this order (every layer that holds rows when omitted) */
  readonly layerIds?: readonly string[];
  /**
   * Only the rows whose box as drawn meets this box, `[west, south, east, north]` (the box as
   * drawn of {@link LayerTableView.listDrawnRows})
   */
  readonly bbox?: [number, number, number, number];
  /** The number of references read at a time (1,024 when omitted) */
  readonly batchSize?: number;
}

/** Reads the references of rows a batch at a time. */
export interface RowCursor {
  /** The references of the next rows (null once every row is read) */
  next(): Int32Array | null;
}

/** The options of {@link createStore}. */
export interface StoreOptions {
  /**
   * How the boxes of the rows and the order of their spatial index are computed from their
   * positions (the plane of the longitudes and latitudes when it is left out): for positions whose
   * boxes are computed otherwise, such as across the ±180 degree meridian. A Worker that builds
   * pages is given the same ({@link RowPageBuilderOptions.spatialIndexing})
   */
  readonly spatialIndexing?: RowSpatialIndexing;
}

/**
 * How the boxes of rows and the order of their spatial index are computed from their positions
 * ({@link StoreOptions.spatialIndexing}). Only the first two values of a position are read.
 */
export interface RowSpatialIndexing {
  /**
   * Writes the box of the positions `[from, to)` as `[minX, minY, maxX, maxY]` into
   * `out[at..at + 4]`: four NaN when there is no position, or one has a NaN.
   *
   * @param coordinates - The positions, `valuesPerPosition` values each
   */
  rowBox(
    coordinates: Float64Array,
    valuesPerPosition: number,
    from: number,
    to: number,
    out: Float64Array,
    at: number,
  ): void;
  /**
   * The key the boxes are put in order by in the spatial index (for the index only, not the
   * `orderKey` of the stacking order), from the center of a box (the
   * Hilbert curve over the plane when it is left out)
   */
  sortKey?(centerX: number, centerY: number): number;
}
