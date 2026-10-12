// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Packing the rows held as columns into the GPU arrays
 *
 * A row is packed from its columns as it is, with the values the feature of the row would get:
 * its style is resolved once per number of style, type of feature and color of the style rule
 * of its layer (`RowStyleSlots`), through the same resolver the features of the Store use, with
 * a probe feature that carries the style of the row. The arrays are written by the same
 * functions the other batches use (`writePointInstance`, `writePackedLineInstances`,
 * `writePolygonFillVertex`, `writePolygonStrokeVertex`), with the number of the row in its
 * group after the values of each instance or vertex.
 *
 * The decisions follow the retained batches of the Store (`store-retained-collect.ts`): a line
 * is drawn per part of two coordinates or more; a polygon per polygon, its fill then its
 * outline, with the rings it draws (`polygon-rings.ts`); a polygon with neither a visible fill
 * nor an outline draws nothing; a width without a created zoom is fixed on screen (negative).
 */

import type { RowGroup } from '../../feature-table/layer-table.js';
import { geometryReaderOf } from '../../feature-table/layer-table.js';
import { rowNumber, rowType, rowValue } from '../../feature-table/row-read.js';
import type { StyleTable } from '../../feature-table/style-table.js';
import { generateCirclePolygon } from '../../geometry/circle.js';
import { drawPropertyKey } from '../../shared/properties.js';
import type { Feature, FeatureType, StyleRule } from '../../shared/types/model.js';
import type { Color } from '../../shared/types/style.js';
import type { PixelRatioInput } from '../../shared/utils/pixel-ratio.js';
import { resolveContentPixelRatio, resolvePixelRatio } from '../../shared/utils/pixel-ratio.js';
import { polygonRingRuns } from '../../table/polygon-rings.js';
import type { GeometryColumnReader } from '../../table/table.js';
import type { ValueStringCache } from '../../table/value-column.js';
import { toPackedPointStyle } from '../renderers/batch-manager.js';
import {
  maxSegmentMercatorOf,
  ROW_LINE_STRIDE,
  toLineInstanceColor,
  writePackedLineInstances,
} from '../renderers/line/line-geometry.js';
import type { SDFStrokeStyle } from '../renderers/line/line-types.js';
import {
  type PointShape,
  pointShapeCode,
  ROW_POINT_STRIDE,
  toInstancedPointShape,
  writePointInstance,
} from '../renderers/point/point-instance.js';
import {
  ROW_POLYGON_STRIDE,
  writePolygonFillVertex,
  writePolygonStrokeVertex,
} from '../renderers/polygon/sdf-polygon.js';
import type { RetainedStyleResolver } from '../renderers/retained.js';
import { applyRuleColor, evaluateStyleRuleValue, type StyleRuleChannel } from '../style-rule.js';
import { anchorElevationMeters } from '../terrain/anchor.js';
import type { TerrainContext } from '../terrain/context.js';

/** The key of the created zoom in the attributes of a row */
const CREATED_ZOOM_KEY = drawPropertyKey('createdZoom');
/** The key of the radius of a Circle in the attributes of a row */
const RADIUS_KEY = drawPropertyKey('radiusMeters');

/** The created zoom of a row whose width is fixed on screen (the shader ignores it) */
const FIXED_WIDTH_CREATED_ZOOM = 0;

/** The number of the style rule colors and of the resolved styles kept per layer */
const NO_RULE_COLOR = '';

/** The style of a point for one style, type and rule color */
export interface PointSlot {
  /** The instanced shape (null: the shape is drawn at once) */
  readonly shape: PointShape | null;
  /** The packed style (`toPackedPointStyle`) */
  readonly packed: Float64Array;
}

/** The style of a line */
export interface LineSlot {
  readonly stroke: SDFStrokeStyle;
  /** The instance color (`toLineInstanceColor`) */
  readonly color: Color;
}

/** The style of a polygon */
export interface PolygonSlot {
  /** The fill color with its opacity */
  readonly fillColor: Color;
  /** The color of the outline with its opacity */
  readonly strokeColor: Color;
  /** Whether the outline is drawn (visible and wider than 0) */
  readonly hasStroke: boolean;
  /** Whether the outline is visible and not solid (the polygon is drawn at once) */
  readonly dashedStroke: boolean;
  /** The width of the outline in CSS px */
  readonly strokeWidth: number;
}

