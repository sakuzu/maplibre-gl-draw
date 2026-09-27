// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The contents given as a columnar table (`ColumnarSource`)
 *
 * It implements the contract of `source.ts` over the typed arrays of the table. What a draw and a
 * hit test need is read from the arrays as they are: the chunks and the spatial index come from
 * `prepareDatasetColumnar` (computed in a Worker, or here when it was not given), and the rows of
 * a chunk are packed straight into the GPU arrays. A feature is built only for a row that is
 * asked for (a hit, the selection, `getFeatures`, the analytic drape, a row drawn in immediate
 * mode).
 *
 * The styles are resolved once per geometry type and rule color, not per row: the rows have no
 * individual style, so two rows of the same type with the same rule color look the same. The
 * resolution goes through the same styler and the same resolver as the features, so a row looks
 * exactly as its feature would.
 *
 * A row is read from the geometry column that holds it: the one column of a table of one type, or
 * the child of a mixed geometry column that the row names, at the row within that child. Each row
 * is collected as its type is (the decisions of `collectFeature`), so the rows of a mixed table
 * are drawn in the order of the table whatever the order within the children.
 */

import type { Feature } from '../../shared/types/model.js';
import type { Color } from '../../shared/types/style.js';
import { toPackedPointStyle } from '../../view/renderers/batch-manager.js';
import { toLineInstanceColor } from '../../view/renderers/line/line-geometry.js';
import type { SDFStrokeStyle } from '../../view/renderers/line/line-types.js';
import {
  type PointShape,
  toInstancedPointShape,
} from '../../view/renderers/point/point-instance.js';
import type { SDFPolygonStyle } from '../../view/renderers/polygon/sdf-polygon.js';
import type { RetainedStyleResolver } from '../../view/renderers/retained.js';
import { evaluateStyleRuleValue, getStyleRuleChannel } from '../../view/style-rule.js';
import { type DisplayChunk, toDisplayChunks } from '../chunk.js';
import {
  type ChunkCollector,
  type ChunkDraft,
  COLLECT_SLICE_ROWS,
  FIXED_WIDTH_ZOOM,
  isDrapedGeometry,
  PackedLinesBuilder,
  PackedPointsBuilder,
  pushFallback,
} from '../retained.js';
import type { DisplaySource, SourceCollectContext } from '../source.js';
import { DisplaySpatialIndex } from '../spatial.js';
import type { DisplayFeatureStyler } from '../style.js';
import type { ThinningRole } from '../thinning.js';
import { prepareDatasetColumnar } from './prepare.js';
import {
  type ColumnarGeometryColumn,
  ColumnarTable,
  columnValue,
  isDictionaryColumn,
} from './table.js';
import type {
  DatasetColumnarGeometryType,
  DatasetColumnarInput,
  DatasetColumnarPrepared,
} from './types.js';

/** The column the zoom of creation of a row is read from (the same key as on a feature) */
const CREATED_ZOOM_COLUMN = 'createdZoom';

/** The key of the slots for "no rule color" */
const NO_RULE_COLOR = '';

/** The resolved style of a point for one rule color */
interface PointSlot {
  /** The instanced shape (null: the shape is drawn in immediate mode) */
  shape: PointShape | null;
  /** The packed style (`toPackedPointStyle`) */
  packed: Float64Array;
}

/** The resolved style of a line for one rule color */
interface LineSlot {
  stroke: SDFStrokeStyle;
  /** The instance color (`toLineInstanceColor`) */
  color: Color;
}

/** The resolved style of a polygon for one rule color */
interface PolygonSlot {
  fillColor: Color;
  strokeStyle: SDFStrokeStyle;
  hasStroke: boolean;
  /** The batch style of a row without createdZoom (a fixed outline width) */
  fixedStyle: SDFPolygonStyle;
  /** The batch style of a row with createdZoom */
  scaledStyle: SDFPolygonStyle;
}

/** The slots of one kind of style, per geometry type and then per rule color */
type SlotMaps<T> = Map<DatasetColumnarGeometryType, Map<string, T>>;

