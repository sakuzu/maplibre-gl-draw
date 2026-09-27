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
import type { Feature, Group, Layer, LoadResult, Metadata, MoveTarget } from './model.js';
import type { LayerStackEntry, Mode, Selection, SnapResult, VertexSelection } from './state.js';

/** A point on the screen, as `[x, y]` in CSS pixels. */
export type ScreenPoint = [number, number];

/**
 * Every change of the document made by one transaction.
 */
export interface DocumentChange {
  /** The features that were created, updated and deleted */
  features: {
    created: Feature[];
    updated: { feature: Feature; previous: Feature }[];
    deleted: Feature[];
  };
  /** The layers that were created, updated and deleted */
  layers: {
    created: Layer[];
    updated: { layer: Layer; previous: Layer }[];
    deleted: Layer[];
  };
  /** The groups that were created, updated and deleted */
  groups: {
    created: Group[];
    updated: { group: Group; previous: Group }[];
    deleted: Group[];
  };
  /** The metadata, when it changed */
  metadata?: { metadata: Metadata; previous: Metadata };
  /** Where the writes came from */
  source: string;
  /** True while a drag is in progress */
  intermediate: boolean;
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
  'dataset.clicked': { datasetId: string; rowIndex: number; row: DatasetRow };
  /** A dataset was added */
  'dataset.added': { dataset: Dataset };
  /** A dataset was removed */
  'dataset.removed': { datasetId: string };
  /** The stacking order of the datasets changed */
  'dataset.reordered': { order: readonly string[]; previous: readonly string[] };
  /** The data of an image is needed */
  'image.requested': { featureId: string; fileId: string };
  /** The divisions of the stacking order changed */
  'layerStack.changed': { entries: readonly LayerStackEntry[] };
  /** Loading or reading an image failed */
  error: { error: DrawError; source: string; featureId?: string };
}

/** A function that receives the payload of an event. */
export type DrawEventListener<K extends keyof DrawEvents = keyof DrawEvents> = (
  payload: DrawEvents[K],
) => void;
