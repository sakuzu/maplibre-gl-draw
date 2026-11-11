// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The events: one list, `DrawEvents`, that applications and extensions subscribe to alike, and
 * the one shape of a value that changes over time, `Observable`
 *
 * A change of the document arrives as one `change` per commit, whatever it changed and however
 * many features, with the IDs of what changed and where it came from. A value that changes over
 * time (the selection, the mode, the features hidden here, the options, the sketches, the
 * datasets, the shapes as they are drawn) is read and followed as an {@link Observable} on its
 * resource, not as an event.
 */

import type { Position } from 'geojson';
import type { DatasetRow } from './datasets.js';
import type { DrawError } from './errors.js';
import type { Hit } from './extension/provider.js';
import type { StoreView, UpdateSource } from './extension/store.js';
import type {
  Feature,
  FeatureValues,
  FileData,
  Group,
  ItemOrderChange,
  Layer,
  Metadata,
  RestoreToken,
  StoredFeature,
} from './model.js';
import type { LayerStackEntry, Mode, SelectionType, SelectionValue, SnapResult } from './state.js';
import type { RowsChange } from './tables.js';

/** A point on the screen, as `[x, y]` in CSS pixels. */
export type ScreenPoint = [number, number];

/**
 * A value that changes over time, in one shape: the value now, and a way to follow it. It keeps
 * the contract of a Svelte store, so `$selection` works as it is; in React,
 * `useSyncExternalStore(observable.subscribe, () => observable.value)` reads it.
 */
export interface Observable<T> {
  /** The value now: the same object while the value does not change */
  readonly value: T;
  /**
   * Calls `run` with the value now at once, and again each time the value changes. It does not
   * depend on `this`.
   *
   * @returns The function that stops calling it
   */
  subscribe(run: (value: T) => void): () => void;
}

/**
 * The IDs of what one commit created, updated, deleted and put in another place, of one kind
 * (features, layers or groups), for the commit as a whole: an ID is listed once in each list at
 * most, in one of `created`, `updated` and `deleted` at most, and not at all when it was created
 * and deleted in the commit, or written back to what it was.
 */
export interface ChangedIds {
  /** Created (written after in the commit included) */
  readonly created: readonly string[];
  /** Changed, otherwise than by its place (it is in `placed` too when it was also put elsewhere) */
  readonly updated: readonly string[];
  /** Deleted (written before in the commit included) */
  readonly deleted: readonly string[];
  /**
   * Put in another place of the stacking order: in its layer or group, or into another one. A
   * feature or a group that changed nothing but its place is here alone. For the layers, those
   * whose place among the layers changed
   */
  readonly placed: readonly string[];
}

/**
 * One commit of the document: what `change` delivers, once per commit, whatever it changed and
 * however many features. It lists the IDs of what changed; what they are now is read from the
 * resources (`draw.features.get`), and what a feature was before the commit with `previous`, in
 * the listener.
 *
 * It fires only for a commit that changed the document (its features, layers, groups, metadata or
 * files). A change of the state of this client alone (the selection, the mode, what is hidden here)
 * is read from the {@link Observable} of its resource.
 */
export interface Change {
  /** The ID of the commit: the `id` of the `draw.write` that made it */
  readonly commit: string;
  /**
   * Where the commit came from: `local` for a write of this client, `undo` and `redo` for a step
   * of its undo taken back and made again, `open` for a document opened, `remote` from elsewhere
   */
  readonly source: 'local' | 'remote' | 'undo' | 'redo' | 'open';
  /** The `label` of the `draw.write` that made it */
  readonly label: string | undefined;
  /** The features */
  readonly features: ChangedIds;
  /** The layers */
  readonly layers: ChangedIds;
  /** The groups */
  readonly groups: ChangedIds;
  /**
   * Whether the document itself changed: its metadata or its files, the whole document replaced,
   * or an entry of the stacking order of the layers that is not a layer (a dataset of the order
   * of the layers, an entry of the application) put in or out of it, or in another place of it
   */
  readonly document: boolean;
  /**
   * The feature as it was before the commit, before its first write in it: one updated, deleted
   * or put in another layer or group. It is read in the listener, while the change is delivered;
   * after, its answer is not kept.
   *
   * @returns The feature before, or `undefined` for one created, one the commit did not change,
   *   and a feature written by a commit from elsewhere to a layer held as rows of columns (which
   *   keeps no value before)
   */
  previous(id: string): Feature | undefined;
  /**
   * The rows of the layers held as rows of columns written ({@link StoreView.tables}), by layer:
   * the same features as `features` lists, by the handles of their rows. Its type is in
   * `@sakuzu/maplibre-gl-draw/kasane`
   *
   * @experimental
   */
  readonly rows?: RowsChange;
}

/**
 * Everything one transaction changed, as the subscribers of the Store receive it
 * (`StoreView.subscribe`). It arrives once per transaction, and each category is present only
 * when the transaction changed it. The instance tells the same commit as {@link Change}
 * (`change`).
 */