/** The slots of a geometry type (created on the first request) */
function slotsOfType<T>(maps: SlotMaps<T>, type: DatasetColumnarGeometryType): Map<string, T> {
  let slots = maps.get(type);
  if (!slots) {
    slots = new Map();
    maps.set(type, slots);
  }
  return slots;
}

/**
 * The styles of the rows of a table, resolved once per geometry type and rule color
 */
class ColumnarStyleSlots {
  private readonly points: SlotMaps<PointSlot> = new Map();
  private readonly lines: SlotMaps<LineSlot> = new Map();
  private readonly polygons: SlotMaps<PolygonSlot> = new Map();
  /** The rule color of each code, when the rule reads a dictionary column */
  private readonly codeColors: (string | undefined)[] = [];

  constructor(
    private readonly table: ColumnarTable,
    private readonly styler: DisplayFeatureStyler,
    private readonly resolver: RetainedStyleResolver,
  ) {}

  /**
   * The rule color of a row (null without a rule)
   *
   * The same color the rule gives the feature of the row: the rule reads one column, and the
   * property of the feature is the value of that column.
   */
  ruleColorOf(row: number): string | null {
    const rule = this.styler.rule;
    if (!rule) return null;
    if (rule.kind === 'single') return rule.color;
    const column = this.table.columns[rule.property];
    if (column === undefined) return evaluateStyleRuleValue(rule, undefined);
    if (isDictionaryColumn(column)) {
      const code = column.codes[row];
      const cached = code >= 0 ? this.codeColors[code] : undefined;
      if (cached !== undefined) return cached;
      const color = evaluateStyleRuleValue(rule, columnValue(column, row));
      if (code >= 0) this.codeColors[code] = color;
      return color;
    }
    return evaluateStyleRuleValue(rule, columnValue(column, row));
  }

  point(type: DatasetColumnarGeometryType, color: string | null): PointSlot {
    const key = color ?? NO_RULE_COLOR;
    const slots = slotsOfType(this.points, type);
    let slot = slots.get(key);
    if (!slot) {
      const style = this.resolver.getPointStyle(this.probe(type, color));
      slot = { shape: toInstancedPointShape(style.shape), packed: toPackedPointStyle(style) };
      slots.set(key, slot);
    }
    return slot;
  }

  line(type: DatasetColumnarGeometryType, color: string | null): LineSlot {
    const key = color ?? NO_RULE_COLOR;
    const slots = slotsOfType(this.lines, type);
    let slot = slots.get(key);
    if (!slot) {
      const stroke = this.resolver.getLineStringStrokeStyle(this.probe(type, color));
      slot = { stroke, color: toLineInstanceColor(stroke.color, stroke.opacity) };
      slots.set(key, slot);
    }
    return slot;
  }

  polygon(type: DatasetColumnarGeometryType, color: string | null): PolygonSlot {
    const key = color ?? NO_RULE_COLOR;
    const slots = slotsOfType(this.polygons, type);
    let slot = slots.get(key);
    if (!slot) {
      const { fillColor, strokeStyle } = this.resolver.getPolygonStyles(this.probe(type, color));
      const hasStroke = strokeStyle.opacity > 0 && strokeStyle.width > 0;
      const styleFor = (strokeWidth: number): SDFPolygonStyle => ({
        fillColor,
        fillOpacity: 1,
        strokeColor: strokeStyle.color,
        strokeWidth,
        strokeOpacity: hasStroke ? 1 : 0,
      });
      slot = {
        fillColor,
        strokeStyle,
        hasStroke,
        fixedStyle: styleFor(hasStroke ? -strokeStyle.width : 0),
        scaledStyle: styleFor(hasStroke ? strokeStyle.width : 0),
      };
      slots.set(key, slot);
    }
    return slot;
  }

  /** A feature of a geometry type carrying the style a row with this rule color gets */
  private probe(type: DatasetColumnarGeometryType, color: string | null): Feature {
    return {
      id: '',
      type,
      coordinates: [] as unknown as Feature['coordinates'],
      layerId: '',
      properties: {},
      style: this.styler.effectiveStyle(undefined, color, getStyleRuleChannel(type)),
      locked: false,
      visible: true,
    };
  }
}

