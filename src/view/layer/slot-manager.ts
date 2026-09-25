// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SlotManager
 *
 * Keeps the slots (one CustomLayer per segment of the stacking order) in step with the stacking
 * order, and counts how many of them are on the maplibre map. The engine behind the slots is
 * built when the first slot goes onto the map and torn down when the last one leaves; the
 * manager only answers "first" and "last", and the layer builds and tears down. How the order is
 * cut into segments is in slots.ts, and the design is chapter 5 of
 * docs/internals/rendering.md ("Slots and separators").
 */

import type { CustomLayerInterface, Map as MapLibreMap } from 'maplibre-gl';
import {
  partitionLayerOrder,
  type RenderSegment,
  type RenderSlot,
  renderSlotLayerId,
  sameSegments,
} from './slots.js';

/** What the manager needs */
export interface SlotManagerDeps {
  map: Pick<MapLibreMap, 'getLayer' | 'addLayer' | 'removeLayer'> & {
    triggerRepaint?: () => void;
  };
  /** The current stacking order */
  getLayerOrder: () => readonly string[];
  /** Predicate that identifies the separators (always false when omitted = a single slot) */
  isExternalEntry?: (entryId: string) => boolean;
  /** Where the changes of the slots and of the segments are notified */
  onSlotsChange?: (slots: RenderSlot[]) => void;
  /** Creates the CustomLayer of the slot at `index` (index 1 onwards) */
  createSlotLayer: (index: number) => CustomLayerInterface;
}

/**
 * The slots of one draw instance
 *
 * @internal
 */
export class SlotManager {
  private readonly deps: SlotManagerDeps;
  /** The current list of segments (layerOrder cut at the separators) */
  private currentSegments: RenderSegment[];
  /** The CustomLayers of the slots (first = backmost; the first is the primary layer) */
  private readonly slotLayers: CustomLayerInterface[] = [];
  /** Number of slots added to maplibre (0 → 1 builds the engine, 1 → 0 tears it down) */
  private added = 0;

  constructor(deps: SlotManagerDeps) {
    this.deps = deps;
    this.currentSegments = partitionLayerOrder(deps.getLayerOrder(), deps.isExternalEntry);
  }

  /** The current list of segments */
  get segments(): readonly RenderSegment[] {
    return this.currentSegments;
  }

  /** Number of slots currently on the map */
  get addedCount(): number {
    return this.added;
  }

  /**
   * Registers the primary layer as the first slot and prepares the following slots
   *
   * When there are separators, the following slots are prepared here (the host adds them to the
   * map in order from the first).
   */
  init(primary: CustomLayerInterface): void {
    this.slotLayers.push(primary);
    for (let index = 1; index < this.currentSegments.length; index++) {
      this.slotLayers.push(this.deps.createSlotLayer(index));
    }
  }

  /**
   * Records that a slot went onto the map
   *
   * @returns true when it is the first one (the engine is to be built)
   */
  attach(): boolean {
    this.added++;
    return this.added === 1;
  }

  /**
   * Records that a slot left the map
   *
   * @returns true when none is left (the engine is to be torn down)
   */
  detach(): boolean {
    this.added = Math.max(0, this.added - 1);
    return this.added === 0;
  }

  /** The list of slots (public form) */
  getRenderSlots(): RenderSlot[] {
    return this.currentSegments.map((segment, index) => ({
      layerId: this.slotLayers[index]?.id ?? renderSlotLayerId(index),
      from: segment.from,
      to: segment.to,
    }));
  }

  /** The CustomLayers of the slots (first = backmost) */
  getSlotLayers(): CustomLayerInterface[] {
    return this.slotLayers.slice();
  }

  /**
   * Makes the slots follow the changes of the stacking order
   *
   * Nothing happens when the list of segments has not changed. A new slot is added to the front
   * of the maplibre order (which is consistent with the slots added from the first one onwards;
   * placing the native layers of the separators again is the responsibility of the host and is
   * prompted by the notification). When a slot is removed, it is removed from the last one.
   */
  sync(): void {
    const { map, isExternalEntry, onSlotsChange } = this.deps;
    const next = partitionLayerOrder(this.deps.getLayerOrder(), isExternalEntry);
    if (sameSegments(next, this.currentSegments)) return;
    this.currentSegments = next;
    const slotLayers = this.slotLayers;
    while (slotLayers.length < next.length) {
      const slot = this.deps.createSlotLayer(slotLayers.length);
      slotLayers.push(slot);
      // The following slots are added to the map only while the first slot is on it (when it is
      // not, the host adds them later in order from the first)
      if (this.hasMapLayer(slotLayers[0].id) && !this.hasMapLayer(slot.id)) {
        map.addLayer(slot);
      }
    }
    while (slotLayers.length > next.length) {
      const slot = slotLayers.pop();
      if (slot && this.hasMapLayer(slot.id)) {
        map.removeLayer(slot.id);
      }
    }
    onSlotsChange?.(this.getRenderSlots());
    map.triggerRepaint?.();
  }

  /** Whether the map has that layer (always false while the style is not loaded) */
  private hasMapLayer(id: string): boolean {
    try {
      return !!this.deps.map.getLayer(id);
    } catch {
      return false;
    }
  }
}