/**
 * The styles of the rows of a layer, resolved once per number of style, type of feature and
 * color of the style rule
 *
 * @internal
 */
export class RowStyleSlots {
  private readonly points = new Map<string, PointSlot>();
  private readonly lines = new Map<string, LineSlot>();
  private readonly polygons = new Map<string, PolygonSlot>();
  /** The rule color of each value of the attribute the rule reads */
  private readonly ruleColors = new Map<unknown, string>();

  /**
   * @param resolver The resolution of the styles of the features
   * @param styles The table of the styles of the rows
   * @param rule The style rule of the layer (none when undefined)
   */
  constructor(
    readonly resolver: RetainedStyleResolver,
    private readonly styles: StyleTable,
    readonly rule: StyleRule | undefined,
  ) {}

  /**
   * The color the style rule of the layer gives a row (null without a rule): the color the rule
   * gives the feature of the row, read from the column of the attribute the rule reads
   */
  ruleColorOf(group: RowGroup, row: number, strings?: ValueStringCache): string | null {
    const rule = this.rule;
    if (!rule) return null;
    const value = rule.kind === 'single' ? undefined : rowValue(group, row, rule.property, strings);
    const cacheable = value === null || typeof value !== 'object';
    if (cacheable) {
      const cached = this.ruleColors.get(value);
      if (cached !== undefined) return cached;
    }
    const color = evaluateStyleRuleValue(rule, value);
    if (cacheable) this.ruleColors.set(value, color);
    return color;
  }

  point(style: number, type: FeatureType, ruleColor: string | null): PointSlot {
    const key = slotKey(style, type, ruleColor);
    let slot = this.points.get(key);
    if (!slot) {
      const resolved = this.resolver.getPointStyle(this.probe(style, type, ruleColor, 'point'));
      slot = { shape: toInstancedPointShape(resolved.shape), packed: toPackedPointStyle(resolved) };
      this.points.set(key, slot);
    }
    return slot;
  }

  line(style: number, type: FeatureType, ruleColor: string | null): LineSlot {
    const key = slotKey(style, type, ruleColor);
    let slot = this.lines.get(key);
    if (!slot) {
      const stroke = this.resolver.getLineStringStrokeStyle(
        this.probe(style, type, ruleColor, 'stroke'),
      );
      slot = { stroke, color: toLineInstanceColor(stroke.color, stroke.opacity) };
      this.lines.set(key, slot);
    }
    return slot;
  }

  polygon(style: number, type: FeatureType, ruleColor: string | null): PolygonSlot {
    const key = slotKey(style, type, ruleColor);
    let slot = this.polygons.get(key);
    if (!slot) {
      const { fillColor, strokeStyle } = this.resolver.getPolygonStyles(
        this.probe(style, type, ruleColor, 'fill'),
      );
      const hasStroke = strokeStyle.opacity > 0 && strokeStyle.width > 0;
      slot = {
        // The batches of polygons fold an opacity of 1 into the fill, and the opacity of the
        // outline (1 when it is drawn) into its color
        fillColor: [fillColor[0], fillColor[1], fillColor[2], fillColor[3]],
        strokeColor: [
          strokeStyle.color[0],
          strokeStyle.color[1],
          strokeStyle.color[2],
          strokeStyle.color[3] * (hasStroke ? 1 : 0),
        ],
        hasStroke,
        dashedStroke: strokeStyle.opacity > 0 && strokeStyle.lineStyle !== 'solid',
        strokeWidth: strokeStyle.width,
      };
      this.polygons.set(key, slot);
    }
    return slot;
  }

  /**
   * A feature that carries the style a row gets: its own style with the color of the rule on
   * the channel the resolution reads (the resolver is given no layer, so it applies no rule of
   * its own)
   */
  private probe(
    style: number,
    type: FeatureType,
    ruleColor: string | null,
    channel: StyleRuleChannel,
  ): Feature {
    return {
      id: '',
      type,
      geometry: { type: 'Point', coordinates: [0, 0] },
      layerId: '',
      groupId: undefined,
      properties: {},
      style: applyRuleColor(this.styles.get(style), ruleColor, channel) ?? {},
      locked: false,
      visible: true,
    };
  }
}

