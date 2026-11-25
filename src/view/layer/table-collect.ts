// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Packing the rows of a layer into the arrays of the chunks drawn in one draw (`RowsRenderer`)
 *
 * A row is packed from its columns as it is, with the values the feature of the row would get:
 * its style is resolved once per number of style, type of feature and color of the style rule of
 * its layer (`RowStyleSlots`), through the same resolver the features use, with a probe feature
 * that carries the style of the row and the color of the rule. The decisions are those the
 * features are drawn with (`renderers/batch-manager.ts` and the retained batches): a line is
 * drawn per part of two coordinates or more; a polygon per polygon, its fill then its outline,
 * with the rings `buildEarcutInput` keeps and the triangles earcut makes of them; a polygon with
 * neither a fill nor an outline draws nothing; a width without a created zoom is fixed on screen
 * (negative).
 *
 * What is packed of a row reads its geometry through one function (`rowGeometryOf`), so that the
 * shapes drawn are read in one place.
 *
 * On the terrain and on the globe a chunk is packed for the surface (`RowsSurface`), with the
 * formulas the renderers of the features use there: a fill is cut with the step of the surface,
 * coarsened for the chunk as for a batch of polygons (`surfaceFillStep`, `tessellateSurfaceFill`),
 * and its outline on the step its fill was cut with (`tessellateRings`); a point carries the
 * elevation of the ground under it, the one the hit testing projects it with
 * (`anchorElevationMeters`); the longest segment of the lines is kept, which the stations of the
 * segments are decided from when they are drawn. Each row keeps the fingerprint of what it was cut
 * with (`RowsDraft.keys`), so that a new surface packs again only the rows it cuts otherwise.
 */

import earcut from 'earcut';
import { generateCirclePolygon } from '../../shared/math/index.js';
import { drawPropertyKey } from '../../shared/properties.js';
import type { FeatureStyle, FeatureType, StyleRule } from '../../shared/types/model.js';
import type { Color } from '../../shared/types/style.js';
import type { PixelRatioInput } from '../../shared/utils/pixel-ratio.js';
import { resolveContentPixelRatio, resolvePixelRatio } from '../../shared/utils/pixel-ratio.js';
import {
  type DrawnRows,
  geometryAt,
  type RowGroup,
  rowNumber,
  rowValue,
  type ShapeFormReader,
} from '../../store/built-in/drawn-rows.js';
import type { Coordinate, Feature } from '../../store/types.js';
import { tessellateSurfaceFill } from '../globe-subdivision.js';
import { toPackedPointStyle } from '../renderers/batch-manager.js';
import {
  screenPixelDistanceXY,
  segmentMetersXY,
  toLineInstanceColor,
  WORLD_TILE_SIZE,
} from '../renderers/line/line-geometry.js';
import type { SDFStrokeStyle } from '../renderers/line/line-types.js';
import { type PointShape, toInstancedPointShape } from '../renderers/point/point-instance.js';
import { POINT_SHAPE_CODE } from '../renderers/point/point-sdf.js';
import { buildEarcutInput } from '../renderers/polygon/earcut-input.js';
import type { RetainedStyleResolver } from '../renderers/retained.js';
import {
  ROWS_DASH,
  ROWS_INSTANCE_FLOATS,
  ROWS_KIND,
  ROWS_ROW_STYLE_FLOATS,
  ROWS_STYLE_FLOATS,
  type RowsChunkData,
  type RowsKind,
  type RowsLineMetrics,
  type RowsPalette,
  writeRowsInstance,
} from '../renderers/rows/rows-format.js';
import { applyRuleColor, evaluateStyleRuleValue, type StyleRuleChannel } from '../style-rule.js';
import { anchorElevationMeters } from '../terrain/anchor.js';
import type { TerrainContext } from '../terrain/context.js';
import { TERRAIN_MAX_TILED_COARSEN } from '../terrain/metrics.js';
import {
  batchTessellationFactor,
  fillSignature,
  polygonTessellationStep,
  ringBoundingCells,
  tessellateRings,
} from '../terrain/polygon.js';
import { reportTerrainCoarsening } from '../terrain/state.js';
import type { TessellationStep } from '../terrain/tessellation.js';

/** The key of the created zoom in the attributes of a row */
const CREATED_ZOOM_KEY = drawPropertyKey('createdZoom');
/** The key of the radius of a Circle in the attributes of a row */
const RADIUS_KEY = drawPropertyKey('radiusMeters');

