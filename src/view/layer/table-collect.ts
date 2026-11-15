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
 *
 * On the terrain and on the globe the rows packed for the drawing in one draw are cut for the
 * surface (`RowsSurface`): the fill of a polygon is cut on the mesh of the surface, its outline
 * on the same step, and the segments of a line into pieces of equal length no longer than the
 * piece of the surface, each piece an instance holding its part `[t0, t1]` of the segment (the
 * coordinates stay those of the line).
 */

import type { PageDictionary, RowGroup, ShapeFormReader, StyleTable } from '@sakuzu/kasane/render';
import { geometryAt, pageRowBox, type RowGeometryAt } from '@sakuzu/kasane/render';
import type { ValueStringCache } from '@sakuzu/tabane';
import {
  rowHasGeometry,
  rowNumber,
  rowTriangles,
  rowType,
  rowValue,
} from '../../feature-table/row-read.js';
import { generateCirclePolygon } from '../../geometry/circle.js';
import { drawPropertyKey } from '../../shared/properties.js';
import type { Feature, FeatureStyle, FeatureType, StyleRule } from '../../shared/types/model.js';
import type { Color } from '../../shared/types/style.js';
import type { PixelRatioInput } from '../../shared/utils/pixel-ratio.js';
import { resolveContentPixelRatio, resolvePixelRatio } from '../../shared/utils/pixel-ratio.js';
import { STYLE_COLUMN } from '../../table/feature-row-columns.js';
import { polygonRingRuns } from '../../table/polygon-rings.js';
import { pairTriangles } from '../../table/row-geometry.js';
import { tessellateSurfaceFill } from '../globe-subdivision.js';
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
import { pointAngleSteps, pointMarkerCode } from '../renderers/point/point-sdf.js';
import {
  ROW_POLYGON_STRIDE,
  writePolygonFillVertex,
  writePolygonStrokeVertex,
} from '../renderers/polygon/sdf-polygon.js';
import type { RetainedStyleResolver } from '../renderers/retained.js';
import {
  ROWS_DASH,
  ROWS_EDGE_FRINGE,
  ROWS_EDGE_INSIDE_LEFT,
  ROWS_INSTANCE_FLOATS,
  ROWS_KIND,
  ROWS_PAIR_EDGE_BITS,
  ROWS_PAIR_EDGES,
  ROWS_ROW_STYLE_FLOATS,
  ROWS_STYLE_FLOATS,
  type RowSprite,
  type RowSpriteSource,
  type RowsChunkData,
  type RowsKind,
  type RowsPalette,
  writeCollapsedInstance,
  writeRowsInstance,
} from '../renderers/rows/rows-format.js';
import { applyRuleColor, evaluateStyleRuleValue, type StyleRuleChannel } from '../style-rule.js';
import { anchorElevationMeters } from '../terrain/anchor.js';
import type { TerrainContext } from '../terrain/context.js';
import { polygonTessellationStep, ringsIntersect, tessellateRings } from '../terrain/polygon.js';
import {
  crossingParameters,
  type MercatorRect,
  mercatorX,
  mercatorY,
  type TessellationStep,
} from '../terrain/tessellation.js';
import { tilingSignature } from '../terrain/tiling.js';

/** The box of a row read for its key of the cut (`pageRowBox`) */
const ROW_BOX = new Float64Array(4);

/** The places of the columns of a feature, read once rather than through the import at every row */
const STYLE = STYLE_COLUMN;

/** The key of the created zoom in the attributes of a row */
const CREATED_ZOOM_KEY = drawPropertyKey('createdZoom');
/** The key of the radius of a Circle in the attributes of a row */
const RADIUS_KEY = drawPropertyKey('radiusMeters');
/**
 * The key of the rotation in the attributes of a row (the markers of a point row turn by it)
 *
 * @internal
 */
export const ROTATION_KEY = drawPropertyKey('rotation');

/**
 * The rotation of the markers of a point row as they are drawn (`pointAngleSteps`): 0 for a row
 * without one, whose markers stay upright on screen
 *
 * @internal
 */
