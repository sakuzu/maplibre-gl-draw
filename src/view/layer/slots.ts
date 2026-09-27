// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Separators and slots of the stacking order
 *
 * Entries of the stacking order (layerOrder) that the host declares as "external entries"
 * (entries we do not draw ourselves, which the host places as native maplibre layers) are treated
 * as separators, and every segment between separators gets its own CustomLayer (a slot).
 * A maplibre style is a single ordered list and nothing can be inserted inside a CustomLayer, so
 * a native layer can be placed in between our own rendering only once the slots are split per
 * segment. The design is in docs/internals/rendering.md, "Slots and separators".
 */

// StackSlot is defined in shared/ because the layerStack.change signal carries it
export type { StackSlot } from '../../shared/types/events.js';

/** A segment ([from, to) in layerOrder) */
export interface RenderSegment {
  readonly from: number;
  readonly to: number;
}

/** Layer id of the first slot (keeps the same id as the single layer used before) */
export const PRIMARY_RENDER_LAYER_ID = 'maplibre-gl-draw-layer';

/** Layer id of the slot at `index` */
export function slotLayerId(index: number): string {
  return index === 0 ? PRIMARY_RENDER_LAYER_ID : `${PRIMARY_RENDER_LAYER_ID}:${index}`;
}

/**
 * Split the stacking order into segments at the separators
 *
 * A separator is an entry for which the predicate returns true, and the separator itself belongs
 * to no segment. No segment is created for an empty run between separators (where separators are
 * adjacent) because there is nothing to draw. If there is no separator at all, the whole list
 * becomes a single segment and the behaviour is the same as the single CustomLayer used before.
 * Even for a list with no entry drawn by us, a slot is needed to draw the foreground pass
 * (selection UI and overlays), so one empty segment is returned.
 */
export function partitionLayerOrder(
  order: readonly string[],
  isExternalEntry?: (entryId: string) => boolean,
): RenderSegment[] {
  if (!isExternalEntry) return [{ from: 0, to: order.length }];
  const segments: RenderSegment[] = [];
  let start = -1;
  for (let i = 0; i < order.length; i++) {
    if (isExternalEntry(order[i])) {
      if (start >= 0) {
        segments.push({ from: start, to: i });
        start = -1;
      }
    } else if (start < 0) {
      start = i;
    }
  }
  if (start >= 0) segments.push({ from: start, to: order.length });
  if (segments.length === 0) segments.push({ from: 0, to: 0 });
  return segments;
}

/** Whether two lists of segments are the same */
export function sameSegments(a: readonly RenderSegment[], b: readonly RenderSegment[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].from !== b[i].from || a[i].to !== b[i].to) return false;
  }
  return true;
}