/**
 * Whether a key is that of an attribute read when a row is packed (besides the one the style rule
 * of its layer reads): the row is packed again when it is written
 *
 * @internal
 */
export function isPackedKey(key: string): boolean {
  return key === CREATED_ZOOM_KEY || key === RADIUS_KEY;
}

/** The degrees of the Web Mercator world per CSS px at zoom 0 (the 512 px tiles of maplibre) */
const CSS_PX_PER_DEGREE = 512 / 360;

/** The radians of a degree */
const RADIANS = Math.PI / 180;

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
  /** The fill color */
  readonly fillColor: Color;
  /** The color of the outline, its alpha 0 when it is not drawn */
  readonly strokeColor: Color;
  /** Whether the outline is drawn (visible and wider than 0) */
  readonly hasStroke: boolean;
  /** Whether the outline is visible and not solid */
  readonly dashedStroke: boolean;
  /** The width of the outline in CSS px */
  readonly strokeWidth: number;
  /** The pattern of the outline */
  readonly lineStyle: 'solid' | 'dashed' | 'dotted';
  /** The color a dashed outline is drawn with, as the lines draw it */
  readonly dashedColor: Color;
  /** The styles as the resolver gives them for the feature of the row */
  readonly resolved: ReturnType<RetainedStyleResolver['getPolygonStyles']>;
}

/** What is resolved of one number of style, by type of feature and rule color */
interface StyleSlots {
  /** The epoch of the number it was resolved for */
  readonly epoch: number;
  readonly points: Map<string, PointSlot>;
  readonly lines: Map<string, LineSlot>;
  readonly polygons: Map<string, PolygonSlot>;
}

/** The key of a type of feature and a rule color */
function slotKey(type: string, ruleColor: string | null): string {
  return `${type}\u0000${ruleColor ?? ''}`;
}

/**
 * The styles of the rows of a layer, resolved once per number of style, type of feature and
 * color of the style rule
 *
 * @internal
 */
export class RowStyleSlots {
  private readonly byStyle = new Map<number, StyleSlots>();
  /** The rule color of each value of the attribute the rule reads */
  private readonly ruleColors = new Map<unknown, string>();

  /**
   * @param resolver The resolution of the styles of the features
   * @param rows The rows the styles are numbers of
   * @param rule The style rule of the layer (none when undefined)
   */
  constructor(
    readonly resolver: RetainedStyleResolver,
    private readonly rows: DrawnRows,
    readonly rule: StyleRule | undefined,
  ) {}

  /**
   * The color the style rule of the layer gives a row (null without a rule), read from the
   * column of the attribute the rule reads
   */
  ruleColorOf(group: RowGroup, row: number): string | null {
    const rule = this.rule;
    if (!rule) return null;
    const value = rule.kind === 'single' ? undefined : rowValue(group, row, rule.property);
    const cacheable = value === null || typeof value !== 'object';
    if (cacheable) {
      const cached = this.ruleColors.get(value);
      if (cached !== undefined) return cached;
    }
    const color = evaluateStyleRuleValue(rule, value);
    if (cacheable) this.ruleColors.set(value, color);
    return color;
  }

