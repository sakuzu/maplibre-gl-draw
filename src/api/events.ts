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
import type { UpdateSource } from './extension/store.js';
import type {
  ChangedIds,
  Feature,
  FeatureInput,
  FeatureValues,
  FileData,
  Group,
  IdSet,
  Layer,
  LoadResult,
  Metadata,
  MoveTarget,
} from './model.js';
import type { RuntimeOptions } from './options.js';
import type { LayerStackEntry, Mode, Selection, SnapResult, VertexSelection } from './state.js';

/** A point on the screen, as `[x, y]` in CSS pixels. */
export type ScreenPoint = [number, number];

/**
 * One change of the document, in the words of the features: what `document.changed` delivers,
 * once per transaction that changed the document. It lists the IDs of what changed; what the
 * features are now is read from `draw.features`.
 *
 * A bulk edit (`features.translate`, `deleteMany`, `restore`, `document.load` and the others)
 * is one operation written in parts: its changes share one `operationId`, every one but the
 * last has `hasMoreParts: true`, and the last one always arrives, also when the edit stopped
 * before it had written everything (`stopped: true`; that change may list nothing). A
 * subscriber that takes an edit as one change (to keep the document, or to write it back)
 * gathers the changes of its `operationId` up to the one without `hasMoreParts`. Any other
 * change is one operation of one change.
 */
export interface DocumentChange {
  /** Where the writes came from */
  source: UpdateSource;
  /**
   * The number of the operation the change is a part of: the same for every part of a bulk
   * edit (`EditCounts.operationId`), for the write of a drag (`drag.started`), and for the
   * calls of the computation of moves that wrote it (`TransformInput.operationId`); a new one
   * for any other change. Numbers are not used twice in an instance.
   */
  operationId: number;
  /** True when more changes of the same operation follow */
  hasMoreParts: boolean;
  /**
   * True on the last change of an operation that stopped before it had written everything
   * (the document turned read-only, or the instance was destroyed; see
   * {@link FeaturesCollection}). The parts written stay
   */
  stopped: boolean;
  /**
   * True when the change replaces the whole document (a load with `mode: 'replace'`, or a
   * replacement written to the Store): `features.deleted` lists what was there, and
   * `features.created` what is written in the change. When the replacement is written in
   * parts, its first change is marked, and the changes of the same operation after it go on
   * writing it. The current mode drops what it was drawing (`ModeHandler.onCancel`); the
   * selection, the editing and the items this client hides let go of what is gone once the
   * operation ends, so that an item written again in a later part keeps them.
   */
  reset: boolean;
  /** The features created, updated, deleted and moved */
  features: ChangedIds;
  /**
   * The layers created, updated and deleted, and the change of the stacking order; a change
   * that creates or deletes a layer always carries `orderChanged`
   */
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
  /**
   * The groups created, updated, deleted and moved. `features.restore` writes all of them
   * back, with the features (see {@link FeatureValues}): a caller that writes back a change
   * reads them only to show what changed
   */
  groups?: {
    created?: Group[];
    updated?: Array<{
      id: string;
      group: Group;
      previous: Group;
    }>;
    deleted?: Group[];
    /**
     * Groups moved themselves (not what they hold): `from` and `to` are each a layer and a
     * position in it (`MoveTarget`, `{ layerId, index }`), where the group was before and
     * where it is now: in another layer, or at another position in its layer
     */
    moved?: Array<{
      id: string;
      group: Group;
      from: MoveTarget;
      to: MoveTarget;
    }>;
  };
  /** The new metadata and the one before it */
  metadata?: {
    metadata: Metadata;
    previous: Metadata;
    /**
     * The keys the change wrote, each once (a key taken off included), so that a subscriber
     * of many keys reads only those
     */
    keys: readonly string[];
  };
  /** The embedded files created and deleted */
  files?: {
    created?: FileData[];
    deleted?: FileData[];
  };
  /**
   * What the change did to the features, the deleted features kept (see
   * {@link FeatureValues}): what `features.restore` takes back. Only for a
   * subscriber of `draw.document.subscribe` that asked for them, for this source; never on the
   * payload of `draw.on('document.changed')`. A change that wrote no feature has none.
   */
  previousValues?: FeatureValues;
}

/**
 * The events, by name, with their payloads.
 */
