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
import type { UpdateSource } from './extension/store.js';
import type { Feature, Group, Layer, LoadResult, Metadata, MoveTarget } from './model.js';
import type {
  LayerStackEntry,
  Mode,
  Selection,
  SelectionType,
  SnapResult,
  VertexSelection,
} from './state.js';

/** A point on the screen, as `[x, y]` in CSS pixels. */
export type ScreenPoint = [number, number];

/**
 * Everything one transaction changed, as `document.changed` and the subscribers of the Store
 * receive it. It arrives once per transaction, and each category is present only when the
 * transaction changed it.
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
  /** The new order of the items of a layer */
  layerReorder?: { layerId: string; order: string[]; previous: string[] };
  /** The new order of the features of a group */
  groupReorder?: { groupId: string; featureIds: string[]; previous: string[] };
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
  /** A feature moved between layers or groups */
  'feature.moved': { feature: Feature; from: MoveTarget; to: MoveTarget; source: string };
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
  /** Every change of one transaction; it arrives once per transaction */
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
  /** The snapping target changed */
  'snap.changed': { result: SnapResult | null };
  /** A place without a feature was clicked */
  'map.clicked': { lngLat: Position; point: ScreenPoint };
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
   * and loads it with `document.load(file, { coordinate: lngLat, zoom, layerId })`
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