  point(style: number, type: string, ruleColor: string | null): PointSlot {
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

  line(style: number, type: string, ruleColor: string | null): LineSlot {
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

  polygon(style: number, type: string, ruleColor: string | null): PolygonSlot {
    const slots = this.slotsOf(style).polygons;
    const key = slotKey(type, ruleColor);
    let slot = slots.get(key);
    if (!slot) {
      const resolved = this.resolver.getPolygonStyles(this.probe(style, type, ruleColor, 'fill'));
      const { fillColor, strokeStyle } = resolved;
      const hasStroke = strokeStyle.opacity > 0 && strokeStyle.width > 0;
      slot = {
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
        resolved,
      };
      slots.set(key, slot);
    }
    return slot;
  }

  /**
   * What is resolved of a number of style: made again when the number was given to another
   * style since (its epoch changed)
   */
  private slotsOf(style: number): StyleSlots {
    const epoch = this.rows.styleEpochOf(style);
    let slots = this.byStyle.get(style);
    if (!slots || slots.epoch !== epoch) {
      slots = { epoch, points: new Map(), lines: new Map(), polygons: new Map() };
      this.byStyle.set(style, slots);
    }
    return slots;
  }

  /**
   * A feature that carries the style a row gets: its own style with the color of the rule on the
   * channel the resolution reads (the resolver is given no layer, so it applies no rule of its own)
   */
  private probe(
    style: number,
    type: string,
    ruleColor: string | null,
    channel: StyleRuleChannel,
  ): Feature {
    const own = this.rows.styleOf(style) as FeatureStyle | undefined;
    return {
      id: '',
      type: type as FeatureType,
      geometry: { type: 'Point', coordinates: [0, 0] },
      layerId: '',
      groupId: undefined,
      properties: {},
      style: applyRuleColor(own, ruleColor, channel) ?? {},
      locked: false,
      visible: true,
    };
  }
}

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
  /** A line or an outline drawn dashed (its segments carry the length before them) */
  dashed: 8,
  /** A polygon whose fill is seen */
  fill: 16,
  /** A polygon with an outline */
  stroke: 32,
} as const;

/** What a resolved style was made from, to make its values again */
interface ResolvedEntry {
  readonly style: number;
  readonly epoch: number;
  readonly key: string;
  readonly layout: number;
  readonly compute: () => void;
}

/**
 * The resolved styles of the rows of a layer as the values of a palette: each style, type of
 * feature and rule color is resolved once and gets a number, its values written once. The widths
 * and sizes are in device pixels of the pixel ratio given (`setPixelRatio` writes every value
 * again with the same numbers). A number no row uses is taken back and given to the next style
 * resolved.
 *
 * @internal
 */
export class RowsStyles {
  private readonly byStyle = new Map<number, { epoch: number; keys: Map<string, number> }>();
  private readonly entries: Array<ResolvedEntry | null> = [];
  private readonly values = new Float32Array(ROWS_STYLE_FLOATS);
  /** Device pixels per CSS px of the sizes fixed on screen */
  screenRatio: number;
  /** Device pixels per CSS px of the widths that follow the zoom */
  contentRatio: number;

