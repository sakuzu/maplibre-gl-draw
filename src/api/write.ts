// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.write`: the one way to change the document, and the transaction it hands its function
 */

import type { FeatureCollection, Position } from 'geojson';
import type { BBox } from '../geometry/types.js';
import type { FeaturesCollection } from './features.js';
import type { GroupsCollection } from './groups.js';
import type { LayersCollection } from './layers.js';
import type {
  DrawDocument,
  DrawProperties,
  Feature,
  FeatureInput,
  FeaturePatch,
  FeatureStyleSample,
  FeatureType,
  GroupInput,
  GroupPatch,
  LayerInput,
  LayerPatch,
  Properties,
} from './model.js';
import type { SelectionTarget } from './state.js';
import type { SaveGoal } from './status.js';

/**
 * The progress of a long task, in one shape. `total` is `null` while it is not known. The last
 * one told has `done === total`.
 */
export interface Progress {
  readonly phase: 'read' | 'parse' | 'check' | 'apply' | 'send' | 'receive' | 'render' | 'export';
  readonly done: number;
  readonly total: number | null;
}

/**
 * The last argument of every method that returns a promise. Stopped by `signal`, it fails with
 * `aborted` and the document does not change; once committed, stopping it does nothing and the
 * promise succeeds.
 */
export interface TaskOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: Progress) => void;
}

/** The options of {@link Draw.write} */
export interface WriteOptions extends TaskOptions {
  /** The name of the commit, told in `change` and shown for its step of undo */
  readonly label?: string;
  /** False to make it no step of undo; true when left out */
  readonly undo?: boolean;
}

/** What a commit gave once made: the value of the function, and the writes left out */
export interface WriteResult<T> {
  readonly value: T;
  /** The writes of the commit left out because what they named was gone when it was made */
  readonly skipped: number;
}

/**
 * What `draw.write` returns: a promise of what the function returned, settled once the commit is
 * made here, with the ID of the commit and the way to follow how far it is saved.
 */
export interface Write<T> extends Promise<T> {
  /** The ID of the commit: the `commit` of `change` and of the `Batch` a storage receives */
  readonly id: string;
  /** The value of the function, with the writes the commit left out; it fails as this promise */
  readonly result: Promise<WriteResult<T>>;
  /**
   * Brings the commit to the storage, up to the stage `until` (`accepted` when left out): it
   * settles once the commit is there, and sends now a commit waiting to be sent again. A commit
   * that changed nothing of the document has nothing to save: it settles once made.
   *
   * @throws `DrawError` (the promise rejects) as the write fails when it fails; with the code
   *   `refused` when the storage refuses the commit, `invalidState` when there is no storage or
   *   it goes through no stage `until` (`status.saving.stages`), or the code of the connection
   *   closed (`credential`, `permission`, `network`) when the commit can no longer be sent
   */
  save(options?: SaveOptions): Promise<void>;
}

/** The options of {@link Write.save} */
export interface SaveOptions extends TaskOptions {
  /** The stage to wait for: `accepted` when left out */
  readonly until?: SaveGoal;
}

// ============================================================================
// What a write names
// ============================================================================

/**
 * A filter of features by the values of the document: what it names is the same on every client,
 * as it does not read what is selected or hidden here.
 */
export interface Filter<P extends object = Properties> {
  readonly layerId: string | readonly string[];
  readonly groupId: string | readonly string[];
  readonly featureType: FeatureType;
  readonly bbox: BBox;
  readonly visible: boolean;
  readonly locked: boolean;
  readonly properties: { readonly [K in keyof (P & DrawProperties)]?: (P & DrawProperties)[K] };
}

/**
 * The features a write names by the values of the document: at least one key, and no key given
 * `undefined` (`invalidInput`), so that a filter never names every feature unawares
 */
export type Where<P extends object = Properties> = {
  [K in keyof Filter<P>]-?: Required<Pick<Filter<P>, K>> & Partial<Omit<Filter<P>, K>>;
}[keyof Filter<P>];

/** Every feature: the one way a write names all of them */
export interface All {
  readonly all: true;
}

/** Many features: IDs (not none: `invalidInput`), a filter, the selection, or all of them */
export type Many<P extends object = Properties> =
  | readonly string[]
  | Where<P>
  | SelectionTarget
  | All;