export interface DrawEvents {
  /**
   * A feature was created, or came back (`features.restore`); `hasMoreParts` is true when the
   * change is a part of a bulk edit that is not its last part, as `hasMoreParts` of the
   * `document.changed` it comes with (the same in the four events of the features)
   *
   * It arrives once per feature, also when one change touches many features. The feature
   * objects are made only while the event has a listener; for changes of many features, listen
   * to `document.changed` instead.
   */
  'feature.created': {
    feature: Feature;
    source: UpdateSource;
    hasMoreParts: boolean;
  };
  /** A feature changed; `intermediate` is true while a drag is in progress */
  'feature.updated': {
    feature: Feature;
    previous: Feature;
    source: UpdateSource;
    intermediate: boolean;
  };
  /**
   * A feature was deleted
   *
   * It arrives once per feature, also when one change touches many features. The feature
   * objects are made only while the event has a listener; for changes of many features, listen
   * to `document.changed` instead. A change that replaces the whole document
   * (`DocumentChange.reset`) tells every feature taken out here, before the features it
   * writes are told as created.
   */
  'feature.deleted': {
    feature: Feature;
    source: UpdateSource;
    hasMoreParts: boolean;
  };
  /**
   * A feature moved to another layer or group, or to another position in its layer or group
   *
   * It arrives once per feature, also when one change touches many features. The feature
   * objects are made only while the event has a listener; for changes of many features, listen
   * to `document.changed` instead.
   */
  'feature.moved': {
    feature: Feature;
    from: MoveTarget;
    to: MoveTarget;
    source: UpdateSource;
    hasMoreParts: boolean;
  };
  /** A layer was created */
  'layer.created': {
    layer: Layer;
    source: UpdateSource;
  };
  /**
   * A layer changed: one of its own values (its name, its visibility, its lock, its opacity,
   * its rule or its metadata). A change of the order of what it holds does not fire it:
   * `feature.moved` and `group.moved` tell of those
   */
  'layer.updated': {
    layer: Layer;
    previous: Layer;
    source: UpdateSource;
  };
  /** A layer was deleted */
  'layer.deleted': {
    layer: Layer;
    source: UpdateSource;
  };
  /** The stacking order of the layers changed */
  'layer.reordered': {
    order: readonly string[];
    previous: readonly string[];
    source: UpdateSource;
  };
  /** A group was created */
  'group.created': {
    group: Group;
    source: UpdateSource;
  };
  /**
   * A group changed: one of its own values (its name, its visibility or its lock). A change of
   * the order of its features does not fire it: `feature.moved` tells of those
   */
  'group.updated': {
    group: Group;
    previous: Group;
    source: UpdateSource;
  };
  /** A group moved to another layer, or to another position in its layer */
  'group.moved': {
    group: Group;
    from: MoveTarget;
    to: MoveTarget;
    source: UpdateSource;
  };
  /** A group was ungrouped */
  'group.deleted': {
    group: Group;
    source: UpdateSource;
  };
  /** The title or the description changed */
  'metadata.updated': {
    metadata: Metadata;
    previous: Metadata;
    source: UpdateSource;
  };
  /**
   * Every change of one transaction that changed the document (features, layers, groups,
   * metadata or files), in the words of the features: the IDs of what changed, where the
   * change came from and the operation it is a part of. It arrives once per such transaction,
   * after the events of the resources, and once more at the end of a bulk edit that stopped
   * (see {@link DocumentChange}). A change of the selection, the mode or another state of this
   * client alone does not fire it. The values the features had before are carried to a
   * subscriber of `draw.document.subscribe` that asks for them. The events of the document
   * are told once the Store has told every one of its listeners, so a listener can write. The
   * changes are told in the order they were written: what a listener writes is told once the
   * change being told has reached every listener and every subscriber.
   */
  'document.changed': DocumentChange;
  /** A document was loaded */
  'document.loaded': {
    result: LoadResult;
    source: UpdateSource;
  };
  /**
   * The selection changed. `operationId` is the operation of the change of the document it
   * came with (the features deleted leaving the selection, a copy selected), as
   * `document.changed` carries it, or `null` when the selection changed alone; the selection
   * changes before that `document.changed` arrives
   */
  'selection.changed': {
    selection: Selection;
    previous: Selection;
    /**
     * The operation of the change of the document that came with it (not of the change of the
     * selection), or `null` when the selection changed alone
     */
    operationId: number | null;
  };
  /** The features this client marks as being edited changed; `ids` is the whole set after it */
  'editingFeatures.changed': {
    ids: IdSet;
  };
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
  'mode.changed': {
    mode: Mode;
    previous: Mode;
  };
  /** The items this client hides changed; `ids` is the whole set after the change */
  'hidden.changed': {
    ids: IdSet;
  };
  /** Read-only was turned on or off */
  'readOnly.changed': {
    readOnly: boolean;
  };
  /** The interaction lock was turned on or off */
  'interactionLock.changed': {
    locked: boolean;
  };
  /**
   * `draw.options.update` changed the options; `options` and `previous` are what
   * `draw.options.get()` returns after and before the change. An update that leaves every
   * value as it was does not fire it
   */
  'options.changed': {
    options: Readonly<RuntimeOptions>;
    previous: Readonly<RuntimeOptions>;
  };
  /** The snapping target changed */
  'snap.changed': {
    result: SnapResult | null;
  };
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
  'map.clicked': {
    lngLat: Position;
    point: ScreenPoint;
    hit: Hit | null;
  };
  /** A row of a dataset was clicked */
  'dataset.clicked': {
    datasetId: string;
    rowIndex: number;
    row: DatasetRow;
    lngLat: Position;
    point: ScreenPoint;
  };
  /** A dataset was added */
  'dataset.added': {
    dataset: Dataset;
  };
  /** A dataset was removed */
  'dataset.removed': {
    datasetId: string;
  };
  /** The stacking order of the datasets changed */
  'dataset.reordered': {
    order: readonly string[];
    previous: readonly string[];
  };
  /**
   * The image mode asks for an image to place at a position: the application picks a file
   * and loads it with `document.load(file, { coordinate: lngLat, zoom, layerId })`. `lngLat` is
   * the clicked position when a click led to the mode (a listener of `map.clicked` entered it),
   * and the center of the map when the mode was entered otherwise
   */
  'image.requested': {
    lngLat: Position;
    zoom: number;
    layerId: string;
  };
  /** The divisions of the stacking order changed */
  'layerStack.changed': {
    entries: readonly LayerStackEntry[];
  };
  /** Loading or reading an image failed */
  'image.failed': {
    error: DrawError;
    source: string;
    featureId?: string;
  };
}

/** A function that receives the payload of an event. */
export type DrawEventListener<K extends keyof DrawEvents = keyof DrawEvents> = (
  payload: DrawEvents[K],
) => void;
