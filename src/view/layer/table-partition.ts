// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The runs and the GPU chunks of a row group of a layer
 *
 * The rows of a group are walked in their order, and a GPU chunk ends where the kind of the run
 * changes (`classifyRow`, the rules the features are drawn by, read from the columns) and where it
 * would hold more than `CHUNK_TARGET_VERTICES` coordinates. For the drawing in one draw, which
 * draws rows of every kind in one chunk, the kinds are only `rows` and `immediate`, so a chunk
 * ends only where a row is drawn at once and where the coordinates would be too many. A chunk is
 * a run of rows in the order of the layer, so drawing the chunks in order and skipping the ones
 * out of view keeps the order. A chunk ends only between two rows.
 *
 * A row without a geometry draws nothing and joins the run it is in.
 */

import type { FeatureTypeRenderer } from '../../extension/renderers.js';
import { circleBoundingBox } from '../../geometry/circle.js';
import type { BBox } from '../../geometry/types.js';
import { drawPropertyKey } from '../../shared/properties.js';
import {
  type DrawnRows,
  pageRowBox,
  type RowGroup,
  rowNumber,
} from '../../store/built-in/drawn-rows.js';
import type { Feature, Layer } from '../../store/types.js';
import { CHUNK_TARGET_VERTICES } from '../../table/partition.js';
import type { FeatureCompanionRegistry } from '../feature-companion.js';
import type { RowStyleSlots } from './table-collect.js';
import { rowGeometryOf } from './table-collect.js';

/** The key of the radius of a Circle in the attributes of a row */
const RADIUS_KEY = drawPropertyKey('radiusMeters');

/** The number of vertices of the ring of a Circle (the estimate of its work) */
const CIRCLE_VERTICES = 65;

/**
 * The kind of a chunk of rows: `rows`, a chunk of the drawing in one draw that holds rows of every
 * kind; the kinds of the drawing by kind, each drawn by the renderer of its kind (`polygon`,
 * `line`, `point-<shape>`); or `immediate`, rows drawn one at a time
 *
 * @internal
 */
export type TableRunKind = 'rows' | 'polygon' | 'line' | `point-${string}` | 'immediate';

/**
 * What the classification of a row reads besides the row
 *
 * @internal
 */
export interface RowClassifyContext {
  readonly rows: DrawnRows;
  /** The styles of the rows of the layer */
  readonly slots: RowStyleSlots;
  /** The renderers of the custom feature types (a registered type is drawn at once) */
  readonly customTypes: ReadonlyMap<string, unknown>;
  /** The providers of the companions of the features */
  readonly companions: FeatureCompanionRegistry;
  /**
   * The feature of a row, made only for a renderer that refuses some features of its type
   * (`appliesTo`) and for a provider of companions
   */
  featureOf(group: RowGroup, row: number): Feature | undefined;
  /** The layer */
  readonly layer?: Layer;
  /**
   * Whether the rows are classified for the drawing in one draw: every row it draws is `rows`,
   * and only the rows it cannot draw are `immediate`. Besides the rows the drawing by kind draws,
   * it draws the dashed and dotted lines and the polygons with a dashed outline
   */
  readonly oneDraw: boolean;
}

/**
 * The kind of the run of a row (null for a row without a geometry): the decisions the features
 * are drawn by (`classifyFeature` of the drawing of the features), read from the columns
 *
 * @internal
 */