function slotKey(style: number, type: FeatureType, ruleColor: string | null): string {
  return `${style}\u0000${type}\u0000${ruleColor ?? NO_RULE_COLOR}`;
}

/**
 * What packing the rows of a layer needs
 *
 * @internal
 */
export interface RowPackContext {
  readonly slots: RowStyleSlots;
  readonly strings: ValueStringCache;
  readonly pixelRatio: PixelRatioInput | undefined;
  readonly terrain: TerrainContext;
}

/**
 * The created zoom of a row (undefined when its width is fixed on screen)
 *
 * @internal
 */
export function rowCreatedZoom(group: RowGroup, row: number): number | undefined {
  return rowNumber(group, row, CREATED_ZOOM_KEY);
}

// === Points ===

/**
 * The number of point instances of a row (a Point 1, a MultiPoint its coordinates, any other
 * row 0)
 *
 * @internal
 */
export function pointInstancesOf(group: RowGroup, row: number): number {
  const reader = geometryReaderOf(group, row);
  if (!reader) return 0;
  const at = group.data.geometry.offsets[row];
  if (reader.type === 'Point') return 1;
  if (reader.type === 'MultiPoint') return reader.vertexStart(at + 1) - reader.vertexStart(at);
  return 0;
}

/**
 * Writes the point instances of a row ({@link ROW_POINT_STRIDE} floats each)
 *
 * @returns The number of instances written
 * @internal
 */
export function writePointRow(
  group: RowGroup,
  row: number,
  target: Float32Array,
  instance: number,
  origin: readonly [number, number],
  context: RowPackContext,
): number {
  const reader = geometryReaderOf(group, row);
  if (!reader || (reader.type !== 'Point' && reader.type !== 'MultiPoint')) return 0;
  const data = group.data;
  const slot = context.slots.point(
    data.styles[row],
    rowType(data, row),
    context.slots.ruleColorOf(group, row, context.strings),
  );
  // A shape that is not instanced makes the row a run drawn at once; it is not packed
  const shape = slot.shape;
  if (!shape) return 0;
  const code = pointShapeCode(shape);
  const dpr = resolvePixelRatio(context.pixelRatio);
  const at = data.geometry.offsets[row];
  const first = reader.vertexStart(at);
  const end = reader.vertexStart(at + 1);
  const coords = reader.coords;
  const stride = reader.dimensions;
  let written = 0;
  for (let v = first; v < end; v++) {
    const lng = coords[v * stride];
    const lat = coords[v * stride + 1];
    const base = (instance + written) * ROW_POINT_STRIDE;
    writePointInstance(
      target,
      base,
      lng,
      lat,
      origin,
      slot.packed,
      0,
      dpr,
      anchorElevationMeters(context.terrain, lng, lat),
      code,
    );
    target[base + ROW_POINT_STRIDE - 1] = row;
    written++;
  }
  return written;
}

// === Lines ===

/**
 * The runs of coordinates of the parts of a line row of two coordinates or more, as pairs
 * `start, end` of the coordinates of its geometry column
 *
 * @returns The geometry column (undefined for a row that is not a line)
 * @internal
 */
export function linePartsOf(
  group: RowGroup,
  row: number,
  out: number[],
): GeometryColumnReader | undefined {
  const reader = geometryReaderOf(group, row);
  if (!reader) return undefined;
  const at = group.data.geometry.offsets[row];
  const o = reader.offsets;
  if (reader.type === 'LineString') {
    if (o[0][at + 1] - o[0][at] >= 2) out.push(o[0][at], o[0][at + 1]);
    return reader;
  }
  if (reader.type === 'MultiLineString') {
    for (let p = o[0][at]; p < o[0][at + 1]; p++) {
      if (o[1][p + 1] - o[1][p] >= 2) out.push(o[1][p], o[1][p + 1]);
    }
    return reader;
  }
  return undefined;
}

/**
 * The coordinates and the instances of the line rows of a batch, as they are packed
 *
 * @internal
 */
export interface LineRowArrays {
  readonly texData: Float32Array;
  readonly texSize: number;
  readonly instanceData: Float32Array;
  instanceCount: number;
  maxSegmentMeters: number;
  coordCount: number;
}