export function rowAngleSteps(group: RowGroup, row: number): number {
  // A value that is no number is read only for a row without a number (pointAngleSteps)
  return pointAngleSteps(rowNumber(group, row, ROTATION_KEY) ?? rowValue(group, row, ROTATION_KEY));
}

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
  /** What is resolved of each number of style, for the epoch of the number it was resolved for */
  private readonly byStyle = new Map<number, StyleSlots>();
  /** The rule color of each value of the attribute the rule reads */
  private readonly ruleColors = new Map<unknown, string>();

  /**
   * @param resolver The resolution of the styles of the features
   * @param styles The table of the styles of the rows
   * @param rule The style rule of the layer (none when undefined)
   */
  constructor(
    readonly resolver: RetainedStyleResolver,
    private readonly styles: StyleTable<FeatureStyle>,
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
    const slots = this.slotsOf(style).points;
    const key = slotKey(type, ruleColor);
    let slot = slots.get(key);
    if (!slot) {
      const resolved = this.resolver.getPointStyle(this.probe(style, type, ruleColor, 'point'));
      slot = { shape: toInstancedPointShape(resolved.shape), packed: toPackedPointStyle(resolved) };
      slots.set(key, slot);
    }
    return slot;
  }

  line(style: number, type: FeatureType, ruleColor: string | null): LineSlot {
    const slots = this.slotsOf(style).lines;
    const key = slotKey(type, ruleColor);
    let slot = slots.get(key);
    if (!slot) {
      const stroke = this.resolver.getLineStringStrokeStyle(
        this.probe(style, type, ruleColor, 'stroke'),
      );
      slot = { stroke, color: toLineInstanceColor(stroke.color, stroke.opacity) };
      slots.set(key, slot);
    }
    return slot;
  }

  polygon(style: number, type: FeatureType, ruleColor: string | null): PolygonSlot {
    const slots = this.slotsOf(style).polygons;
    const key = slotKey(type, ruleColor);
    let slot = slots.get(key);
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
      slots.set(key, slot);
    }
    return slot;
  }

  /**
   * The picture a source of pictures gives the points of a style (null for points it draws at
   * once), asked once per source, revision and style
   */
  sprite(source: RowSpriteSource, style: number): RowSprite | null {
    const sprites = this.slotsOf(style).sprites;
    let known = sprites.get(source);
    if (!known || known.revision !== source.revision) {
      known = { revision: source.revision, sprite: source.sprite(this.styles.get(style)) ?? null };
      sprites.set(source, known);
    }
    return known.sprite;
  }

  /**
   * What is resolved of a number of style: made again when the table of styles gave the number
   * to another style since (its epoch changed), so a number given again is never read with the
   * resolution of the style it had
   */
  private slotsOf(style: number): StyleSlots {
    const epoch = this.styles.epochOf(style);
    let slots = this.byStyle.get(style);
    if (!slots || slots.epoch !== epoch) {
      slots = {
        epoch,
        points: new Map(),
        lines: new Map(),
        polygons: new Map(),
        sprites: new Map(),
      };
      this.byStyle.set(style, slots);
    }
    return slots;
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

/** What is resolved of one number of style, by type of feature and rule color */
interface StyleSlots {
  /** The epoch of the number it was resolved for (`StyleTable.epochOf`) */
  readonly epoch: number;
  readonly points: Map<string, PointSlot>;
  readonly lines: Map<string, LineSlot>;
  readonly polygons: Map<string, PolygonSlot>;
  readonly sprites: Map<RowSpriteSource, { revision: number; sprite: RowSprite | null }>;
}

/** The key of a type of feature and a rule color */
function slotKey(type: FeatureType, ruleColor: string | null): string {
  return `${type}\u0000${ruleColor ?? NO_RULE_COLOR}`;
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
 * How the rows packed for the drawing in one draw are cut for the surface they are drawn on (the
 * terrain, the globe). Every row packed with one surface is cut alike, so the fills of rows next
 * to each other lie on one mesh
 *
 * @internal
 */
export interface RowsSurface {
  /** The step the fills and their outlines are cut on, its coarsening included (null: none) */
  readonly fill: TessellationStep | null;
  /** The longest piece of a segment of a line, in Mercator units (0: the segments are whole) */
  readonly linePiece: number;
  /**
   * Whether the triangles of the fills are turned to face the camera on their front (the
   * terrain discards the back faces of the fills)
   */
  readonly orient: boolean;
  /**
   * Whether the polygons and the lines read the ground seen at each pixel (the drape band of
   * the terrain): they are packed whole, their pairs of triangles knowing which of their edges
   * are on the outline and their outlines which side is inside, with the edges that draw the
   * soft edge of a fill whose outline does not
   */
  readonly ground?: boolean;
}

/**
 * The surface of the polygons and the lines that read the ground seen at each pixel
 *
 * @internal
 */
export const GROUND_SURFACE: RowsSurface = {
  fill: null,
  linePiece: 0,
  orient: false,
  ground: true,
};

/**
 * The room a line or a polygon row packed for a surface that cuts it leaves after its instances
 * and its coordinates, as a share of them: the cut of a row follows its position (the mesh lines
 * a polygon crosses, the pieces of a line), so a row moved or cut again for a step close to the
 * one it was packed for still fits its place, and is written there rather than drawn from the
 * delta of its layer. A first value, to be set from measured data
 *
 * @internal
 */
export const SURFACE_ROOM = 0.25;

/**
 * The most pieces one segment of a line is cut into (a guard against a runaway: a segment longer
 * than this many pieces is cut into pieces longer than the piece of the surface)
 *
 * @internal
 */
export const MAX_SEGMENT_PIECES = 1024;

/**
 * The fingerprint of how a row is cut for a surface: two packings of a row with the same
 * fingerprint cut it alike, so a row whose fingerprint did not change keeps its packing when the
 * surface changes. For a polygon, the step of its fill and the configuration of the tiles of the
 * terrain covering its extent (`tilingSignature`); for a line, the piece; for any other row,
 * nothing
 *
 * @returns A 32-bit hash of the fingerprint (0 for a row the surface does not cut)
 * @internal
 */
export function rowSurfaceKey(group: RowGroup, row: number, surface: RowsSurface | null): number {
  if (!surface) return 0;
  switch (rowType(group.data, row)) {
    case 'LineString':
    case 'Freehand':
    case 'MultiLineString':
      return surface.linePiece > 0 ? hashString(`l${surface.linePiece}`) : 0;
    case 'Polygon':
    case 'MultiPolygon':
    case 'Circle': {
      // Packed whole, with what the reading of the ground needs
      if (surface.ground) return GROUND_KEY;
      const step = surface.fill;
      if (!step) return 0;
      const b = ROW_BOX;
      if (!pageRowBox(group.data, row, b)) return 0;
      // Mercator y decreases as the latitude increases
      const x0 = mercatorX(b[0]);
      const y0 = mercatorY(b[3]);
      const x1 = mercatorX(b[2]);
      const y1 = mercatorY(b[1]);
      let key = tilingSignature(
        step.tiling ?? null,
        step.region ?? null,
        step.coarsen && step.coarsen > 1 ? step.coarsen : 1,
        step.grid,
        x0,
        y0,
        x1,
        y1,
      );
      // Without the index of the tiles, the region still decides what is cut
      if (!step.tiling && step.region) key += `|${regionRelation(step.region, x0, y0, x1, y1)}`;
      return hashString(`f${key}`);
    }
    default:
      return 0;
  }
}

/** The fingerprint of a polygon packed for the ground seen at each pixel */
const GROUND_KEY = hashString('ground');

/** How an extent lies to a region: inside it, outside it, or across its edge (with the edge) */
function regionRelation(
  region: MercatorRect,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): string {
  if (x0 >= region.x0 && x1 <= region.x1 && y0 >= region.y0 && y1 <= region.y1) return 'i';
  if (x1 < region.x0 || x0 > region.x1 || y1 < region.y0 || y0 > region.y1) return 'o';
  return `${region.x0},${region.y0},${region.x1},${region.y1}`;
}

/** The 32-bit FNV-1a hash of a string (never 0, which a row the surface does not cut has) */
function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash === 0 ? 1 : hash;
}

/**
 * The number of pieces of equal length a segment is cut into for a piece of the surface
 *
 * @param piece The longest piece, in Mercator units (0: the segment is whole)
 * @internal
 */
export function segmentPieces(
  lng0: number,
  lat0: number,
  lng1: number,
  lat1: number,
  piece: number,
): number {
  if (!(piece > 0)) return 1;
  const length = Math.hypot(mercatorX(lng1) - mercatorX(lng0), mercatorY(lat1) - mercatorY(lat0));
  if (!(length > piece)) return 1;
  return Math.min(MAX_SEGMENT_PIECES, Math.ceil(length / piece));
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
    (data.wholes[STYLE] as PageDictionary).indexes[row],
    rowType(data, row),
    context.slots.ruleColorOf(group, row, context.strings),
  );
  // A shape that is not instanced makes the row a run drawn at once; it is not packed
  const shape = slot.shape;
  if (!shape) return 0;
  const code = pointMarkerCode(pointShapeCode(shape), rowAngleSteps(group, row));
  const dpr = resolvePixelRatio(context.pixelRatio);
  const first = reader.vertexStart(at);
  const end = reader.vertexStart(at + 1);
  const coords = reader.coords;
  const stride = reader.stride;
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
): ShapeFormReader | undefined {
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
    (data.wholes[STYLE] as PageDictionary).indexes[row],
    rowType(data, row),
    context.slots.ruleColorOf(group, row, context.strings),
  );
  const createdZoom = rowCreatedZoom(group, row);
  // A fixed width is declared by the negative convention (as in `collectLineItems`)
  const width = createdZoom === undefined ? -slot.stroke.width : slot.stroke.width;
  const screenDpr = resolvePixelRatio(context.pixelRatio);
  const contentDpr = resolveContentPixelRatio(context.pixelRatio);
  const coords = reader.coords;
  const stride = reader.stride;
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
  /** The pairs of triangles of the fill: indices `[from, to)` of the indices of the row */
  readonly triangleFrom: number;
  readonly triangleTo: number;
  /** The number of triangles of the pairs (a lone triangle is a pair of one) */
  readonly triangleCount: number;
  /** The first vertex of the fill of this polygon among the vertices of the fill of the row */
  readonly base: number;
  /**
   * The coordinate of `coords` the row starts at: the coordinates of a part are told by their
   * place from it (the ones of the ring of a Circle by their place in the ring)
   */
  readonly first: number;
}