export interface DocumentChange {
  /** Where the writes came from */
  source?: UpdateSource;
  /**
   * True when the notification replaces the whole document at once, as a Store given in the
   * `store` option does when it takes a document from elsewhere. The current mode drops what
   * it was drawing then (`ModeHandler.onCancel`), because the shape it holds may refer to
   * what is gone. A Store sets it; the changes that come with it list what was replaced.
   */
  reset?: boolean;
  /** The features created, updated and deleted */
  features?: {
    created?: StoredFeature[];
    updated?: Array<{
      id: string;
      feature: StoredFeature;
      previous: StoredFeature;
    }>;
    deleted?: StoredFeature[];
  };
  /**
   * The layers created, updated and deleted, and the change of their stacking order. An update
   * that changed nothing but the `items` of a layer is left out (`order` tells it), as is one of
   * a group that changed nothing but its `featureIds`
   */
  layers?: {
    created?: Layer[];
    updated?: Array<{ id: string; layer: Layer; previous: Layer }>;
    deleted?: Layer[];
    orderChanged?: { order: string[]; previous: string[] };
  };
  /** The groups created, updated and deleted */
  groups?: {
    created?: Group[];
    updated?: Array<{ id: string; group: Group; previous: Group }>;
    deleted?: Group[];
  };
  /**
   * The items (features and groups) put in another place of the stacking order, created and
   * deleted, in the order they were put there, each with where it was and where it is (by the
   * items just below and above it at that moment), or many rows of a layer held as rows at once.
   * Moving the items back to where they were, from the last one, puts the order back
   */
  order?: ItemOrderChange[];
  /**
   * What keeps the rows and the groups this client deleted in the transaction, when the Store
   * holds its features as rows: what undoes the deletion holds it (written back with
   * `features.restore` and `groups.restore`, they come back where they were), and lets go of it
   * with `features.releaseRestore` once it no longer needs them
   */
  restoreToken?: RestoreToken;
  /**
   * The values the features held as rows had before a write of this client, for the fields it
   * wrote, when the Store holds its features as rows: written back with `features.restore`, they
   * put the features back. The Store gives them for the rows that were there when the
   * transaction began, through any of its writes, other than their place in the stacking order
   * (their layer, group and keys of the order, which `order` tells). A row created has none
   * (written deleted, it is taken back). Absent for a change from elsewhere
   */
  previousValues?: FeatureValues;
  /**
   * The new selection and the one before it, as the Store keeps them (`Store.getSelection`). Many
   * features selected in bulk are told with no IDs: `draw.selection.value` gives their number,
   * layers and extent
   */
  selection?: {
    type: SelectionType | null;
    ids: string[];
    previousType: SelectionType | null;
    previousIds: string[];
  };
  /** The IDs of the features whose editing started and ended */
  editing?: { started?: string[]; ended?: string[] };
  /** The new mode and the one before it */
  mode?: { mode: Mode; previous: Mode };
  /** The new metadata and the one before it */
  metadata?: { metadata: Metadata; previous: Metadata };
  /** The embedded files created and deleted */
  files?: { created?: FileData[]; deleted?: FileData[] };
  /**
   * The rows of the layers held as rows of columns written ({@link StoreView.tables}); a feature
   * is in `features` or here, never in both. Its type is in `@sakuzu/maplibre-gl-draw/kasane`
   *
   * @experimental
   */
  rows?: RowsChange;
}

/**
 * The events, by name, with their payloads.
 */
export interface DrawEvents {
  /**
   * A commit of the document: once per commit that changed it (its features, layers, groups,
   * metadata or files), whatever it changed and however many features, from this client or from
   * elsewhere
   */
  change: Change;
  /**
   * A drag started; `bulk` for features selected in bulk, whose IDs are not listed: the value of
   * their selection (`SelectionValue.ids` is `null`; `listSelectedRows` of
   * `@sakuzu/maplibre-gl-draw/kasane` reads their rows)
   */
  'drag.started': {
    kind: 'feature' | 'vertex' | 'handle';
    featureIds: string[];
    bulk?: SelectionValue;
  };
  /** A drag ended; `cancelled` is true when it was cancelled */
  'drag.ended': {
    kind: 'feature' | 'vertex' | 'handle';
    featureIds: string[];
    bulk?: SelectionValue;
    cancelled: boolean;
  };
  /** Read-only was turned on or off */
  'readOnly.changed': { readOnly: boolean };
  /** The interaction lock was turned on or off */
  'interactionLock.changed': { locked: boolean };
  /** The snapping target changed */
  'snap.changed': { result: SnapResult | null };
  /**
   * A click on the map in the select mode, whether it hit something or not. `lngLat` is the
   * position of the pointer before snapping, and `hit` the frontmost thing under it (a feature,
   * a row of a dataset, a companion), or `null` when the click hit nothing
   */
  'map.clicked': { lngLat: Position; point: ScreenPoint; hit: Hit | null };
  /** A row of a dataset was clicked */
  'dataset.clicked': {
    datasetId: string;
    rowIndex: number;
    row: DatasetRow;
    lngLat: Position;
    point: ScreenPoint;
  };
  /** The divisions of the stacking order changed */
  'layerStack.changed': { entries: readonly LayerStackEntry[] };
  /** Loading or reading an image failed */
  error: { error: DrawError; source: string; featureId?: string };
}

/** A function that receives the payload of an event. */
export type DrawEventListener<K extends keyof DrawEvents = keyof DrawEvents> = (
  payload: DrawEvents[K],
) => void;