/**
 * The arrays of the lines of rows with this many coordinates and instances
 *
 * @internal
 */
export function createLineRowArrays(coords: number, instances: number): LineRowArrays {
  const texSize = Math.max(2, Math.ceil(Math.sqrt(Math.max(coords, 1))));
  return {
    texData: new Float32Array(texSize * texSize * 4),
    texSize,
    instanceData: new Float32Array(instances * ROW_LINE_STRIDE),
    instanceCount: 0,
    maxSegmentMeters: 0,
    coordCount: 0,
  };
}

/**
 * Writes the coordinates and the instances of a line row
 *
 * @returns The number of instances written
 * @internal
 */
export function writeLineRow(
  group: RowGroup,
  row: number,
  arrays: LineRowArrays,
  origin: readonly [number, number],
  context: RowPackContext,
  parts: number[],
): number {
  parts.length = 0;
  const reader = linePartsOf(group, row, parts);
  if (!reader || parts.length === 0) return 0;
  const data = group.data;
  const slot = context.slots.line(
    data.styles[row],
    rowType(data, row),
    context.slots.ruleColorOf(group, row, context.strings),
  );
  const createdZoom = rowCreatedZoom(group, row);
  // A fixed width is declared by the negative convention (as in `collectLineItems`)
  const width = createdZoom === undefined ? -slot.stroke.width : slot.stroke.width;
  const screenDpr = resolvePixelRatio(context.pixelRatio);
  const contentDpr = resolveContentPixelRatio(context.pixelRatio);
  const coords = reader.coords;
  const stride = reader.dimensions;
  const firstInstance = arrays.instanceCount;
  for (let k = 0; k < parts.length; k += 2) {
    const start = parts[k];
    const end = parts[k + 1];
    const coordOffset = arrays.coordCount;
    for (let v = start; v < end; v++) {
      const at = (arrays.coordCount + v - start) * 4;
      arrays.texData[at] = coords[v * stride] - origin[0];
      arrays.texData[at + 1] = coords[v * stride + 1] - origin[1];
    }
    const meters = writePackedLineInstances(
      arrays.instanceData,
      ROW_LINE_STRIDE,
      arrays.instanceCount,
      coordOffset,
      coords,
      stride,
      start,
      end,
      // The cumulative distance is the one of zoom 0 (it only matters to a dash)
      0,
      screenDpr,
      contentDpr,
      width,
      createdZoom ?? FIXED_WIDTH_CREATED_ZOOM,
      slot.color,
      0,
    );
    if (meters > arrays.maxSegmentMeters) arrays.maxSegmentMeters = meters;
    const instances = end - start - 1;
    for (let i = 0; i < instances; i++) {
      arrays.instanceData[(arrays.instanceCount + i) * ROW_LINE_STRIDE + ROW_LINE_STRIDE - 1] = row;
    }
    arrays.instanceCount += instances;
    arrays.coordCount += end - start;
  }
  return arrays.instanceCount - firstInstance;
}

/**
 * The longest segment of the line instances on the Mercator plane (the subdivision on the
 * globe reads it)
 *
 * @internal
 */
export function lineRowsMercatorLength(
  arrays: LineRowArrays,
  pixelRatio?: PixelRatioInput,
): number {
  return maxSegmentMercatorOf(
    arrays.instanceData,
    ROW_LINE_STRIDE,
    arrays.instanceCount,
    0,
    resolvePixelRatio(pixelRatio),
  );
}

// === Polygons ===

/**
 * One polygon of a row as it is drawn
 *
 * @internal
 */
export interface PolygonPart {
  /** The coordinates the rings are read from */
  readonly coords: Float64Array;
  /** The values per coordinate in `coords` */
  readonly stride: number;
  /** The rings drawn, as pairs `start, end` of coordinates */
  readonly runs: number[];
  /** The number of coordinates of the rings drawn (the vertices of the fill) */
  readonly vertices: number;
  /** The triangles of the fill: indices `[from, to)` of the indices of the row */
  readonly triangleFrom: number;
  readonly triangleTo: number;
  /** The first vertex of the fill of this polygon among the vertices of the fill of the row */
  readonly base: number;
}