/** What a write names: one ID, or many features */
export type Target<P extends object = Properties> = string | Many<P>;

/** Just below or just above another item: `below` is the item just below this one */
export type Neighbor =
  | { readonly below: string; readonly above?: never }
  | { readonly above: string; readonly below?: never };

/**
 * Where an item goes in the stacking order: next to another item of the same layer or group (a
 * {@link Neighbor} alone), or into a layer or a group, at the front unless a neighbor is given
 */
export type Placement =
  | Neighbor
  | ({ readonly layerId: string; readonly groupId?: string } & Partial<Neighbor>)
  | ({ readonly groupId: string; readonly layerId?: string } & Partial<Neighbor>);

/** A move, from a point to another, `[longitude, latitude]` in degrees */
export interface Translate {
  readonly from: Position;
  readonly to: Position;
}

/** A turn about a point, counterclockwise seen from above */
export interface Rotate {
  readonly center: Position;
  readonly angleDegrees: number;
}

/** A stretch from a point */
export interface Scale {
  readonly center: Position;
  readonly eastFactor: number;
  readonly northFactor: number;
  /** The factor of the size of points and of the width of lines */
  readonly sizeFactor: number;
}

// ============================================================================
// The transaction
// ============================================================================

/**
 * The hand a transaction writes with: the only thing that writes the document. Its writes are
 * kept in it and committed at once when the function of `draw.write` ends; until then nobody
 * reads them. Its reads read the document as committed (what it wrote is read once committed),
 * except `features.get` and `has`, which read what it wrote of a feature by its ID.
 *
 * One write of it that fails fails the whole transaction, even when its error is caught: nothing
 * is committed. Once the function has ended, a call fails with `transactionClosed`. A read while
 * one of its writes is still under way (a `tx.import` not awaited) throws `writeNotFinished`.
 */
export interface Transaction<P extends object = Properties> {
  /** The ID of the commit it makes */
  readonly id: string;
  /** The `signal` of the write, to give to a `fetch` made in it */
  readonly signal: AbortSignal;
  readonly features: TransactionFeatures<P>;
  readonly layers: TransactionLayers;
  readonly groups: TransactionGroups;
  readonly document: TransactionDocument;
  /**
   * Adds what a source holds to the document: one commit and one step of undo however many
   * times it is called, so several files are one step. A document is replaced with `draw.open`.
   * `options.layer` wins over the `maplibre-gl-draw:layerId` of the features.
   */
  import(source: ImportSource, options?: ImportOptions): Promise<ImportResult>;
}

/**
 * The writes of the features.
 *
 * The locks: a write that names features by their IDs (one ID, an array of IDs, the entries of
 * `update`) is written whole or not at all, and fails with `locked` when one of them is locked
 * (a patch of the lock or of the visibility alone excepted). A write given a filter, `{ all: true }`
 * or `draw.selection.target` leaves the locked features as they are and counts only the features
 * it writes. A target of the selection names the selection as it was when it was read.
 */
