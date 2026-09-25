// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SlotManager: allocating and releasing the slots as the stacking order changes, and counting
 * the slots on the map (the first builds the engine, the last tears it down)
 */

import type { CustomLayerInterface } from 'maplibre-gl';
import { describe, expect, it, vi } from 'vitest';
import { SlotManager } from './slot-manager.js';
import { renderSlotLayerId } from './slots.js';

function slotLayer(index: number): CustomLayerInterface {
  return { id: renderSlotLayerId(index), type: 'custom', render: () => {} };
}

function setup(initialOrder: string[]) {
  let order = initialOrder;
  const onMap = new Set<string>();
  const map = {
    getLayer: vi.fn((id: string) => (onMap.has(id) ? { id } : undefined)),
    addLayer: vi.fn((layer: CustomLayerInterface) => {
      onMap.add(layer.id);
    }),
    removeLayer: vi.fn((id: string) => {
      onMap.delete(id);
    }),
    triggerRepaint: vi.fn(),
  };
  const onSlotsChange = vi.fn();
  const slots = new SlotManager({
    map: map as never,
    getLayerOrder: () => order,
    // Entries named "ext:" are the separators of the host
    isExternalEntry: (id) => id.startsWith('ext:'),
    onSlotsChange,
    createSlotLayer: slotLayer,
  });
  const primary = slotLayer(0);
  slots.init(primary);
  return {
    slots,
    map,
    onMap,
    onSlotsChange,
    primary,
    setOrder: (next: string[]) => {
      order = next;
    },
  };
}

describe('SlotManager allocation', () => {
  it('prepares one slot per segment, the first being the primary layer', () => {
    const { slots, primary } = setup(['a', 'ext:mvt', 'b', 'c']);
    const layers = slots.getSlotLayers();
    expect(layers).toHaveLength(2);
    expect(layers[0]).toBe(primary);
    expect(slots.getRenderSlots()).toEqual([
      { layerId: renderSlotLayerId(0), from: 0, to: 1 },
      { layerId: renderSlotLayerId(1), from: 2, to: 4 },
    ]);
  });

  it('adds a slot when a separator appears, onto the map only while the first slot is on it', () => {
    const { slots, map, onMap, onSlotsChange, setOrder } = setup(['a', 'b']);
    setOrder(['a', 'ext:mvt', 'b']);
    slots.sync();
    // The first slot is not on the map: the host adds the new one later
    expect(map.addLayer).not.toHaveBeenCalled();
    expect(slots.getSlotLayers()).toHaveLength(2);
    expect(onSlotsChange).toHaveBeenCalledTimes(1);

    onMap.add(renderSlotLayerId(0));
    setOrder(['a', 'ext:mvt', 'b', 'ext:raster', 'c']);
    slots.sync();
    expect(map.addLayer).toHaveBeenCalledTimes(1);
    expect(onMap.has(renderSlotLayerId(2))).toBe(true);
    expect(onSlotsChange).toHaveBeenLastCalledWith([
      { layerId: renderSlotLayerId(0), from: 0, to: 1 },
      { layerId: renderSlotLayerId(1), from: 2, to: 3 },
      { layerId: renderSlotLayerId(2), from: 4, to: 5 },
    ]);
  });

  it('releases the last slots when separators go away, removing them from the map', () => {
    const { slots, map, onMap, setOrder } = setup(['a', 'ext:mvt', 'b', 'ext:raster', 'c']);
    for (const layer of slots.getSlotLayers()) onMap.add(layer.id);
    setOrder(['a', 'b', 'c']);
    slots.sync();
    expect(slots.getSlotLayers()).toHaveLength(1);
    expect(map.removeLayer).toHaveBeenCalledWith(renderSlotLayerId(2));
    expect(map.removeLayer).toHaveBeenCalledWith(renderSlotLayerId(1));
    expect(onMap.has(renderSlotLayerId(0))).toBe(true);
  });

  it('does nothing when the segments did not change', () => {
    const { slots, onSlotsChange, map, setOrder } = setup(['a', 'ext:mvt', 'b']);
    setOrder(['a', 'ext:mvt', 'b']);
    slots.sync();
    expect(onSlotsChange).not.toHaveBeenCalled();
    expect(map.triggerRepaint).not.toHaveBeenCalled();
  });
});

describe('SlotManager attach and detach', () => {
  it('answers first on the first attach and last when the count returns to zero', () => {
    const { slots } = setup(['a', 'ext:mvt', 'b']);
    expect(slots.attach()).toBe(true);
    expect(slots.attach()).toBe(false);
    expect(slots.addedCount).toBe(2);
    expect(slots.detach()).toBe(false);
    expect(slots.detach()).toBe(true);
    expect(slots.addedCount).toBe(0);
    // A removal without an addition does not go below zero (and still counts as the last)
    expect(slots.detach()).toBe(true);
    expect(slots.addedCount).toBe(0);
  });
});
