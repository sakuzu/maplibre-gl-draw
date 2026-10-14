// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The operations on features selected in bulk (`Selection.bulk`): deleting, grouping, taking
 * them out of their groups, putting them in a place, changing their style
 *
 * They do what the same operations do on features selected one by one, on the rows of the
 * selection, through the Store (`Store.applyBulk`): one write of the rows, recorded and notified
 * once, with the values before. The rows go in the order of their layers wherever a place is
 * given to many of them at once (a group made of them, a layer they go to).
 */

import type { RowStyleSample, RowUpdate } from '../feature-table/bulk-plan.js';
import { isRowLocked, livePlaceOf, rowsByLayerInOrder } from '../feature-table/bulk-rows.js';
import { featureTablesInternals } from '../feature-table/feature-tables.js';
import { TableSelection } from '../feature-table/selection.js';
import type { AutoNameGenerator } from '../shared/utils/name-generator.js';
import { itemNeighbors } from '../store/item-lists.js';
import type { Store } from '../store/store.js';
import type { ItemPlacement, TableGroup } from '../store/types.js';

/** What the rows read of the layers and the groups, and what this client hides */
function containersOf(store: Store) {
  return {
    layerVisible: (layerId: string) => store.getLayer(layerId)?.visible === true,
    layerLocked: (layerId: string) => store.getLayer(layerId)?.locked === true,
    hidden: (id: string) => store.isHidden(id),
  };
}

/**
 * Deletes the features selected in bulk that are not locked, and clears the selection, as one
 * change
 *
 * @returns false when nothing is selected in bulk, nothing can be deleted, or the deletion is
 *   refused (read-only, the interaction lock)
 * @internal
 */
export function deleteBulkSelection(store: Store): boolean {
  if (!store.getSelectedRows()) return false;
  return store.transact(() => {
    if (!store.applyBulk({ kind: 'delete' })) return false;
    store.setSelection(null, []);
    return true;
  });
}

/**
 * Whether any feature selected in bulk is locked (itself, its group or its layer)
 *
 * @internal
 */
export function bulkSelectionLocked(store: Store): boolean {
  return store.isSelectedRowLocked();
}

/**
 * Whether any of these rows is locked (itself, its group or its layer)
 *
 * @internal
 */
export function rowsLocked(store: Store, rows: TableSelection): boolean {
  const internals = featureTablesInternals(store.tables);
  if (!internals) return false;
  const containers = containersOf(store);
  return rows.handles.some((handle) => isRowLocked(internals, containers, handle));
}

/**
 * Makes a group of the features selected in bulk, as `groupSelection` does for features selected
 * one by one: they must all be in one layer and in no group. The group takes the place of the
 * frontmost of them, and they go in it in their order
 *
 * @returns The id of the group, or null when they cannot be grouped
 * @internal
 */
export function groupBulkSelection(
  store: Store,
  generateId: () => string,
  autoNameGenerator: AutoNameGenerator,
): string | null {
  const rows = store.getSelectedRows();
  const internals = featureTablesInternals(store.tables);
  const selection = store.getSelection();
  if (!rows || !internals || selection.type !== 'feature') return null;
  if (store.isReadOnly() || store.isInteractionLocked()) return null;
  // One layer, no group
  const byLayer = rowsByLayerInOrder(internals, rows);
  if (byLayer.size !== 1) return null;
  const [layerId, ordered] = [...byLayer][0];
  if (ordered.length < 2) return null;
  for (const handle of ordered) {
    const place = livePlaceOf(internals, handle);
    const group = place ? place.group.data.groups[place.row] : -1;
    if (group >= 0 && internals.groups.idOf(group) !== undefined) {
      const groupId = internals.groups.idOf(group) as string;
      if (store.getGroup(groupId)) return null;
    }
  }
  const frontmost = internals.ids.idOf(ordered[ordered.length - 1]) as string;
  const group: TableGroup = {
    id: generateId(),
    layerId,
    name: autoNameGenerator.generateGroupName(),
    visible: true,
    locked: false,
    kind: 'table',
  };
  store.transact(() => {
    store.createGroup(group);
    // Just below the frontmost feature, which then goes into it with the others
    store.moveItems([group.id], { layerId, above: frontmost });
    store.applyBulk({ kind: 'place', to: { layerId, groupId: group.id } });
  });
  return store.getGroup(group.id) ? group.id : null;
}

/**
 * Takes the features selected in bulk that are in a group out of it, as `ungroupSelection` does
 * for features selected one by one: the features of a group go just in front of it, in their
 * order (a group left empty is deleted)
 *
 * @returns false when none of them is in a group, or the change is refused
 * @internal
 */
export function ungroupBulkSelection(store: Store): boolean {
  const rows = store.getSelectedRows();
  const internals = featureTablesInternals(store.tables);
  if (!rows || !internals || store.isReadOnly() || store.isInteractionLocked()) return false;
  const blocks = groupBlocks(store, rows);
  if (blocks.length === 0) return false;
  store.transact(() => {
    for (const block of blocks) {
      const around = itemNeighbors(store, block.layerId, undefined, block.groupId);
      store.applyBulk(
        {
          kind: 'place',
          to: { layerId: block.layerId, below: block.groupId, above: around?.above ?? null },
        },
        block.rows,
      );
    }
  });
  return true;
}

/**
 * The features selected in bulk that are in a group, by group: each group with its layer and its
 * features in their order
 *
 * @internal
 */
export function groupBlocks(
  store: Store,
  rows: TableSelection,
): Array<{ layerId: string; groupId: string; rows: TableSelection }> {
  const internals = featureTablesInternals(store.tables);
  if (!internals) return [];
  const blocks = new Map<string, { layerId: string; handles: number[] }>();
  for (const [layerId, handles] of rowsByLayerInOrder(internals, rows)) {
    for (const handle of handles) {
      const place = livePlaceOf(internals, handle);
      const group = place ? place.group.data.groups[place.row] : -1;
      const groupId = group >= 0 ? internals.groups.idOf(group) : undefined;
      if (groupId === undefined || !store.getGroup(groupId)) continue;
      let block = blocks.get(groupId);
      if (!block) {
        block = { layerId, handles: [] };
        blocks.set(groupId, block);
      }
      block.handles.push(handle);
    }
  }
  return [...blocks].map(([groupId, block]) => ({
    layerId: block.layerId,
    groupId,
    rows: TableSelection.of(block.handles),
  }));
}

/**
 * Puts the features selected in bulk in a place, in their order (another layer, a group)
 *
 * @returns false when the change is refused (read-only, the interaction lock, a feature locked)
 * @internal
 */
export function placeBulkSelection(store: Store, to: ItemPlacement): boolean {
  if (!store.getSelectedRows() || bulkSelectionLocked(store)) return false;
  return store.applyBulk({ kind: 'place', to });
}

/**
 * Changes the features selected in bulk: a change is made once per kind of feature (its type,
 * its style and its created zoom) and written to every feature of the kind
 *
 * @returns false when nothing is written, or the change is refused (read-only, the interaction
 *   lock, a feature locked for a change other than of its lock or its visibility)
 * @internal
 */
export function updateBulkSelection(
  store: Store,
  make: (sample: RowStyleSample) => RowUpdate | null,
): boolean {
  return store.applyBulk({ kind: 'update', make });
}
