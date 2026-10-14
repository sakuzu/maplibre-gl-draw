// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The events: one list, `DrawEvents`, that applications and extensions subscribe to alike
 *
 * An event is named `resource.pastParticiple`. A change of the document carries its source,
 * and `document.changed` arrives once per transaction with every change of it.
 */

import type { Position } from 'geojson';
import type { Dataset, DatasetRow } from './datasets.js';
import type { DrawError } from './errors.js';
import type { Hit } from './extension/provider.js';
import type { StoreView, UpdateSource } from './extension/store.js';
import type {
  Feature,
  FeatureInput,
  FeatureValues,
  FileData,
  Group,
  ItemOrderChange,
  ItemPosition,
  Layer,
  LoadResult,
  Metadata,
  RestoreToken,
} from './model.js';
import type { RuntimeOptions } from './options.js';
import type {
  LayerStackEntry,
  Mode,
  Selection,
  SelectionType,
  SnapResult,
  VertexSelection,
} from './state.js';
import type { RowsChange } from './tables.js';

/** A point on the screen, as `[x, y]` in CSS pixels. */
export type ScreenPoint = [number, number];

/**
 * Everything one transaction changed, as `document.changed` and the subscribers of the Store
 * receive it. It arrives once per transaction, and each category is present only when the
 * transaction changed it.
 *
 * `document.changed` fires only for a transaction that changed the document (features, layers,
 * groups, metadata or files); the selection, the editing and the mode are carried along when
 * the same transaction changed them. A change of the state of this client alone has its own
 * event (`selection.changed`, `mode.changed` and so on).
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
    created?: Feature[];
    updated?: Array<{
      id: string;
      feature: Feature;
      previous: Feature;
      /** True while a drag or a drawing is in progress; a final update always follows */
      isIntermediate?: boolean;
    }>;
    deleted?: Feature[];
  };
  /** The layers created, updated and deleted, and the change of their stacking order */
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
  /** The new selection and the one before it */
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
  /**
   * The rows held as columns opened as features for this client (`added`, their features) and
   * no longer (`removed`, their ids): not a change of the document. A row is opened while it is
   * selected or edited; a row deleted is in `features.deleted`, never in `removed`
   *
   * @experimental
   */
  opened?: { added: Feature[]; removed: string[] };
}

/**
 * The events, by name, with their payloads.
 */
