// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * EventEmitter
 *
 * The component that notifies the outside of state changes.
 * Events can be subscribed to in a form such as draw.on('feature.create', ...).
 */

import type {
  DatasetClickEventPayload,
  MapClickEventPayload,
  RenderSlot,
  SnapResult,
} from '../types/events.js';
import type {
  Feature,
  Group,
  Layer,
  Metadata,
  Mode,
  SelectionType,
  UpdateSource,
} from '../types/model.js';

/**
 * Names of the editing operations of draw.geometry
 */
export type GeometryOperationName = 'union' | 'subtract' | 'intersect' | 'buffer' | 'split';

/**
 * Notification emitted when a geometric operation has been applied
 *
 * status expresses the outcome of the operation. 'applied' means that a result feature was
 * created; 'empty' means that the operation itself succeeded but the result had no area (an
 * intersection that does not overlap, a subtraction where everything was taken away, a buffer
 * where every input became empty, a split that did not divide the polygon). When it is
 * 'empty', the inputs are not modified at all and resultIds is empty.
 *
 * The result of the boolean editing operations (union / subtract / intersect) is always a
 * single one, so the length of resultIds is at most 1. A buffer creates a result per input, so
 * there can be several. A split produces two or more results. resultId is the first element of
 * resultIds (null when it is empty), a shorthand for subscribers that only deal with
 * operations producing a single result.
 *
 * The inputIds of a split are in the order [the polygon being cut, the line that cuts] (the
 * line is an input of the operation but remains without being removed).
 */
export interface GeometryAppliedPayload {
  /** Name of the operation */
  operation: GeometryOperationName;
  /** IDs of the input features (in z order; the last one is in the foreground) */
  inputIds: string[];
  /** ID of the result feature. null when the result is empty */
  resultId: string | null;
  /** IDs of the result features (in z order). An empty array when the result is empty */
  resultIds: string[];
  /** Outcome of the operation */
  status: 'applied' | 'empty';
}

/**
 * Every feature change of one store flush (one transaction, or one mutation outside a
 * transaction)
 *
 * It is emitted once per flush that changes features, after the per-feature events of the
 * same flush, and carries all of them. A subscriber that rebuilds a view on any change
 * subscribes to this instead of the per-feature events, so a bulk load of N features costs
 * one rebuild rather than N.
 */
export interface FeaturesChangePayload {
  /** The features created */
  created: Feature[];
  /** The features updated, each with the feature before the update */
  updated: { feature: Feature; previous: Feature }[];
  /** The features deleted, as they were when they were deleted */
  deleted: Feature[];
  /**
   * Source of the flush ('local', 'silent' or 'batch' from core, 'remote' from a replaced
   * store, or a value of a plugin)
   */
  source: UpdateSource;
}

/**
 * The events of a draw instance by their internal names, with their payloads
 *
 * A plugin subscribes to them with `on` of {@link PluginContext}. They are the events the host
 * receives with `draw.on`, named without the `draw.` prefix: `feature.create` here is
 * `draw.feature.create` there ({@link EventPayloads} describes each one).
 */