/**
 * The plan of a polygon row: its polygons, its style, and what it adds to a batch
 *
 * @internal
 */
export interface PolygonRowPlan {
  readonly parts: readonly PolygonPart[];
  readonly slot: PolygonSlot;
  /**
   * The indices of the pairs of triangles of the row (into the vertices of its fill; 4 per pair,
   * `FILL_TRIANGLES`)
   */
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
  // The first coordinate of the row (the ring of a Circle starts at 0)
  let first = 0;
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
    first = reader.vertexStart(at);
    polygons.push({
      coords: reader.coords,
      stride: reader.stride,
      rings: o[1],
      from: o[0][at],
      to: o[0][at + 1],
    });
  } else if (reader.type === 'MultiPolygon') {
    const o = reader.offsets;
    first = reader.vertexStart(at);
    for (let p = o[0][at]; p < o[0][at + 1]; p++) {
      polygons.push({
        coords: reader.coords,
        stride: reader.stride,
        rings: o[2],
        from: o[1][p],
        to: o[1][p + 1],
      });
    }
  } else {
    return null;
  }

  const slot = context.slots.polygon(
    (data.wholes[STYLE] as PageDictionary).indexes[row],
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
    // The pairs of this polygon are the ones that point into its vertices
    const triangleFrom = t;
    let triangleCount = 0;
    while (t < triangles.length && triangles[t] < base + vertices) {
      triangleCount += triangles[t + 2] === triangles[t + 3] ? 1 : 2;
      t += 4;
    }
    const part: PolygonPart = {
      coords: polygon.coords,
      stride: polygon.stride,
      runs,
      vertices,
      triangleFrom,
      triangleTo: t,
      triangleCount,
      base,
      first,
    };
    parts.push(part);
    if (part.triangleTo > part.triangleFrom) {
      vertexCount += vertices;
      indexCount += part.triangleCount * 3;
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
      // Each pair is its two triangles (a lone triangle is one)
      for (let t = part.triangleFrom; t < part.triangleTo; t += 4) {
        const a = triangles[t] - part.base + n;
        const b = triangles[t + 1] - part.base + n;
        const c = triangles[t + 2] - part.base + n;
        const d = triangles[t + 3] - part.base + n;
        indices[i++] = a;
        indices[i++] = b;
        indices[i++] = c;
        if (d === c) continue;
        indices[i++] = c;
        indices[i++] = b;
        indices[i++] = d;
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
 * The layout of the instances of a row a resolved style gives: what the instances of a row
 * depend on besides its geometry (a row whose resolved style changes keeps its instances when
 * the layout of the new one is the same, and only its style is written)
 *
 * @internal
 */
export const ROWS_LAYOUT = {
  point: 1,
  line: 2,
  polygon: 3,
  sprite: 4,
  /** A line or an outline drawn dashed (its segments carry the length before them) */
  dashed: 8,
  /** A polygon whose fill is seen */
  fill: 16,
  /** A polygon with an outline */
  stroke: 32,
} as const;

/** What a resolved style was made from, to make its values again */
interface ResolvedEntry {
  /** The number of the style of the rows and its epoch */
  readonly style: number;
  readonly epoch: number;
  /** The key of the entry in the numbers of the style */
  readonly key: string;
  /** The layout of the instances it gives ({@link ROWS_LAYOUT}) */
  readonly layout: number;
  /** Writes its values into the scratch of the styles */
  readonly compute: () => void;
}

/**
 * The resolved styles of the rows of a layer as the values of a palette: each style, type of
 * feature and rule color (and each picture of a source of pictures) is resolved once and gets a
 * number, its values written once (`rows-format.ts`). The widths and sizes are in device pixels
 * of the pixel ratio given (`setPixelRatio` writes every value again with the same numbers).
 *
 * The rows that use each number are counted in the palette (`RowsDraft`), and a number no row
 * uses is taken back and given to the next style resolved, so changing the style of rows again
 * and again does not grow the palette. A number of the table of styles given to another style is
 * told by its epoch: the numbers resolved for the style it had are never read for the new one.
 *
 * @internal
 */
export class RowsStyles {
  /** The resolved numbers by number of style (for its epoch) and key */
  private readonly byStyle = new Map<number, { epoch: number; keys: Map<string, number> }>();
  /** What each resolved number was made from (null for a number taken back) */
  private readonly entries: Array<ResolvedEntry | null> = [];
  private readonly values = new Float32Array(ROWS_STYLE_FLOATS);
  private readonly sources = new Map<RowSpriteSource, number>();
  /** Device pixels per CSS px of the sizes fixed on screen */
  screenRatio: number;
  /** Device pixels per CSS px of the widths that follow the zoom */
  contentRatio: number;

  constructor(
    public slots: RowStyleSlots,
    readonly palette: RowsPalette,
    pixelRatio: PixelRatioInput | undefined,
    private readonly styles?: StyleTable<FeatureStyle>,
  ) {
    this.screenRatio = resolvePixelRatio(pixelRatio);
    this.contentRatio = resolveContentPixelRatio(pixelRatio);
    palette.onFree = (number) => this.forget(number);
  }

  /** The number of resolved styles held */
  get size(): number {
    return this.palette.size;
  }

  /** The layout of the instances a resolved style gives ({@link ROWS_LAYOUT}; 0 for none) */
  layoutOf(number: number): number {
    return this.entries[number]?.layout ?? 0;
  }

  /**
   * Writes every value again for another pixel ratio, with the same numbers (the chunks keep
   * their rows; the values reach the GPU with the next upload)
   *
   * @returns Whether the ratios changed
   */
  setPixelRatio(pixelRatio: PixelRatioInput | undefined): boolean {
    const screen = resolvePixelRatio(pixelRatio);
    const content = resolveContentPixelRatio(pixelRatio);
    if (screen === this.screenRatio && content === this.contentRatio) return false;
    this.screenRatio = screen;
    this.contentRatio = content;
    this.entries.forEach((entry, number) => {
      if (!entry) return;
      this.values.fill(0);
      entry.compute();
      this.palette.write(number, this.values);
    });
    return true;
  }

  /**
   * The number of the style of a point: its fill, its stroke, then its radius, its stroke width
   * and the code of its shape (null for a shape that is not instanced)
   */
  point(style: number, type: FeatureType, ruleColor: string | null): number | null {
    const key = `p${slotKey(type, ruleColor)}`;
    const known = this.known(style, key);
    if (known !== undefined) return known;
    const slots = this.slots;
    const slot = slots.point(style, type, ruleColor);
    if (!slot.shape) return null;
    const shape = slot.shape;
    return this.add(style, key, ROWS_LAYOUT.point, () => {
      const v = this.values;
      const packed = slot.packed;
      for (let i = 0; i < 8; i++) v[i] = packed[i];
      v[8] = packed[8] * this.screenRatio;
      v[9] = packed[9] * this.screenRatio;
      v[10] = pointShapeCode(shape);
    });
  }

  /**
   * The number of the style of a line: its color, then its width that follows the zoom, its
   * width fixed on screen (negative), its width in CSS px and its pattern
   */
  line(style: number, type: FeatureType, ruleColor: string | null): number {
    const key = `l${slotKey(type, ruleColor)}`;
    const known = this.known(style, key);
    if (known !== undefined) return known;
    const slot = this.slots.line(style, type, ruleColor);
    const dashed = slot.stroke.lineStyle !== 'solid';
    return this.add(style, key, ROWS_LAYOUT.line | (dashed ? ROWS_LAYOUT.dashed : 0), () => {
      const v = this.values;
      for (let i = 0; i < 4; i++) v[i] = slot.color[i];
      this.widths(v, 4, slot.stroke.width, slot.stroke.lineStyle);
    });
  }

  /**
   * The number of the style of a polygon: its fill, the color of its outline, the widths of its
   * outline (as a line's) and the color of a dashed outline
   */
  polygon(style: number, type: FeatureType, ruleColor: string | null): number {
    const key = `g${slotKey(type, ruleColor)}`;
    const known = this.known(style, key);
    if (known !== undefined) return known;
    const slot = this.slots.polygon(style, type, ruleColor);
    const layout =
      ROWS_LAYOUT.polygon |
      (slot.fillColor[3] > 0 ? ROWS_LAYOUT.fill : 0) |
      (slot.hasStroke ? ROWS_LAYOUT.stroke : 0) |
      (slot.hasStroke && slot.dashedStroke ? ROWS_LAYOUT.dashed : 0);
    return this.add(style, key, layout, () => {
      const v = this.values;
      for (let i = 0; i < 4; i++) {
        v[i] = slot.fillColor[i];
        v[4 + i] = slot.strokeColor[i];
        v[12 + i] = slot.dashedColor[i];
      }
      this.widths(v, 8, slot.strokeWidth, slot.dashedStroke ? slot.lineStyle : 'solid');
    });
  }

  /**
   * The number of the style of a picture: its rectangle in the texture, then its half size in
   * CSS px and its bearing
   */
  sprite(source: RowSpriteSource, sprite: RowSprite, style: number): number {
    const key = `s${this.sourceNumber(source)}\u0000${source.revision}`;
    const known = this.known(style, key);
    if (known !== undefined) return known;
    return this.add(style, key, ROWS_LAYOUT.sprite, () => {
      const v = this.values;
      for (let i = 0; i < 4; i++) v[i] = sprite.uv[i];
      v[4] = sprite.halfWidth;
      v[5] = sprite.halfHeight;
      v[6] = sprite.direction >= 0 ? sprite.direction : -1;
    });
  }

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

  /** The epoch of a number of style (0 without a table of styles) */
  private epochOf(style: number): number {
    return this.styles?.epochOf(style) ?? 0;
  }

  /** The resolved number of a style and a key, when it is held for the epoch of the style */
  private known(style: number, key: string): number | undefined {
    const held = this.byStyle.get(style);
    if (!held || held.epoch !== this.epochOf(style)) return undefined;
    return held.keys.get(key);
  }

  /** Resolves a new number: its values computed and added to the palette */
  private add(style: number, key: string, layout: number, compute: () => void): number {
    this.values.fill(0);
    compute();
    const number = this.palette.add(this.values);
    const epoch = this.epochOf(style);
    let held = this.byStyle.get(style);
    if (!held || held.epoch !== epoch) {
      held = { epoch, keys: new Map() };
      this.byStyle.set(style, held);
    }
    held.keys.set(key, number);
    this.entries[number] = { style, epoch, key, layout, compute };
    return number;
  }

  /** Forgets a number the palette took back (no row uses it any more) */
  private forget(number: number): void {
    const entry = this.entries[number];
    if (!entry) return;
    this.entries[number] = null;
    const held = this.byStyle.get(entry.style);
    if (held && held.epoch === entry.epoch && held.keys.get(entry.key) === number) {
      held.keys.delete(entry.key);
      if (held.keys.size === 0) this.byStyle.delete(entry.style);
    }
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
  /** How the rows are cut for the surface (none on a flat map) */
  readonly surface?: RowsSurface | null;
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
  /** The resolved style of each row (-1 for none), counted in the palette while it is held */
  readonly rowStyle: Int32Array;
  readonly rowFirst: Int32Array;
  readonly pointFirst: Int32Array;
  readonly coordFirst: Int32Array;
  /**
   * Whether a row a surface cuts leaves room after it (a chunk being built); a row packed to be
   * written into its place in a chunk leaves none (it takes the room its place has)
   */
  leavesRoom = true;

  /**
   * @param rows The rows of the chunk
   * @param rowBase The first row of the chunk in its group
   * @param coords The coordinates expected (the arrays grow past it)
   * @param palette The palette the resolved styles of the rows are counted in (none when null)
   */
  constructor(
    readonly rows: number,
    readonly rowBase: number,
    coords = 64,
    readonly palette: RowsPalette | null = null,
  ) {
    this.coords = new Float32Array(Math.max(coords, 4) * 2);
    this.instances = new Float32Array(Math.max(coords, 4) * 2 * ROWS_INSTANCE_FLOATS);
    this.points = new Float32Array(4 * ROWS_INSTANCE_FLOATS);
    this.rowStyles = new Float32Array(Math.max(rows, 1) * ROWS_ROW_STYLE_FLOATS);
    this.rowStyle = new Int32Array(rows).fill(-1);
    this.rowFirst = new Int32Array(rows + 1);
    this.pointFirst = new Int32Array(rows + 1);
    this.coordFirst = new Int32Array(rows + 1);
  }

  /** Sets the resolved style of a row, counted in the palette (the one it had is not counted) */
  setRowStyle(i: number, style: number): void {
    const old = this.rowStyle[i];
    if (old === style) return;
    if (style >= 0) this.palette?.retain(style);
    if (old >= 0) this.palette?.release(old);
    this.rowStyle[i] = style;
  }

  /** Stops counting the resolved styles of the rows (a draft dropped without its chunk) */
  releaseStyles(): void {
    if (this.palette) this.palette.releaseAll(this.rowStyle);
    this.rowStyle.fill(-1);
  }

  /**
   * Adds a coordinate (an offset from the origin) and returns its number
   *
   * @param _source The place of the coordinate among the coordinates of its row, from its first
   *   (the ring of a Circle from the first of the ring); -1 for none
   */
  coord(x: number, y: number, _source = -1): number {
    const at = this.coordCount * 2;
    if (at + 2 > this.coords.length) this.coords = grown(this.coords, at + 2);
    this.coords[at] = x;
    this.coords[at + 1] = y;
    return this.coordCount++;
  }

  /**
   * Adds an instance (and to the instances of the points, for a point or a picture)
   *
   * @param t0 The start of the piece of a segment it draws (0: its start)
   * @param t1 The end of the piece (1: its end)
   */
  instance(
    kind: RowsKind,
    row: number,
    i0: number,
    i1: number,
    i2: number,
    i3: number,
    extra = 0,
    t0 = 0,
    t1 = 1,
  ): void {
    if ((this.instanceCount + 1) * ROWS_INSTANCE_FLOATS > this.instances.length) {
      this.instances = grown(this.instances, (this.instanceCount + 1) * ROWS_INSTANCE_FLOATS);
    }
    writeRowsInstance(
      this.instances,
      this.instanceCount++,
      kind,
      row,
      i0,
      i1,
      i2,
      i3,
      extra,
      t0,
      t1,
    );
    if (kind === ROWS_KIND.point || kind === ROWS_KIND.sprite) {
      if ((this.pointCount + 1) * ROWS_INSTANCE_FLOATS > this.points.length) {
        this.points = grown(this.points, (this.pointCount + 1) * ROWS_INSTANCE_FLOATS);
      }
      writeRowsInstance(this.points, this.pointCount++, kind, row, i0, i1, i2, i3, extra);
    }
  }

  /**
   * Leaves room after the instances and the coordinates of a row: instances that draw nothing
   * (`writeCollapsedInstance`) and copies of its last coordinate, which a write in place of the
   * row may take
   */
  room(row: number, first: number, coordFirst: number, share: number): void {
    const instances = Math.ceil((this.instanceCount - first) * share);
    const coords = Math.ceil((this.coordCount - coordFirst) * share);
    if (instances === 0 || this.coordCount === coordFirst) return;
    const last = this.coordCount - 1;
    const x = this.coords[last * 2];
    const y = this.coords[last * 2 + 1];
    for (let c = 0; c < coords; c++) this.coord(x, y);
    for (let i = 0; i < instances; i++) {
      if ((this.instanceCount + 1) * ROWS_INSTANCE_FLOATS > this.instances.length) {
        this.instances = grown(this.instances, (this.instanceCount + 1) * ROWS_INSTANCE_FLOATS);
      }
      writeCollapsedInstance(this.instances, this.instanceCount++, row, last);
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
      rowStyle: this.rowStyle,
      rowFirst: this.rowFirst,
      pointFirst: this.pointFirst,
      coordFirst: this.coordFirst,
      palette,
      sprites,
    };
  }
}

/**
 * Packs the coordinates of one row and hands on the ones of a range of its coordinates: what a
 * write of the positions of a row that keeps its shape writes (the coordinates are numbered as
 * the packing of the row numbers them, from its first)
 *
 * @internal
 */
export class RowCoordsDraft extends RowsDraft {
  /**
   * @param from The first coordinate of the row handed on (counted as `coord` counts it)
   * @param to The end of the coordinates handed on
   * @param emit Receives the number of each coordinate in the packing of the row and its values
   */
  constructor(
    private readonly from: number,
    private readonly to: number,
    private readonly emit: (coord: number, x: number, y: number) => void,
  ) {
    super(1, 0, 4, null);
  }

  override coord(x: number, y: number, source = -1): number {
    const number = this.coordCount++;
    if (source >= this.from && source < this.to) this.emit(number, x, y);
    return number;
  }

  override instance(): void {}

  override setRowStyle(): void {}
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
  draft.setRowStyle(i, -1);
  const first = draft.instanceCount;
  const coordFirst = draft.coordCount;
  // A row a surface cuts leaves room for its cut to change
  const surface = context.surface;
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
        if (surface && surface.linePiece > 0 && draft.leavesRoom) {
          draft.room(row, first, coordFirst, SURFACE_ROOM);
        }
        break;
      case 'Polygon':
      case 'MultiPolygon':
      case 'Circle':
        collectPolygonRow(group, row, styleAt, draft, origin, context);
        if (surface?.fill && draft.leavesRoom) draft.room(row, first, coordFirst, SURFACE_ROOM);
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
  draft.setRowStyle(at / ROWS_ROW_STYLE_FLOATS, style);
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
  const resolved = pointStyleOf(group, row, context);
  // A shape that is not instanced makes the row a run drawn at once; it is not packed
  if (!resolved) return;
  const { kind, style } = resolved;
  writeRowStyle(draft, styleAt, style, undefined);
  // The markers turn by the rotation of the row (a picture of an extension does not read it)
  if (kind === ROWS_KIND.point) draft.rowStyles[styleAt + 3] = rowAngleSteps(group, row);
  const coords = reader.coords;
  const stride = reader.stride;
  const first = reader.vertexStart(at);
  for (let v = first; v < reader.vertexStart(at + 1); v++) {
    const index = draft.coord(
      coords[v * stride] - origin[0],
      coords[v * stride + 1] - origin[1],
      v - first,
    );
    draft.instance(kind, row, index, -1, -1, -1);
  }
}

/**
 * The kind of the instances of a point row and its resolved style: a picture of the source of
 * pictures of the row, or the built-in point (null for a row that is not packed: a picture the
 * source does not give, a shape that is not instanced)
 */
function pointStyleOf(
  group: RowGroup,
  row: number,
  context: RowsPackContext,
): { kind: RowsKind; style: number } | null {
  const data = group.data;
  const source = context.spriteSourceOf(row);
  if (source) {
    const sprite = context.slots.sprite(
      source,
      (data.wholes[STYLE] as PageDictionary).indexes[row],
    );
    if (!sprite) return null;
    return {
      kind: ROWS_KIND.sprite,
      style: context.rowsStyles.sprite(
        source,
        sprite,
        (data.wholes[STYLE] as PageDictionary).indexes[row],
      ),
    };
  }
  const style = context.rowsStyles.point(
    (data.wholes[STYLE] as PageDictionary).indexes[row],
    rowType(data, row),
    context.slots.ruleColorOf(group, row, context.strings),
  );
  return style === null ? null : { kind: ROWS_KIND.point, style };
}

/**
 * The resolved style a row is packed with (-1 for a row packed without one: no geometry, a
 * polygon with neither a fill seen nor an outline, a point not packed), as `collectRow` resolves
 * it: what tells whether a change of the style of a row only changes its style
 *
 * @internal
 */
export function resolveRowStyle(group: RowGroup, row: number, context: RowsPackContext): number {
  if (!rowHasGeometry(group, row)) return -1;
  const data = group.data;
  const type = rowType(data, row);
  const ruleColor = (): string | null => context.slots.ruleColorOf(group, row, context.strings);
  switch (type) {
    case 'LineString':
    case 'Freehand':
    case 'MultiLineString':
      return context.rowsStyles.line(
        (data.wholes[STYLE] as PageDictionary).indexes[row],
        type,
        ruleColor(),
      );
    case 'Polygon':
    case 'MultiPolygon':
    case 'Circle': {
      const color = ruleColor();
      const slot = context.slots.polygon(
        (data.wholes[STYLE] as PageDictionary).indexes[row],
        type,
        color,
      );
      if (!slot.hasStroke && slot.fillColor[3] <= 0) return -1;
      return context.rowsStyles.polygon(
        (data.wholes[STYLE] as PageDictionary).indexes[row],
        type,
        color,
      );
    }
    default: {
      const reader = geometryAt(group, row)?.reader;
      if (reader?.type !== 'Point' && reader?.type !== 'MultiPoint') return -1;
      if (type !== 'Point' && type !== 'MultiPoint' && !context.spriteSourceOf(row)) return -1;
      return pointStyleOf(group, row, context)?.style ?? -1;
    }
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
  const rowFirst = reader.vertexStart((geometryAt(group, row) as RowGeometryAt).at);
  const data = group.data;
  const ruleColor = context.slots.ruleColorOf(group, row, context.strings);
  const type = rowType(data, row);
  const style = context.rowsStyles.line(
    (data.wholes[STYLE] as PageDictionary).indexes[row],
    type,
    ruleColor,
  );
  writeRowStyle(draft, styleAt, style, rowCreatedZoom(group, row));
  const dashed =
    context.slots.line((data.wholes[STYLE] as PageDictionary).indexes[row], type, ruleColor).stroke
      .lineStyle !== 'solid';
  const piece = context.surface?.linePiece ?? 0;
  const coords = reader.coords;
  const stride = reader.stride;
  for (let k = 0; k < parts.length; k += 2) {
    const start = parts[k];
    const end = parts[k + 1];
    const base = draft.coordCount;
    for (let v = start; v < end; v++) {
      draft.coord(coords[v * stride] - origin[0], coords[v * stride + 1] - origin[1], v - rowFirst);
    }
    const n = end - start;
    // The length of the part before each segment, as the dashes measure it (zoom 0)
    let before = 0;
    for (let s = 0; s < n - 1; s++) {
      const a = (start + s) * stride;
      const b = (start + s + 1) * stride;
      // A segment cut for the surface is drawn in pieces of equal length, in their order
      const pieces = segmentPieces(coords[a], coords[a + 1], coords[b], coords[b + 1], piece);
      for (let p = 0; p < pieces; p++) {
        draft.instance(
          ROWS_KIND.segment,
          row,
          s > 0 ? base + s - 1 : -1,
          base + s,
          base + s + 1,
          s + 2 < n ? base + s + 2 : -1,
          dashed ? before : 0,
          p / pieces,
          (p + 1) / pieces,
        );
      }
      if (dashed) {
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
    (data.wholes[STYLE] as PageDictionary).indexes[row],
    rowType(data, row),
    context.slots.ruleColorOf(group, row, context.strings),
  );
  writeRowStyle(draft, styleAt, style, plan.createdZoom);
  const surface = context.surface;
  if (surface?.fill) {
    collectSurfacePolygonRow(plan, row, draft, origin, context, surface, surface.fill);
    return;
  }
  const solidOutline = slot.hasStroke && !slot.dashedStroke;
  const dashedOutline = slot.hasStroke && slot.dashedStroke;
  // Read on the ground: the pairs know their edges on the outline, the outlines the side of the
  // inside, and the soft edge of the fill is drawn by its outline or by edges of its own
  const ground = surface?.ground === true;
  for (const part of plan.parts) {
    const fill = part.triangleTo > part.triangleFrom && slot.fillColor[3] > 0;
    if (!fill && !slot.hasStroke) continue;
    // The coordinates of the rings of the polygon, read by its fill and its outline alike
    const base = draft.coordCount;
    const { coords, stride, runs } = part;
    for (let k = 0; k < runs.length; k += 2) {
      for (let c = runs[k]; c < runs[k + 1]; c++) {
        draft.coord(
          coords[c * stride] - origin[0],
          coords[c * stride + 1] - origin[1],
          c - part.first,
        );
      }
    }
    const rings = ground ? groundRingsOf(coords, stride, runs) : null;
    // 1. The fill, in the pairs of triangles of its triangulation
    if (fill) {
      const shift = base - part.base;
      for (let t = part.triangleFrom; t < part.triangleTo; t += 4) {
        draft.instance(
          ROWS_KIND.fill,
          row,
          triangles[t] + shift,
          triangles[t + 1] + shift,
          triangles[t + 2] + shift,
          triangles[t + 3] + shift,
          rings
            ? pairEdges(
                rings,
                triangles[t] - part.base,
                triangles[t + 1] - part.base,
                triangles[t + 2] - part.base,
                triangles[t + 3] - part.base,
              )
            : 0,
        );
      }
    }
    // 2. The soft edge of the fill outside it, where the outline does not draw it
    if (rings && fill && !solidOutline) {
      let ringBase = base;
      for (let k = 0; k < runs.length; k += 2) {
        const count = runs[k + 1] - runs[k];
        const at = (j: number) => ringBase + (((j % count) + count) % count);
        const side = rings.insideLeft[k / 2] ? ROWS_EDGE_INSIDE_LEFT : 0;
        for (let j = 0; j < count; j++) {
          draft.instance(
            ROWS_KIND.fringe,
            row,
            at(j - 1),
            at(j),
            at(j + 1),
            at(j + 2),
            side | ROWS_EDGE_FRINGE,
          );
        }
        ringBase += count;
      }
    }
    // 3. The outline: the edges of every ring
    if (solidOutline || dashedOutline) {
      let ringBase = base;
      for (let k = 0; k < runs.length; k += 2) {
        const count = runs[k + 1] - runs[k];
        const at = (j: number) => ringBase + (((j % count) + count) % count);
        let before = 0;
        // Read on the ground, a solid outline draws the soft edge of the fill too
        const flags = rings
          ? (rings.insideLeft[k / 2] ? ROWS_EDGE_INSIDE_LEFT : 0) | (fill ? ROWS_EDGE_FRINGE : 0)
          : 0;
        for (let j = 0; j < count; j++) {
          if (solidOutline) {
            draft.instance(ROWS_KIND.outline, row, at(j - 1), at(j), at(j + 1), at(j + 2), flags);
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
 * The rings of a polygon as its fill and its outline number their coordinates (one after the
 * other): where each starts, how many coordinates it has, and whether the inside of the polygon
 * is on the left of its edges (on the map with the north up: the outer ring counterclockwise,
 * a hole clockwise)
 */
interface GroundRings {
  readonly starts: number[];
  readonly counts: number[];
  readonly insideLeft: boolean[];
}

function groundRingsOf(
  coords: ArrayLike<number>,
  stride: number,
  runs: ArrayLike<number>,
): GroundRings {
  const starts: number[] = [];
  const counts: number[] = [];
  const insideLeft: boolean[] = [];
  let next = 0;
  for (let k = 0; k < runs.length; k += 2) {
    const from = runs[k] as number;
    const to = runs[k + 1] as number;
    starts.push(next);
    counts.push(to - from);
    next += to - from;
    // Twice the signed area of the ring (positive counterclockwise), from its first point
    let area = 0;
    const x0 = coords[from * stride] as number;
    const y0 = coords[from * stride + 1] as number;
    for (let c = from + 1; c + 1 < to; c++) {
      const ax = (coords[c * stride] as number) - x0;
      const ay = (coords[c * stride + 1] as number) - y0;
      const bx = (coords[(c + 1) * stride] as number) - x0;
      const by = (coords[(c + 1) * stride + 1] as number) - y0;
      area += ax * by - ay * bx;
    }
    // The outer ring holds the inside, a hole leaves it out
    insideLeft.push(k === 0 ? area > 0 : area < 0);
  }
  return { starts, counts, insideLeft };
}

/** Whether two coordinates of the rings are the ends of an edge of the outline */
function onOutline(rings: GroundRings, a: number, b: number): boolean {
  if (a === b) return false;
  for (let k = 0; k < rings.starts.length; k++) {
    const start = rings.starts[k] as number;
    const count = rings.counts[k] as number;
    if (a < start || a >= start + count) continue;
    if (b < start || b >= start + count) return false;
    const d = (((b - a) % count) + count) % count;
    return d === 1 || d === count - 1;
  }
  return false;
}

/** What a pair of triangles a b c and c b d knows of its edges on the outline */
function pairEdges(rings: GroundRings, a: number, b: number, c: number, d: number): number {
  const bits = ROWS_PAIR_EDGE_BITS;
  let edges = ROWS_PAIR_EDGES;
  if (onOutline(rings, a, b)) edges |= bits.ab;
  if (onOutline(rings, b, c)) edges |= bits.bc;
  if (onOutline(rings, c, a)) edges |= bits.ca;
  if (d !== c) {
    if (onOutline(rings, b, d)) edges |= bits.bd;
    if (onOutline(rings, d, c)) edges |= bits.dc;
  }
  return edges;
}

/**
 * Packs a polygon row cut for a surface: for each of its polygons, its fill cut on the step of
 * the surface (the triangles of its triangulation cut on the mesh, paired again), then its rings
 * cut on the step its fill was cut on, so the outline lies on the same mesh as the edge of the
 * fill. On the terrain the triangles are turned to face the camera on their front
 */
function collectSurfacePolygonRow(
  plan: PolygonRowPlan,
  row: number,
  draft: RowsDraft,
  origin: readonly [number, number],
  context: RowsPackContext,
  surface: RowsSurface,
  base: TessellationStep,
): void {
  const { slot, triangles } = plan;
  const solidOutline = slot.hasStroke && !slot.dashedStroke;
  const dashedOutline = slot.hasStroke && slot.dashedStroke;
  plan.parts.forEach((part, partIndex) => {
    const fill = part.triangleTo > part.triangleFrom && slot.fillColor[3] > 0;
    if (!fill && !slot.hasStroke) return;
    const { coords, stride, runs } = part;
    // The coordinates of the rings as the triangulation numbers them, and the rings
    const flat: number[] = [];
    const rings: Array<Array<[number, number]>> = [];
    for (let k = 0; k < runs.length; k += 2) {
      const ring: Array<[number, number]> = [];
      for (let c = runs[k]; c < runs[k + 1]; c++) {
        flat.push(coords[c * stride], coords[c * stride + 1]);
        ring.push([coords[c * stride], coords[c * stride + 1]]);
      }
      rings.push(ring);
    }
    let step: TessellationStep | null = null;
    // The coordinates of the rings as they are: the first ones of the cut of the fill (which
    // keeps them, in their order, before the points it adds)
    let ringCoords = -1;
    // 1. The fill: its triangles cut on the mesh, paired again
    if (fill) {
      const indices: number[] = [];
      for (let t = part.triangleFrom; t < part.triangleTo; t += 4) {
        const a = triangles[t] - part.base;
        const b = triangles[t + 1] - part.base;
        const c = triangles[t + 2] - part.base;
        const d = triangles[t + 3] - part.base;
        indices.push(a, b, c);
        if (d !== c) indices.push(c, b, d);
      }
      const cut = tessellateSurfaceFill(context.terrain, undefined, partIndex, flat, indices, base);
      step = cut.step;
      const first = draft.coordCount;
      ringCoords = first;
      const points = cut.flatCoords;
      for (let i = 0; i < points.length; i += 2) {
        draft.coord(points[i] - origin[0], points[i + 1] - origin[1], -1);
      }
      pairTriangles(cut.indices, 0, cut.indices.length, 0, (a, b, c, d) => {
        // The front of the pair faces the camera: a negative cross product on the Mercator plane
        // (y down), as the cut of the terrain turns its triangles (`pushOriented`)
        if (surface.orient && crossOnMercator(points, a, b, c) > 0) {
          draft.instance(ROWS_KIND.fill, row, first + a, first + c, first + b, first + d);
        } else {
          draft.instance(ROWS_KIND.fill, row, first + a, first + b, first + c, first + d);
        }
      });
    }
    // 2. The outline: the rings cut on the step of the fill (on the step of the polygon when it
    // has no fill), each ring its edges in order (a solid outline between the points of its cut,
    // as coordinates of their own)
    if (!solidOutline && !dashedOutline) return;
    const ringStep = step ?? polygonTessellationStep(base, flat);
    if (dashedOutline) {
      // A dashed outline: each edge of the rings drawn in its pieces between the points it is cut
      // at, as a segment of a line cut for the surface, so the dashes of an edge are drawn over
      // the whole edge whatever the length of its pieces
      if (ringCoords < 0) {
        ringCoords = draft.coordCount;
        for (let i = 0; i < flat.length; i += 2) {
          draft.coord(flat[i] - origin[0], flat[i + 1] - origin[1], -1);
        }
      }
      const cuts = ringEdgeCuts(rings, ringStep);
      let ringBase = ringCoords;
      rings.forEach((ring, r) => {
        const count = ring.length;
        const at = (j: number) => ringBase + (((j % count) + count) % count);
        let before = 0;
        for (let j = 0; j < count; j++) {
          const ts = cuts?.[r][j] ?? NO_CUTS;
          for (let k = 0; k <= ts.length; k++) {
            draft.instance(
              ROWS_KIND.dashedOutline,
              row,
              j > 0 ? at(j - 1) : -1,
              at(j),
              at(j + 1),
              j + 1 < count ? at(j + 2) : -1,
              before,
              k > 0 ? ts[k - 1] : 0,
              k < ts.length ? ts[k] : 1,
            );
          }
          const [lng0, lat0] = ring[j];
          const [lng1, lat1] = ring[(j + 1) % count];
          before += dashSegmentLength(lng0, lat0, lng1, lat1, 0);
        }
        ringBase += count;
      });
      return;
    }
    for (const ring of tessellateRings(rings, ringStep)) {
      const count = ring.length;
      if (count < 2) continue;
      const ringBase = draft.coordCount;
      for (const [lng, lat] of ring) draft.coord(lng - origin[0], lat - origin[1], -1);
      const at = (j: number) => ringBase + (((j % count) + count) % count);
      for (let j = 0; j < count; j++) {
        draft.instance(ROWS_KIND.outline, row, at(j - 1), at(j), at(j + 1), at(j + 2));
      }
    }
  });
}

/** An edge not cut */
const NO_CUTS: readonly number[] = [];

/**
 * Where each edge of the rings of a polygon is cut on a step, as {@link tessellateRings} cuts
 * them: the parameters along each edge (ascending, between 0 and 1) of the points it adds (null
 * when the rings are outside the region and are not cut)
 */
function ringEdgeCuts(
  rings: ReadonlyArray<ReadonlyArray<[number, number]>>,
  step: TessellationStep,
): number[][][] | null {
  if (!(step.grid > 0)) return null;
  if (step.region && !ringsIntersect(rings as Array<Array<[number, number]>>, step.region)) {
    return null;
  }
  const grid = step.coarsen && step.coarsen > 1 ? step.grid * step.coarsen : step.grid;
  return rings.map((ring) =>
    ring.map((a, j) => {
      const b = ring[(j + 1) % ring.length];
      const out: number[] = [];
      for (const t of crossingParameters(a, b, grid, step.region)) {
        if (t <= 0 || t >= 1 || t === out[out.length - 1]) continue;
        out.push(t);
      }
      return out;
    }),
  );
}

/** The cross product of the triangle of three points of a flat array, on the Mercator plane */
function crossOnMercator(points: readonly number[], a: number, b: number, c: number): number {
  const ax = mercatorX(points[a * 2]);
  const ay = mercatorY(points[a * 2 + 1]);
  const bx = mercatorX(points[b * 2]);
  const by = mercatorY(points[b * 2 + 1]);
  const cx = mercatorX(points[c * 2]);
  const cy = mercatorY(points[c * 2 + 1]);
  return (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
}
