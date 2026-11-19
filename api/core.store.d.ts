// @sakuzu/maplibre-gl-draw/store (3.0 の案、第 3 稿。第 3 稿への批判の決め
// spec-draft/v3/REVIEW-DECISIONS.md を当てて直した)。Store を作る人と、外で起きた変更を Store に
// 書く人のための入口の宣言の全部。
// main の入口の型 (Layer、Group、Metadata、FileData、FeatureType、FeatureStyle、UpdateSource) は
// main の物を使う。行と列とページの型は、この入口が自分の宣言として見せる (Kasane の型を import
// しない。標準の Store の中で Kasane の表が持つ)。

import type { Geometry } from 'geojson';
import type {
  FeatureStyle,
  FeatureType,
  FileData,
  Group,
  Layer,
  Metadata,
  UpdateSource,
} from '@sakuzu/maplibre-gl-draw';

/**
 * The Store of a draw instance, for an application that keeps the document somewhere of its own,
 * and for writing into the document a change made outside the instance.
 *
 * The instance keeps its document in a Store: the features, held as rows of columns, and the
 * layers, the groups, the stacking order, the embedded files and the metadata. `createStore` makes
 * the built-in one, which holds the rows in the tables of `@sakuzu/kasane`; an application gives
 * its own in the `store` option of `createDraw`, and reaches the one an instance uses with
 * `draw.getStore()`, as an extension does with `ctx.store`.
 *
 * Come here to:
 *
 * - keep the document somewhere of your own, by wrapping the built-in Store and taking over some
 *   of its writes ({@link createStore})
 * - write into the document a change made outside the instance, such as one your application
 *   read from elsewhere, so that it shows on a client that only views the document as well
 *   (source `'remote'`), many rows at a time and without a feature per row
 * - open a large document from pages of rows built in a Worker ({@link createRowPageBuilder}),
 *   with the source `'remote'` as well
 *
 * The edits of the user do not come here: `draw.features` writes them, checking read-only and the
 * locks, and so does `draw.features.restore`, which writes back the values a change had before.
 * Most applications never import from here: the main entry is enough.
 *
 * ```ts
 * import { createDraw } from '@sakuzu/maplibre-gl-draw';
 * import { createStore } from '@sakuzu/maplibre-gl-draw/store';
 *
 * const base = createStore();
 * const store = { ...base, setMetadata: (m) => (m.title === '' ? false : base.setMetadata(m)) };
 * const draw = createDraw(map, { store });
 * store.subscribe((change) => console.log(change.source, change.rows?.layers.size));
 * ```
 *
 * @module maplibre-gl-draw/store
 */

