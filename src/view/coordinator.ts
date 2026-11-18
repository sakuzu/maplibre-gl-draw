// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * RenderCoordinator
 *
 * Subscribes to the Store and to the state of this client the instance holds, and
 * automatically triggers a repaint when either changes.
 * This removes the need for each mode to call requestRepaint() explicitly.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import type { ClientChange } from '../store/memory/ui-state.js';
import type { Store } from '../store/store.js';
import type { StoreChange } from '../store/types.js';

/**
 * RenderCoordinator interface
 *
 * @internal
 */
export interface RenderCoordinator {
  /**
   * Starts the subscriptions (the Store and the state of this client) and triggers a repaint on
   * every change
   */
  start(): void;

  /**
   * Cancels the subscriptions
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
  /** The Store, and the state of this client the instance holds (`store.client`) */
  store: Pick<Store, 'subscribe' | 'client'>;
}

/**
 * Determines whether a change of the Store requires a repaint
 */
function shouldRepaint(changes: StoreChange): boolean {
  // A repaint is required if any of the following changed
  return !!(
    changes.features || // creation, update or deletion of features
    changes.layers || // layer changes
    changes.groups || // group changes (reordering, show/hide)
    changes.layerReorder || // reordering of items within a layer
    changes.groupReorder || // reordering of features within a group
    changes.tentative || // changes to the transient state while drawing
    changes.uiStateChanged || // changes to the UI state (dragState, boxSelection)
    // the whole document replaced
    changes.reset
  );
}

/**
 * Determines whether a change of the state of this client requires a repaint: the selection,
 * and the vertex selection, read-only, the interaction lock and local hiding
 */
function shouldRepaintClient(change: ClientChange): boolean {
  return !!(change.selection || change.uiStateChanged);
}

/**
 * RenderCoordinator implementation
 */
export class RenderCoordinatorImpl implements RenderCoordinator {
  private map: MapLibreMap;
  private store: RenderCoordinatorDeps['store'];
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

    const stopStore = this.store.subscribe((changes: StoreChange) => {
      if (shouldRepaint(changes)) {
        this.map.triggerRepaint();
      }
    });
    const stopClient = this.store.client.subscribe((change: ClientChange) => {
      if (shouldRepaintClient(change)) {
        this.map.triggerRepaint();
      }
    });
    this.unsubscribe = () => {
      stopStore();
      stopClient();
    };
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
