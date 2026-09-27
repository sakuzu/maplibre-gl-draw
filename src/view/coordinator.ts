// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * RenderCoordinator
 *
 * Subscribes to the Store and automatically triggers a repaint when the state changes.
 * This removes the need for each mode to call requestRepaint() explicitly.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';

import type { Store } from '../store/store.js';
import type { StoreChange } from '../store/types.js';

/**
 * RenderCoordinator interface
 *
 * @internal
 */
export interface RenderCoordinator {
  /**
   * Starts the Store subscription and triggers a repaint on every change
   */
  start(): void;

  /**
   * Cancels the Store subscription
   */
  stop(): void;

  /**
   * Requests a repaint manually
   * The automatic trigger is normally enough; this is for special cases
   */
  requestRender(): void;
}

/**
 * Dependencies of RenderCoordinator
 */
export interface RenderCoordinatorDeps {
  map: MapLibreMap;
  store: Store;
}

/**
 * Determines whether a change requires a repaint
 */
function shouldRepaint(changes: StoreChange): boolean {
  // A repaint is required if any of the following changed
  return !!(
    (
      changes.features || // creation, update or deletion of features
      changes.layers || // layer changes
      changes.groups || // group changes (reordering, show/hide)
      changes.layerReorder || // reordering of items within a layer
      changes.groupReorder || // reordering of features within a group
      changes.selection || // selection state changes
      changes.tentative || // changes to the transient state while drawing
      changes.uiStateChanged
    ) // changes to the UI state (dragState, boxSelection)
  );
}

/**
 * RenderCoordinator implementation
 */
export class RenderCoordinatorImpl implements RenderCoordinator {
  private map: MapLibreMap;
  private store: Store;
  private unsubscribe: (() => void) | null = null;

  constructor(deps: RenderCoordinatorDeps) {
    this.map = deps.map;
    this.store = deps.store;
  }

  start(): void {
    // Do nothing if already subscribed
    if (this.unsubscribe) {
      return;
    }

    this.unsubscribe = this.store.subscribe((changes: StoreChange) => {
      if (shouldRepaint(changes)) {
        this.map.triggerRepaint();
      }
    });
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  requestRender(): void {
    this.map.triggerRepaint();
  }
}

/**
 * Creates a RenderCoordinator
 *
 * @internal
 */
export function createRenderCoordinator(deps: RenderCoordinatorDeps): RenderCoordinator {
  return new RenderCoordinatorImpl(deps);
}
