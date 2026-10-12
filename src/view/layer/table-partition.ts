// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The runs and the GPU chunks of a row group held as columns
 *
 * The rows of a group are walked in their order, and a GPU chunk ends where the kind of the
 * run changes (`classifyRow`, the rules of `classifyFeature` read from the columns) and where it
 * would hold more than `CHUNK_TARGET_VERTICES` coordinates. A chunk is a run of rows in the
 * order of the layer, so drawing the chunks in order and skipping the ones out of view keeps the
 * order, as the retained chunks of the Store do. A chunk ends only between two rows, so the
 * parts of a row are never in two chunks.
 *
 * A row without a geometry draws nothing and joins the run it is in.
 */

import type { RowGroup } from '../../feature-table/layer-table.js';
import { geometryReaderOf } from '../../feature-table/layer-table.js';
import { rowType } from '../../feature-table/row-read.js';
import type { BoundingBox, Feature, Layer } from '../../shared/types/model.js';
import { CHUNK_TARGET_VERTICES } from '../../table/partition.js';
import type { FeatureCompanionRegistry } from '../feature-companion.js';
import type { RunKind } from './store-retained-classify.js';
import type { RowStyleSlots } from './table-collect.js';

/** The number of vertices of the ring of a Circle (the estimate of its work) */
const CIRCLE_VERTICES = 65;

/**
 * What the classification of a row reads besides the row
 *
 * @internal
 */
export interface RowClassifyContext {
  /** The styles of the rows of the layer */
  readonly slots: RowStyleSlots;
  /** The renderers of the custom feature types (a registered type is drawn at once) */
  readonly customTypes: ReadonlyMap<string, unknown>;
  /** The providers of the companions of the features */
  readonly companions: FeatureCompanionRegistry;
  /**
   * The feature of a row, made only for an extension that answers from a feature (a renderer
   * that refuses some features of its type, a provider of companions)
   */
  featureOf(group: RowGroup, row: number): Feature;
  /** The layer (its style rule is in `slots`) */
  readonly layer?: Layer;
}

/**
 * The kind of the run of a row, by the rules of `classifyFeature` (the two must stay one to one:
 * a change on one side only breaks the order)
 *
 * @returns The kind, or null for a row without a geometry (it draws nothing)
 * @internal
 */
export function classifyRow(
  group: RowGroup,
  row: number,
  context: RowClassifyContext,
): RunKind | null {
  const data = group.data;
  if (data.geometry.types[row] < 0) return null;
  const type = rowType(data, row);

  // A custom type is drawn at once, unless its renderer refuses this feature
  const renderer = context.customTypes.get(type) as
    | { appliesTo?: (feature: Feature) => boolean }
    | undefined;
  if (renderer !== undefined) {
    if (!renderer.appliesTo || renderer.appliesTo(context.featureOf(group, row))) {
      return 'immediate';
    }
  }

  // A feature with a companion is drawn at once (the companion is drawn right before it)
  if (context.companions.any() && context.companions.has(context.featureOf(group, row))) {
    return 'immediate';
  }

  const slots = context.slots;
  const color = (): string | null => slots.ruleColorOf(group, row);
  switch (type) {
    case 'Point':
    case 'MultiPoint':
      return slots.point(data.styles[row], type, color()).shape ? 'point' : 'immediate';
    case 'LineString':
    case 'Freehand':
    case 'MultiLineString':
      return slots.line(data.styles[row], type, color()).stroke.lineStyle === 'solid'
        ? 'line'
        : 'immediate';
    case 'Polygon':
    case 'MultiPolygon':
    case 'Circle':
      // Only a dashed outline cannot be retained (fill only and a solid outline can be)
      return slots.polygon(data.styles[row], type, color()).dashedStroke ? 'immediate' : 'polygon';
    default:
      // Kinds that retained mode does not handle, such as Image
      return 'immediate';
  }
}

/**
 * A GPU chunk of a row group: a run of its rows of one kind
 *
 * @internal
 */
export interface OrderedChunkRange {
  readonly kind: RunKind;
  /** The first row of the chunk in its group */
  readonly from: number;
  /** The end of its rows (exclusive) */
  readonly to: number;
  /** The coordinates of its rows (the estimate of the work of a build) */
  readonly vertices: number;
  /** The union of the bboxes of its rows (null when no row has one) */
  readonly bounds: BoundingBox | null;
}

/**
 * Cuts the rows of a group into GPU chunks
 *
 * @param classify The kind of the run of a row (null for a row that draws nothing)
 * @param targetVertices The largest number of coordinates of a chunk (a row of more makes a
 *   chunk of its own)
 * @internal
 */
export function partitionRowGroup(
  group: RowGroup,
  classify: (row: number) => RunKind | null,
  targetVertices = CHUNK_TARGET_VERTICES,
): OrderedChunkRange[] {
  const out: OrderedChunkRange[] = [];
  const bounds = group.data.rowBounds;
  let kind: RunKind | null = null;
  let from = 0;
  let vertices = 0;
  let box: [number, number, number, number] | null = null;

  const close = (to: number): void => {
    if (to > from && kind !== null) {
      out.push({
        kind,
        from,
        to,
        vertices,
        bounds: box ? { minX: box[0], minY: box[1], maxX: box[2], maxY: box[3] } : null,
      });
    }
    from = to;
    vertices = 0;
    box = null;
  };

  for (let row = 0; row < group.data.length; row++) {
    const rowKind = classify(row);
    const rowVertices = rowVertexCount(group, row);
    if (rowKind !== null && kind !== null && rowKind !== kind) close(row);
    else if (
      rowKind !== null &&
      kind !== null &&
      row > from &&
      vertices + rowVertices > targetVertices
    ) {
      close(row);
    }
    if (rowKind !== null) kind = rowKind;
    vertices += rowVertices;
    const at = row * 4;
    if (!Number.isNaN(bounds[at])) {
      if (!box) box = [bounds[at], bounds[at + 1], bounds[at + 2], bounds[at + 3]];
      else {
        if (bounds[at] < box[0]) box[0] = bounds[at];
        if (bounds[at + 1] < box[1]) box[1] = bounds[at + 1];
        if (bounds[at + 2] > box[2]) box[2] = bounds[at + 2];
        if (bounds[at + 3] > box[3]) box[3] = bounds[at + 3];
      }
    }
  }
  close(group.data.length);
  return out;
}

/** The number of coordinates a row draws (the estimate of its work) */
function rowVertexCount(group: RowGroup, row: number): number {
  const reader = geometryReaderOf(group, row);
  if (!reader) return 0;
  if (rowType(group.data, row) === 'Circle' && reader.type === 'Point') return CIRCLE_VERTICES;
  const at = group.data.geometry.offsets[row];
  return reader.vertexStart(at + 1) - reader.vertexStart(at);
}