/**
 * The contents of a dataset given as a columnar table
 *
 * @internal
 */
export class ColumnarSource implements DisplaySource {
  readonly table: ColumnarTable;
  readonly length: number;
  readonly bounds: Float64Array;
  readonly chunks: readonly DisplayChunk[];
  readonly index = new DisplaySpatialIndex();
  /** The rows have no individual style */
  readonly maxStylePointRadius = 0;

  /** The features of every row with a geometry, built on the first request */
  private allFeatures: Feature[] | null = null;
  /** The row of each id, built on the first request (only with an ids column) */
  private rowById: Map<string, number> | null = null;
  /** The resolved styles, and what they were resolved with */
  private slots: ColumnarStyleSlots | null = null;
  private slotsKey: readonly [number, DisplayFeatureStyler, RetainedStyleResolver] | null = null;

  /**
   * @param prepared The result of `prepareDatasetColumnar` for this table (computed here when
   *   omitted)
   * @throws when the table does not add up, or when `prepared` was made for another length
   */
  constructor(input: DatasetColumnarInput, prepared?: DatasetColumnarPrepared) {
    this.table = new ColumnarTable(input);
    this.length = this.table.length;
    const ready = prepared ?? prepareDatasetColumnar(input);
    if (ready.length !== this.length || ready.bounds.length !== this.length * 4) {
      throw new Error(
        `Columnar input: prepared was made for ${ready.length} rows, the table has ${this.length}`,
      );
    }
    this.bounds = ready.bounds;
    this.chunks = toDisplayChunks({
      rows: ready.chunkRows,
      offsets: ready.chunkOffsets,
      bounds: ready.chunkBounds,
    });
    this.index.adopt({
      nodeSize: ready.indexNodeSize,
      numItems: ready.indexItemCount,
      boxes: ready.indexBoxes,
      indices: ready.indexEntries,
      levelBounds: ready.indexLevels,
    });
  }

  hasGeometry(row: number): boolean {
    return !Number.isNaN(this.bounds[row * 4]);
  }

  featureAt(row: number): Feature {
    return this.table.featureAt(row, this.hasGeometry(row));
  }

  idOf(row: number): string {
    return this.table.idOf(row);
  }

  typeOf(row: number): Feature['type'] | null {
    return this.hasGeometry(row) ? (this.table.columnOf(row)?.type ?? null) : null;
  }

  rowsOfIds(ids: ReadonlySet<string>): number[] {
    const rows = new Set<number>();
    for (const id of ids) {
      const row = this.rowOfId(id);
      if (row >= 0 && this.hasGeometry(row)) rows.add(row);
    }
    return [...rows].sort((a, b) => a - b);
  }

  features(): Feature[] {
    if (!this.allFeatures) {
      const features: Feature[] = [];
      for (let row = 0; row < this.length; row++) {
        if (this.hasGeometry(row)) features.push(this.featureAt(row));
      }
      this.allFeatures = features;
    }
    return this.allFeatures;
  }

  thinningRole(row: number): ThinningRole {
    if (!this.hasGeometry(row)) return 'skip';
    return this.table.columnOf(row)?.type === 'Point' ? 'point' : 'winner';
  }

  pointOf(row: number): readonly [number, number] {
    const column = this.table.columnOf(row) as ColumnarGeometryColumn;
    return column.position(this.table.childRowOf(row));
  }

  styleRadiusOf(): number | undefined {
    return undefined;
  }

