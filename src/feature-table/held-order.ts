// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The features of the rows held, in stacking order
 *
 * A Store of rows holds no feature as an object but the rows held (selected, edited): they are
 * the features core reads where a Store of objects gives every feature (what is drawn over the
 * rows, the spatial index of the features, the features a click is tested on first).
 */

import type { FeatureTables } from '../api/tables.js';
import type { Feature } from '../shared/types/model.js';
import { compareRowKeys } from '../table/row-keys.js';
import { featureTablesInternals } from './feature-tables.js';

/**
 * The features of the rows held, back to front: by the stacking order of their layers, then by
 * their places in their layers (a layer not in the order is left out)
 *
 * @internal
 */
export function heldFeaturesInOrder(
  tables: FeatureTables | undefined,
  layerOrder: readonly string[],
): Feature[] {
  const internals = featureTablesInternals(tables);
  if (!internals || !tables) return [];
  const layerAt = new Map(layerOrder.map((id, i) => [id, i]));
  const entries: Array<{ feature: Feature; layer: number; handle: number }> = [];
  for (const handle of internals.heldHandles()) {
    const feature = internals.heldFeature(tables.idOf(handle) as string);
    const layer = feature ? layerAt.get(feature.layerId) : undefined;
    if (!feature || layer === undefined) continue;
    entries.push({ feature, layer, handle });
  }
  entries.sort((a, b) => {
    if (a.layer !== b.layer) return a.layer - b.layer;
    const pa = internals.placeOf(a.handle);
    const pb = internals.placeOf(b.handle);
    if (!pa || !pb) return 0;
    return compareRowKeys(pa.group.data, pa.row, pb.group.data, pb.row, internals.groups);
  });
  return entries.map((entry) => entry.feature);
}