/**
 * The plan of a polygon row: its polygons, its style, and what it adds to a batch
 *
 * @internal
 */
export interface PolygonRowPlan {
  readonly parts: readonly PolygonPart[];
  readonly slot: PolygonSlot;
  /** The indices of the triangles of the row (into the vertices of its fill) */
  readonly triangles: Uint16Array | Uint32Array;
  readonly createdZoom: number | undefined;
  /** The vertices and the indices the row adds to a batch */
  readonly vertexCount: number;
  readonly indexCount: number;
}

/**
 * Plans a polygon row (null for a row that draws nothing: not a polygon, no visible fill nor
 * outline)
 *
 * @internal
 */
export function planPolygonRow(
  group: RowGroup,
  row: number,
  context: RowPackContext,
): PolygonRowPlan | null {
  const data = group.data;
  const type = rowType(data, row);
  const reader = geometryReaderOf(group, row);
  if (!reader) return null;
  const at = data.geometry.offsets[row];

  // The polygons of the row: their rings as offsets into coordinates
  const polygons: Array<{
    coords: Float64Array;
    stride: number;
    rings: Int32Array;
    from: number;
    to: number;
  }> = [];
  if (type === 'Circle' && reader.type === 'Point') {
    const radius = rowNumber(group, row, RADIUS_KEY);
    if (!radius || radius <= 0) return null;
    const center = reader.position(at);
    const ring = generateCirclePolygon(center, radius);
    if (ring.length === 0) return null;
    const coords = new Float64Array(ring.length * 2);
    for (let i = 0; i < ring.length; i++) {
      coords[i * 2] = ring[i][0];
      coords[i * 2 + 1] = ring[i][1];
    }
    polygons.push({ coords, stride: 2, rings: Int32Array.of(0, ring.length), from: 0, to: 1 });
  } else if (reader.type === 'Polygon') {
    const o = reader.offsets;
    polygons.push({
      coords: reader.coords,
      stride: reader.dimensions,
      rings: o[1],
      from: o[0][at],
      to: o[0][at + 1],
    });
  } else if (reader.type === 'MultiPolygon') {
    const o = reader.offsets;
    for (let p = o[0][at]; p < o[0][at + 1]; p++) {
      polygons.push({
        coords: reader.coords,
        stride: reader.dimensions,
        rings: o[2],
        from: o[1][p],
        to: o[1][p + 1],
      });
    }
  } else {
    return null;
  }

  const slot = context.slots.polygon(
    data.styles[row],
    type,
    context.slots.ruleColorOf(group, row, context.strings),
  );
  if (!slot.hasStroke && slot.fillColor[3] <= 0) return null;

  const triangles = rowTriangles(group, row);
  const parts: PolygonPart[] = [];
  let base = 0;
  let t = 0;
  let vertexCount = 0;
  let indexCount = 0;
  for (const polygon of polygons) {
    const runs: number[] = [];
    const vertices = polygonRingRuns(
      polygon.coords,
      polygon.stride,
      polygon.rings,
      polygon.from,
      polygon.to,
      runs,
    );
    if (vertices === 0) continue;
    // The triangles of this polygon are the ones that point into its vertices
    const triangleFrom = t;
    while (t < triangles.length && triangles[t] < base + vertices) t += 3;
    const part: PolygonPart = {
      coords: polygon.coords,
      stride: polygon.stride,
      runs,
      vertices,
      triangleFrom,
      triangleTo: t,
      base,
    };
    parts.push(part);
    if (part.triangleTo > part.triangleFrom) {
      vertexCount += vertices;
      indexCount += part.triangleTo - part.triangleFrom;
    }
    if (slot.hasStroke) {
      vertexCount += vertices * 4;
      indexCount += vertices * 6;
    }
    base += vertices;
  }
  if (vertexCount === 0) return null;
  return {
    parts,
    slot,
    triangles,
    createdZoom: rowCreatedZoom(group, row),
    vertexCount,
    indexCount,
  };
}

/** The indices of the triangles of the fill of a row */
function rowTriangles(group: RowGroup, row: number): Uint16Array | Uint32Array {
  const t = group.data.triangles;
  const start = t.offsets[row];
  const end = t.offsets[row + 1];
  if (end > start) return t.indices.subarray(start, end);
  const wide = indexOfRow(t.wideRows, row);
  if (wide < 0) return t.indices.subarray(start, start);
  return t.wideIndices.subarray(t.wideOffsets[wide], t.wideOffsets[wide + 1]);
}

