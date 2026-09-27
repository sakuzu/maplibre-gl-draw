// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The signals of the engine
 *
 * The parts of the engine announce what the Store does not record (snapping, clicks, the
 * datasets, the stacking order, failed loads, drags, image requests) on one internal emitter
 * per instance. The events of the draw instance are made from these signals and from the
 * notifications of the Store (see `api/impl/events.ts`); nothing outside the engine
 * subscribes to the signals.
 */

import type {
  DatasetClickEventPayload,
  MapClickEventPayload,
  RenderSlot,
  SnapResult,
} from '../types/events.js';

/**
 * The signals of the engine by name, with their payloads
 *
 * @internal
 */
export interface EngineSignals {
  /** The image mode asks the host for an image file, to place at the carried position */
  'image.request': { coordinate: [number, number]; zoom: number; layerId: string };
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
   * Emitted once the dataset is listed, so a handler can get it by its id.
   */
  'dataset.add': { datasetId: string };
  /**
   * A dataset was removed
   *
   * Emitted once it is no longer listed. It is not emitted when the draw instance is
   * destroyed. A dataset added again under the same id is a new object, announced by a new
   * `dataset.add`.
   */
  'dataset.remove': { datasetId: string };
  /**
   * The order of the datasets changed
   *
   * Emitted when a move put a dataset elsewhere within its side or on another side. `order`
   * is the ids in display order, from the back to the front. A move that leaves everything
   * where it was emits nothing, and adding or removing a dataset emits `dataset.add` or
   * `dataset.remove` instead.
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
   * of the stacking order
   */
  'layerStack.change': { slots: RenderSlot[] };
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
 * The payload of the load.error signal
 *
 * @internal
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
 * A listener of one signal
 *
 * @internal
 */
export type SignalListener<K extends keyof EngineSignals> = (data: EngineSignals[K]) => void;

/**
 * The emitter of the signals of one engine
 *
 * @internal
 */
export interface EventEmitter {
  /**
   * Registers an event listener
   */
  on<K extends keyof EngineSignals>(event: K, listener: SignalListener<K>): void;

  /**
   * Unregisters an event listener
   */
  off<K extends keyof EngineSignals>(event: K, listener: SignalListener<K>): void;

  /**
   * Emits an event
   */
  emit<K extends keyof EngineSignals>(event: K, data: EngineSignals[K]): void;
}

/**
 * The emitter of the signals of one engine
 *
 * @internal
 */
export class EventEmitterImpl implements EventEmitter {
  private listeners = new Map<keyof EngineSignals, Set<SignalListener<keyof EngineSignals>>>();

  on<K extends keyof EngineSignals>(event: K, listener: SignalListener<K>): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener as SignalListener<keyof EngineSignals>);
  }

  off<K extends keyof EngineSignals>(event: K, listener: SignalListener<K>): void {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(listener as SignalListener<keyof EngineSignals>);
    }
  }

  emit<K extends keyof EngineSignals>(event: K, data: EngineSignals[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;

    // Take a snapshot so that listeners being added or removed during emit has no effect,
    // and isolate each one individually so that an exception from a single listener does not
    // drag in the following listeners or the internal processing of the engine.
    for (const listener of [...set]) {
      try {
        (listener as SignalListener<K>)(data);
      } catch (error) {
        console.error(`Error in event listener for "${String(event)}":`, error);
      }
    }
  }
}
