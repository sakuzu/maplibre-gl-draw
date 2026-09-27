// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * click / dblclick handling for SelectMode
 *
 * Single click: the priority order is plugin intercept -> vertex click -> feature selection
 *   1. While a plugin is interacting, clicks inside its container are consumed; anything else
 *      finishes it
 *   2. A click on a vertex handle of a singly selected feature that supports vertex editing
 *      (LineString / Polygon / the Multi types) -> vertex selection
 *   3. Unified z traversal (hitTestTopmost) -> if it is a Store feature, the selection is
 *      updated / shift+click toggles / re-clicking an already selected feature is delegated to
 *      pluginManager.handleFeatureClick.
 *      If a dataset is in the foreground, Store features are not grabbed and it
 *      is treated as clearing the selection.
 *      If a feature companion is in the foreground, the click is consumed and passed to the
 *      provider (the selection is left unchanged)
 *
 * Double click: selects the feature and notifies pluginManager.handleFeatureDoubleClick
 */

import type { MouseNormalizedEvent } from '../../dispatcher/types.js';
import type { SelectionUIConfig } from '../../shared/config/selection.js';
import { createCoordinateTransform } from '../../shared/math/index.js';
import { supportsVertexEditing } from '../../shared/utils/coordinates.js';
import { hasVertexRef, isSameVertexRef } from '../../shared/utils/vertex-ref.js';
import { getDisplayFeatures } from '../../store/local-visibility.js';
import type { Selection } from '../../store/types.js';
import { notifyFeatureCompanionClick } from '../../view/feature-companion.js';
import { hitTestHandles } from '../../view/ui/handle-test.js';
import { getSelectedFeatures } from '../../view/ui/helper.js';
import type { ModeContext } from '../handler.js';

/**
 * The main logic of onClick
 */
export function handleSelectClick(
  event: MouseNormalizedEvent,
  context: ModeContext,
  config: SelectionUIConfig,
): void {
  if (handlePluginInteractionClick(event, context)) {
    return;
  }

  const { store } = context;
  const selection = store.getSelection();
  const selectedIds = selection.type === 'feature' ? selection.ids : [];

  if (handleVertexClick(event, selectedIds, context, config)) {
    return;
  }
  store.setSelectedVertices(null);

  handleFeatureClick(event, selection, selectedIds, context);
}

/**
 * The main logic of onDoubleClick
 *
 * A double click on a feature is consumed (its default action is prevented, so MapLibre does
 * not zoom); a double click on the empty map is left to MapLibre.
 */
export function handleSelectDoubleClick(event: MouseNormalizedEvent, context: ModeContext): void {
  if (context.pluginManager?.isPluginInteracting()) return;

  const { store } = context;
  const orderedFeatures = getDisplayFeatures(store);

  // Store features are not grabbed when a dataset is in the foreground
  const top = context.hitTestTopmost(event.point, { orderedFeatures });
  if (top?.kind !== 'store') return;
  event.originalEvent.preventDefault();

  const filtered = context.pluginManager?.filterSelectionCandidates([top.feature.id]) ?? [
    top.feature.id,
  ];
  if (filtered.length > 0) {
    store.setSelection('feature', filtered);
  }
  context.pluginManager?.handleFeatureDoubleClick(top.feature.id);
}

/**
 * Click handling during a plugin interaction
 *
 * @returns true when the click was consumed (= the caller skips the rest of the handling)
 */
function handlePluginInteractionClick(event: MouseNormalizedEvent, context: ModeContext): boolean {
  const pm = context.pluginManager;
  if (!pm?.isPluginInteracting()) return false;

  const container = pm.getPluginInteractionContainer();
  if (container) {
    const target = event.originalEvent.target as HTMLElement;
    if (container.contains(target)) {
      return true;
    }
  }
  pm.finishPluginInteraction();
  return true;
}

/**
 * Click handling for vertex handles
 *
 * @returns true when a vertex was selected
 */
function handleVertexClick(
  event: MouseNormalizedEvent,
  selectedIds: string[],
  context: ModeContext,
  config: SelectionUIConfig,
): boolean {
  if (selectedIds.length !== 1) return false;

  const { store, map } = context;
  const selectedFeatures = getSelectedFeatures(store);
  const feature = selectedFeatures[0];
  // Only types that support vertex editing (LineString / Polygon / the Multi types) are subject
  // to vertex selection
  if (!feature || !supportsVertexEditing(feature.type)) return false;

  const transform = createCoordinateTransform(map);
  const zoom = map.getZoom();
  const handleHit = hitTestHandles(
    event.point,
    selectedFeatures,
    transform,
    config,
    zoom,
    context.selectionScope,
  );

  if (handleHit?.type !== 'vertex' || handleHit.vertexRef === undefined) {
    return false;
  }

  const featureId = handleHit.featureId;
  if (!featureId) return false;
  const vertexRef = handleHit.vertexRef;
  const currentVertexSelection = store.getVertexSelection();

  if (event.modifiers.shift && currentVertexSelection?.featureId === featureId) {
    // Shift+click: add / remove a vertex of the same feature
    const refs = currentVertexSelection.vertices;
    if (hasVertexRef(refs, vertexRef)) {
      const newRefs = refs.filter((r) => !isSameVertexRef(r, vertexRef));
      store.setSelectedVertices(newRefs.length === 0 ? null : { featureId, vertices: newRefs });
    } else {
      store.setSelectedVertices({ featureId, vertices: [...refs, vertexRef] });
    }
  } else {
    store.setSelectedVertices({ featureId, vertices: [vertexRef] });
  }
  return true;
}

/**
 * Feature selection handling
 */
function handleFeatureClick(
  event: MouseNormalizedEvent,
  selection: Selection,
  selectedIds: string[],
  context: ModeContext,
): void {
  const { store } = context;
  const orderedFeatures = getDisplayFeatures(store);

  const top = context.hitTestTopmost(event.point, { orderedFeatures });

  // A feature companion is in the foreground: the provider receives the click and core changes
  // the selection in no way at all (not even clearing it as an empty click would). Core does not
  // know what the companion is, so its job ends at consuming the click and reporting it.
  if (top?.kind === 'companion') {
    notifyFeatureCompanionClick(context.featureCompanions, top.companion);
    return;
  }

  // When there is nothing, and when a dataset is in the foreground, Store
  // features are not grabbed. A dataset's click fires only when the intercepting side
  // (dataset/interaction) is interactive.
  if (top?.kind !== 'store') {
    if (!event.modifiers.shift) {
      store.setSelection(null, []);
    }
    return;
  }
  const feature = top.feature;

  // Re-clicking an already selected feature -> delegate to the plugins
  if (!event.modifiers.shift && selectedIds.length === 1 && selectedIds.includes(feature.id)) {
    if (context.pluginManager?.handleFeatureClick(feature.id)) {
      return;
    }
  }

  // Update the selection
  const candidateIds = event.modifiers.shift
    ? toggleSelection(selection, feature.id)
    : [feature.id];

  const filtered = context.pluginManager?.filterSelectionCandidates(candidateIds) ?? candidateIds;
  if (filtered.length === 0) {
    store.setSelection(null, []);
  } else {
    store.setSelection('feature', filtered);
  }
}

/**
 * Toggling the selection with Shift+click
 */
function toggleSelection(selection: Selection, featureId: string): string[] {
  const current = selection.type === 'feature' ? [...selection.ids] : [];
  const index = current.indexOf(featureId);
  if (index === -1) {
    current.push(featureId);
  } else {
    current.splice(index, 1);
  }
  return current;
}