export interface DrawEvents {
  /** A feature was created */
  'feature.created': { feature: Feature; source: string };
  /** A feature changed; `intermediate` is true while a drag is in progress */
  'feature.updated': { feature: Feature; previous: Feature; source: string; intermediate: boolean };
  /** A feature was deleted */
  'feature.deleted': { feature: Feature; source: string };
  /**
   * A feature moved between layers or groups: where it was and where it is, by the items just
   * below and above it
   */
  'feature.moved': { feature: Feature; from: ItemPosition; to: ItemPosition; source: string };
  /**
   * An item (a feature, or a group of features) was put in another place of the stacking order,
   * in its layer or group or into another one (`kind: 'item'`: where it was and where it is, by
   * the items just below and above it), or many rows of a layer held as rows were (`kind:
   * 'rows'`: their number, and the place they were put at together when they were). An item
   * created or deleted is told by its own event
   */
  'item.moved':
    | { kind: 'item'; itemId: string; from: ItemPosition; to: ItemPosition; source: string }
    | { kind: 'rows'; layerId: string; count: number; to?: ItemPosition; source: string };
  /** A layer was created */
  'layer.created': { layer: Layer; source: string };
  /** A layer changed */
  'layer.updated': { layer: Layer; previous: Layer; source: string };
  /** A layer was deleted */
  'layer.deleted': { layer: Layer; source: string };
  /** The stacking order of the layers changed */
  'layer.reordered': { order: readonly string[]; previous: readonly string[]; source: string };
  /** A group was created */
  'group.created': { group: Group; source: string };
  /** A group changed */
  'group.updated': { group: Group; previous: Group; source: string };
  /** A group was ungrouped */
  'group.deleted': { group: Group; source: string };
  /** The title or the description changed */
  'metadata.updated': { metadata: Metadata; previous: Metadata; source: string };
  /**
   * Rows of the layers held as rows of columns were written ({@link StoreView.tables}): by layer,
   * the rows created, updated and deleted, by their handles, and the fields written
   */
  'rows.changed': { rows: RowsChange; source: string };
  /**
   * Every change of one transaction that changed the document (features, rows, layers, groups,
   * metadata or files); it arrives once per such transaction, after the events of the
   * resources. A change of the selection, the mode or another state of this client alone does
   * not fire it.
   */
  'document.changed': DocumentChange;
  /** A document was loaded */
  'document.loaded': { result: LoadResult; source: string };
  /** The selection changed */
  'selection.changed': { selection: Selection; previous: Selection };
  /** The vertex selection changed */
  'vertexSelection.changed': {
    selection: VertexSelection | null;
    previous: VertexSelection | null;
  };
  /** A drag started */
  'drag.started': { kind: 'feature' | 'vertex' | 'handle'; featureIds: string[] };
  /** A drag ended; `cancelled` is true when it was cancelled */
  'drag.ended': { kind: 'feature' | 'vertex' | 'handle'; featureIds: string[]; cancelled: boolean };
  /** The mode changed */
  'mode.changed': { mode: Mode; previous: Mode };
  /** The items this client hides changed; `ids` is the whole set after the change */
  'hidden.changed': { ids: readonly string[] };
  /** Read-only was turned on or off */
  'readOnly.changed': { readOnly: boolean };
  /** The interaction lock was turned on or off */
  'interactionLock.changed': { locked: boolean };
  /**
   * `draw.options.update` changed the options; `options` and `previous` are what
   * `draw.options.get()` returns after and before the change. An update that leaves every
   * value as it was does not fire it
   */
  'options.changed': { options: Readonly<RuntimeOptions>; previous: Readonly<RuntimeOptions> };
  /** The snapping target changed */
  'snap.changed': { result: SnapResult | null };
  /**
   * The shape being drawn changed, or was cleared (`feature` is `null`). It fires once per
   * change, with no throttling: at each vertex, at each move of the pointer that moves the
   * shape, and when the shape is created, cancelled or left. `feature` has the type, the
   * geometry and the layer of the shape, the ID it will be created with, and the radius of a
   * circle; it is a copy that the drawing does not change afterwards. `confirmedVertices` and
   * `highlightVertex` are the options the shape was shown with (`ModeContext.preview.set`):
   * each is left out when it was not given, and both when the shape is cleared.
   */
  'preview.changed': {
    feature: FeatureInput | null;
    confirmedVertices?: number;
    highlightVertex?: number;
  };
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
  /** A dataset was added */
  'dataset.added': { dataset: Dataset };
  /** A dataset was removed */
  'dataset.removed': { datasetId: string };
  /** The stacking order of the datasets changed */
  'dataset.reordered': { order: readonly string[]; previous: readonly string[] };
  /**
   * The image mode asks for an image to place at a position: the application picks a file
   * and loads it with `document.load(file, { coordinate: lngLat, zoom, layerId })`. `lngLat` is
   * the clicked position when a click led to the mode (a listener of `map.clicked` entered it),
   * and the center of the map when the mode was entered otherwise
   */
  'image.requested': { lngLat: Position; zoom: number; layerId: string };
  /** The divisions of the stacking order changed */
  'layerStack.changed': { entries: readonly LayerStackEntry[] };
  /** Loading or reading an image failed */
  error: { error: DrawError; source: string; featureId?: string };
}

/** A function that receives the payload of an event. */
export type DrawEventListener<K extends keyof DrawEvents = keyof DrawEvents> = (
  payload: DrawEvents[K],
) => void;