// =============================================================================
// Store
// =============================================================================

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
 *   go of. The id of a deleted row that nothing keeps is free again: `createRows` takes it inside
 *   the transaction that deleted the row too (the row comes back with its reference, and the
 *   change lists it as updated), and pages take it once that transaction has ended.
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
export interface Store extends StoreView {
  /**
   * Creates rows: one feature per id, with the values given, in the layer or the group of its
   * `parent`. The rows of one call are those of one layer, and their geometries have the number
   * of values per position of that layer. The rows are given new references ({@link RowRef}),
   * which the change lists (`rows`, as `created`).
   *
   * The fields `type`, `parent` and `orderKey` are needed, and the geometry; the others, and a
   * value `undefined` in a field given, take the values of a new feature (visible, not locked, the
   * style `{}`, no attributes). See {@link FeatureRowField} for the fields and their values.
   *
   * @param rows - The ids of the new rows, the values of their fields and their geometries, one
   *   per id
   * @returns False when an id is in use or the Store does not take the rows (none is created)
   * @throws `DrawError` with the code `invalidInput` when a needed field is missing, a field is
   *   not one of a row, a value is not one of its field, the rows are in more than one layer, or
   *   the geometries have another number of values per position than the layer; nothing is
   *   created then
   */
  createRows(rows: NewRows): boolean;
  /**
   * Creates the rows of pages built in a Worker ({@link createRowPageBuilder}) in a layer at once,
   * without copying their columns: what a large document is opened from, a few pages at a time
   * so that the map keeps drawing between them. The rows are given references and are listed as
   * created in the change. The pages are kept as they are, so their arrays are not to be changed
   * afterwards.
   *
   * @param layerId - The layer the rows go into
   * @param pages - The pages
   * @returns False when the Store does not take the pages (none is added)
   * @throws `DrawError` with the code `notFound` when there is no such layer or a row names a
   *   group that is not there, `alreadyExists` when an id of a row is in use, or `invalidInput`
   *   when a page was built for other dimensions than those of the layer; nothing is added then
   */
  createRowsFromPages(layerId: string, pages: readonly RowPage[]): boolean;
  /**
   * Writes values of rows there are, by their references: the fields given and the geometry, for
   * the rows given ({@link RowValues}). `deleted` deletes a row (non-zero), or brings back a
   * deleted row that a {@link DeletedRowsToken} keeps (zero), with its values and at its place as
   * they were: it is how a change made outside the instance is written, deletions and the rows
   * that come back included.
   *
   * A new `parent` puts a row in another layer or group (into the layer of the group), and a new
   * `orderKey` puts it in another place there. The rows of one call are those of one layer.
   *
   * A deleted row that a {@link DeletedRowsToken} keeps, and one that values of features keep on
   * the main entry (`FeatureValues`), are found by their ids with `tables.findRow`.
   *
   * @param values - The rows, the values of their fields, their geometries and their deletion
   * @returns False when the Store does not take the write (nothing is written)
   * @throws `DrawError` with the code `notFound` when a reference names no row (or a deleted row
   *   that nothing keeps), or `invalidInput` when a field is not one of a row, a value is not one
   *   of its field, or the rows are in more than one layer; nothing is written then
   */
  writeRows(values: RowValues): boolean;
  /**
   * Lets go of the rows a token keeps ({@link StoreChange.deletedRowsToken}): they go for good, and
   * their ids may be taken again. A token let go of, or one the Store does not know, keeps nothing.
   * The Store itself, and the rows that are not deleted, are not touched.
   */
  releaseDeletedRows(token: DeletedRowsToken): void;
  /**
   * Takes everything out of the document: the rows, the groups, the layers, the stacking order,
   * the files, and the metadata (which becomes `{}`). It is how the whole document is replaced
   * (read again from the start): write the new content after it, and the change of its
   * transaction has `reset: true`. A replacement too large for one task is written in parts of
   * one operation ({@link StoreTransactOptions}): `clear` in the first, and the instance takes what
   * is gone out of the selection and the hidden items only once the operation ends, so that a row
   * written again in a later part keeps them.
   *
   * A row whose id comes back keeps its reference, so what is kept by the references (the rows
   * hidden on this client, the values a caller keeps per row) goes on. The rows whose ids have not
   * come back when the operation ends are let go of ({@link RowRef}). The tokens keep nothing
   * afterwards.
   */
  clear(): void;
  /**
   * Creates a layer. It goes to the front of the stacking order unless the order holds its id.
   *
   * @param options - The number of values of the positions of its rows, read once (2 when it is
   *   left out): a layer of positions with a height or a measure keeps them
   * @returns False when the id is in use
   */
  createLayer(layer: Layer, options?: LayerRowOptions): boolean;
  /** Changes the fields given of a layer. */
  updateLayer(id: string, updates: Partial<Layer>): boolean;
  /**
   * Deletes a layer, with its rows and its groups, and takes it out of the stacking order. The
   * rows are listed as deleted in the change, and a listener that asked for it keeps them
   * (`keepDeletedRows`).
   */
  deleteLayer(id: string): boolean;
  /** Replaces the stacking order. */
  setLayerOrder(order: string[]): boolean;
  /**
   * Creates a group. Its members are the rows whose `parent` is its id: write theirs to make
   * them members.
   *
   * @returns False when the id is in use, or its layer is not there
   */
  createGroup(group: StoreGroup): boolean;
  /**
   * Changes the fields given of a group. A new `layerId` puts the group, with its members, in that
   * layer (the exception to the rule that the Store does nothing by itself); a new `orderKey` puts
   * it in another place among the items of its layer.
   */
  updateGroup(id: string, updates: Partial<StoreGroup>): boolean;
  /**
   * Deletes a group. It does not move its members: write their `parent` and `orderKey` first, in
   * the same transaction, or delete them.
   *
   * @returns False when a row that is not deleted still names it
   */
  deleteGroup(id: string): boolean;
  /** Adds an embedded file. */
  createFile(file: FileData): boolean;
  /** Deletes an embedded file. */
  deleteFile(id: string): boolean;
  /**
   * Changes the keys given of the metadata, the keys of the extensions included (see `Metadata` of
   * the main entry); a key given as `undefined` is taken off, and the other keys keep what they
   * have. The change tells the keys written (`StoreChange.metadata.keys`).
   */
  setMetadata(metadata: Partial<Metadata>): boolean;
  /**
   * A new number of an operation, never given before by this Store: for a caller that writes one
   * change made outside the instance in several transactions, which give it in their options
   * ({@link StoreTransactOptions.operationId}). The instance takes the numbers of its own
   * operations here too.
   *
   * A large change is written so, in parts that each keep the map responsive (within 100 ms, the
   * work of the listeners of the change included), as the bulk edits of the instance are. The
   * caller closes the operation in a `finally`, so that it ends also when the writing fails:
   *
   * ```ts
   * const operationId = store.newOperationId();
   * let ended = false;
   * try {
   *   for (let i = 0; i < parts.length; i += 1) {
   *     const hasMoreParts = i < parts.length - 1;
   *     ended = !hasMoreParts; // the last part ends the operation, also when it throws
   *     store.transact(() => store.writeRows(parts[i]), 'remote', { operationId, hasMoreParts });
   *     if (hasMoreParts) await new Promise(requestAnimationFrame);
   *   }
   * } finally {
   *   // A part that threw before the last leaves the operation open: a transaction that writes
   *   // nothing ends it, and its change is told all the same
   *   if (!ended) store.transact(() => {}, 'remote', { operationId, stopped: true });
   * }
   * ```
   */
  newOperationId(): number;
}

