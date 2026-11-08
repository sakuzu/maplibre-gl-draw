// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Whether a layer is drawn from its rows
 */

import type { FeatureTables } from '../api/tables.js';
import type { Layer } from '../shared/types/model.js';
import { featureTablesInternals } from './feature-tables.js';

/**
 * Whether a layer is drawn from its rows: a layer the tables hold, or a layer held as rows that has
 * none yet. Such a layer is drawn by the drawing of the rows only, at its place in the order; the
 * features made of its rows are what is read of the rows (a click, the selection), never another
 * path of drawing them (the drape of the terrain, the features drawn at once), or a row would be
 * drawn twice
 *
 * @internal
 */
export function isLayerDrawnFromRows(tables: FeatureTables | undefined, layer: Layer): boolean {
  const internals = featureTablesInternals(tables);
  if (!internals) return false;
  return layer.kind === 'table' || internals.layerTable(layer.id) !== undefined;
}
