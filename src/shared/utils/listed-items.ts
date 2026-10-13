// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The items a layer lists and the members a group lists
 *
 * A layer of objects lists its items and a group of it its members. A layer held as rows lists
 * neither: its items and the members of its groups are read from its rows
 * (`LayerTableView.itemsInOrder`, `groupMembersInOrder`). What reads the lists of a layer that
 * may be held as rows reads them here, and is refused rather than given an empty list.
 */

import type { Group, Layer } from '../types/model.js';

/**
 * The items a layer lists
 *
 * @throws when the layer is held as rows (its items are read from its rows)
 */
export function listedItems(layer: Layer): readonly string[] {
  if (layer.kind === 'table') {
    throw new Error(
      `The layer "${layer.id}" is held as rows: its items are read from its rows, not listed`,
    );
  }
  return layer.items;
}

/**
 * The members a group lists
 *
 * @throws when the group is of a layer held as rows (its members are read from the rows)
 */
export function listedMembers(group: Group): readonly string[] {
  if (group.kind === 'table') {
    throw new Error(
      `The group "${group.id}" is of a layer held as rows: its members are read from the rows, not listed`,
    );
  }
  return group.featureIds;
}
