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
 * Puts the slots back on top of the map after a style change
 *
 * The slots, and the native layers the host placed between them (the separators), form one
 * block that belongs at the top of the map, with the slots in their order (the first is the
 * backmost). A full `setStyle` gives that by itself: the old layers are gone and the slots are
 * added again on top. A diffed `setStyle` does not: maplibre's `Style.serialize()` leaves custom
 * layers out, so the diff neither removes nor adds the slots, and the layers of the new style are
 * added above them, which hides the drawing under the basemap.
 *
 * Nothing is moved when the block is already in place, so the `styledata` that follows a move
 * finds nothing to do. When it is not, the block is moved to the top: each slot, followed by the
 * native layers that sat just above it (up to the next slot), keeps its neighbours. The layers
 * above the frontmost slot are taken as part of the new style and stay below the block.
 *
 * @param map The map
 * @param slotLayers The slots (first = backmost)
 */
function placeSlotsOnTop(map: MapLibreMap, slotLayers: readonly CustomLayerInterface[]): void {
  const order = map.getLayersOrder();
  const slotIds = slotLayers.map((layer) => layer.id).filter((id) => order.includes(id));
  if (slotIds.length === 0) return;
  const isSlot = new Set(slotIds);

  // The block runs from the backmost slot on the map to the frontmost one
  let first = -1;
  let last = -1;
  order.forEach((id, index) => {
    if (!isSlot.has(id)) return;
    if (first < 0) first = index;
    last = index;
  });
  const block = order.slice(first, last + 1);
  const slotsInBlock = block.filter((id) => isSlot.has(id));
  const inOrder = slotsInBlock.every((id, index) => id === slotIds[index]);
  if (inOrder && last === order.length - 1) return;

  // Each slot keeps the native layers that followed it
  const following = new Map<string, string[]>();
  let current = '';
  for (const id of block) {
    if (isSlot.has(id)) {
      current = id;
      following.set(id, []);
    } else {
      following.get(current)?.push(id);
    }
  }
  for (const slotId of slotIds) {
    map.moveLayer(slotId);
    for (const id of following.get(slotId) ?? []) map.moveLayer(id);
  }
}

/**
 * Keeps the frames of the stacking order on the map for as long as the returned detach function has not
 * been called
 *
 * One rule covers every timing: the slots are added whenever the style accepts layers and a slot
 * is missing. It is checked once now (for a map whose style is already parsed, even while tiles
 * are still loading) and again on every `styledata` and `style.load` event. maplibre fires
 * `styledata` when a style finishes loading (before `style.load` and `load`) and after changes to
 * the style, so the slots are also restored after a full `setStyle`. A slot that is already on
 * the map is never added twice.
 *
 * The slots are added in order from the first (the backmost), which lines them up in the same
 * order in maplibre (layers added later are on top). A slot missing while a later one is on the
 * map is added just behind it.
 *
 * On `style.load` the slots are also put back on top of the map (see `placeSlotsOnTop`). maplibre
 * fires it when a style is loaded and at the end of a diffed `setStyle` that changed something,
 * and only then: a layer the host adds or moves itself fires `styledata` alone, so a layer the
 * host put above the drawing stays there until the style is changed.
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
    const slotLayers = getSlotLayers();
    slotLayers.forEach((slotLayer, index) => {
      if (map.getLayer(slotLayer.id)) return;
      // Behind the next slot that is on the map, so that the slots stay in order
      const next = slotLayers.slice(index + 1).find((later) => map.getLayer(later.id));
      if (next) map.addLayer(slotLayer, next.id);
      else map.addLayer(slotLayer);
    });
  };
  const restoreSlots = (): void => {
    ensureSlots();
    if (styleAcceptsLayers(map)) placeSlotsOnTop(map, getSlotLayers());
  };

  map.on('styledata', ensureSlots);
  map.on('style.load', restoreSlots);
  ensureSlots();

  return () => {
    map.off('styledata', ensureSlots);
    map.off('style.load', restoreSlots);
  };
}
