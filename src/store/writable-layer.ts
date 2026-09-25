// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Derivation of the writable layer
 *
 * Determines the layer that user drawing may write new features into. A pure function with
 * the same standing as lock.ts (isFeatureLocked) and local-visibility.ts (isLocallyHidden):
 * it only reads the Store and changes nothing.
 *
 * A layer can be written when it exists, is not locked, is visible (shared visible) and is
 * not locally hidden on this client. Drawing into a locked layer would bypass the lock, and
 * drawing into a hidden layer (shared or local) would create a feature the user cannot see.
 *
 * This is a rule for user drawing only. It is not a write gate: the Store's write methods and
 * the public API still accept any existing layer (read-only is the only write gate).
 */

import type { LocalHiddenStore } from './local-visibility.js';
import type { Layer } from './types.js';

/** The minimal interface that isWritableLayer requires. */
export type WritableLayerCheckStore = LocalHiddenStore;

/** The minimal interface that resolveWritableLayerId requires. */
export interface WritableLayerStore extends WritableLayerCheckStore {
  getLayer(id: string): Layer | undefined;
  getAllLayers(): Layer[];
}

/**
 * Whether user drawing may write new features into the layer
 */
export function isWritableLayer(
  layer: Layer | undefined,
  store: WritableLayerCheckStore,
): layer is Layer {
  return layer !== undefined && !layer.locked && layer.visible && !store.isLocallyHidden(layer.id);
}

/**
 * Resolves the layer that user drawing writes new features into
 *
 * The preferred layer (the active layer) when it can be written, otherwise the first layer
 * that can be written, otherwise an empty string. It never changes the active layer, so the
 * active layer comes back once it is unlocked or shown again.
 */
export function resolveWritableLayerId(store: WritableLayerStore, preferredId: string): string {
  if (isWritableLayer(store.getLayer(preferredId), store)) return preferredId;
  return store.getAllLayers().find((layer) => isWritableLayer(layer, store))?.id ?? '';
}