/** The options of {@link Store.createLayer}. */
export interface LayerRowOptions {
  /**
   * The number of values of each position of the rows of the layer: 2 (longitude, latitude), 3
   * (and the height in meters, or a measure) or 4 (both). 2 when it is left out; it does not change
   * afterwards. The rows of a layer of 3 or 4 values are drawn and hit by their first two
   */
  readonly valuesPerPosition?: 2 | 3 | 4;
  /** What the third value is when there are 3: `height` (Z, the default) or `measure` (M) */
  readonly thirdValue?: 'height' | 'measure';
}

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
  /**
   * The keys of the attributes the rows given hold, each once, in no particular order: read their
   * values with `tables.readValues`, as the fields `properties:<key>`. With it every value of a
   * row can be read without knowing its keys first (to write out a whole document).
   *
   * @param rows - The rows; every row of the document when it is left out
   */
  listPropertyKeys(rows?: Int32Array): string[];
  /**
   * Subscribes to the changes of the document, as rows: one change arrives per outermost
   * transaction that changed it.
   *
   * A listener that asks for them gets more in its changes: the values the rows had before
   * (`previousValues`, for the sources it names), and a token that keeps the rows the change
   * deleted (`keepDeletedRows`). The Store reads and keeps them only while a listener asks, so they
   * cost nothing otherwise.
   *
   * @param listener - Called with each change; it does not write to the Store while it is
   *   called (`invalidState`), and writes after the change has been told, as the rules above say
   * @param options - What the changes of this listener carry besides the rows written
   * @returns The function that unsubscribes
   */
  subscribe(listener: (change: StoreChange) => void, options?: SubscribeOptions): () => void;
  /**
   * Runs `fn` as one transaction, so that its writes arrive as one change.
   *
   * A nested call with a source other than that of the outer call throws `DrawError` with the
   * code `invalidState`, writing nothing; one with the same source folds into the outer call, and
   * the options of the outermost call win. The transactions of an instance (`draw.transact`) are
   * transactions of its Store, so this one rule holds between them and the transactions of the
   * Store, whichever is inside the other. When `fn` throws, the writes it made before stay, and
   * are told as one change before the error is thrown again.
   *
   * @param source - Where the writes come from, never left out, so that a write made directly is
   *   not taken for an edit of the user: `'remote'` for a change made outside the instance (the
   *   instance gives `'local'` and the sources of its edits)
   * @param options - The operation the transaction is a part of, when one change is written in
   *   several transactions
   * @returns What `fn` returns
   * @throws `DrawError` with the code `invalidState` when it is called inside a transaction (of
   *   the Store or of an instance) of another source, or while a listener of the Store is
   *   called, or the error `fn` throws
   */
  transact<T>(fn: () => T, source: UpdateSource, options?: StoreTransactOptions): T;
}