export function classifyRow(
  group: RowGroup,
  row: number,
  context: RowClassifyContext,
): TableRunKind | null {
  const { rows } = context;
  if (!rows.hasGeometry(group, row)) return null;
  const type = rows.typeOf(group, row);
  // A custom type is drawn at once (unless its renderer refuses the feature)
  const renderer = context.customTypes.get(type) as
    | Pick<FeatureTypeRenderer, 'appliesTo'>
    | undefined;
  if (renderer) {
    if (!renderer.appliesTo) return 'immediate';
    const feature = context.featureOf(group, row);
    if (!feature || renderer.appliesTo.call(renderer, feature)) return 'immediate';
  }
  // A feature with a companion needs a hook right before it
  if (context.companions.any()) {
    const feature = context.featureOf(group, row);
    if (feature && context.companions.has(feature)) return 'immediate';
  }
  const style = rows.styleNumberOf(group, row);
  const ruleColor = context.slots.ruleColorOf(group, row);
  switch (type) {
    case 'Point':
    case 'MultiPoint': {
      const shape = context.slots.point(style, type, ruleColor).shape;
      if (!shape) return 'immediate';
      return context.oneDraw ? 'rows' : `point-${shape}`;
    }
    case 'LineString':
    case 'Freehand':
    case 'MultiLineString': {
      if (context.oneDraw) return 'rows';
      return context.slots.line(style, type, ruleColor).stroke.lineStyle === 'solid'
        ? 'line'
        : 'immediate';
    }
    case 'Polygon':
    case 'MultiPolygon':
    case 'Circle': {
      if (context.oneDraw) return 'rows';
      const slot = context.slots.polygon(style, type, ruleColor);
      return slot.dashedStroke ? 'immediate' : 'polygon';
    }
    default:
      return 'immediate';
  }
}

/**
 * A run of rows of one kind, in the order of its group
 *
 * @internal
 */
export interface OrderedChunkRange {
  readonly kind: TableRunKind;
  /** The first row of the run in its group */
  readonly from: number;
  /** The end of the run (exclusive) */
  readonly to: number;
  /** The coordinates of the run (the estimate of its work) */
  readonly vertices: number;
  /** The union of the boxes of its rows (null when no row has one) */
  readonly bounds: BBox | null;
}

/**
 * The box of a row as it is drawn: the box of its positions, or for a Circle the box of its
 * circle (false for a row without one)
 *
 * @internal
 */
export function drawnRowBox(rows: DrawnRows, group: RowGroup, row: number, out: Float64Array) {
  if (!pageRowBox(group.data, row, out)) return false;
  if (rows.typeOf(group, row) !== 'Circle') return true;
  const radius = rowNumber(group, row, RADIUS_KEY);
  if (!radius || radius <= 0) return true;
  const box = circleBoundingBox([out[0], out[1]], radius);
  if (!box) return true;
  out[0] = box[0];
  out[1] = box[1];
  out[2] = box[2];
  out[3] = box[3];
  return true;
}

/**
 * Cuts the rows of a group into runs: a run ends where the kind changes, and where it would hold
 * more than `targetVertices` coordinates
 *
 * @internal
 */
export function partitionRowGroup(
  rows: DrawnRows,
  group: RowGroup,
  classify: (row: number) => TableRunKind | null,
  targetVertices = CHUNK_TARGET_VERTICES,
): OrderedChunkRange[] {
  const out: OrderedChunkRange[] = [];
  const b = new Float64Array(4);
  let kind: TableRunKind | null = null;
  let from = 0;
  let vertices = 0;
  let box: BBox | null = null;

  const close = (to: number): void => {
    if (to > from && kind !== null) out.push({ kind, from, to, vertices, bounds: box });
    from = to;
    vertices = 0;
    box = null;
  };

  for (let row = 0; row < group.data.length; row++) {
    const rowKind = classify(row);
    const rowVertices = rowVertexCount(rows, group, row);
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
    if (drawnRowBox(rows, group, row, b)) {
      if (!box) box = [b[0], b[1], b[2], b[3]];
      else {
        if (b[0] < box[0]) box[0] = b[0];
        if (b[1] < box[1]) box[1] = b[1];
        if (b[2] > box[2]) box[2] = b[2];
        if (b[3] > box[3]) box[3] = b[3];
      }
    }
  }
  close(group.data.length);
  return out;
}

/** The number of coordinates a row draws (the estimate of its work) */
function rowVertexCount(rows: DrawnRows, group: RowGroup, row: number): number {
  const geometry = rowGeometryOf(group, row);
  if (!geometry) return 0;
  const { reader, at } = geometry;
  if (rows.typeOf(group, row) === 'Circle' && reader.type === 'Point') return CIRCLE_VERTICES;
  if (reader.depth === 0) return 1;
  return reader.vertexStart(at + 1) - reader.vertexStart(at);
}
