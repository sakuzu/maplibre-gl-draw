// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// A drop in the layer tree, converted to a call of core.
//
// The tree reports the node, its new parent and its index among the parent's children after the
// move, counted from the front (the top of the tree). Core counts from the back, and its lists
// can hold IDs the tree does not show (a dataset in the stacking order; the features of a layer
// when the tree shows only the groups). So the index is not mirrored by arithmetic: the node is
// placed just in front of the node that is behind it in the tree (the one below it after the
// move), at that node's position in core's list plus one, or at the back (0) when nothing in the
// tree is behind it.
//
// - a layer: `layers.reorder` with the layers in their new order from the back. The entries of
//   the stacking order that are not layers are left out of it, and core keeps their positions
// - a group: `groups.move` to `{ layerId, index }`
// - a feature: `features.move` to `{ layerId, index }`, or to `{ groupId, index }` in a group

import type { TreeMove } from '@sakuzu/kata/svelte';
import type { Group, Layer, MoveTarget } from '@sakuzu/maplibre-gl-draw';
import { canDropInto, indexNodes, type LayerTreeNode } from './tree.js';

/** The call of core a drop makes */
export type MovePlan =
  | { kind: 'layers'; order: string[] }
  | { kind: 'group'; id: string; to: MoveTarget }
  | { kind: 'feature'; id: string; to: MoveTarget };

/** A list with an ID taken out and put back at an index */
function placed(ids: readonly string[], id: string, index: number): string[] {
  const out = ids.filter((x) => x !== id);
  out.splice(Math.max(0, Math.min(index, out.length)), 0, id);
  return out;
}

/**
 * The position in a list of core, from the back, of an item that goes just in front of `behind`
 * (a node of the tree, or undefined when the item goes to the back)
 */
export function coreIndex(
  coreList: readonly string[],
  id: string,
  behind: string | undefined,
): number {
  if (behind === undefined) return 0;
  const at = coreList.filter((x) => x !== id).indexOf(behind);
  return at === -1 ? 0 : at + 1;
}

/**
 * The call of core for a drop in the tree
 *
 * @param move - What the tree reported: the node, its new parent (null for the root) and its
 *   index among the parent's children after the move, from the front
 * @param nodes - The nodes the tree showed when the node was dropped
 * @returns The call, or null when the drop is not one the tree allows
 */
export function planMove(move: TreeMove, nodes: readonly LayerTreeNode[]): MovePlan | null {
  const index = indexNodes(nodes);
  const at = index.get(move.id);
  if (!at) return null;
  const parent = move.parentId === null ? null : (index.get(move.parentId)?.node ?? null);
  if (move.parentId !== null && !parent) return null;
  if (!canDropInto(at.node, parent)) return null;

  if (at.node.kind === 'layer') {
    const front = placed(
      nodes.map((n) => n.id),
      move.id,
      move.index,
    );
    return { kind: 'layers', order: front.reverse() };
  }
  if (!parent) return null;

  // The children of the new parent from the front, after the move; the one after the node is
  // the one behind it
  const shown = placed(
    (parent.children ?? []).map((n) => n.id),
    move.id,
    move.index,
  );
  const behind = shown[shown.indexOf(move.id) + 1];
  if (parent.kind === 'layer') {
    const layer = parent.data as Layer;
    const to = { layerId: layer.id, index: coreIndex(layer.items, move.id, behind) };
    return at.node.kind === 'group'
      ? { kind: 'group', id: move.id, to }
      : { kind: 'feature', id: move.id, to };
  }
  const group = parent.data as Group;
  return {
    kind: 'feature',
    id: move.id,
    to: { groupId: group.id, index: coreIndex(group.featureIds, move.id, behind) },
  };
}
