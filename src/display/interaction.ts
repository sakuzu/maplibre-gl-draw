// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Hit test interception of the datasets
 *
 * It is called after InputRouter has dispatched a normalized event to the modes, and returns
 * click / hover as events of a dataset. It shows no selection UI and changes nothing in the
 * state of the Store.
 *
 * Where it is dispatched is decided by the result of the unified z scan (`hitTestTopmost`). Only
 * the frontmost of the visible things receives the click, so when a feature of the Store is in
 * front nothing is dispatched to a dataset, and when a dataset is in front it is dispatched
 * to that dataset (the rule that the Store always wins was abolished).
 *
 * When a dataset that is not interactive is frontmost, it only blocks the hit and fires
 * nothing (the feature of the result becomes null). When there is not a single visible
 * dataset, the scan itself is not run (so that the cost is zero while it is disabled).
 */

import type { TopHit } from '../dispatcher/hit-test/topmost.js';
import type { MouseNormalizedEvent } from '../dispatcher/types.js';
import type { Coordinate } from '../shared/types/model.js';
import type { DatasetManager } from './manager.js';
import type { DatasetClickEventPayload } from './types.js';

/**
 * Dependencies of the interception
 *
 * @internal
 */
export interface DisplayInteractionsDeps {
  /** The manager of the datasets */
  manager: DatasetManager;
  /** Returns the frontmost hit in the visual stacking order (the unified z scan) */
  hitTestTopmost(event: MouseNormalizedEvent): TopHit | null;
  /**
   * Notification of the resolved result of a click (the source of the public instance event
   * draw.dataset.click). It is called once whether there was a hit or not. It is not called when
   * a feature of the Store is in front.
   */
  notifyClick?(payload: DatasetClickEventPayload): void;
}

/**
 * Interface of the interception
 *
 * @internal
 */
export interface DisplayInteractions {
  /** Dispatches a click */
  handleClick(event: MouseNormalizedEvent): void;
  /** Dispatches a mouse move (fires hover) */
  handleMouseMove(event: MouseNormalizedEvent): void;
  /** Resets the hover state */
  reset(): void;
}

/**
 * Creates the interception
 *
 * @internal
 */
export function createDisplayInteractions(deps: DisplayInteractionsDeps): DisplayInteractions {
  const { manager, hitTestTopmost, notifyClick } = deps;

  /** The dataset id and feature id being hovered */
  let hoveredDatasetId: string | null = null;
  let hoveredFeatureId: string | null = null;

  function toCoordinate(event: MouseNormalizedEvent): Coordinate {
    return [event.lngLat.lng, event.lngLat.lat];
  }

  function clearHover(lngLat: Coordinate): void {
    if (hoveredDatasetId === null) return;

    const previous = manager.getInternal(hoveredDatasetId);
    const datasetId = hoveredDatasetId;
    hoveredDatasetId = null;
    hoveredFeatureId = null;

    // Report with feature: null that it left the target
    previous?.emit('hover', { datasetId, feature: null, row: null, lngLat });
  }

  return {
    handleClick(event: MouseNormalizedEvent): void {
      if (!manager.hasAny()) return;

      const top = hitTestTopmost(event);
      // Nothing happens when a feature of the Store is in front (that is the domain of the
      // Store selection; neither the click of a dataset nor a no-hit notification is
      // emitted). A companion of a feature (feature companion) is likewise the domain of the
      // Store side, and the click is handed to the provider by the select mode.
      if (top?.kind === 'store' || top?.kind === 'companion') return;

      const coordinate = toCoordinate(event);
      if (top?.kind === 'dataset' && top.feature) {
        // A feature of an interactive dataset was hit. Both the click of the dataset and
        // the notification of the resolved result are emitted
        const row = top.row ?? -1;
        manager.getInternal(top.dataset.id)?.emit('click', {
          datasetId: top.dataset.id,
          feature: top.feature,
          row,
          lngLat: coordinate,
        });
        notifyClick?.({
          datasetId: top.dataset.id,
          feature: top.feature,
          row,
          lngLat: coordinate,
        });
        return;
      }
      // Nothing was there, or a non-interactive dataset merely blocked it: it is reported as
      // a no-hit (the source of "click on empty space to deselect" on the host side)
      notifyClick?.({ datasetId: null, feature: null, row: null, lngLat: coordinate });
    },

    handleMouseMove(event: MouseNormalizedEvent): void {
      const coordinate = toCoordinate(event);

      if (!manager.hasAny()) {
        clearHover(coordinate);
        return;
      }

      const top = hitTestTopmost(event);
      if (top?.kind !== 'dataset' || !top.feature) {
        clearHover(coordinate);
        return;
      }

      if (top.dataset.id === hoveredDatasetId && top.feature.id === hoveredFeatureId) {
        // Nothing fires while the pointer only moves over the same feature
        return;
      }

      clearHover(coordinate);
      hoveredDatasetId = top.dataset.id;
      hoveredFeatureId = top.feature.id;
      manager.getInternal(top.dataset.id)?.emit('hover', {
        datasetId: top.dataset.id,
        feature: top.feature,
        row: top.row ?? null,
        lngLat: coordinate,
      });
    },

    reset(): void {
      hoveredDatasetId = null;
      hoveredFeatureId = null;
    },
  };
}
