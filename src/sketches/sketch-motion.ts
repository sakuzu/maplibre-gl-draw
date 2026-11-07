// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The rows a sketch of this client moves on the GPU
 *
 * A sketch of this client of one edit `translate`, `rotate` or `scale` draws the rows of the
 * features it edits by a moving set of the state of the rows, whatever their number: the set draws
 * them moved by the edit (`view/renderers/row-motion.ts`), their values are not touched, and a row
 * written meanwhile is drawn moved from its new values, so the sketch is applied again over it with
 * nothing to do. The rows of the features the sketch names are in `SKETCH_MOVE_SET`, and the rows
 * selected in bulk (`{ selection: true }`) in `BULK_MOVE_SET`.
 *
 * A moving set holds one edit, and a row is in one set. What cannot be moved so is drawn on the
 * slow path (the sketches applied one after the other on the CPU): a feature with no row, a row
 * another sketch edits too, and the features of a sketch that finds its set taken.
 */

import { livePlaceOf } from '../feature-table/bulk-rows.js';
import { featureTablesInternals } from '../feature-table/feature-tables.js';
import type { TableSelection } from '../feature-table/selection.js';
import type { Store, TransformEdit } from '../store/store.js';
import { transformFieldsOfStore, transformRolesOf } from '../store/transform-roles.js';

/**
 * The rows a sketch moves by a moving set
 *
 * @internal
 */
export interface SketchMotion {
  /** The moving set */
  readonly set: number;
  /** The rows */
  readonly rows: TableSelection;
  /** The ones of them turned or scaled by their values */
  readonly byValues: Int32Array;
  /** The kind of the edit `byValues` was found for */
  readonly kind: TransformEdit['kind'];
  /** The features moved that the sketch names (none for the rows selected in bulk) */
  readonly ids: ReadonlySet<string>;
  /** The features of the sketch drawn on the slow path */
  readonly slow: readonly string[];
}

/** No rows */
const NO_HANDLES = new Int32Array(0);

/**
 * The rows that a drag turns (`rotate`) or scales (`scale`) by their values, which are drawn so
 * while they are moved (`setByValues` of the state of the rows): the rows whose type gives them a
 * rotation, and the ones that keep their shape
 *
 * @internal
 */
export function rowsByValues(
  store: Store,
  rows: TableSelection,
  kind: TransformEdit['kind'],
): Int32Array {
  const internals = featureTablesInternals(store.tables);
  if (!internals || kind === 'translate') return NO_HANDLES;
  const fields = transformFieldsOfStore(store);
  const out: number[] = [];
  for (const handle of rows.handles) {
    const place = livePlaceOf(internals, handle);
    const view = place ? store.tables?.get(place.layer.layerId) : undefined;
    const type = view?.getRowType(handle);
    if (!view || type === null || type === undefined) continue;
    const roles = transformRolesOf(
      type,
      (key) => view.getRowValue(handle, key) !== undefined,
      fields,
    );
    if (kind === 'rotate' ? roles.angleDegrees !== undefined : roles.uniformScale) out.push(handle);
  }
  return Int32Array.from(out);
}
