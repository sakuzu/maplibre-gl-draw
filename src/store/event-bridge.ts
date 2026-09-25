// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * EventBridge
 *
 * A bridge that converts the Store's StateChanges into EventEmitter events.
 * It converts the Store's internal event format into the public event format used by
 * draw.on().
 */

import type { EventEmitter } from '../shared/utils/event-emitter.js';
import type { Store } from './store.js';
import type { StateChanges } from './types.js';

/**
 * EventBridge interface
 *
 * @internal
 */
export interface EventBridge {
  /**
   * Starts the bridge (starts subscribing to the Store)
   */
  start(): void;

  /**
   * Stops the bridge (unsubscribes from the Store)
   */
  stop(): void;
}

/**
 * EventBridge implementation
 *
 * @internal
 */
export class EventBridgeImpl implements EventBridge {
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly store: Store,
    private readonly emitter: EventEmitter,
  ) {}

  start(): void {
    if (this.unsubscribe) return;

    this.unsubscribe = this.store.subscribe((changes) => {
      this.handleChanges(changes);
    });
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  private handleChanges(changes: StateChanges): void {
    // Every change is emitted as its own event, whatever the source: a subscriber that keeps
    // another copy in sync (a server, an index) needs each of them. A subscriber that only
    // rebuilds a view on any change subscribes to features.change instead, which comes once
    // per flush, so a bulk load of N features does not cost it N rebuilds.
    const features = changes.features;
    if (features) {
      const created = [...(features.created ?? [])];
      const updated = (features.updated ?? []).map(({ feature, previous }) => ({
        feature,
        previous,
      }));
      const deleted = [...(features.deleted ?? [])];
      for (const feature of created) {
        this.emitter.emit('feature.create', { feature });
      }
      for (const payload of updated) {
        this.emitter.emit('feature.update', payload);
      }
      for (const feature of deleted) {
        this.emitter.emit('feature.delete', { feature });
      }
      if (created.length > 0 || updated.length > 0 || deleted.length > 0) {
        this.emitter.emit('features.change', {
          created,
          updated,
          deleted,
          source: changes.source ?? 'local',
        });
      }
    }

    // Layer events
    if (changes.layers) {
      if (changes.layers.created) {
        for (const layer of changes.layers.created) {
          this.emitter.emit('layer.create', { layer });
        }
      }
      if (changes.layers.updated) {
        for (const { layer, previous } of changes.layers.updated) {
          this.emitter.emit('layer.update', { layer, previous });
        }
      }
      if (changes.layers.deleted) {
        for (const layer of changes.layers.deleted) {
          this.emitter.emit('layer.delete', { layer });
        }
      }
      if (changes.layers.orderChanged) {
        this.emitter.emit('layer.reorder', {
          order: changes.layers.orderChanged.order,
          previous: changes.layers.orderChanged.previous,
        });
      }
    }

    // Group events
    if (changes.groups) {
      if (changes.groups.created) {
        for (const group of changes.groups.created) {
          this.emitter.emit('group.create', { group });
        }
      }
      if (changes.groups.updated) {
        for (const { group, previous } of changes.groups.updated) {
          this.emitter.emit('group.update', { group, previous });
        }
      }
      if (changes.groups.deleted) {
        for (const group of changes.groups.deleted) {
          this.emitter.emit('group.delete', { group });
        }
      }
    }

    // Layer reorder event (reordering within a layer)
    if (changes.layerReorder) {
      // Emitted as a layer.update event (in order to update the UI)
      const layer = this.store.getLayer(changes.layerReorder.layerId);
      if (layer) {
        this.emitter.emit('layer.update', {
          layer,
          previous: { ...layer, order: changes.layerReorder.previous },
        });
      }
    }

    // Group reorder event (reordering within a group)
    if (changes.groupReorder) {
      // Emitted as a group.update event (in order to update the UI)
      const group = this.store.getGroup(changes.groupReorder.groupId);
      if (group) {
        this.emitter.emit('group.update', {
          group,
          previous: { ...group, featureIds: changes.groupReorder.previous },
        });
      }
    }

    // Selection event
    if (changes.selection) {
      this.emitter.emit('selection.change', {
        type: changes.selection.type,
        ids: changes.selection.ids,
        previousType: changes.selection.previousType,
        previousIds: changes.selection.previousIds,
      });
    }

    // Mode event
    if (changes.mode) {
      this.emitter.emit('mode.change', {
        mode: changes.mode.mode,
        previousMode: changes.mode.previous,
      });
    }

    // Metadata event
    if (changes.metadata) {
      this.emitter.emit('metadata.change', {
        metadata: changes.metadata.metadata,
        previous: changes.metadata.previous,
      });
    }
  }
}
