// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import type { CustomLayerInterface, Map as MapLibreMap } from 'maplibre-gl';

/**
 * Whether the style of the map accepts new layers right now
 *
 * This is the same condition that maplibre checks in `map.addLayer` (the style has finished
 * parsing its stylesheet). It is deliberately not `map.loaded()` or `map.isStyleLoaded()`: those
 * are also false while tiles, sprites or images are loading, which happens after every pan or
 * zoom, although layers can be added at that time.
 */
function styleAcceptsLayers(map: MapLibreMap): boolean {
  return map.style?._loaded === true;
}

/**
 * Keeps the frames of the stacking order on the map for as long as the returned detach function has not
 * been called
 *
 * One rule covers every timing: the slots are added whenever the style accepts layers and a slot
 * is missing. It is checked once now (for a map whose style is already parsed, even while tiles
 * are still loading) and again on every `styledata` event. maplibre fires `styledata` when a
 * style finishes loading (before `style.load` and `load`) and after changes to the style, so the
 * slots are also restored after `setStyle`, including a diffed `setStyle` that drops layers it
 * does not know. A slot that is already on the map is never added twice.
 *
 * The slots are added in order from the first (the backmost), which lines them up in the same
 * order in maplibre (layers added later are on top).
 *
 * @param map The map
 * @param getSlotLayers Returns the current list of slots (first = backmost)
 * @returns A function that stops watching the style (it does not remove the layers)
 */
export function attachSlotLayers(
  map: MapLibreMap,
  getSlotLayers: () => readonly CustomLayerInterface[],
): () => void {
  const ensureSlots = (): void => {
    if (!styleAcceptsLayers(map)) return;
    for (const slotLayer of getSlotLayers()) {
      if (!map.getLayer(slotLayer.id)) {
        map.addLayer(slotLayer);
      }
    }
  };

  map.on('styledata', ensureSlots);
  ensureSlots();

  return () => {
    map.off('styledata', ensureSlots);
  };
}