export interface EventMap {
  /** A feature was created */
  'feature.create': { feature: Feature };
  /** A feature was updated (with the feature before the update) */
  'feature.update': { feature: Feature; previous: Feature };
  /** A feature was deleted */
  'feature.delete': { feature: Feature };
  /** Every feature change of one Store notification, after the per-feature events */
  'features.change': FeaturesChangePayload;
  /** The selection changed */
  'selection.change': {
    type: SelectionType | null;
    ids: string[];
    previousType: SelectionType | null;
    previousIds: string[];
  };
  /** The mode changed */
  'mode.change': { mode: Mode; previousMode: Mode };
  /** A layer was created */
  'layer.create': { layer: Layer };
  /** A layer was updated (with the layer before the update) */
  'layer.update': { layer: Layer; previous: Layer };
  /** A layer was deleted */
  'layer.delete': { layer: Layer };
  /** The stacking order of the layers changed */
  'layer.reorder': { order: string[]; previous: string[] };
  /** A group was created */
  'group.create': { group: Group };
  /** A group was updated (with the group before the update) */
  'group.update': { group: Group; previous: Group };
  /** A group was deleted */
  'group.delete': { group: Group };
  /** The metadata of the document changed */
  'metadata.change': { metadata: Metadata; previous: Metadata };
  /** The image mode asks the host for an image file, to place at the carried position */
  'image.request': { coordinate: [number, number]; zoom: number; layerId: string };
  /** An operation of `draw.geometry` finished */
  'geometry.applied': GeometryAppliedPayload;
  /**
   * Change of the snapping result
   *
   * Emitted when the snapping target changes (and, when snapping to an edge whose coordinates
   * move, when the coordinates change). When snapping is lost, it is emitted once with no
   * target.
   */
  'snap.change': SnapResult;
  /**
   * Resolution result of the click interception on datasets
   *
   * Emits on one channel whether a click in select mode hit a feature of a dataset
   * (datasetId / feature are carried) or hit nothing (both are null).
   * It is not emitted for a click that hit a feature of the Store.
   */
  'dataset.click': DatasetClickEventPayload;
  /**
   * A dataset was added
   *
   * Emitted by `addDataset` once the dataset is listed, so a handler can get it
   * by its id. A plugin that follows every dataset (to subscribe to its `change`)
   * subscribes to this and to `dataset.remove`, and lists the datasets that already exist
   * once when it is installed.
   */
  'dataset.add': { datasetId: string };
  /**
   * A dataset was removed
   *
   * Emitted by `removeDataset` and by the `remove` of the dataset, once it is no
   * longer listed. It is not emitted when the draw instance is destroyed. A dataset added
   * again under the same id is a new object, announced by a new `dataset.add`.
   */
  'dataset.remove': { datasetId: string };
  /**
   * The order of the datasets changed
   *
   * Emitted by `moveDataset` when it moved a dataset within its side or to
   * another side. `order` is the ids in display order, from the back to the front (the same
   * as `getDatasets`). A move that leaves everything where it was emits nothing, and
   * adding or removing a dataset emits `dataset.add` or `dataset.remove` instead.
   */
  'dataset.reorder': { order: string[] };
  /**
   * Map click in select mode
   *
   * Emits the normalized click as is on one channel, regardless of whether anything was hit
   * and of what was hit (the coordinates are before snapping). It is for read-only
   * subscription and does not affect the selection behavior of the modes. It is used by
   * callers that need "a click anywhere on the map".
   */
  'map.click': MapClickEventPayload;
  /**
   * Addition or removal of frames (the CustomLayer per interval) and changes of the intervals
   *
   * On receiving this, the host re-places the native layers that correspond to the separators
   * between the frames (it carries the same content as getRenderSlots).
   */
  'renderslots.change': { slots: RenderSlot[] };
  /**
   * Failure of an asynchronous load that no call returns
   *
   * `image`: the image of an Image feature could not be decoded (`featureId`). It is emitted
   * once per feature and image, the decode is not retried, and the feature is drawn without
   * its image. The error is the one that was thrown.
   */
  'load.error': LoadErrorPayload;
  /**
   * A drag of the select mode started: the features it moves, and what was grabbed (the
   * features themselves, a vertex or a midpoint, or a handle of the selection)
   *
   * A drag of an auxiliary handle is not announced (its provider writes the changes itself).
   */
  'drag.started': { kind: 'feature' | 'vertex' | 'handle'; featureIds: string[] };
  /**
   * The drag announced by `drag.started` ended, with the same IDs; `cancelled` is true when it
   * was aborted instead of committed
   */
  'drag.ended': {
    kind: 'feature' | 'vertex' | 'handle';
    featureIds: string[];
    cancelled: boolean;
  };
}

/**
 * The payload of the load.error event
 */
export interface LoadErrorPayload {
  /** Where the load was: the image of an Image feature */
  source: 'image';
  /** The Image feature whose image failed */
  featureId: string;
  /** What was thrown */
  error: unknown;
}

/**
 * Event listener type
 */
export type EventListener<K extends keyof EventMap> = (data: EventMap[K]) => void;

/**
 * EventEmitter interface
 */
export interface EventEmitter {
  /**
   * Registers an event listener
   */
  on<K extends keyof EventMap>(event: K, listener: EventListener<K>): void;

  /**
   * Unregisters an event listener
   */
  off<K extends keyof EventMap>(event: K, listener: EventListener<K>): void;

  /**
   * Emits an event
   */
  emit<K extends keyof EventMap>(event: K, data: EventMap[K]): void;
}

/**
 * EventEmitter implementation
 */
export class EventEmitterImpl implements EventEmitter {
  private listeners = new Map<keyof EventMap, Set<EventListener<keyof EventMap>>>();

  on<K extends keyof EventMap>(event: K, listener: EventListener<K>): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener as EventListener<keyof EventMap>);
  }

  off<K extends keyof EventMap>(event: K, listener: EventListener<K>): void {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(listener as EventListener<keyof EventMap>);
    }
  }

  emit<K extends keyof EventMap>(event: K, data: EventMap[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;

    // Take a snapshot so that listeners being added or removed during emit has no effect,
    // and isolate each one individually so that an exception from a single listener does not
    // drag in the following listeners or the internal processing of the Core (EventBridge and
    // so on).
    for (const listener of [...set]) {
      try {
        (listener as EventListener<K>)(data);
      } catch (error) {
        console.error(`Error in event listener for "${String(event)}":`, error);
      }
    }
  }
}