/** The place of a row in an ascending list of rows (-1 when it is not there) */
function indexOfRow(rows: Int32Array, row: number): number {
  let lo = 0;
  let hi = rows.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid] === row) return mid;
    if (rows[mid] < row) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/**
 * Writes the vertices and the indices of a polygon row as the batches of polygons lay them
 * out: for each polygon, its fill, then its outline (4 vertices and 6 indices per edge)
 *
 * @param vertices The vertex array ({@link ROW_POLYGON_STRIDE} floats per vertex)
 * @param vertexAt The vertex of `vertices` the row starts at
 * @param indices The index array
 * @param indexAt The index of `indices` the row starts at
 * @param firstVertex The number of the first vertex of the row in the whole batch
 * @internal
 */
export function writePolygonRow(
  plan: PolygonRowPlan,
  row: number,
  vertices: Float32Array,
  vertexAt: number,
  indices: Uint32Array,
  indexAt: number,
  firstVertex: number,
  origin: readonly [number, number],
  pixelRatio: PixelRatioInput | undefined,
): void {
  const { slot, triangles } = plan;
  let v = vertexAt;
  let n = firstVertex;
  let i = indexAt;
  const screenDpr = resolvePixelRatio(pixelRatio);
  const contentDpr = resolveContentPixelRatio(pixelRatio);
  // A fixed width is declared by the negative convention (as in `collectPolygons`)
  const width = plan.createdZoom === undefined ? -slot.strokeWidth : slot.strokeWidth;
  const strokeWidth = width * (width < 0 ? screenDpr : contentDpr);
  const createdZoom = plan.createdZoom ?? FIXED_WIDTH_CREATED_ZOOM;

  for (const part of plan.parts) {
    const { coords, stride, runs } = part;
    // 1. The fill: the coordinates of its rings, and its triangles
    if (part.triangleTo > part.triangleFrom) {
      for (let k = 0; k < runs.length; k += 2) {
        for (let c = runs[k]; c < runs[k + 1]; c++) {
          const at = v * ROW_POLYGON_STRIDE;
          writePolygonFillVertex(
            vertices,
            at,
            coords[c * stride],
            coords[c * stride + 1],
            origin,
            slot.fillColor,
          );
          vertices[at + ROW_POLYGON_STRIDE - 1] = row;
          v++;
        }
      }
      for (let t = part.triangleFrom; t < part.triangleTo; t++) {
        indices[i++] = triangles[t] - part.base + n;
      }
      n += part.vertices;
    }

    // 2. The outline: a quad per edge of every ring
    if (slot.hasStroke) {
      for (let k = 0; k < runs.length; k += 2) {
        const start = runs[k];
        const count = runs[k + 1] - start;
        const point = (j: number): [number, number] => {
          const c = start + (((j % count) + count) % count);
          return [coords[c * stride], coords[c * stride + 1]];
        };
        for (let j = 0; j < count; j++) {
          const curr = point(j);
          const next = point(j + 1);
          const prev = point(j - 1);
          const nextNext = point(j + 2);
          const quad: Array<
            [[number, number], [number, number], [number, number], number, number]
          > = [
            [curr, prev, next, 1, 0],
            [curr, prev, next, -1, 0],
            [next, curr, nextNext, 1, 1],
            [next, curr, nextNext, -1, 1],
          ];
          for (const [pos, before, after, side, along] of quad) {
            const at = v * ROW_POLYGON_STRIDE;
            writePolygonStrokeVertex(
              vertices,
              at,
              pos,
              slot.strokeColor,
              before,
              after,
              side,
              along,
              strokeWidth,
              createdZoom,
              origin,
            );
            vertices[at + ROW_POLYGON_STRIDE - 1] = row;
            v++;
          }
          indices[i] = n;
          indices[i + 1] = n + 1;
          indices[i + 2] = n + 2;
          indices[i + 3] = n + 2;
          indices[i + 4] = n + 1;
          indices[i + 5] = n + 3;
          i += 6;
          n += 4;
        }
      }
    }
  }
}
