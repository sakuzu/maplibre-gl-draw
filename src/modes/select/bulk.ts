// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The select mode over features selected in bulk (`Selection.bulk`)
 *
 * - A box drawn over a Store of rows finds the rows in it on their columns: the rows whose extent
 *   is in the box are in it, the others are tested as the features they are, by the test of
 *   their type (the rows on the sides of the box only)
 * - A drag of the features selected in bulk is shown by a sketch of `{ selection: true }`, which
 *   draws their rows moved by a moving set (`sketches/sketch-motion.ts`), and written once on the
 *   CPU with the same edit when the drag is let go, in the same task the set is let go of (the
 *   drawing takes both in the same frame)
 * - The arrow keys move them by a sketch of `{ selection: true }` as well (`nudge.ts`)
 * - A locked feature stays where it is: its row is not in the moving set, and the others move
 */

import { featureTablesInternals } from '../../feature-table/feature-tables.js';
import type { RowGroup } from '../../feature-table/layer-table.js';
import { rowGeometry, rowProperties, rowType } from '../../feature-table/row-read.js';
import { BULK_MOVE_SET, STATE_UNHIT_MASK } from '../../feature-table/row-state.js';
import { TableSelection } from '../../feature-table/selection.js';
import { writeKindsInSlices } from '../../operations/bulk-sliced.js';
import { type BulkKinds, transformKinds } from '../../operations/bulk-transform.js';
import type { TransformEdit } from '../../store/store.js';
import type { BoxSelection, Feature } from '../../store/types.js';
import { ROW_FLAG_DELETED, ROW_FLAG_LOCKED } from '../../table/row-group-types.js';
import type { EngineModeContext } from '../handler.js';
import { boxRects, isFeatureInBox } from './box-selection.js';

export { BULK_MOVE_SET };

/**
 * The rows in a box drawn over a Store of rows, read on their columns: the rows that can be
 * seen and are not locked (nor their group or their layer), whose geometry meets the box by the
 * test of their type
 *
 * A row whose extent is inside the box is in it without being made a feature (the test of a
 * point, a line, an area or a circle is met then); a row on a side of the box is made the
 * feature it is, without being opened, and tested as the features are.
 *
 * @internal
 */
export function queryRowsInBox(box: BoxSelection, context: EngineModeContext): TableSelection {
  const { store, boxSelectionRegistry } = context;
  const tables = store.tables;
  const internals = featureTablesInternals(tables);
  if (!tables || !internals) return TableSelection.empty;
  const found = new Set<number>();
  const layers = new Map<string, boolean>();
  const layerOpen = (layerId: string): boolean => {
    let open = layers.get(layerId);
    if (open === undefined) {
      const layer = store.getLayer(layerId);
      open = layer?.visible === true && !layer.locked && !store.isHidden(layerId);
      layers.set(layerId, open);
    }
    return open;
  };
  for (const rect of boxRects(box.startPoint, box.endPoint)) {
    const cursor = tables.scan({
      bbox: [rect.minX, rect.minY, rect.maxX, rect.maxY],
      order: 'any',
    });
    for (let batch = cursor.next(); batch; batch = cursor.next()) {
      for (const handle of batch) {
        if (found.has(handle)) continue;
        const place = internals.placeOf(handle);
        if (!place) continue;
        const { group, row } = place;
        const data = group.data;
        const flags = data.flags[row];
        if ((flags & (ROW_FLAG_DELETED | ROW_FLAG_LOCKED)) !== 0) continue;
        if ((group.state[row] & STATE_UNHIT_MASK) !== 0) continue;
        if (!layerOpen(place.layer.layerId)) continue;
        const featureGroup = data.groups[row];
        if (featureGroup >= 0) {
          if (
            !internals.groups.isVisible(featureGroup) ||
            internals.groups.isLocked(featureGroup)
          ) {
            continue;
          }
          const groupId = internals.groups.idOf(featureGroup);
          if (groupId !== undefined && store.isHidden(groupId)) continue;
        }
        const type = rowType(data, row);
        const b = data.rowBounds;
        const at = row * 4;
        const inside =
          b[at] >= rect.minX &&
          b[at + 2] <= rect.maxX &&
          b[at + 1] >= rect.minY &&
          b[at + 3] <= rect.maxY;
        if (inside && boxSelectionRegistry.get(type)?.insideMeetsTest === true) {
          found.add(handle);
          continue;
        }
        const feature = rowAsFeature(
          internals.ids.idOf(handle) as string,
          place.layer.layerId,
          group,
          row,
        );
        if (feature && isFeatureInBox(feature, rect, boxSelectionRegistry)) found.add(handle);
      }
    }
  }
  return TableSelection.of([...found]);
}

/**
 * A row as the feature it is, to test it as features are tested (null for a row without a
 * geometry); the values of its positions after `x` and `y` are kept
 */
function rowAsFeature(id: string, layerId: string, group: RowGroup, row: number): Feature | null {
  const geometry = rowGeometry(group, row);
  if (!geometry) return null;
  const data = group.data;
  return {
    id,
    type: rowType(data, row),
    geometry: geometry as Feature['geometry'],
    layerId,
    groupId: undefined,
    properties: rowProperties(group, row),
    style: {},
    visible: true,
    locked: false,
  };
}

// ============================================================================
// The write of a drag
// ============================================================================

/**
 * Writes a drag of features selected in bulk let go, by the edit its sketch shows them moved by, in
 * steps (`bulk-sliced.ts`): the rows stay in their moving set, each leaves it in the task it is
 * written in, and the moving set is let go of with the last of them (`RowStateSets`); then `done`
 * is called
 *
 * @param rows The rows, in their moving set
 * @internal
 */
export function writeBulkEdit(
  context: EngineModeContext,
  rows: TableSelection,
  edit: TransformEdit,
  done: () => void,
): void {
  const { store, map } = context;
  const states = featureTablesInternals(store.tables)?.states;
  const release = (): void => {
    states?.setMoving(rows.handles, 0);
    states?.setByValues(rows.handles, false);
    map.triggerRepaint();
    done();
  };
  let kinds: BulkKinds | null = null;
  try {
    kinds = transformKinds(store, edit, rows);
  } finally {
    if (!kinds) release();
  }
  if (!kinds) return;
  writeKindsInSlices(store, rows, kinds, {
    onWritten: (written) => {
      states?.setMoving(Int32Array.from(written), 0);
      map.triggerRepaint();
    },
    onDone: release,
  });
}