  constructor(
    public slots: RowStyleSlots,
    readonly palette: RowsPalette,
    pixelRatio: PixelRatioInput | undefined,
    private readonly rows: DrawnRows,
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
   * Writes every value again for another pixel ratio, with the same numbers
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
   * (device px) and the code of its shape (null for a shape that is not instanced)
   */
  point(style: number, type: string, ruleColor: string | null): number | null {
    const key = `p${slotKey(type, ruleColor)}`;
    const known = this.known(style, key);
    if (known !== undefined) return known;
    const slot = this.slots.point(style, type, ruleColor);
    if (!slot.shape) return null;
    const shape = slot.shape;
    return this.add(style, key, ROWS_LAYOUT.point, () => {
      const v = this.values;
      const packed = slot.packed;
      for (let i = 0; i < 8; i++) v[i] = packed[i];
      v[8] = packed[8] * this.screenRatio;
      v[9] = packed[9] * this.screenRatio;
      v[10] = POINT_SHAPE_CODE[shape];
    });
  }

  /**
   * The number of the style of a line: its color, then its width that follows the zoom, its
   * width fixed on screen (negative), its width in CSS px and its pattern
   */
  line(style: number, type: string, ruleColor: string | null): number {
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
  polygon(style: number, type: string, ruleColor: string | null): number {
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

  private known(style: number, key: string): number | undefined {
    const held = this.byStyle.get(style);
    if (!held || held.epoch !== this.rows.styleEpochOf(style)) return undefined;
    return held.keys.get(key);
  }

  private add(style: number, key: string, layout: number, compute: () => void): number {
    this.values.fill(0);
    compute();
    const number = this.palette.add(this.values);
    const epoch = this.rows.styleEpochOf(style);
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
 * What packing the rows of a layer needs
 *
 * @internal
 */
export interface RowsPackContext {
  readonly rows: DrawnRows;
  readonly slots: RowStyleSlots;
  /** The styles of the layer as the values of a palette */
  readonly rowsStyles: RowsStyles;
  /** The surface the rows are packed for (none on a flat map) */
  readonly surface?: RowsSurface | null;
}

/**
 * The surface the rows of a chunk are packed for: the terrain, or the globe
 *
 * @internal
 */
export interface RowsSurface {
  /** The terrain state of the instance (the elevations, the fills cut so far) */
  readonly terrain: TerrainContext;
  /**
   * The step the fills and the outlines are cut with: the step of the surface coarsened for the
   * chunk (`surfaceFillStep`), null when the surface cuts none
   */
  readonly fill: TessellationStep | null;
}

/**
 * The step the fills of a chunk are cut with: the step of the surface coarsened for the cells of
 * the fills of the chunk, as the polygons of a batch are coarsened together (so the fills next to
 * each other lie on one grid), the coarsening reported for the bias of the depth
 *
 * @param base The step of the surface (`getSurfaceTessellationStep` for the fills)
 * @param cells The cells of the fills of the chunk (`rowFillCells` of its rows)
 * @internal
 */
export function surfaceFillStep(
  terrain: TerrainContext,
  base: TessellationStep,
  cells: number,
): TessellationStep {
  const factor = batchTessellationFactor(cells);
  reportTerrainCoarsening(terrain, factor);
  if (factor <= 1) return base;
  if (base.tiling) return { ...base, coarsen: Math.min(factor, TERRAIN_MAX_TILED_COARSEN) };
  return { grid: base.grid * factor, maxPoints: base.maxPoints, region: base.region };
}

/**
 * The cells of the step of the surface the fills of a row cover (the outer ring of each of its
 * polygons drawn), which the coarsening of its chunk is decided from
 *
 * @internal
 */
export function rowFillCells(
  group: RowGroup,
  row: number,
  context: Pick<RowsPackContext, 'rows' | 'slots'>,
  base: TessellationStep,
): number {
  const { rows } = context;
  if (!rows.hasGeometry(group, row)) return 0;
  const type = rows.typeOf(group, row);
  if (type !== 'Polygon' && type !== 'MultiPolygon' && type !== 'Circle') return 0;
  const slot = context.slots.polygon(
    rows.styleNumberOf(group, row),
    type,
    context.slots.ruleColorOf(group, row),
  );
  if (!slot.hasStroke && slot.fillColor[3] <= 0) return 0;
  let cells = 0;
  for (const polygon of rowPolygonsOf(group, row, type)) {
    const outer = polygon[0];
    if (outer) cells += ringBoundingCells(outer, base.grid, base.region);
  }
  return cells;
}

/**
 * The fingerprint of what a row is cut with on a surface (0 for a row the surface does not cut):
 * for a polygon, the conditions that decide the cut of each of its polygons (`fillSignature`),
 * for a point, the elevations of its points
 *
 * @internal
 */
export function rowSurfaceKey(group: RowGroup, row: number, context: RowsPackContext): number {
  const surface = context.surface;
  const { rows } = context;
  if (!surface || !rows.hasGeometry(group, row)) return 0;
  const type = rows.typeOf(group, row);
  if (type === 'Point' || type === 'MultiPoint') {
    const geometry = rowGeometryOf(group, row);
    if (!geometry) return 0;
    const { reader, at } = geometry;
    const first = reader.vertexStart(at);
    const end = reader.depth === 0 ? first + 1 : reader.vertexStart(at + 1);
    const heights: number[] = [];
    for (let v = first; v < end; v++) {
      heights.push(
        Math.fround(
          anchorElevationMeters(
            surface.terrain,
            reader.coords[v * reader.stride],
            reader.coords[v * reader.stride + 1],
          ),
        ),
      );
    }
    return keyOfText(heights.join(','));
  }
  if (type !== 'Polygon' && type !== 'MultiPolygon' && type !== 'Circle') return 0;
  const step = surface.fill;
  if (!step) return 0;
  const signatures: string[] = [];
  for (const polygon of rowPolygonsOf(group, row, type)) {
    signatures.push(fillSignature(step, buildEarcutInput(polygon).flatCoords));
  }
  return keyOfText(signatures.join('|'));
}

/** A number of a text (32 bits, never 0: 0 names no fingerprint) */
function keyOfText(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash === 0 ? 1 : hash;
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
  coords: Float32Array;
  coordCount = 0;
  readonly rowStyles: Float32Array;
  /** The resolved style of each row (-1 for none), counted in the palette while it is held */
  readonly rowStyle: Int32Array;
  readonly rowFirst: Int32Array;
  readonly coordFirst: Int32Array;
  /** The fingerprint of what each row is cut with on the surface (`rowSurfaceKey`; 0: none) */
  readonly keys: Int32Array;
  /**
   * On the surface, what each row is in the runs of the lines a batch of lines is drawn from: 0 a
   * row without a geometry (it joins the run it is in), 1 a line, 2 a row of another kind (it ends
   * the run)
   */
  readonly runKinds: Uint8Array;
  /** On the surface, the longest segment of each line, then of its run, in meters */
  readonly runMeters: Float32Array;
  /** On the surface, the longest segment of each line, then of its run, on the Mercator plane */
  readonly runMercator: Float32Array;
  /** What the stations of the segments are decided from */
  readonly lines: RowsLineMetrics = { surface: false, maxSegmentMeters: 0, maxSegmentMercator: 0 };

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
    this.rowStyles = new Float32Array(Math.max(rows, 1) * ROWS_ROW_STYLE_FLOATS);
    this.rowStyle = new Int32Array(rows).fill(-1);
    this.rowFirst = new Int32Array(rows + 1);
    this.coordFirst = new Int32Array(rows + 1);
    this.keys = new Int32Array(rows);
    this.runKinds = new Uint8Array(rows);
    this.runMeters = new Float32Array(rows);
    this.runMercator = new Float32Array(rows);
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
   * @param _source The place of the coordinate among the coordinates of its row (-1 for none)
   */
  coord(x: number, y: number, _source = -1): number {
    const at = this.coordCount * 2;
    if (at + 2 > this.coords.length) this.coords = grown(this.coords, at + 2);
    this.coords[at] = x;
    this.coords[at + 1] = y;
    return this.coordCount++;
  }

  /** Adds an instance */
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
  ) {
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
  }

  /** The packed arrays of the chunk */
  finish(origin: [number, number], palette: RowsPalette): RowsChunkData {
    return {
      origin,
      rowBase: this.rowBase,
      rows: this.rows,
      instances: this.instances,
      instanceCount: this.instanceCount,
      coords: this.coords,
      coordCount: this.coordCount,
      rowStyles: this.rowStyles,
      rowStyle: this.rowStyle,
      rowFirst: this.rowFirst,
      coordFirst: this.coordFirst,
      palette,
      lines: this.lines,
    };
  }

  /**
   * Gives every segment of a run of lines the longest segment of the run: the lines that follow
   * each other with no row of another kind between them are the lines a batch of lines is drawn
   * from, and its segments are drawn in the stations of the longest segment of the batch
   * (`resolveLineStations`)
   */
  spreadRuns(): void {
    const kinds = this.runKinds;
    let from = 0;
    while (from < this.rows) {
      if (kinds[from] !== 1) {
        from++;
        continue;
      }
      let to = from;
      let meters = 0;
      let mercator = 0;
      while (to < this.rows && kinds[to] !== 2) {
        if (kinds[to] === 1) {
          meters = Math.max(meters, this.runMeters[to]);
          mercator = Math.max(mercator, this.runMercator[to]);
        }
        to++;
      }
      for (let i = from; i < to; i++) {
        if (kinds[i] !== 1) continue;
        this.runMeters[i] = meters;
        this.runMercator[i] = mercator;
        this.writeRun(i, meters, mercator);
      }
      from = to;
    }
  }

  /** Writes the longest segment of its run into the segments of a line */
  writeRun(i: number, meters: number, mercator: number): void {
    for (let k = this.rowFirst[i]; k < this.rowFirst[i + 1]; k++) {
      this.instances[k * ROWS_INSTANCE_FLOATS + 5] = meters;
      this.instances[k * ROWS_INSTANCE_FLOATS + 6] = mercator;
    }
  }

  /** Widens the longest segment of the lines by the longest segment of a line */
  segment(meters: number, mercator: number): void {
    const lines = this.lines;
    if (meters > lines.maxSegmentMeters) lines.maxSegmentMeters = meters;
    if (mercator > lines.maxSegmentMercator) lines.maxSegmentMercator = mercator;
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
 * The geometry of a row as it is drawn (its reader and its row there), or undefined for a row
 * without one: the one place the drawing of the rows reads the shapes it draws
 *
 * @internal
 */
export function rowGeometryOf(
  group: RowGroup,
  row: number,
): { readonly reader: ShapeFormReader; readonly at: number } | undefined {
  return geometryAt(group, row);
}

/**
 * The created zoom of a row (undefined when its width is fixed on screen)
 *
 * @internal
 */
export function rowCreatedZoom(group: RowGroup, row: number): number | undefined {
  return rowNumber(group, row, CREATED_ZOOM_KEY);
}

/**
 * The radius of the row of a Circle, in meters (undefined for none)
 *
 * @internal
 */
export function rowRadius(group: RowGroup, row: number): number | undefined {
  return rowNumber(group, row, RADIUS_KEY);
}

/** Whether a type of feature is drawn as a line */
function isLineType(type: string): boolean {
  return type === 'LineString' || type === 'Freehand' || type === 'MultiLineString';
}

/** The length of a segment as the dashes cut on the CPU measure it, in CSS px at zoom 0 */
function dashSegmentLength(lng0: number, lat0: number, lng1: number, lat1: number): number {
  const latitude = (lat0 + lat1) / 2;
  const cosLatitude = Math.max(Math.cos(latitude * RADIANS), 1e-6);
  const x = (lng1 - lng0) * CSS_PX_PER_DEGREE;
  const y = ((lat1 - lat0) * CSS_PX_PER_DEGREE) / cosLatitude;
  return Math.hypot(x, y);
}

/**
 * The polygons of a row as the features of the row are drawn: each polygon as its rings, the
 * Circle as the ring of its radius (none for a row that is not a polygon, or a Circle without a
 * radius)
 *
 * @internal
 */
export function rowPolygonsOf(group: RowGroup, row: number, type: string): Coordinate[][][] {
  const geometry = rowGeometryOf(group, row);
  if (!geometry) return [];
  const { reader, at } = geometry;
  if (type === 'Circle' && reader.type === 'Point') {
    const radius = rowRadius(group, row);
    if (!radius || radius <= 0) return [];
    const center = reader.position(reader.vertexStart(at));
    return [[generateCirclePolygon([center[0], center[1]], radius)]];
  }
  if (reader.type === 'Polygon') return [reader.coordinatesOf(at) as Coordinate[][]];
  if (reader.type === 'MultiPolygon') return reader.coordinatesOf(at) as Coordinate[][][];
  return [];
}

/**
 * The resolved style a row is packed with (-1 for a row packed without one: no geometry, a
 * polygon with neither a fill nor an outline, a point not instanced), as `collectRow` resolves
 * it: what tells whether a change of the style of a row only changes its style
 *
 * @internal
 */
export function resolveRowStyle(group: RowGroup, row: number, context: RowsPackContext): number {
  const { rows } = context;
  if (!rows.hasGeometry(group, row)) return -1;
  const type = rows.typeOf(group, row);
  const style = rows.styleNumberOf(group, row);
  const ruleColor = context.slots.ruleColorOf(group, row);
  switch (type) {
    case 'LineString':
    case 'Freehand':
    case 'MultiLineString':
      return context.rowsStyles.line(style, type, ruleColor);
    case 'Polygon':
    case 'MultiPolygon':
    case 'Circle': {
      const slot = context.slots.polygon(style, type, ruleColor);
      if (!slot.hasStroke && slot.fillColor[3] <= 0) return -1;
      return context.rowsStyles.polygon(style, type, ruleColor);
    }
    case 'Point':
    case 'MultiPoint':
      return context.rowsStyles.point(style, type, ruleColor) ?? -1;
    default:
      return -1;
  }
}

/**
 * Packs a row into a chunk drawn in one draw: its style, then its instances in the order they
 * are drawn, and its coordinates
 *
 * - a point: one instance per point
 * - a line: one instance per segment of each part, the parts in order; a dashed line carries the
 *   length of its part before each segment
 * - a polygon: for each polygon of the row in order, the triangles of its fill (when its fill is
 *   seen), then the edges of its rings, the outer ring first (when it has an outline; a dashed
 *   outline is drawn as lines, each ring from its first coordinate back to it)
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
  const { rows } = context;
  const styleAt = i * ROWS_ROW_STYLE_FLOATS;
  draft.rowStyles.fill(0, styleAt, styleAt + ROWS_ROW_STYLE_FLOATS);
  draft.setRowStyle(i, -1);
  if (context.surface) {
    draft.lines.surface = true;
    draft.keys[i] = rowSurfaceKey(group, row, context);
    draft.runKinds[i] = rows.hasGeometry(group, row)
      ? isLineType(rows.typeOf(group, row))
        ? 1
        : 2
      : 0;
  }
  if (rows.hasGeometry(group, row)) {
    const type = rows.typeOf(group, row);
    switch (type) {
      case 'Point':
      case 'MultiPoint':
        collectPointRow(group, row, type, styleAt, draft, origin, context);
        break;
      case 'LineString':
      case 'Freehand':
      case 'MultiLineString':
        collectLineRow(group, row, type, styleAt, draft, origin, context);
        break;
      case 'Polygon':
      case 'MultiPolygon':
      case 'Circle':
        collectPolygonRow(group, row, type, styleAt, draft, origin, context);
        break;
    }
  }
  draft.rowFirst[i + 1] = draft.instanceCount;
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
  type: string,
  styleAt: number,
  draft: RowsDraft,
  origin: readonly [number, number],
  context: RowsPackContext,
): void {
  const geometry = rowGeometryOf(group, row);
  if (!geometry || (geometry.reader.type !== 'Point' && geometry.reader.type !== 'MultiPoint')) {
    return;
  }
  const { reader, at } = geometry;
  const style = context.rowsStyles.point(
    context.rows.styleNumberOf(group, row),
    type,
    context.slots.ruleColorOf(group, row),
  );
  // A shape that is not instanced is drawn at once; it is not packed
  if (style === null) return;
  writeRowStyle(draft, styleAt, style, undefined);
  const coords = reader.coords;
  const stride = reader.stride;
  const first = reader.vertexStart(at);
  const end = reader.depth === 0 ? first + 1 : reader.vertexStart(at + 1);
  const terrain = context.surface?.terrain;
  for (let v = first; v < end; v++) {
    const x = coords[v * stride];
    const y = coords[v * stride + 1];
    const index = draft.coord(x - origin[0], y - origin[1], v - first);
    // On the surface, the elevation of the ground the hit testing projects the point with
    const elevation = terrain ? anchorElevationMeters(terrain, x, y) : 0;
    draft.instance(ROWS_KIND.point, row, index, -1, -1, -1, elevation);
  }
}

function collectLineRow(
  group: RowGroup,
  row: number,
  type: string,
  styleAt: number,
  draft: RowsDraft,
  origin: readonly [number, number],
  context: RowsPackContext,
): void {
  const geometry = rowGeometryOf(group, row);
  if (!geometry) return;
  const { reader, at } = geometry;
  const o = reader.offsets;
  // The parts of two coordinates or more, as runs of the coordinates of the column
  const parts: number[] = [];
  if (reader.type === 'LineString') {
    if (o[0][at + 1] - o[0][at] >= 2) parts.push(o[0][at], o[0][at + 1]);
  } else if (reader.type === 'MultiLineString') {
    for (let p = o[0][at]; p < o[0][at + 1]; p++) {
      if (o[1][p + 1] - o[1][p] >= 2) parts.push(o[1][p], o[1][p + 1]);
    }
  }
  if (parts.length === 0) return;
  const rowFirst = reader.vertexStart(at);
  const styleNumber = context.rows.styleNumberOf(group, row);
  const ruleColor = context.slots.ruleColorOf(group, row);
  const style = context.rowsStyles.line(styleNumber, type, ruleColor);
  writeRowStyle(draft, styleAt, style, rowCreatedZoom(group, row));
  const dashed = context.slots.line(styleNumber, type, ruleColor).stroke.lineStyle !== 'solid';
  const coords = reader.coords;
  const stride = reader.stride;
  // On the surface, the longest segment of the line, in meters and on the Mercator plane: each
  // segment of it is drawn in the stations a batch of this line alone is drawn in
  let rowMeters = 0;
  let rowMercator = 0;
  if (context.surface) {
    for (let k = 0; k < parts.length; k += 2) {
      for (let v = parts[k]; v < parts[k + 1] - 1; v++) {
        const a = v * stride;
        const b = a + stride;
        const meters = segmentMetersXY(coords[a], coords[a + 1], coords[b], coords[b + 1]);
        if (meters > rowMeters) rowMeters = meters;
        const mercator =
          screenPixelDistanceXY(coords[a], coords[a + 1], coords[b], coords[b + 1], 0) /
          WORLD_TILE_SIZE;
        if (mercator > rowMercator) rowMercator = mercator;
      }
    }
    draft.segment(rowMeters, rowMercator);
    const i = styleAt / ROWS_ROW_STYLE_FLOATS;
    draft.runMeters[i] = rowMeters;
    draft.runMercator[i] = rowMercator;
  }
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
      draft.instance(
        ROWS_KIND.segment,
        row,
        s > 0 ? base + s - 1 : -1,
        base + s,
        base + s + 1,
        s + 2 < n ? base + s + 2 : -1,
        dashed ? before : 0,
        context.surface ? rowMeters : 0,
        context.surface ? rowMercator : 1,
      );
      if (dashed) {
        const a = (start + s) * stride;
        const b = (start + s + 1) * stride;
        before += dashSegmentLength(coords[a], coords[a + 1], coords[b], coords[b + 1]);
      }
    }
  }
}

function collectPolygonRow(
  group: RowGroup,
  row: number,
  type: string,
  styleAt: number,
  draft: RowsDraft,
  origin: readonly [number, number],
  context: RowsPackContext,
): void {
  const styleNumber = context.rows.styleNumberOf(group, row);
  const ruleColor = context.slots.ruleColorOf(group, row);
  const slot = context.slots.polygon(styleNumber, type, ruleColor);
  if (!slot.hasStroke && slot.fillColor[3] <= 0) return;
  const polygons = rowPolygonsOf(group, row, type);
  if (polygons.length === 0) return;
  const style = context.rowsStyles.polygon(styleNumber, type, ruleColor);
  writeRowStyle(draft, styleAt, style, rowCreatedZoom(group, row));
  const solidOutline = slot.hasStroke && !slot.dashedStroke;
  const dashedOutline = slot.hasStroke && slot.dashedStroke;
  const surface = context.surface;
  const step = surface?.fill ?? null;
  const id = step ? context.rows.idOf(context.rows.refOf(group, row)) : undefined;
  let source = 0;
  let partIndex = -1;
  for (const polygon of polygons) {
    partIndex++;
    const outer = polygon[0];
    const count = polygon.reduce((sum, ring) => sum + ring.length, 0);
    const { flatCoords, holeIndices, rings } = buildEarcutInput(polygon);
    if (!outer || outer.length < 3 || rings.length === 0) {
      source += count;
      continue;
    }
    // The coordinates of the rings kept, read by the fill and the outline alike
    const base = draft.coordCount;
    for (let c = 0; c < flatCoords.length; c += 2) {
      draft.coord(flatCoords[c] - origin[0], flatCoords[c + 1] - origin[1], source + c / 2);
    }
    source += count;
    // The step the fill was cut with, which the outline is cut with too (on one grid)
    let polygonStep: TessellationStep | null = null;
    // 1. The fill, a triangle per instance
    if (slot.fillColor[3] > 0) {
      let triangles: number[] = earcut(flatCoords, holeIndices);
      let fillBase = base;
      if (step && surface && triangles.length > 0) {
        const cut = tessellateSurfaceFill(
          surface.terrain,
          id,
          partIndex,
          flatCoords,
          triangles,
          step,
        );
        polygonStep = cut.step;
        if (cut.flatCoords !== flatCoords) {
          fillBase = draft.coordCount;
          const cutCoords = cut.flatCoords;
          for (let c = 0; c < cutCoords.length; c += 2) {
            draft.coord(cutCoords[c] - origin[0], cutCoords[c + 1] - origin[1]);
          }
        }
        triangles = cut.indices;
      }
      for (let t = 0; t < triangles.length; t += 3) {
        const c = fillBase + triangles[t + 2];
        draft.instance(
          ROWS_KIND.fill,
          row,
          fillBase + triangles[t],
          fillBase + triangles[t + 1],
          c,
          c,
        );
      }
    }
    // 2. The outline: the edges of every ring
    if (!solidOutline && !dashedOutline) continue;
    let ringBase = base;
    let drawnRings = rings;
    if (step) {
      // A polygon without a fill takes the step from its size
      const ringStep = polygonStep ?? polygonTessellationStep(step, flatCoords);
      const cut = tessellateRings(rings, ringStep);
      if (cut !== rings) {
        drawnRings = cut.filter((ring) => ring.length >= 3);
        ringBase = draft.coordCount;
        for (const ring of drawnRings) {
          for (const coordinate of ring) {
            draft.coord(coordinate[0] - origin[0], coordinate[1] - origin[1]);
          }
        }
      }
    }
    for (const ring of drawnRings) {
      const n = ring.length;
      const at = (j: number) => ringBase + (((j % n) + n) % n);
      let before = 0;
      for (let j = 0; j < n; j++) {
        if (solidOutline) {
          draft.instance(ROWS_KIND.outline, row, at(j - 1), at(j), at(j + 1), at(j + 2));
          continue;
        }
        // A dashed ring is a line from its first coordinate around back to it, with a round end
        // at both ends of it, as the dashes of a ring are cut
        draft.instance(
          ROWS_KIND.dashedOutline,
          row,
          j > 0 ? at(j - 1) : -1,
          at(j),
          at(j + 1),
          j + 1 < n ? at(j + 2) : -1,
          before,
        );
        const a = ring[j];
        const b = ring[(j + 1) % n];
        before += dashSegmentLength(a[0], a[1], b[0], b[1]);
      }
      ringBase += n;
    }
  }
}
