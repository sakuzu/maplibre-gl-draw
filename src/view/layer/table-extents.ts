// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The extents the rows held as columns drawn at once are drawn over (`RowExtents`)
 *
 * A row drawn at once is drawn in view or not by the extent of what is drawn of it, not by the box
 * of its positions: a type laid around its anchor (an Image, a custom type whose footprint is laid
 * on the map) covers the box its footprint gives, as the retained chunks of a Store of objects take
 * it (`computeAnchoredExtent` of `store-retained-bbox.ts`), and a type whose footprint is a size on
 * the screen reaches the half diagonal of its size in pixels around its position, laid on the ground at
 * the scale of the frame drawn (`metersPerPixelInFrame`, the conversion of a size of the current
 * view). Any other row covers the box of its positions.
 *
 * The extent of a row is read from its feature once, and again only after the row is written (or
 * the extents are dropped, when what gives them changes), so the work of a frame does not follow
 * the rows of a layer.
 */

import { rowType } from '../../feature-table/row-read.js';
import type { RowGroup } from '../../feature-table/row-table.js';
import type { BBox } from '../../geometry/types.js';
import { degreesPerMeterAt } from '../../shared/math/ground-scale.js';
import { metersPerPixelInFrame, type ScreenScaleFrame } from '../../shared/math/screen-scale.js';
import type { Feature } from '../../shared/types/model.js';
import type { SelectionExtensionRegistry } from '../ui/selection-ui/index.js';
import { computeAnchoredExtent } from './store-retained-bbox.js';

/**
 * The extents of the rows of a group, read so far
 *
 * @internal
 */
export interface GroupExtents {
  /** The generation of the extents they were read in */
  readonly generation: number;
  /** The box of each row, `[minX, minY, maxX, maxY]` (NaN for a row without one) */
  readonly boxes: Float64Array;
  /** How far each row reaches on the screen around its box, in pixels (0 for none) */
  readonly reachPx: Float32Array;
  /** Whether the extent of each row is read */
  readonly known: Uint8Array;
}

/**
 * The extents of the rows drawn at once, by group
 *
 * @internal
 */
export class RowExtents {
  private readonly groups = new WeakMap<RowGroup, GroupExtents>();
  private current = 0;

  /** Changes whenever every extent read is dropped */
  get generation(): number {
    return this.current;
  }

  /**
   * @param extensions The footprints of the custom types of the instance (none: an Image alone
   *   has an extent of its own)
   */
  constructor(private readonly extensions?: SelectionExtensionRegistry) {}

  /** Drops every extent read: what gives them changed (a custom type came or went) */
  clear(): void {
    this.current++;
  }

  /** Drops the extent of a row written (read again when next needed) */
  forget(group: RowGroup, row: number): void {
    const held = this.groups.get(group);
    if (held && row < held.known.length) held.known[row] = 0;
  }

  /**
   * The extents of the rows of a group, the one of a row read when it is not
   *
   * @param featureOf Makes the feature of a row (asked only for a type with an extent of its own)
   * @returns The extents, the one of the row read
   */
  read(group: RowGroup, row: number, featureOf: () => Feature): GroupExtents {
    const held = this.of(group);
    if (held.known[row] === 0) this.readRow(group, row, featureOf, held);
    return held;
  }

  /**
   * The extents of the rows of a group, those of `[from, to)` read
   *
   * @param featureOf Makes the feature of a row (asked only for a type with an extent of its own)
   */
  readRange(
    group: RowGroup,
    from: number,
    to: number,
    featureOf: (row: number) => Feature,
  ): GroupExtents {
    const held = this.of(group);
    for (let row = from; row < to; row++) {
      if (held.known[row] === 0) this.readRow(group, row, () => featureOf(row), held);
    }
    return held;
  }

  /**
   * The extents of the rows of a group as they are read (made empty when it has none of this
   * generation): a row not read, or written since, has the box of its positions or the extent it
   * had
   */
  of(group: RowGroup): GroupExtents {
    const n = group.data.length;
    let held = this.groups.get(group);
    if (!held || held.generation !== this.current || held.known.length !== n) {
      held = {
        generation: this.current,
        boxes: new Float64Array(n * 4),
        reachPx: new Float32Array(n),
        known: new Uint8Array(n),
      };
      this.groups.set(group, held);
    }
    return held;
  }

  private readRow(
    group: RowGroup,
    row: number,
    featureOf: () => Feature,
    held: GroupExtents,
  ): void {
    const data = group.data;
    const at = row * 4;
    const boxes = held.boxes;
    const own = !Number.isNaN(data.rowBounds[at]) && this.readsFeature(data, row);
    const feature = own ? featureOf() : null;
    const extent = feature ? computeAnchoredExtent(feature, this.extensions) : null;
    if (extent) {
      boxes[at] = extent[0];
      boxes[at + 1] = extent[1];
      boxes[at + 2] = extent[2];
      boxes[at + 3] = extent[3];
    } else {
      boxes[at] = data.rowBounds[at];
      boxes[at + 1] = data.rowBounds[at + 1];
      boxes[at + 2] = data.rowBounds[at + 2];
      boxes[at + 3] = data.rowBounds[at + 3];
    }
    held.reachPx[row] = feature ? this.reachPxOf(feature) : 0;
    held.known[row] = 1;
  }

  /** Whether the extent of a row is read from its feature (a type with one of its own) */
  private readsFeature(data: RowGroup['data'], row: number): boolean {
    const type = rowType(data, row);
    if (type === 'Image') return true;
    const extensions = this.extensions;
    if (!extensions) return false;
    return (
      extensions.getBoundingBoxCalculator(type) !== undefined ||
      extensions.getPointFrameExtentProvider(type) !== undefined
    );
  }

  /**
   * How far a footprint of the screen reaches from its position, in pixels (0 for none): the half
   * diagonal of its rectangle, whatever the bearing of the map
   */
  private reachPxOf(feature: Feature): number {
    const extent = this.extensions?.getPointFrameExtentProvider(feature.type)?.(feature);
    if (!extent) return 0;
    const reach = Math.hypot(extent.halfWidth, extent.halfHeight);
    return Number.isFinite(reach) && reach > 0 ? reach : 0;
  }
}

/**
 * The degrees of longitude and of latitude a size on the screen covers anywhere in a box, in the
 * frame drawn: at least those at every latitude of the box
 *
 * @param reachPx The size, in pixels
 * @param minY The south of the box
 * @param maxY The north of the box
 */
export function reachDegrees(
  reachPx: number,
  minY: number,
  maxY: number,
  frame: ScreenScaleFrame,
): [number, number] {
  if (reachPx <= 0) return [0, 0];
  // The degrees of a pixel east grow away from the equator, those north toward it (or stay)
  const far = Math.max(Math.abs(minY), Math.abs(maxY));
  const near = minY <= 0 && maxY >= 0 ? 0 : Math.min(Math.abs(minY), Math.abs(maxY));
  let lng = 0;
  let lat = 0;
  for (const latitude of [far, near]) {
    const meters = reachPx * metersPerPixelInFrame(frame, latitude);
    const [east, north] = degreesPerMeterAt(latitude);
    lng = Math.max(lng, meters * east);
    lat = Math.max(lat, meters * north);
  }
  return [lng, lat];
}

/**
 * A box widened by degrees of longitude and of latitude
 *
 * @internal
 */
export function widened(box: BBox, lng: number, lat: number): BBox {
  if (lng === 0 && lat === 0) return box;
  return [box[0] - lng, Math.max(-90, box[1] - lat), box[2] + lng, Math.min(90, box[3] + lat)];
}