  collector(rows: Int32Array, context: SourceCollectContext): ChunkCollector {
    const table = this.table;
    // Whether the solid lines and polygons of each child are left to the analytic drape
    const skipDraped = table.children.map(
      (column) => context.skipDrapedFills === true && isDraped(column.type),
    );
    const createdZoom = table.columns[CREATED_ZOOM_COLUMN];
    let next = 0;
    let lastFallbackRow = -1;

    return {
      collect: (draft, styles, deadline, now): boolean => {
        const slots = this.slotsFor(context, styles);
        const collect = new RowCollector(this, draft, slots, (row) => {
          // A Multi geometry comes around once per part; it is sent to immediate mode once
          if (row === lastFallbackRow) return;
          lastFallbackRow = row;
          pushFallback(draft, context.styler.prepareIfStyled(this.featureAt(row)));
        });
        const createdZoomOf = (row: number): number | undefined => {
          if (createdZoom === undefined) return undefined;
          const value = columnValue(createdZoom, row);
          return typeof value === 'number' ? value : undefined;
        };

        while (next < rows.length) {
          const end = Math.min(rows.length, next + COLLECT_SLICE_ROWS);
          for (; next < end; next++) {
            const row = rows[next];
            if (!context.isDrawn(row)) continue;
            const child = table.childOf(row);
            if (child < 0) continue;
            const column = table.children[child];
            const at = table.childRowOf(row);
            const o = column.offsets;
            const skip = skipDraped[child];
            switch (column.type) {
              case 'Point':
                // Only a point needs the feature for the predicate of the external renderer
                if (
                  context.isExternallyRenderedPoint?.(
                    context.styler.prepareIfStyled(this.featureAt(row)),
                  )
                ) {
                  break;
                }
                collect.point(row, column, at);
                break;
              case 'MultiPoint':
                for (let v = o[0][at]; v < o[0][at + 1]; v++) collect.point(row, column, v);
                break;
              case 'LineString':
                if (context.pointsOnly) break;
                collect.line(row, column, o[0][at], o[0][at + 1], createdZoomOf(row), skip);
                break;
              case 'MultiLineString':
                if (context.pointsOnly) break;
                for (let p = o[0][at]; p < o[0][at + 1]; p++) {
                  collect.line(row, column, o[1][p], o[1][p + 1], createdZoomOf(row), skip);
                }
                break;
              case 'Polygon':
                if (context.pointsOnly) break;
                collect.polygon(
                  row,
                  column,
                  o[0][at],
                  o[0][at + 1],
                  o[1],
                  0,
                  createdZoomOf(row),
                  skip,
                );
                break;
              case 'MultiPolygon':
                if (context.pointsOnly) break;
                for (let p = o[0][at]; p < o[0][at + 1]; p++) {
                  collect.polygon(
                    row,
                    column,
                    o[1][p],
                    o[1][p + 1],
                    o[2],
                    p - o[0][at],
                    createdZoomOf(row),
                    skip,
                  );
                }
                break;
            }
          }
          if (now() >= deadline) break;
        }
        return next >= rows.length;
      },
    };
  }

  rowOfId(id: string): number {
    const table = this.table;
    if (!table.ids) {
      const row = Number(id);
      return Number.isInteger(row) && row >= 0 && row < this.length && String(row) === id
        ? row
        : -1;
    }
    if (!this.rowById) {
      const map = new Map<string, number>();
      for (let row = 0; row < this.length; row++) map.set(table.idOf(row), row);
      this.rowById = map;
    }
    return this.rowById.get(id) ?? -1;
  }

  // === Internals ===

  /** The resolved styles for this dataset and resolver (dropped when the style changed) */
  private slotsFor(
    context: SourceCollectContext,
    resolver: RetainedStyleResolver,
  ): ColumnarStyleSlots {
    const key = this.slotsKey;
    if (
      !this.slots ||
      !key ||
      key[0] !== context.styleKey ||
      key[1] !== context.styler ||
      key[2] !== resolver
    ) {
      this.slots = new ColumnarStyleSlots(this.table, context.styler, resolver);
      this.slotsKey = [context.styleKey, context.styler, resolver];
    }
    return this.slots;
  }
}

/** Whether the analytic drape draws the rows of this type */
function isDraped(type: DatasetColumnarGeometryType): boolean {
  return isDrapedGeometry({ type } as Feature);
}

