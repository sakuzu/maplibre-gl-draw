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
import { geometryAt } from '../../feature-table/layer-table.js';
import {
  rowHasGeometry,
  rowNumber,
  rowTriangles,
  rowType,
  rowValue,
} from '../../feature-table/row-read.js';
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
import { dashSegmentLength } from '../renderers/line/dash.js';
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
import {
  ROWS_DASH,
  ROWS_INSTANCE_FLOATS,
  ROWS_KIND,
  ROWS_ROW_STYLE_FLOATS,
  ROWS_STYLE_FLOATS,
  type RowSprite,
  type RowSpriteSource,
  type RowsChunkData,
  type RowsKind,
  type RowsPalette,
  writeRowsInstance,
} from '../renderers/rows/rows-format.js';
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
  /** The pattern of the outline */
  readonly lineStyle: 'solid' | 'dashed' | 'dotted';
  /**
   * The color a dashed outline is drawn with, as the lines draw it (`toLineInstanceColor` of the
   * color of the outline and its opacity)
   */
  readonly dashedColor: Color;
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
  /** The pictures of each source of pictures, for its revision */
  private readonly sprites = new Map<
    RowSpriteSource,
    { revision: number; sprites: Map<number, RowSprite | null> }
  >();

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
        lineStyle: strokeStyle.lineStyle,
        dashedColor: toLineInstanceColor(strokeStyle.color, strokeStyle.opacity),
      };
      this.polygons.set(key, slot);
    }
    return slot;
  }

  /**
   * The picture a source of pictures gives the points of a style (null for points it draws at
   * once), asked once per source, revision and style
   */
  sprite(source: RowSpriteSource, style: number): RowSprite | null {
    let bySource = this.sprites.get(source);
    if (!bySource || bySource.revision !== source.revision) {
      bySource = { revision: source.revision, sprites: new Map() };
      this.sprites.set(source, bySource);
    }
    let sprite = bySource.sprites.get(style);
    if (sprite === undefined) {
      sprite = source.sprite(this.styles.get(style)) ?? null;
      bySource.sprites.set(style, sprite);
    }
    return sprite;
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
  const geometry = geometryAt(group, row);
  if (!geometry) return 0;
  const { reader, at } = geometry;
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
  const geometry = geometryAt(group, row);
  if (!geometry || (geometry.reader.type !== 'Point' && geometry.reader.type !== 'MultiPoint')) {
    return 0;
  }
  const { reader, at } = geometry;
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
  const geometry = geometryAt(group, row);
  if (!geometry) return undefined;
  const { reader, at } = geometry;
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
  const geometry = geometryAt(group, row);
  if (!geometry) return null;
  const { reader, at } = geometry;

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

// === The rows drawn in one draw ===

/**
 * The resolved styles of the rows of a layer as the values of a palette: each style, type of
 * feature and rule color (and each picture of a source of pictures) is resolved once and gets a
 * number, its values written once (`rows-format.ts`). The widths and sizes are in device pixels
 * of the pixel ratio it was made with.
 *
 * @internal
 */
export class RowsStyles {
  private readonly numbers = new Map<string, number>();
  private readonly values = new Float32Array(ROWS_STYLE_FLOATS);
  /** Device pixels per CSS px of the sizes fixed on screen */
  readonly screenRatio: number;
  /** Device pixels per CSS px of the widths that follow the zoom */
  readonly contentRatio: number;

  constructor(
    readonly slots: RowStyleSlots,
    readonly palette: RowsPalette,
    pixelRatio: PixelRatioInput | undefined,
  ) {
    this.screenRatio = resolvePixelRatio(pixelRatio);
    this.contentRatio = resolveContentPixelRatio(pixelRatio);
  }

  /**
   * The number of the style of a point: its fill, its stroke, then its radius, its stroke width
   * and the code of its shape (null for a shape that is not instanced)
   */
  point(style: number, type: FeatureType, ruleColor: string | null): number | null {
    const key = `p${slotKey(style, type, ruleColor)}`;
    const known = this.numbers.get(key);
    if (known !== undefined) return known;
    const slot = this.slots.point(style, type, ruleColor);
    if (!slot.shape) return null;
    const v = this.cleared();
    const packed = slot.packed;
    for (let i = 0; i < 8; i++) v[i] = packed[i];
    v[8] = packed[8] * this.screenRatio;
    v[9] = packed[9] * this.screenRatio;
    v[10] = pointShapeCode(slot.shape);
    return this.add(key);
  }

  /**
   * The number of the style of a line: its color, then its width that follows the zoom, its
   * width fixed on screen (negative), its width in CSS px and its pattern
   */
  line(style: number, type: FeatureType, ruleColor: string | null): number {
    const key = `l${slotKey(style, type, ruleColor)}`;
    const known = this.numbers.get(key);
    if (known !== undefined) return known;
    const slot = this.slots.line(style, type, ruleColor);
    const v = this.cleared();
    for (let i = 0; i < 4; i++) v[i] = slot.color[i];
    this.widths(v, 4, slot.stroke.width, slot.stroke.lineStyle);
    return this.add(key);
  }

  /**
   * The number of the style of a polygon: its fill, the color of its outline, the widths of its
   * outline (as a line's) and the color of a dashed outline
   */
  polygon(style: number, type: FeatureType, ruleColor: string | null): number {
    const key = `g${slotKey(style, type, ruleColor)}`;
    const known = this.numbers.get(key);
    if (known !== undefined) return known;
    const slot = this.slots.polygon(style, type, ruleColor);
    const v = this.cleared();
    for (let i = 0; i < 4; i++) {
      v[i] = slot.fillColor[i];
      v[4 + i] = slot.strokeColor[i];
      v[12 + i] = slot.dashedColor[i];
    }
    this.widths(v, 8, slot.strokeWidth, slot.dashedStroke ? slot.lineStyle : 'solid');
    return this.add(key);
  }

  /**
   * The number of the style of a picture: its rectangle in the texture, then its half size in
   * CSS px and its bearing
   */
  sprite(source: RowSpriteSource, sprite: RowSprite, style: number): number {
    const key = `s${this.sourceNumber(source)}\u0000${style}\u0000${source.revision}`;
    const known = this.numbers.get(key);
    if (known !== undefined) return known;
    const v = this.cleared();
    for (let i = 0; i < 4; i++) v[i] = sprite.uv[i];
    v[4] = sprite.halfWidth;
    v[5] = sprite.halfHeight;
    v[6] = sprite.direction >= 0 ? sprite.direction : -1;
    return this.add(key);
  }

  private readonly sources = new Map<RowSpriteSource, number>();

  private sourceNumber(source: RowSpriteSource): number {
    let number = this.sources.get(source);
    if (number === undefined) {
      number = this.sources.size;
      this.sources.set(source, number);
    }
    return number;
  }

  /** Writes the widths of a line or an outline from `at` */
  private widths(
    v: Float32Array,
    at: number,
    width: number,
    lineStyle: 'solid' | 'dashed' | 'dotted',
  ): void {
    // The width that follows the zoom, and the one fixed on screen (the negative convention):
    // the row picks one by whether it has a created zoom
    v[at] = width * this.contentRatio;
    v[at + 1] = -width * this.screenRatio;
    v[at + 2] = width;
    v[at + 3] = ROWS_DASH[lineStyle];
  }

  private cleared(): Float32Array {
    this.values.fill(0);
    return this.values;
  }

  private add(key: string): number {
    const number = this.palette.add(this.values);
    this.numbers.set(key, number);
    return number;
  }
}

/**
 * What packing the rows of a layer into chunks drawn in one draw needs
 *
 * @internal
 */
export interface RowsPackContext extends RowPackContext {
  /** The styles of the layer as the values of a palette */
  readonly rowsStyles: RowsStyles;
  /**
   * The source of the pictures a row of the group packed is drawn with (undefined for a row
   * drawn as its built-in kind)
   */
  spriteSourceOf(row: number): RowSpriteSource | undefined;
}

/**
 * The arrays of a chunk of rows being packed: the instances, the coordinates, the style of each
 * row, and where each row starts in them
 *
 * @internal
 */
export class RowsDraft {
  instances: Float32Array;
  instanceCount = 0;
  points: Float32Array;
  pointCount = 0;
  coords: Float32Array;
  coordCount = 0;
  readonly rowStyles: Float32Array;
  readonly rowFirst: Int32Array;
  readonly pointFirst: Int32Array;
  readonly coordFirst: Int32Array;

  /**
   * @param rows The rows of the chunk
   * @param rowBase The first row of the chunk in its group
   * @param coords The coordinates expected (the arrays grow past it)
   */
  constructor(
    readonly rows: number,
    readonly rowBase: number,
    coords = 64,
  ) {
    this.coords = new Float32Array(Math.max(coords, 4) * 2);
    this.instances = new Float32Array(Math.max(coords, 4) * 2 * ROWS_INSTANCE_FLOATS);
    this.points = new Float32Array(4 * ROWS_INSTANCE_FLOATS);
    this.rowStyles = new Float32Array(Math.max(rows, 1) * ROWS_ROW_STYLE_FLOATS);
    this.rowFirst = new Int32Array(rows + 1);
    this.pointFirst = new Int32Array(rows + 1);
    this.coordFirst = new Int32Array(rows + 1);
  }

  /** Adds a coordinate (an offset from the origin) and returns its number */
  coord(x: number, y: number): number {
    const at = this.coordCount * 2;
    if (at + 2 > this.coords.length) this.coords = grown(this.coords, at + 2);
    this.coords[at] = x;
    this.coords[at + 1] = y;
    return this.coordCount++;
  }

  /** Adds an instance (and to the instances of the points, for a point or a picture) */
  instance(
    kind: RowsKind,
    row: number,
    i0: number,
    i1: number,
    i2: number,
    i3: number,
    extra = 0,
  ): void {
    if ((this.instanceCount + 1) * ROWS_INSTANCE_FLOATS > this.instances.length) {
      this.instances = grown(this.instances, (this.instanceCount + 1) * ROWS_INSTANCE_FLOATS);
    }
    writeRowsInstance(this.instances, this.instanceCount++, kind, row, i0, i1, i2, i3, extra);
    if (kind === ROWS_KIND.point || kind === ROWS_KIND.sprite) {
      if ((this.pointCount + 1) * ROWS_INSTANCE_FLOATS > this.points.length) {
        this.points = grown(this.points, (this.pointCount + 1) * ROWS_INSTANCE_FLOATS);
      }
      writeRowsInstance(this.points, this.pointCount++, kind, row, i0, i1, i2, i3, extra);
    }
  }

  /** The packed arrays of the chunk */
  finish(
    origin: [number, number],
    palette: RowsPalette,
    sprites: RowSpriteSource | null,
  ): RowsChunkData {
    return {
      origin,
      rowBase: this.rowBase,
      rows: this.rows,
      instances: this.instances,
      instanceCount: this.instanceCount,
      points: this.points,
      pointCount: this.pointCount,
      coords: this.coords,
      coordCount: this.coordCount,
      rowStyles: this.rowStyles,
      rowFirst: this.rowFirst,
      pointFirst: this.pointFirst,
      coordFirst: this.coordFirst,
      palette,
      sprites,
    };
  }
}

/** A Float32Array of at least `length` floats with the values of `array` */
function grown(array: Float32Array, length: number): Float32Array {
  let size = Math.max(array.length * 2, 16);
  while (size < length) size *= 2;
  const out = new Float32Array(size);
  out.set(array);
  return out;
}

/**
 * Packs a row into a chunk drawn in one draw: its style, then its instances in the order they
 * are drawn, and its coordinates
 *
 * - a point: one instance per point (a picture when its row is drawn with pictures)
 * - a line: one instance per segment of each part, the parts in order; a dashed line carries the
 *   length of its part before each segment
 * - a polygon: for each polygon of the row in order, the pairs of triangles of its fill (when
 *   its fill is seen), then the edges of its rings, the outer ring first (when it has an outline;
 *   a dashed outline is drawn as lines, each ring from its first coordinate)
 *
 * @param i The row in the chunk (`row - draft.rowBase`)
 * @param origin The origin the coordinates are offsets from
 * @internal
 */
export function collectRow(
  group: RowGroup,
  row: number,
  i: number,
  draft: RowsDraft,
  origin: readonly [number, number],
  context: RowsPackContext,
): void {
  const data = group.data;
  const styleAt = i * ROWS_ROW_STYLE_FLOATS;
  draft.rowStyles.fill(0, styleAt, styleAt + ROWS_ROW_STYLE_FLOATS);
  if (rowHasGeometry(group, row)) {
    const type = rowType(data, row);
    switch (type) {
      case 'Point':
      case 'MultiPoint':
        collectPointRow(group, row, styleAt, draft, origin, context);
        break;
      case 'LineString':
      case 'Freehand':
      case 'MultiLineString':
        collectLineRow(group, row, styleAt, draft, origin, context);
        break;
      case 'Polygon':
      case 'MultiPolygon':
      case 'Circle':
        collectPolygonRow(group, row, styleAt, draft, origin, context);
        break;
      default: {
        // A custom type drawn with pictures holds points
        if (context.spriteSourceOf(row))
          collectPointRow(group, row, styleAt, draft, origin, context);
        break;
      }
    }
  }
  draft.rowFirst[i + 1] = draft.instanceCount;
  draft.pointFirst[i + 1] = draft.pointCount;
  draft.coordFirst[i + 1] = draft.coordCount;
}

/** Writes the style of a row: the number of its style, its created zoom and whether it has one */
function writeRowStyle(
  draft: RowsDraft,
  at: number,
  style: number,
  createdZoom: number | undefined,
): void {
  draft.rowStyles[at] = style;
  draft.rowStyles[at + 1] = createdZoom ?? 0;
  draft.rowStyles[at + 2] = createdZoom === undefined ? 0 : 1;
}

function collectPointRow(
  group: RowGroup,
  row: number,
  styleAt: number,
  draft: RowsDraft,
  origin: readonly [number, number],
  context: RowsPackContext,
): void {
  const geometry = geometryAt(group, row);
  if (!geometry || (geometry.reader.type !== 'Point' && geometry.reader.type !== 'MultiPoint')) {
    return;
  }
  const { reader, at } = geometry;
  const data = group.data;
  const source = context.spriteSourceOf(row);
  let kind: RowsKind;
  let style: number | null;
  if (source) {
    const sprite = context.slots.sprite(source, data.styles[row]);
    if (!sprite) return;
    kind = ROWS_KIND.sprite;
    style = context.rowsStyles.sprite(source, sprite, data.styles[row]);
  } else {
    kind = ROWS_KIND.point;
    style = context.rowsStyles.point(
      data.styles[row],
      rowType(data, row),
      context.slots.ruleColorOf(group, row, context.strings),
    );
  }
  // A shape that is not instanced makes the row a run drawn at once; it is not packed
  if (style === null) return;
  writeRowStyle(draft, styleAt, style, undefined);
  const coords = reader.coords;
  const stride = reader.dimensions;
  for (let v = reader.vertexStart(at); v < reader.vertexStart(at + 1); v++) {
    const index = draft.coord(coords[v * stride] - origin[0], coords[v * stride + 1] - origin[1]);
    draft.instance(kind, row, index, -1, -1, -1);
  }
}

function collectLineRow(
  group: RowGroup,
  row: number,
  styleAt: number,
  draft: RowsDraft,
  origin: readonly [number, number],
  context: RowsPackContext,
): void {
  const parts: number[] = [];
  const reader = linePartsOf(group, row, parts);
  if (!reader || parts.length === 0) return;
  const data = group.data;
  const ruleColor = context.slots.ruleColorOf(group, row, context.strings);
  const type = rowType(data, row);
  const style = context.rowsStyles.line(data.styles[row], type, ruleColor);
  writeRowStyle(draft, styleAt, style, rowCreatedZoom(group, row));
  const dashed = context.slots.line(data.styles[row], type, ruleColor).stroke.lineStyle !== 'solid';
  const coords = reader.coords;
  const stride = reader.dimensions;
  for (let k = 0; k < parts.length; k += 2) {
    const start = parts[k];
    const end = parts[k + 1];
    const base = draft.coordCount;
    for (let v = start; v < end; v++) {
      draft.coord(coords[v * stride] - origin[0], coords[v * stride + 1] - origin[1]);
    }
    const n = end - start;
    // The length of the part before each segment, as the dashes measure it (zoom 0)
    let before = 0;
    for (let s = 0; s < n - 1; s++) {
      draft.instance(
        ROWS_KIND.segment,
        row,
        s > 0 ? base + s - 1 : -1,
        base + s,
        base + s + 1,
        s + 2 < n ? base + s + 2 : -1,
        dashed ? before : 0,
      );
      if (dashed) {
        const a = (start + s) * stride;
        const b = (start + s + 1) * stride;
        before += dashSegmentLength(coords[a], coords[a + 1], coords[b], coords[b + 1], 0);
      }
    }
  }
}

function collectPolygonRow(
  group: RowGroup,
  row: number,
  styleAt: number,
  draft: RowsDraft,
  origin: readonly [number, number],
  context: RowsPackContext,
): void {
  const plan = planPolygonRow(group, row, context);
  if (!plan) return;
  const { slot, triangles } = plan;
  const data = group.data;
  const style = context.rowsStyles.polygon(
    data.styles[row],
    rowType(data, row),
    context.slots.ruleColorOf(group, row, context.strings),
  );
  writeRowStyle(draft, styleAt, style, plan.createdZoom);
  const solidOutline = slot.hasStroke && !slot.dashedStroke;
  const dashedOutline = slot.hasStroke && slot.dashedStroke;
  for (const part of plan.parts) {
    const fill = part.triangleTo > part.triangleFrom && slot.fillColor[3] > 0;
    if (!fill && !slot.hasStroke) continue;
    // The coordinates of the rings of the polygon, read by its fill and its outline alike
    const base = draft.coordCount;
    const { coords, stride, runs } = part;
    for (let k = 0; k < runs.length; k += 2) {
      for (let c = runs[k]; c < runs[k + 1]; c++) {
        draft.coord(coords[c * stride] - origin[0], coords[c * stride + 1] - origin[1]);
      }
    }
    // 1. The fill, in pairs of triangles
    if (fill) {
      pairTriangles(triangles, part.triangleFrom, part.triangleTo, part.base, (a, b, c, d) => {
        draft.instance(ROWS_KIND.fill, row, base + a, base + b, base + c, base + d);
      });
    }
    // 2. The outline: the edges of every ring
    if (solidOutline || dashedOutline) {
      let ringBase = base;
      for (let k = 0; k < runs.length; k += 2) {
        const count = runs[k + 1] - runs[k];
        const at = (j: number) => ringBase + (((j % count) + count) % count);
        let before = 0;
        for (let j = 0; j < count; j++) {
          if (solidOutline) {
            draft.instance(ROWS_KIND.outline, row, at(j - 1), at(j), at(j + 1), at(j + 2));
            continue;
          }
          // A dashed ring is a line from its first coordinate around back to it, with a round
          // end at both ends of it, as the dashes of a ring are cut
          draft.instance(
            ROWS_KIND.dashedOutline,
            row,
            j > 0 ? at(j - 1) : -1,
            at(j),
            at(j + 1),
            j + 1 < count ? at(j + 2) : -1,
            before,
          );
          const a = (runs[k] + j) * stride;
          const b = (runs[k] + ((j + 1) % count)) * stride;
          before += dashSegmentLength(coords[a], coords[a + 1], coords[b], coords[b + 1], 0);
        }
        ringBase += count;
      }
    }
  }
}

/**
 * Pairs the triangles of a polygon that share an edge, for the fill drawn in strips of 4
 * vertices: a pair `(a, b, c, d)` is the triangles `(a, b, c)` and `(c, b, d)`, which share the
 * edge `b, c` and keep the winding of the triangles they were; a triangle without a partner is
 * `(a, b, c, c)` (the second triangle has no area). The triangles of a polygon do not overlap and
 * have one color, so how they are paired changes no pixel.
 *
 * @param triangles The indices of the triangles, 3 per triangle
 * @param from The first index of the triangles of the polygon
 * @param to The end of its indices
 * @param base What the indices of the polygon are counted from (subtracted from them)
 * @param emit Receives each pair (or triangle) as indices counted from `base`
 * @internal
 */
export function pairTriangles(
  triangles: ArrayLike<number>,
  from: number,
  to: number,
  base: number,
  emit: (a: number, b: number, c: number, d: number) => void,
): void {
  const count = (to - from) / 3;
  if (count <= 0) return;
  // The triangle of each directed edge, by its two ends
  const edges = new Map<number, number>();
  let span = 1;
  for (let t = from; t < to; t++) span = Math.max(span, triangles[t] - base + 1);
  const key = (u: number, v: number) => u * span + v;
  for (let t = 0; t < count; t++) {
    const at = from + t * 3;
    const a = triangles[at] - base;
    const b = triangles[at + 1] - base;
    const c = triangles[at + 2] - base;
    edges.set(key(a, b), t);
    edges.set(key(b, c), t);
    edges.set(key(c, a), t);
  }
  const used = new Uint8Array(count);
  for (let t = 0; t < count; t++) {
    if (used[t]) continue;
    used[t] = 1;
    const at = from + t * 3;
    const v = [triangles[at] - base, triangles[at + 1] - base, triangles[at + 2] - base];
    let paired = false;
    // An edge `p, q` of this triangle is shared with the triangle that has `q, p`
    for (let e = 0; e < 3 && !paired; e++) {
      const p = v[e];
      const q = v[(e + 1) % 3];
      const other = edges.get(key(q, p));
      if (other === undefined || used[other]) continue;
      const o = from + other * 3;
      const w = [triangles[o] - base, triangles[o + 1] - base, triangles[o + 2] - base];
      // The corner of the other triangle off the shared edge
      let d = -1;
      for (const x of w) if (x !== p && x !== q) d = x;
      if (d < 0) continue;
      used[other] = 1;
      paired = true;
      // This triangle as (r, p, q): the shared edge is p -> q, its third corner r
      const r = v[(e + 2) % 3];
      emit(r, p, q, d);
    }
    if (!paired) emit(v[0], v[1], v[2], v[2]);
  }
}