/** The options of {@link StoreView.transact}. */
export interface StoreTransactOptions {
  /**
   * The operation the transaction is a part of ({@link Store.newOperationId}): the transactions
   * that give the same number are told as the parts of one change, with that `operationId`. A new
   * number is taken when it is left out
   */
  readonly operationId?: number;
  /**
   * True for every part of an operation but the last: its change has `hasMoreParts: true`. The
   * caller always ends an operation with a transaction without it, also when it stops early
   * (`stopped`), and in a `finally` (see {@link Store.newOperationId}): that transaction is told
   * even when it writes nothing. False when it is left out
   */
  readonly hasMoreParts?: boolean;
  /** True on the last part of an operation that stopped before it had written everything */
  readonly stopped?: boolean;
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

// =============================================================================
// 行と表
// =============================================================================

/**
 * The reference of a row: a number the document gives a row the first time it sees its id, and
 * never changes while the row is there, whatever group, layer or place the row moves to. A
 * caller that keeps a value per row outside the row keys it by the reference.
 *
 * The reference of a deleted row lasts as long as something keeps the row (a
 * {@link DeletedRowsToken}, or values of features of the main entry). A deleted row that nothing
 * keeps is let go of once the change that deleted it has been told to every listener, or once
 * the last token that kept it has been let go of: its number may then be given to another row,
 * and its id, seen again, gets a new reference. A caller that keeps values by the references
 * drops those of the rows a change lists as deleted, unless it keeps the rows.
 */
export type RowRef = number;

/**
 * A field of the values of a row of a feature, and the value each row has in it. A value that
 * breaks the rule of its field makes the whole write refused (see {@link Store}); a caller that
 * writes values that came from elsewhere checks them first with {@link validateRowValues}. In every
 * field, a string that is not well-formed (it holds a lone surrogate), as a key or as a value, breaks
 * the rule, and so does a value of arrays and objects nested more than 32 deep.
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
 * - `style`: the whole style of the feature, an object (`{}` for none) whose values are values
 *   JSON holds, as those of `properties:<key>`. The keys the library defines hold strings and
 *   finite numbers (`FeatureStyle` of the main entry); a key the library does not know is kept,
 *   whatever value JSON holds
 * - `style:<key>`: one key of the style (`style:fillColor`), a value JSON holds; writing
 *   `undefined` takes the key off. A caller that keeps or writes back what changed reads the
 *   keys written, not the whole object
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
export type FeatureRowField = 'type' | 'geometry' | 'visible' | 'locked' | 'style' | `style:${string}` | 'parent' | 'orderKey' | `properties:${string}`;

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
export declare const GEOMETRY_TYPES: readonly ['Point', 'LineString', 'Polygon', 'MultiPoint', 'MultiLineString', 'MultiPolygon'];

/**
 * Checks values of rows against the rules of their fields ({@link FeatureRowField}) before they
 * are written, without a Store: for a caller that writes values that came from elsewhere (from
 * another program), so that one wrong value does not make a whole write refused. It checks the
 * values themselves (their kinds, the geometries and their number of values per position), not
 * what depends on the document (an id in use, a parent that is not there).
 *
 * @param values - The values, as they would be given to `writeRows` or `createRows`
 * @param valuesPerPosition - The number of values of a position of the layer they go to
 * @returns The first value that breaks a rule: the index of its row in the values, its field and
 *   the reason in English, for logs; or `null` when every value keeps the rules
 */
export declare function validateRowValues(values: RowValues | NewRows, valuesPerPosition: 2 | 3 | 4): {
  readonly row: number;
  readonly field: FeatureRowField | 'deleted';
  readonly reason: string;
} | null;

/**
 * Makes a key of order between two keys ({@link FeatureRowField}, `orderKey`), as the instance
 * makes one for an item put between two others: for a caller that writes to the Store directly.
 * The key is greater than `before` and less than `after`, compared as strings of bytes.
 *
 * @param before - The key of the item behind, or `undefined` for the back of all
 * @param after - The key of the item in front, or `undefined` for the front of all
 * @returns The new key
 * @throws `DrawError` with the code `invalidInput` when `before` is not less than `after`
 */
export declare function createOrderKeyBetween(before: string | undefined, after: string | undefined): string;

/** New rows: their ids, and the values of their fields and their geometries ({@link Store.createRows}). */
export interface NewRows {
  /**
   * The ids, one per new row, unique and not in use: non-empty well-formed strings (an id that
   * holds a lone surrogate is refused as `invalidInput`)
   */
  readonly ids: readonly string[];
  /** The values of each field, one per id ({@link FeatureRowField}) */
  readonly fields: ReadonlyMap<FeatureRowField, readonly unknown[]>;
  /** The geometries, one per id */
  readonly geometry: GeometryColumn;
}

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
  findRow(id: string): {
    readonly ref: RowRef;
    readonly deleted: boolean;
  } | undefined;
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
  readValues(rows: Int32Array, fields: readonly FeatureRowField[], options?: {
    readonly deleted?: boolean;
  }): RowValues;
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

// =============================================================================
// 変更の通知
// =============================================================================

/**
 * Everything one transaction changed in the document, as rows (the change `DocumentChange` of the
 * main entry tells in the words of the features), as the listeners of the Store
 * receive it: once per transaction, each category present only when the transaction changed it.
 * The instance tells the same change to `draw.on('document.changed')` in the words of the
 * features (the IDs), with the same `operationId`.
 *
 * It names the rows and the fields written, and carries the values they had before (for a
 * listener that asks): the values written are read from `tables` while the change is told, when
 * they are those right after the change (see {@link StoreView}). It does not tell which operation
 * wrote them (a move, a rotation, a paste): two edits that write the same values make the same
 * change.
 */
export interface StoreChange {
  /** Where the writes came from: the source of the transaction, `'remote'` for a write outside one */
  source: UpdateSource;
  /** The number of the operation the change is a part of ({@link StoreTransactOptions}) */
  operationId: number;
  /** True when more changes of the same operation follow */
  hasMoreParts: boolean;
  /** True on the last change of an operation that stopped before it had written everything */
  stopped: boolean;
  /**
   * True when the change replaces the whole document (`clear`, and what was written after it in
   * the same transaction). The rows, layers, groups and files listed as deleted are those taken
   * out; the ones created, those written after.
   */
  reset: boolean;
  /**
   * The rows written, by layer: the references of the rows created, updated and deleted, and the
   * fields written. The rows created are those of `createRows` and `createRowsFromPages`; a row
   * brought back (`deleted` written 0) is listed as updated. A row moved to another layer is
   * listed as updated in the layer it is in now, and not in the one it left. A row the change left
   * as it was (a locked one) is not listed. The id of a row deleted is still read with
   * `tables.getRowId` while the change is delivered. A row the transaction deleted and created
   * again by its id (`createRows`) keeps its reference and is listed as updated.
   */
  rows?: RowsChange;
  /**
   * The values the rows had before the transaction, by the id of the layer they are in (as
   * `rows` lists them), so that the geometries of one layer have one number of values per
   * position: for every field the transaction wrote (`parent` and `orderKey` included, and the
   * keys of the style written), with `deleted` for the rows it deleted or brought back. A row
   * created by the transaction has none. Only for a listener that asked for them, for this
   * source ({@link SubscribeOptions.previousValues}).
   */
  previousValues?: ReadonlyMap<string, RowValues>;
  /**
   * What keeps the rows the transaction deleted (its own deletions, and the rows of a layer it
   * deleted), so that writing them with `deleted` 0 brings them back where they were. The listener
   * lets go of it with `store.releaseDeletedRows` once it no longer needs them. Only for a listener
   * that asked for it (`keepDeletedRows`), and only when the transaction deleted rows; a change
   * with `reset` has none.
   */
  deletedRowsToken?: DeletedRowsToken;
  /** The layers created, updated and deleted, and the change of the stacking order */
  layers?: {
    created?: Layer[];
    updated?: Array<{
      id: string;
      layer: Layer;
      previous: Layer;
    }>;
    deleted?: Layer[];
    orderChanged?: {
      order: string[];
      previous: string[];
    };
  };
  /** The groups created, updated and deleted (the rows that joined or left them are in `rows`) */
  groups?: {
    created?: StoreGroup[];
    updated?: Array<{
      id: string;
      group: StoreGroup;
      previous: StoreGroup;
    }>;
    deleted?: StoreGroup[];
  };
  /** The new metadata and the one before it */
  metadata?: {
    metadata: Metadata;
    previous: Metadata;
    /** The keys the transaction wrote, each once (a key taken off included) */
    keys: readonly string[];
  };
  /** The embedded files created and deleted */
  files?: {
    created?: FileData[];
    deleted?: FileData[];
  };
}

/** The rows one change wrote, by layer. */
export interface RowsChange {
  /** The rows of each layer, by the id of the layer */
  readonly layers: ReadonlyMap<string, LayerRowsChange>;
}

/** The rows of one layer one change wrote. */
export interface LayerRowsChange {
  /** The rows created */
  readonly created: Int32Array;
  /** The rows updated (a row that came from another layer, and a row brought back, included) */
  readonly updated: Int32Array;
  /** The rows deleted */
  readonly deleted: Int32Array;
  /**
   * The fields written, for the rows updated: `style:<key>` and `properties:<key>` name the keys
   * that changed
   */
  readonly fields: ReadonlySet<FeatureRowField>;
}

/** What the changes a listener receives carry besides the rows written ({@link StoreView.subscribe}). */
export interface SubscribeOptions {
  /**
   * Whether its changes carry the values the rows had before ({@link StoreChange.previousValues}):
   * true for the changes of every source, the sources whose changes carry them (a listener that
   * keeps its own edits leaves out `'remote'`), `{ except }` with the sources whose changes do
   * not carry them (every other source, those an extension names included), or a function that
   * answers for each change from its source and the number of its operation, as
   * `DocumentSubscribeOptions.previousValues` of the main entry does (a caller that writes
   * changes made outside the instance under operation numbers it took answers false for those,
   * and true for the changes other callers write with the same source). The function is asked
   * before the transaction writes, once per transaction; it answers at once and writes nothing.
   * False when it is left out.
   */
  readonly previousValues?: boolean | readonly UpdateSource[] | {
    readonly except: readonly UpdateSource[];
  } | ((change: {
    readonly source: UpdateSource;
    readonly operationId: number;
  }) => boolean);
  /**
   * Whether the rows its changes delete are kept for it, until it lets go of them
   * ({@link StoreChange.deletedRowsToken}). False when it is left out.
   */
  readonly keepDeletedRows?: boolean;
}

declare const deletedRowsTokenBrand: unique symbol;

/**
 * What keeps the rows one change deleted, so that they can be brought back, for the listener it
 * was given to
 * ({@link StoreChange.deletedRowsToken}).
 *
 * The rows stay as they were, with their values, their references and their places, until the
 * listener lets go of them (`store.releaseDeletedRows(token)`); their ids stay in use until then.
 * Written with `deleted` 0, they come back where they were. A listener that keeps a token for long
 * keeps the memory of its rows: it lets go of the tokens it no longer needs.
 */
export type DeletedRowsToken = number & {
  readonly [deletedRowsTokenBrand]: true;
};

// =============================================================================
// 標準の Store
// =============================================================================

/** The options of {@link createStore}. */
export interface StoreOptions {
  /**
   * Where the large merges and builds of rows run (a Worker of the application that runs
   * {@link mergeRowPages} and {@link createRowPageBuilder}); on the main thread, between the
   * frames of the map, when it is left out
   */
  readonly worker?: RowPageWorker;
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
  rowBox(coordinates: Float64Array, valuesPerPosition: number, from: number, to: number, out: Float64Array, at: number): void;
  /**
   * The key the boxes are put in order by in the spatial index (for the index only, not the
   * `orderKey` of the stacking order), from the center of a box (the
   * Hilbert curve over the plane when it is left out)
   */
  sortKey?(centerX: number, centerY: number): number;
}

/**
 * Creates an empty Store in memory: the one an instance makes when it is given none. It holds the
 * rows in the tables of `@sakuzu/kasane`.
 *
 * It is a plain object whose members do not depend on `this`. To keep the document somewhere of
 * your own, spread it into a new object and replace the writes you take over; call the replaced
 * member of the built-in Store from yours so that it still holds the document (the instance draws
 * the rows from its tables). The instance then calls your members.
 *
 * It needs no map: a Store made and written without an instance can be read on its own, and
 * takes writes of any source while no instance uses it (see {@link Store}).
 *
 * @example A Store that does not take a title longer than 200 characters
 * ```ts
 * const base = createStore();
 * const store: Store = {
 *   ...base,
 *   setMetadata: (metadata) =>
 *     (metadata.title?.length ?? 0) > 200 ? false : base.setMetadata(metadata),
 * };
 * const draw = createDraw(map, { store });
 * ```
 */
export declare function createStore(options?: StoreOptions): Store;

// =============================================================================
// ページ (Worker で作る行の塊)
// =============================================================================

declare const rowPageBrand: unique symbol;

/**
 * A page of rows: a few thousand rows of one layer, in the order of the layer, as columns of
 * typed arrays. A Worker builds it ({@link createRowPageBuilder}) and posts it to the main thread
 * without a copy ({@link getRowPageTransferList}), and the Store takes it as it is
 * ({@link Store.createRowsFromPages}). Its columns are read by the Store only.
 */
export interface RowPage {
  /** The number of rows */
  readonly length: number;
  /** Tells it from other objects */
  readonly [rowPageBrand]: true;
}

/** One row given to a {@link RowPageBuilder}. */
export interface RowInput {
  /** The id of the row, unique in the document */
  readonly id: string;
  /** The type of the feature (`'Point'`, `'Circle'`, the name of a custom type) */
  readonly type: FeatureType;
  /**
   * The GeoJSON geometry (a Circle and an Image give the Point of their center, a Freehand a
   * LineString), or null for a row without one
   */
  readonly geometry: Geometry | null;
  /** The key of its order, among the members of its group or the items of its layer */
  readonly orderKey: string;
  /** The id of its group, one of `RowPageBuilderOptions.groups`; none when it is left out */
  readonly groupId?: string;
  /** The style */
  readonly style?: Readonly<FeatureStyle>;
  /** The attributes */
  readonly properties?: Readonly<Record<string, unknown>>;
  /** Whether it is visible (true when it is left out) */
  readonly visible?: boolean;
  /** Whether it is locked (false when it is left out) */
  readonly locked?: boolean;
}

/** The options of {@link createRowPageBuilder}. */
export interface RowPageBuilderOptions {
  /** The groups the rows can be in, with the keys of their places (none when it is left out) */
  readonly groups?: readonly {
    readonly id: string;
    readonly orderKey: string;
  }[];
  /** The number of values of the positions of the layer the pages go to (2 when it is left out) */
  readonly valuesPerPosition?: 2 | 3 | 4;
  /** What the third value is when there are 3, as the layer has it ({@link LayerRowOptions.thirdValue}): `height` (the default) or `measure` */
  readonly thirdValue?: 'height' | 'measure';
  /** The system of the boxes, the one the Store is given ({@link StoreOptions.spatialIndexing}) */
  readonly spatialIndexing?: RowSpatialIndexing;
}

/** Builds the pages of one layer, in a Worker or on the main thread. */
export interface RowPageBuilder {
  /** The number of rows added */
  readonly length: number;
  /**
   * Adds a row.
   *
   * @throws `DrawError` with the code `invalidInput` when the id was already added, when the
   *   geometry is not a GeoJSON geometry of one of the six types, or when a value of the style or
   *   the attributes cannot be held (a number that is not finite, a function)
   */
  addRow(row: RowInput): void;
  /**
   * Puts the rows in the order of their keys and cuts them into pages.
   *
   * @throws `DrawError` with the code `notFound` when a row names a group the options do not give
   */
  finish(): RowPage[];
}

/**
 * Creates the builder of the pages of one layer: what a Worker of the application runs to build a
 * large document, so that the main thread only takes the pages in.
 *
 * @example
 * ```ts
 * // worker.ts
 * const builder = createRowPageBuilder();
 * for (const row of rows) builder.addRow(row);
 * const pages = builder.finish();
 * self.postMessage(pages, { transfer: getRowPageTransferList(pages) });
 *
 * // main.ts
 * worker.onmessage = (event) => {
 *   store.transact(() => store.createRowsFromPages('buildings', event.data), 'remote');
 * };
 * ```
 */
export declare function createRowPageBuilder(options?: RowPageBuilderOptions): RowPageBuilder;

/**
 * Every buffer of pages, for `postMessage` with transfer, each one once. After the transfer the
 * arrays are empty in the Worker that posted them.
 */
export declare function getRowPageTransferList(pages: readonly RowPage[]): ArrayBuffer[];

declare const rowPageMergeTaskBrand: unique symbol;

/**
 * Work the Store hands to a Worker: rows of pages to merge into the next pages of a layer, posted
 * as it is (it holds no function).
 */
export interface RowPageMergeTask {
  /** Tells it from other objects */
  readonly [rowPageMergeTaskBrand]: true;
}

/** Merges rows of pages into new pages: what a Worker runs for {@link RowPageWorker.merge}. */
export declare function mergeRowPages(merge: RowPageMergeTask): RowPage[];

/** A Worker of the application as the Store hands it its work ({@link StoreOptions.worker}). */
export interface RowPageWorker {
  /** Merges rows of pages ({@link mergeRowPages} in the Worker) */
  merge(merge: RowPageMergeTask): Promise<RowPage[]>;
  /** Builds rows into pages ({@link createRowPageBuilder} in the Worker): many new rows written at once */
  build(rows: readonly RowInput[], options: RowPageBuilderOptions): Promise<RowPage[]>;
}