export interface TransactionFeatures<P extends object = Properties>
  extends Omit<FeaturesCollection, 'get' | 'getMany'> {
  /** What this transaction wrote of the feature, or what is committed */
  get(id: string): Feature<P> | undefined;
  getMany(ids: readonly string[]): (Feature<P> | undefined)[];
  /** One input gives the feature, an array of them gives their IDs */
  create(input: FeatureInput<P>): Promise<Feature<P>>;
  create(inputs: readonly FeatureInput<P>[]): Promise<readonly string[]>;
  /**
   * An ID gives the feature; many features give how many were changed. The patch given to many
   * can be a function, asked once per kind of feature (its type, style and zoom of creation),
   * that gives the patch of the kind or `null` to leave it.
   */
  update(id: string, patch: FeaturePatch<P>): Promise<Feature<P>>;
  update(
    target: Many<P>,
    patch: FeaturePatch<P> | ((sample: FeatureStyleSample) => FeaturePatch<P> | null),
  ): Promise<number>;
  /** A patch of its own for each feature. @returns How many were changed */
  update(
    entries: readonly { readonly id: string; readonly patch: FeaturePatch<P> }[],
  ): Promise<number>;
  /** @returns How many were deleted */
  delete(target: Target<P>): Promise<number>;
  /** Moves the features. @returns How many */
  translate(target: Target<P>, input: Translate): Promise<number>;
  /** Turns the features. @returns How many */
  rotate(target: Target<P>, input: Rotate): Promise<number>;
  /** Stretches the features. @returns How many */
  scale(target: Target<P>, input: Scale): Promise<number>;
  /** Puts the features elsewhere in the stacking order, a layer or a group. @returns How many */
  place(target: Target<P>, to: Placement): Promise<number>;
  /** Joins areas into one, which takes their place */
  union(ids: readonly string[]): Promise<Feature<P>>;
  /** Subtracts areas from an area, whose place the result takes */
  difference(id: string, subtract: readonly string[]): Promise<Feature<P>>;
  /** Keeps where areas overlap, in their place */
  intersection(ids: readonly string[]): Promise<Feature<P>>;
  /** Splits an area along a line into the features it gives */
  split(id: string, lineId: string): Promise<readonly Feature<P>[]>;
  /** Creates the area around a feature */
  buffer(id: string, distanceMeters: number): Promise<Feature<P>>;
}

/** The writes of the layers */
export interface TransactionLayers extends LayersCollection {
  create(input?: LayerInput): Promise<import('./model.js').Layer>;
  update(id: string, patch: LayerPatch): Promise<import('./model.js').Layer>;
  /** Deletes the layers with their features and groups. @returns How many */
  delete(target: string | readonly string[] | All): Promise<number>;
  /**
   * Puts a layer just below or above another. An entry of the stacking order that is not a layer
   * (a dataset whose order is `layerOrder`, an entry of the application) is placed the same way,
   * and can be the neighbor
   */
  place(id: string, to: Neighbor): Promise<void>;
}

/** The writes of the groups */
export interface TransactionGroups extends GroupsCollection {
  create(input: GroupInput): Promise<import('./model.js').Group>;
  update(id: string, patch: GroupPatch): Promise<import('./model.js').Group>;
  /** Deletes groups; whether their members stay or go with them is always said */
  delete(
    target: string | readonly string[],
    options: { readonly members: 'keep' | 'delete' },
  ): Promise<number>;
  place(id: string, to: Placement): Promise<void>;
}

/** The writes of the document as a whole */
export interface TransactionDocument {
  readonly title: string;
  readonly description: string;
  /** The values an application or an extension keeps on the document, under keys of its prefix */
  readonly metadata: { readonly [key: `${string}:${string}`]: unknown };
  /**
   * Changes the fields given: the title, the description, and the values of `metadata` key by
   * key (keys of their own prefix, `app:key`, JSON values). A key is removed by naming it in
   * `unset`.
   */
  update(patch: {
    readonly title?: string;
    readonly description?: string;
    readonly metadata?: { readonly [key: `${string}:${string}`]: unknown };
    readonly unset?: { readonly metadata?: readonly `${string}:${string}`[] };
  }): Promise<void>;
}

// ============================================================================
// Opening and importing
// ============================================================================

/** A source to open: a JSON string, a file, a document of the library or GeoJSON */
export type OpenSource = string | Blob | DrawDocument | FeatureCollection;

/** A source to import */
export type ImportSource = OpenSource;

/** A feature of the source that was left out, and why */
export interface SkippedFeature {
  readonly index: number;
  readonly error: import('./errors.js').DrawError;
}

/** What `draw.open` read */
export interface OpenResult {
  readonly features: number;
  readonly skipped: readonly SkippedFeature[];
}

/** The options of `tx.import` */
export interface ImportOptions {
  /** The layer to put the features in: its ID, or a new layer made in the same commit */
  readonly layer?: string | LayerInput;
  /** A new group, made in the same commit, to put the features in */
  readonly group?: Omit<GroupInput, 'members'>;
  /** What an ID the document already holds becomes: a new ID. Nothing is written over */
  readonly duplicateIds?: 'renew';
}

/** What `tx.import` read */
export interface ImportResult {
  readonly count: number;
  readonly layerId: string;
  readonly skipped: readonly SkippedFeature[];
}