/**
 * Pushes the parts of the rows of one dataset into the intermediate data of one build
 *
 * The decisions are those of `collectFeature` in `retained.ts`, made on the arrays of the table.
 */
class RowCollector {
  constructor(
    private readonly source: ColumnarSource,
    private readonly draft: ChunkDraft,
    private readonly slots: ColumnarStyleSlots,
    private readonly fallback: (row: number) => void,
  ) {}

  /**
   * A point at coordinate `v` of the geometry column of the row (a shape without instancing
   * support goes to immediate mode)
   */
  point(row: number, column: ColumnarGeometryColumn, v: number): void {
    const slot = this.slots.point(column.type, this.slots.ruleColorOf(row));
    if (!slot.shape) {
      this.fallback(row);
      return;
    }
    let builder = this.draft.packedPoints.get(slot.shape);
    if (!builder) {
      builder = new PackedPointsBuilder();
      this.draft.packedPoints.set(slot.shape, builder);
    }
    const at = v * column.dimensions;
    builder.push(column.coords[at], column.coords[at + 1], slot.packed);
  }

  /**
   * A line over the coordinates `[start, end)` of the geometry column of the row (a dashed line
   * goes to immediate mode)
   */
  line(
    row: number,
    column: ColumnarGeometryColumn,
    start: number,
    end: number,
    createdZoom: number | undefined,
    skipSolid: boolean,
  ): void {
    if (end - start < 2) return;
    const slot = this.slots.line(column.type, this.slots.ruleColorOf(row));
    const stroke = slot.stroke;
    if (stroke.lineStyle !== 'solid') {
      this.fallback(row);
      return;
    }
    // A solid line is drawn by the analytic drape as ground pixels (in this frame only)
    if (skipSolid && stroke.opacity > 0 && stroke.width > 0) return;

    const draft = this.draft;
    const fixed = createdZoom === undefined;
    let builder = fixed ? draft.packedFixedLines : draft.packedScaledLines;
    if (!builder) {
      builder = new PackedLinesBuilder();
      if (fixed) draft.packedFixedLines = builder;
      else draft.packedScaledLines = builder;
    }
    // A fixed line width is declared by the negative convention (as in `collectLine`)
    builder.push(
      column.coords,
      column.dimensions,
      start,
      end,
      fixed ? -stroke.width : stroke.width,
      createdZoom ?? FIXED_WIDTH_ZOOM,
      slot.color,
    );
  }

  /**
   * A polygon made of the rings `[ringStart, ringEnd)` of the geometry column of the row (a dashed
   * outline goes to immediate mode)
   *
   * @param ringOffsets The offsets from a ring to its coordinates
   */
  polygon(
    row: number,
    column: ColumnarGeometryColumn,
    ringStart: number,
    ringEnd: number,
    ringOffsets: Int32Array,
    partIndex: number,
    createdZoom: number | undefined,
    skipSolid: boolean,
  ): void {
    if (ringEnd <= ringStart) return;
    if (ringOffsets[ringStart + 1] - ringOffsets[ringStart] < 3) return;

    const slot = this.slots.polygon(column.type, this.slots.ruleColorOf(row));
    if (slot.hasStroke && slot.strokeStyle.lineStyle !== 'solid') {
      this.fallback(row);
      return;
    }
    if (!slot.hasStroke && slot.fillColor[3] <= 0) return;
    // The solid fill and outline are drawn by the analytic drape as ground pixels
    if (skipSolid) return;

    const rings: Array<[number, number][]> = new Array(ringEnd - ringStart);
    for (let r = ringStart; r < ringEnd; r++) {
      rings[r - ringStart] = column.positions(ringOffsets[r], ringOffsets[r + 1]);
    }
    const fixed = createdZoom === undefined;
    (fixed ? this.draft.fixedPolygons : this.draft.scaledPolygons).push({
      coordinates: rings,
      style: fixed ? slot.fixedStyle : slot.scaledStyle,
      createdZoom: createdZoom ?? FIXED_WIDTH_ZOOM,
      featureId: this.source.idOf(row),
      partIndex,
    });
  }
}
