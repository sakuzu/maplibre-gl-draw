// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Every feature of the document in stacking order, including the ones the order cannot reach
 */

import type { Feature } from './types.js';

/** The minimal interface that listEveryFeatureInOrder requires. */
export interface OrderedFeatureStore {
  listFeatures(): Feature[];
  listFeaturesInOrder(): Feature[];
}

/**
 * Every feature in stacking order (layer order -> order within the layer -> order within the
 * group), whatever the visible flags say. A feature that the stacking order does not reach (the
 * features of a layer that is not on it) is appended at the end.
 *
 * @internal
 */
export function listEveryFeatureInOrder(store: OrderedFeatureStore): Feature[] {
  const ordered = store.listFeaturesInOrder();
  const all = store.listFeatures();
  if (ordered.length === all.length) return ordered;
  const listed = new Set(ordered.map((feature) => feature.id));
  return [...ordered, ...all.filter((feature) => !listed.has(feature.id))];
}
