// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The writes the interface makes, each one transaction of `draw.write`. A write core refuses
// (read-only, a lock) or that fails gives false: the interface shows what is, and core tells why.

import type { Draw, FeaturePatch, Placement } from '@sakuzu/maplibre-gl-draw';
import { DrawError } from '@sakuzu/maplibre-gl-draw';

/** The members of a draw instance the writes use */
export type WriteDraw = Pick<Draw, 'write'> & {
  readonly selection: Pick<Draw['selection'], 'value' | 'target'>;
};

/** Runs a write: true once committed, false when core refused it or it failed */
export async function write(
  draw: Pick<Draw, 'write'>,
  fn: Parameters<Draw['write']>[0],
): Promise<boolean> {
  try {
    await draw.write(fn);
    return true;
  } catch (error) {
    if (error instanceof DrawError) return false;
    throw error;
  }
}

/** Deletes what is selected: features, groups or layers */
export function deleteSelection(draw: WriteDraw): Promise<boolean> {
  const { type, count, ids } = draw.selection.value;
  if (type === null || count === 0) return Promise.resolve(false);
  // The layers and the groups selected go with what they hold
  if (type === 'layer' && ids) return write(draw, (tx) => tx.layers.delete(ids));
  if (type === 'group' && ids) {
    return write(draw, (tx) => tx.groups.delete(ids, { members: 'delete' }));
  }
  return write(draw, (tx) => tx.features.delete(draw.selection.target));
}

/** Makes a group of the selected features */
export function groupSelection(draw: WriteDraw): Promise<boolean> {
  const { type, ids } = draw.selection.value;
  if (type !== 'feature' || !ids || ids.length === 0) return Promise.resolve(false);
  return write(draw, (tx) => tx.groups.create({ featureIds: ids }));
}

/** Dissolves the selected groups: their features stay in their place in the layer */
export function ungroupSelection(draw: WriteDraw): Promise<boolean> {
  const { type, ids } = draw.selection.value;
  if (type !== 'group' || !ids || ids.length === 0) return Promise.resolve(false);
  return write(draw, (tx) => tx.groups.delete(ids, { members: 'keep' }));
}

/** The fields of a feature the interface changes, as the keys of its properties */
export interface FeatureFieldsPatch {
  readonly visible?: boolean;
  readonly locked?: boolean;
  readonly style?: Record<string, unknown>;
  readonly properties?: Record<string, unknown>;
}

/** A change of the interface as a patch of core */
export function featurePatchOf(patch: FeatureFieldsPatch): FeaturePatch {
  const properties: Record<string, unknown> = { ...patch.properties };
  if (patch.visible !== undefined) properties['maplibre-gl-draw:visible'] = patch.visible;
  if (patch.locked !== undefined) properties['maplibre-gl-draw:locked'] = patch.locked;
  if (patch.style !== undefined) properties['maplibre-gl-draw:style'] = patch.style;
  return { properties } as FeaturePatch;
}

/** Puts an item elsewhere, as the interface names a place (an end is `null`) */
export function placementOf(to: {
  readonly layerId: string;
  readonly groupId?: string;
  readonly below?: string | null;
  readonly above?: string | null;
}): Placement {
  return {
    layerId: to.layerId,
    ...(to.groupId !== undefined && { groupId: to.groupId }),
    ...(typeof to.below === 'string'
      ? { below: to.below }
      : typeof to.above === 'string'
        ? { above: to.above }
        : {}),
  } as Placement;
}
