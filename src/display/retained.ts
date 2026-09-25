// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Retained-mode rendering of a dataset
 *
 * The GPU resources (retained batches) are built per chunk and a frame only issues the draw
 * calls. The vertex data does not depend on the camera (projection is done with the
 * projectionData and zoom uniforms of each frame), so it only has to be rebuilt when the set of
 * features or the style rules change.
 *
 * The building uses the pure conversion functions of BatchManager (toLineBatchItem /
 * toPointInstanceData) and the style resolution of FeatureDrawer as they are.
 *
 * Within a chunk the draw order is bundled as "polygons → lines → points → the features that
 * cannot be retained" (once things are batched, features of the same kind become a single draw
 * call). The features that cannot be retained (dashed lines, images, point shapes without
 * instancing support) are sent through the immediate-mode path.
 *
 * A build has two phases, both advanced by the time budget of the frame: the dataset, which
 * walks the rows of the chunk and resolves their styles into the intermediate data (a
 * `ChunkCollector`; the features of an array go through `collectFeatures`, a columnar table
 * through `columnar/collect.ts`), and the building of the GPU resources from it.
 */

import type { ProjectionData } from 'maplibre-gl';
import { generateCirclePolygon } from '../shared/math/index.js';
import type { Coordinate, Feature } from '../shared/types/model.js';
import { getCircleRadius, getCreatedZoom } from '../shared/utils/property.js';
import { toLineBatchItem, toPointInstanceData } from '../view/renderers/batch-manager.js';
import { NEUTRAL_DRAW_FACTORS, type RetainedDrawFactors } from '../view/renderers/draw-factors.js';
import type { PackedLineItems } from '../view/renderers/line/line-geometry.js';
import type {
  LineBatchItem,
  LineBatchShape,
  RetainedLineBatch,
  RetainedLineBuildOptions,
} from '../view/renderers/line/line-types.js';
import {
  PACKED_POINT_STYLE_STRIDE,
  type PackedPointInstances,
  type PointInstanceDataFull,
  type PointShape,
  type RetainedPointBatch,
  toInstancedPointShape,
} from '../view/renderers/point/point-instance.js';
import type {
  RetainedPolygonBatch,
  SDFPolygonBatchData,
} from '../view/renderers/polygon/sdf-polygon.js';
import type { RetainedRendererSet, RetainedStyleResolver } from '../view/renderers/retained.js';
import type { ChunkTriangulator } from './triangulation.js';

/**
 * Base zoom of the line width (for the features without createdZoom)
 *
 * @internal
 *
 * Baking in the zoom at build time would change the line width when the zoom changes. Fixing
 * createdZoom at 0 and passing 0 to u_zoom at draw time makes `2^(zoom - createdZoom) = 1`, that
 * is, the line width on screen stays constant. This looks the same as immediate mode (which puts
 * the current zoom into createdZoom every frame).
 */
export const FIXED_WIDTH_ZOOM = 0;

/**
 * The set of retained batches a chunk holds
 *
 * @internal
 */
export interface DisplayChunkBatches {
  /** Polygons (fill + solid outline). Split between fixed width and createdZoom */
  polygons: RetainedPolygonBatch[];
  /** Lines (solid only) */
  lines: RetainedLineBatch[];
  /** Points (per shape) */
  points: RetainedPointBatch[];
  /** The features that cannot be retained and are drawn in immediate mode (in draw order) */
  fallback: Feature[];
}

/**
 * Points packed into growing typed arrays (one shape)
 *
 * @internal
 */
export class PackedPointsBuilder {
  private size = 0;
  private lngLat = new Float64Array(128);
  private style = new Float64Array(64 * PACKED_POINT_STYLE_STRIDE);

  /** The number of points pushed */
  get count(): number {
    return this.size;
  }

  /** Pushes a point with its packed style (`toPackedPointStyle`) */
  push(lng: number, lat: number, style: Float64Array): void {
    const i = this.size;
    if ((i + 1) * 2 > this.lngLat.length) {
      this.lngLat = grow(this.lngLat, (i + 1) * 2);
      this.style = grow(this.style, (i + 1) * PACKED_POINT_STYLE_STRIDE);
    }
    this.lngLat[i * 2] = lng;
    this.lngLat[i * 2 + 1] = lat;
    this.style.set(style, i * PACKED_POINT_STYLE_STRIDE);
    this.size = i + 1;
  }

  /** The points pushed so far */
  view(): PackedPointInstances {
    return { count: this.size, lngLat: this.lngLat, style: this.style };
  }
}

/**
 * Lines packed into growing typed arrays; the coordinates stay in the buffer they come from
 *
 * While every line comes from one buffer, the lines are read from it without a copy. When a line
 * comes from another buffer (a table whose rows are read from geometry columns of several types),
 * the coordinates of the lines pushed so far and of every later line are copied into a buffer of
 * the builder, in the same order, so the lines read the same values.
 *
 * @internal
 */
export class PackedLinesBuilder {
  private size = 0;
  private start = new Int32Array(64);
  private end = new Int32Array(64);
  private strokeWidth = new Float64Array(64);
  private createdZoom = new Float64Array(64);
  private color = new Float64Array(256);
  /** The buffer the lines are read from (null before the first line) */
  private coords: Float64Array | null = null;
  /** The number of values per coordinate in `coords` */
  private stride = 2;
  /** The coordinates written into the buffer of the builder (-1 while it reads the caller's) */
  private copied = -1;

  /** The number of lines pushed */
  get count(): number {
    return this.size;
  }

  /**
   * Pushes a line: the coordinates `[start, end)` of a buffer
   *
   * @param coords The buffer of the coordinates (interleaved)
   * @param stride The number of values per coordinate in `coords` (2 or 3)
   * @param strokeWidth The width in CSS px with the sign convention of `LineBatchItemBase`
   * @param color The instance color (`toLineInstanceColor`)
   */
  push(
    coords: Float64Array,
    stride: number,
    start: number,
    end: number,
    strokeWidth: number,
    createdZoom: number,
    color: ArrayLike<number>,
  ): void {
    if (this.coords === null) {
      this.coords = coords;
      this.stride = stride;
    } else if (this.copied >= 0 || coords !== this.coords || stride !== this.stride) {
      if (this.copied < 0) this.copyPushed();
      const at = this.append(coords, stride, start, end);
      end = at + (end - start);
      start = at;
    }

    const i = this.size;
    if (i + 1 > this.start.length) {
      this.start = grow(this.start, i + 1);
      this.end = grow(this.end, i + 1);
      this.strokeWidth = grow(this.strokeWidth, i + 1);
      this.createdZoom = grow(this.createdZoom, i + 1);
      this.color = grow(this.color, (i + 1) * 4);
    }
    this.start[i] = start;
    this.end[i] = end;
    this.strokeWidth[i] = strokeWidth;
    this.createdZoom[i] = createdZoom;
    this.color[i * 4] = color[0];
    this.color[i * 4 + 1] = color[1];
    this.color[i * 4 + 2] = color[2];
    this.color[i * 4 + 3] = color[3];
    this.size = i + 1;
  }

  /** The lines pushed so far */
  view(): PackedLineItems {
    return {
      count: this.size,
      coords: this.coords ?? new Float64Array(0),
      stride: this.stride,
      start: this.start,
      end: this.end,
      strokeWidth: this.strokeWidth,
      createdZoom: this.createdZoom,
      color: this.color,
    };
  }

  /** Moves the coordinates of the lines pushed so far into a buffer of the builder */
  private copyPushed(): void {
    const from = this.coords as Float64Array;
    const stride = this.stride;
    let total = 0;
    for (let i = 0; i < this.size; i++) total += this.end[i] - this.start[i];
    this.coords = new Float64Array(Math.max(256, total * 4));
    this.stride = 2;
    this.copied = 0;
    for (let i = 0; i < this.size; i++) {
      const at = this.append(from, stride, this.start[i], this.end[i]);
      this.end[i] = at + (this.end[i] - this.start[i]);
      this.start[i] = at;
    }
  }

  /**
   * Appends the coordinates `[start, end)` of a buffer to the buffer of the builder
   *
   * @returns Where they start in the buffer of the builder
   */
  private append(from: Float64Array, stride: number, start: number, end: number): number {
    const at = this.copied;
    const next = at + (end - start);
    let coords = this.coords as Float64Array;
    if (next * 2 > coords.length) {
      coords = grow(coords, next * 2);
      this.coords = coords;
    }
    for (let v = start; v < end; v++) {
      const to = (at + v - start) * 2;
      coords[to] = from[v * stride];
      coords[to + 1] = from[v * stride + 1];
    }
    this.copied = next;
    return at;
  }
}

/** A typed array of the same kind holding at least `length` elements (the contents kept) */
function grow<T extends Float64Array | Int32Array>(array: T, length: number): T {
  let size = array.length * 2;
  while (size < length) size *= 2;
  const next = new (array.constructor as new (size: number) => T)(size);
  next.set(array);
  return next;
}

/**
 * Intermediate data accumulated while building
 *
 * A collector fills either the arrays of objects (the features of an array) or the packed
 * builders (a columnar table); the building reads both.
 *
 * @internal
 */
export interface ChunkDraft {
  /** Polygons with a fixed line width */
  fixedPolygons: SDFPolygonBatchData[];
  /** Polygons scaled against createdZoom */
  scaledPolygons: SDFPolygonBatchData[];
  /** Lines with a fixed line width */
  fixedLines: LineBatchItem[];
  /** Lines scaled against createdZoom */
  scaledLines: LineBatchItem[];
  /** Packed lines with a fixed line width */
  packedFixedLines: PackedLinesBuilder | null;
  /** Packed lines scaled against createdZoom */
  packedScaledLines: PackedLinesBuilder | null;
  /** Points per shape */
  points: Map<PointShape, PointInstanceDataFull[]>;
  /** Packed points per shape */
  packedPoints: Map<PointShape, PackedPointsBuilder>;
  /** The features sent to immediate mode */
  fallback: Feature[];
}

/**
 * Creates empty intermediate data
 *
 * @internal
 */
export function createChunkDraft(): ChunkDraft {
  return {
    fixedPolygons: [],
    scaledPolygons: [],
    fixedLines: [],
    scaledLines: [],
    packedFixedLines: null,
    packedScaledLines: null,
    points: new Map(),
    packedPoints: new Map(),
    fallback: [],
  };
}

/**
 * Walks the rows of a chunk into the intermediate data, a slice at a time
 *
 * @internal
 */
export interface ChunkCollector {
  /**
   * Collects rows until the deadline or the end
   *
   * At least one slice of rows is collected per call (otherwise it would never end).
   *
   * @returns Whether every row has been collected
   */
  collect(
    draft: ChunkDraft,
    styles: RetainedStyleResolver,
    deadline: number,
    now: () => number,
  ): boolean;
}

/**
 * The number of rows collected between two looks at the clock
 *
 * @internal
 */
export const COLLECT_SLICE_ROWS = 512;

/**
 * What decides how the rows of a chunk are collected
 *
 * @internal
 */
export interface CollectOptions {
  /**
   * Predicate that returns whether a point is drawn by an external renderer (every point is
   * pushed when omitted). A point for which it is true goes neither onto a batch nor into
   * fallback
   */
  isExternallyRenderedPoint?: (feature: Feature) => boolean;
  /**
   * Do not push the solid polygons and lines (a frame where the analytic drape draws them as
   * ground pixels)
   */
  skipDrapedFills?: boolean;
  /** Collect only the points (the re-bake of the anchor elevations) */
  pointsOnly?: boolean;
}

/**
 * The collector of features (the features with the style rules applied, in draw order)
 *
 * @param count The number of rows
 * @param featureOf The feature of a row with the rule colors applied, or null when it is not
 *   drawn (thinned away). It is called as the dataset advances, so the preparation of the
 *   features is sliced by the budget of the frame as well
 *
 * @internal
 */
export function collectFeatures(
  count: number,
  featureOf: (index: number) => Feature | null,
  options: CollectOptions = {},
): ChunkCollector {
  let next = 0;
  return {
    collect(draft, styles, deadline, now): boolean {
      while (next < count) {
        const end = Math.min(count, next + COLLECT_SLICE_ROWS);
        for (; next < end; next++) {
          const feature = featureOf(next);
          if (!feature?.visible) continue;
          if (options.pointsOnly && feature.type !== 'Point' && feature.type !== 'MultiPoint') {
            continue;
          }
          collectFeature(
            feature,
            draft,
            styles,
            options.isExternallyRenderedPoint,
            options.skipDrapedFills,
          );
        }
        if (now() >= deadline) break;
      }
      return next >= count;
    },
  };
}

/**
 * The collector of an array of features
 *
 * @internal
 */
export function collectFeatureArray(
  features: readonly Feature[],
  options: CollectOptions = {},
): ChunkCollector {
  return collectFeatures(features.length, (index) => features[index], options);
}

/**
 * Whether the set of retained batches is empty (nothing at all to draw)
 *
 * @internal
 */
export function isEmptyChunkBatches(batches: DisplayChunkBatches): boolean {
  return (
    batches.polygons.length === 0 &&
    batches.lines.length === 0 &&
    batches.points.length === 0 &&
    batches.fallback.length === 0
  );
}

/**
 * Builds the retained batches of a chunk
 *
 * @param features The features with the colors of the style rules applied (in draw order)
 * @param renderers The full set of renderers of retained mode
 * @param origin The origin of the relative coordinates (the representative point of the chunk)
 * @param triangulator The entry point of the triangulation of huge polygons (synchronous when
 *   omitted)
 * @param isExternallyRenderedPoint Predicate that returns whether a point is drawn by an external
 *   renderer (every point is pushed when omitted). A point for which it is true goes neither onto
 *   a batch nor into fallback
 * @param skipDrapedFills Do not push the solid polygons and lines (a frame where the analytic
 *   drape draws them as ground pixels)
 * @returns The batches that were built. When the GPU resources could not be created (the shaders
 *          are not initialized) null is returned and the caller rebuilds them on the next frame
 *
 * @internal
 */
export function buildChunkBatches(
  features: Feature[],
  renderers: RetainedRendererSet,
  origin: [number, number],
  triangulator?: ChunkTriangulator,
  isExternallyRenderedPoint?: (feature: Feature) => boolean,
  skipDrapedFills = false,
): DisplayChunkBatches | null {
  const draft = createChunkDraft();
  collectFeatureArray(features, { isExternallyRenderedPoint, skipDrapedFills }).collect(
    draft,
    renderers.styles,
    Number.POSITIVE_INFINITY,
    () => 0,
  );

  const batches: DisplayChunkBatches = {
    polygons: [],
    lines: [],
    points: [],
    fallback: draft.fallback,
  };

  // Polygons (drawn in the order fixed width → createdZoom)
  //
  // With a polygon waiting for triangulation, the result can be "not a single triangle to fill".
  // That is different from the shaders not being initialized (which needs a rebuild), so it is
  // not treated as a failure (rebuilding every frame would repeat the flattening of a huge
  // polygon forever).
  if (draft.fixedPolygons.length > 0) {
    const batch = renderers.polygon.buildRetained(draft.fixedPolygons, {
      origin,
      widthZoom: FIXED_WIDTH_ZOOM,
      triangulator,
    });
    if (!batch && !triangulator?.hasDeferred()) return null;
    if (batch) batches.polygons.push(batch);
  }
  if (draft.scaledPolygons.length > 0) {
    const batch = renderers.polygon.buildRetained(draft.scaledPolygons, { origin, triangulator });
    if (!batch && !triangulator?.hasDeferred()) return null;
    if (batch) batches.polygons.push(batch);
  }

  // Lines (solid only; dashes are sent to immediate mode) and points (per shape)
  for (const task of lineAndPointTasks(draft, renderers, origin, batches)) {
    if (!task()) return null;
  }

  return batches;
}

/**
 * The tasks that build the lines (fixed width, then createdZoom) and the points (per shape) of
 * the intermediate data, in draw order. A task returns false when the build failed
 */
function lineAndPointTasks(
  draft: ChunkDraft,
  renderers: RetainedRendererSet,
  origin: [number, number],
  batches: DisplayChunkBatches,
): Array<() => boolean> {
  const tasks: Array<() => boolean> = [];
  const solid: LineBatchShape = { lineStyle: 'solid' };
  const lineGroups: Array<[LineBatchItem[], PackedLinesBuilder | null, RetainedLineBuildOptions]> =
    [
      [draft.fixedLines, draft.packedFixedLines, { origin, widthZoom: FIXED_WIDTH_ZOOM }],
      [draft.scaledLines, draft.packedScaledLines, { origin }],
    ];
  for (const [items, packed, options] of lineGroups) {
    if (items.length > 0) {
      tasks.push(() => {
        const batch = renderers.line.buildRetainedBatch(items, solid, options);
        if (!batch) return false;
        batches.lines.push(batch);
        return true;
      });
    }
    if (packed && packed.count > 0) {
      tasks.push(() => {
        const lines = packed.view();
        const batch = renderers.line.buildRetainedPackedBatch
          ? renderers.line.buildRetainedPackedBatch(lines, solid, options)
          : renderers.line.buildRetainedBatch(unpackLines(lines), solid, options);
        if (!batch) return false;
        batches.lines.push(batch);
        return true;
      });
    }
  }

  for (const [shape, points] of draft.points) {
    if (points.length === 0) continue;
    tasks.push(() => {
      const batch = renderers.point.buildRetained(points, shape, { origin });
      if (!batch) return false;
      batches.points.push(batch);
      return true;
    });
  }
  for (const [shape, builder] of draft.packedPoints) {
    if (builder.count === 0) continue;
    tasks.push(() => {
      const batch = buildPackedPoints(renderers, builder.view(), shape, origin);
      if (!batch) return false;
      batches.points.push(batch);
      return true;
    });
  }
  return tasks;
}

/** Builds packed points (as objects when the renderer has no packed builder) */
function buildPackedPoints(
  renderers: RetainedRendererSet,
  points: PackedPointInstances,
  shape: PointShape,
  origin: [number, number],
): RetainedPointBatch | null {
  return renderers.point.buildRetainedPacked
    ? renderers.point.buildRetainedPacked(points, shape, { origin })
    : renderers.point.buildRetained(unpackPoints(points), shape, { origin });
}

/**
 * The packed points as objects (the same values)
 *
 * @internal
 */
export function unpackPoints(points: PackedPointInstances): PointInstanceDataFull[] {
  const out: PointInstanceDataFull[] = new Array(points.count);
  const { lngLat, style } = points;
  for (let i = 0; i < points.count; i++) {
    const s = i * PACKED_POINT_STYLE_STRIDE;
    out[i] = {
      coord: [lngLat[i * 2], lngLat[i * 2 + 1]],
      fillColor: [style[s], style[s + 1], style[s + 2], style[s + 3]],
      strokeColor: [style[s + 4], style[s + 5], style[s + 6], style[s + 7]],
      fillSize: style[s + 8],
      strokeWidth: style[s + 9],
    };
  }
  return out;
}

/**
 * The packed lines as objects: the coordinates copied into arrays, the instance color with an
 * opacity of 1 (the same instance color)
 *
 * @internal
 */
export function unpackLines(lines: PackedLineItems): LineBatchItem[] {
  const out: LineBatchItem[] = new Array(lines.count);
  const { coords, stride } = lines;
  for (let i = 0; i < lines.count; i++) {
    const positions: Array<[number, number]> = [];
    for (let v = lines.start[i]; v < lines.end[i]; v++) {
      positions.push([coords[v * stride], coords[v * stride + 1]]);
    }
    out[i] = {
      coords: positions,
      featureId: '',
      closed: false,
      strokeWidth: lines.strokeWidth[i],
      createdZoom: lines.createdZoom[i],
      color: [
        lines.color[i * 4],
        lines.color[i * 4 + 1],
        lines.color[i * 4 + 2],
        lines.color[i * 4 + 3],
      ],
      opacity: 1,
    };
  }
  return out;
}

/**
 * Target number of vertices of the polygons built in one slice
 *
 * With terrain, building a polygon includes the work of "cutting the surface along the grid of
 * the real mesh of the tiles" and takes a few microseconds per original vertex. Building a single
 * large surface that covers the view takes hundreds of milliseconds and stalls the frame (430 ms
 * measured). Polygons are therefore bundled by vertex count and built one bundle at a time.
 *
 * A bundle becomes one retained batch, so making it too small increases the draw calls. 2,000 was
 * taken from "5 to 10 ms per bundle, a few bundles per chunk".
 */
const BUILD_SLICE_VERTICES = 2_000;

/**
 * The job that builds the retained batches of a chunk in slices
 *
 * What cannot be finished in one frame is advanced by the budget of the frame and handed on. The
 * caller keeps drawing the batches of the previous version until it is finished
 * (`display/chunk-set.ts`). It is built the same way as the one-shot build
 * (`buildChunkBatches`); only the unit of bundling differs.
 */
export interface ChunkBuildJob {
  /**
   * Advances until the deadline
   *
   * At least one step is taken even when the budget is exhausted (otherwise it would never end).
   *
   * @returns Whether it is finished
   */
  step(deadline: number, now: () => number): boolean;
  /** The finished batches (null when unfinished or when the build failed) */
  take(): DisplayChunkBatches | null;
  /** Discards the GPU resources built so far */
  dispose(renderers: RetainedRendererSet): void;
}

/**
 * Cuts the polygons into several bundles by vertex count
 *
 * The order within a bundle and between bundles is unchanged, so the draw order (z-order) does
 * not change.
 */
function sliceByVertices(polygons: SDFPolygonBatchData[]): SDFPolygonBatchData[][] {
  if (polygons.length === 0) return [];

  const slices: SDFPolygonBatchData[][] = [];
  let current: SDFPolygonBatchData[] = [];
  let vertices = 0;
  for (const polygon of polygons) {
    let count = 0;
    for (const ring of polygon.coordinates) count += ring.length;
    // A surface that exceeds the budget on its own cannot be split any further, so it becomes a
    // bundle of its own
    if (current.length > 0 && vertices + count > BUILD_SLICE_VERTICES) {
      slices.push(current);
      current = [];
      vertices = 0;
    }
    current.push(polygon);
    vertices += count;
  }
  if (current.length > 0) slices.push(current);
  return slices;
}

/**
 * Starts the job that builds the retained batches of a chunk in slices
 *
 * Nothing is done at the start. The first steps walk the rows (`collector`), then the GPU
 * resources are built bundle by bundle; both are advanced by the budget of the frame, so neither
 * the resolution of the styles nor the packing of a large chunk lands on one frame.
 *
 * @param collector Walks the rows of the chunk into the intermediate data
 * @param renderers The full set of renderers of retained mode
 * @param origin The origin of the relative coordinates (the representative point of the chunk)
 * @param triangulator The entry point of the triangulation of huge polygons (synchronous when
 *   omitted)
 *
 * @internal
 */
export function createChunkBuildJob(
  collector: ChunkCollector,
  renderers: RetainedRendererSet,
  origin: [number, number],
  triangulator?: ChunkTriangulator,
): ChunkBuildJob {
  const draft = createChunkDraft();
  const batches: DisplayChunkBatches = {
    polygons: [],
    lines: [],
    points: [],
    fallback: draft.fallback,
  };

  let collected = false;
  /** The list of jobs advanced one at a time (planned once the rows are collected) */
  let tasks: Array<() => boolean> | null = null;
  let next = 0;
  let failed = false;

  return {
    step(deadline: number, now: () => number): boolean {
      if (failed) return true;
      // The dataset is sliced by the deadline (at least one slice per call)
      if (!collected) {
        collected = collector.collect(draft, renderers.styles, deadline, now);
        if (!collected) return false;
      }
      tasks ??= buildTasks(draft, renderers, origin, triangulator, batches);
      while (next < tasks.length) {
        if (!tasks[next]()) {
          failed = true;
          return true;
        }
        next++;
        // Once the budget is exhausted, on to the next frame (at least one step has been taken)
        if (now() >= deadline) break;
      }
      return next >= tasks.length;
    },
    take(): DisplayChunkBatches | null {
      if (failed || !tasks || next < tasks.length) return null;
      return batches;
    },
    dispose(rendererSet: RetainedRendererSet): void {
      disposeChunkBatches(batches, rendererSet);
    },
  };
}

/**
 * The tasks that build the retained batches from the collected intermediate data (polygons in
 * bundles by vertex count, then lines, then points)
 */
function buildTasks(
  draft: ChunkDraft,
  renderers: RetainedRendererSet,
  origin: [number, number],
  triangulator: ChunkTriangulator | undefined,
  batches: DisplayChunkBatches,
): Array<() => boolean> {
  const tasks: Array<() => boolean> = [];

  // Polygons (drawn in the order fixed width → createdZoom). One batch per bundle
  for (const slice of sliceByVertices(draft.fixedPolygons)) {
    tasks.push(() => {
      const batch = renderers.polygon.buildRetained(slice, {
        origin,
        widthZoom: FIXED_WIDTH_ZOOM,
        triangulator,
      });
      // With a polygon waiting for triangulation, the result can be "not a single triangle to
      // fill". That is different from the shaders not being initialized (which needs a rebuild),
      // so it is not treated as a failure
      if (!batch) return triangulator?.hasDeferred() === true;
      batches.polygons.push(batch);
      return true;
    });
  }
  for (const slice of sliceByVertices(draft.scaledPolygons)) {
    tasks.push(() => {
      const batch = renderers.polygon.buildRetained(slice, { origin, triangulator });
      if (!batch) return triangulator?.hasDeferred() === true;
      batches.polygons.push(batch);
      return true;
    });
  }

  // Lines (solid only; dashes are sent to immediate mode) and points (per shape)
  tasks.push(...lineAndPointTasks(draft, renderers, origin, batches));
  return tasks;
}

/**
 * Rebuilds only the retained batches of the points of a chunk (exclusively for re-baking the
 * anchor elevation when a DEM arrives)
 *
 * The polygons, the lines and fallback are not touched at all. The polygons and lines of a
 * dataset do not refer to the terrain elevation, so there is no reason to rebuild
 * them. Avoiding the re-triangulation of the polygons, which goes through earcut, is the only
 * purpose of separating this function out.
 *
 * The point shapes without instancing support (on the fallback side) are not handled here. They
 * are drawn in immediate mode with `anchorElevationMeters` looked up again every frame
 * (point-shape.ts), so they are never left behind when the generation advances.
 *
 * @param collector A collector of the points of the chunk (`pointsOnly`). The dataset uses
 *   the same code as the build, so the appearance at build time and at re-bake time cannot
 *   disagree
 * @returns true when they could be rebuilt. When the retained-mode renderers do not have their
 *   shaders yet (the build failed) false is returned and the old point batches are left as they
 *   are (it is tried again the next time the generation advances)
 */
export function rebuildChunkPoints(
  batches: DisplayChunkBatches,
  collector: ChunkCollector,
  renderers: RetainedRendererSet,
  origin: [number, number],
): boolean {
  const draft = createChunkDraft();
  collector.collect(draft, renderers.styles, Number.POSITIVE_INFINITY, () => 0);
  // draft.fallback collects the shapes without instancing support, but they can be thrown away.
  // They are drawn by immediate mode, which looks the elevation up again every frame, so they are
  // never left behind.

  const newBatches: RetainedPointBatch[] = [];
  const built = (batch: RetainedPointBatch | null): boolean => {
    // It could not be built, for example because the shaders are not initialized. The new batches
    // built so far are referenced by nobody, so they are discarded and a failure is returned with
    // the old batches left in place
    if (!batch) {
      for (const done of newBatches) renderers.point.disposeRetained(done);
      return false;
    }
    newBatches.push(batch);
    return true;
  };
  for (const [shape, points] of draft.points) {
    if (points.length === 0) continue;
    if (!built(renderers.point.buildRetained(points, shape, { origin }))) return false;
  }
  for (const [shape, builder] of draft.packedPoints) {
    if (builder.count === 0) continue;
    if (!built(buildPackedPoints(renderers, builder.view(), shape, origin))) return false;
  }

  for (const old of batches.points) {
    renderers.point.disposeRetained(old);
  }
  batches.points = newBatches;
  return true;
}

/**
 * Draws the retained batches of a chunk (it does not build them)
 *
 * @param factors The factors at draw time (when omitted, a scale of 1 and an opacity of 1, as
 *   before). The same factors apply to the fixed and the scaled batches alike, and to points,
 *   lines and polygons alike (so that no path a data surface takes is missed)
 *
 * @internal
 */
export function drawChunkBatches(
  batches: DisplayChunkBatches,
  renderers: RetainedRendererSet,
  zoom: number,
  projectionData: ProjectionData,
  factors: RetainedDrawFactors = NEUTRAL_DRAW_FACTORS,
): void {
  const viewport = renderers.viewport();

  for (const batch of batches.polygons) {
    renderers.polygon.drawRetained(batch, zoom, projectionData, viewport, factors);
  }
  for (const batch of batches.lines) {
    renderers.line.drawRetainedBatch(batch, zoom, projectionData, factors);
  }
  for (const batch of batches.points) {
    renderers.point.drawRetained(batch, zoom, projectionData, factors);
  }
}

/**
 * Disposes the retained batches of a chunk
 *
 * @internal
 */
export function disposeChunkBatches(
  batches: DisplayChunkBatches,
  renderers: RetainedRendererSet,
): void {
  for (const batch of batches.polygons) {
    renderers.polygon.disposeRetained(batch);
  }
  for (const batch of batches.lines) {
    renderers.line.disposeRetainedBatch(batch);
  }
  for (const batch of batches.points) {
    renderers.point.disposeRetained(batch);
  }

  batches.polygons.length = 0;
  batches.lines.length = 0;
  batches.points.length = 0;
}

// === Internals of the building ===

/**
 * Whether it is a type that the analytic drape draws as ground pixels
 *
 * It is paired with the dataset in `view/terrain/drape/pass.ts`. Changing only one of them
 * would draw a surface twice or draw neither of them.
 *
 * @internal
 */
export function isDrapedGeometry(feature: Feature): boolean {
  return (
    feature.type === 'Polygon' ||
    feature.type === 'MultiPolygon' ||
    feature.type === 'LineString' ||
    feature.type === 'MultiLineString'
  );
}

/**
 * Pushes a feature into the intermediate data
 *
 * @internal
 */
export function collectFeature(
  feature: Feature,
  draft: ChunkDraft,
  styles: RetainedStyleResolver,
  isExternallyRenderedPoint?: (feature: Feature) => boolean,
  skipDrapedFills = false,
): void {
  const skipSolid = skipDrapedFills && isDrapedGeometry(feature);
  switch (feature.type) {
    case 'Point':
      collectPoint(
        feature,
        feature.coordinates as Coordinate,
        draft,
        styles,
        isExternallyRenderedPoint,
      );
      return;
    case 'MultiPoint':
      // Whether the predicate applies to Point alone is up to the predicate itself (the test is
      // in one place)
      for (const coord of feature.coordinates as Coordinate[]) {
        collectPoint(feature, coord, draft, styles, isExternallyRenderedPoint);
      }
      return;
    case 'LineString':
    case 'Freehand':
      collectLine(feature, feature.coordinates as Coordinate[], draft, styles, skipSolid);
      return;
    case 'MultiLineString':
      for (const coords of feature.coordinates as Coordinate[][]) {
        collectLine(feature, coords, draft, styles, skipSolid);
      }
      return;
    case 'Polygon':
      collectPolygon(feature, feature.coordinates as Coordinate[][], draft, styles, 0, skipSolid);
      return;
    case 'MultiPolygon': {
      const parts = feature.coordinates as Coordinate[][][];
      for (let i = 0; i < parts.length; i++) {
        collectPolygon(feature, parts[i], draft, styles, i, skipSolid);
      }
      return;
    }
    case 'Circle': {
      const radiusMeters = getCircleRadius(feature);
      if (!radiusMeters || radiusMeters <= 0) return;
      const center = feature.coordinates as Coordinate;
      collectPolygon(feature, [generateCirclePolygon(center, radiusMeters)], draft, styles);
      return;
    }
    default:
      // A kind that retained mode does not handle, such as Image, is sent to immediate mode
      pushFallback(draft, feature);
  }
}

/**
 * Pushes a feature that is sent to immediate mode
 *
 * A Multi geometry is decided per part, so the same feature can come around several times in a
 * row. The immediate-mode path draws every part of a feature at once, so it is not pushed twice.
 *
 * @internal
 */
export function pushFallback(draft: ChunkDraft, feature: Feature): void {
  if (draft.fallback[draft.fallback.length - 1] === feature) return;
  draft.fallback.push(feature);
}

/**
 * Pushes a point (a shape without instancing support is sent to immediate mode)
 *
 * A point drawn by an external renderer goes neither onto a batch nor into the immediate-mode
 * list (core draws nothing; drawing it is the job of the external renderer).
 */
function collectPoint(
  feature: Feature,
  coord: Coordinate,
  draft: ChunkDraft,
  styles: RetainedStyleResolver,
  isExternallyRenderedPoint?: (feature: Feature) => boolean,
): void {
  if (isExternallyRenderedPoint?.(feature)) return;

  const style = styles.getPointStyle(feature);
  const shape = toInstancedPointShape(style.shape);
  if (!shape) {
    // The path that goes to immediate mode is not multiplied by the factors of zoomScale
    pushFallback(draft, feature);
    return;
  }

  let points = draft.points.get(shape);
  if (!points) {
    points = [];
    draft.points.set(shape, points);
  }
  points.push(toPointInstanceData(coord, style));
}

/**
 * Pushes a line (a dashed line is sent to immediate mode because its CPU-side splitting depends
 * on the zoom)
 */
function collectLine(
  feature: Feature,
  coords: Coordinate[],
  draft: ChunkDraft,
  styles: RetainedStyleResolver,
  skipSolid = false,
): void {
  if (coords.length < 2) return;

  const strokeStyle = styles.getLineStringStrokeStyle(feature);
  if (strokeStyle.lineStyle !== 'solid') {
    // The path that goes to immediate mode is not multiplied by the factors of zoomScale
    pushFallback(draft, feature);
    return;
  }
  // A solid line is drawn by the analytic drape as ground pixels (in this frame only)
  if (skipSolid && strokeStyle.opacity > 0 && strokeStyle.width > 0) return;

  const createdZoom = getCreatedZoom(feature);
  const target = createdZoom === undefined ? draft.fixedLines : draft.scaledLines;
  const item = toLineBatchItem(
    coords as [number, number][],
    feature.id,
    strokeStyle,
    createdZoom ?? FIXED_WIDTH_ZOOM,
  );
  // A fixed line width is declared by the negative convention. With widthZoom 0 and createdZoom 0
  // it would look the same through `2^(0 - 0) = 1`, but only a negative value says "a size fixed
  // in screen pixels" and gets the factor of the rendering pixel ratio (renderScale) applied
  // ("the two ratios" in shared/utils/pixel-ratio.ts).
  if (createdZoom === undefined) item.strokeWidth = -item.strokeWidth;
  target.push(item);
}

/**
 * Pushes a polygon (a dashed outline is sent to immediate mode)
 *
 * A fill-only polygon is also pushed as an SDFPolygon without an outline (immediate mode uses
 * PolygonBatchRenderer, but the appearance of the fill is the same).
 */
function collectPolygon(
  feature: Feature,
  rings: Coordinate[][],
  draft: ChunkDraft,
  styles: RetainedStyleResolver,
  partIndex = 0,
  skipSolid = false,
): void {
  const outerRing = rings[0];
  if (!outerRing || outerRing.length < 3) return;

  const { fillColor, strokeStyle } = styles.getPolygonStyles(feature);
  const hasStroke = strokeStyle.opacity > 0 && strokeStyle.width > 0;

  if (hasStroke && strokeStyle.lineStyle !== 'solid') {
    // The path that goes to immediate mode is not multiplied by the factors of zoomScale
    pushFallback(draft, feature);
    return;
  }
  if (!hasStroke && fillColor[3] <= 0) return;
  // The solid fill and outline are drawn by the analytic drape as ground pixels (in this frame
  // only)
  if (skipSolid) return;

  const createdZoom = getCreatedZoom(feature);
  const target = createdZoom === undefined ? draft.fixedPolygons : draft.scaledPolygons;
  // A fixed line width is declared by the negative convention (the same reason as collectLine).
  const strokeWidth = hasStroke
    ? createdZoom === undefined
      ? -strokeStyle.width
      : strokeStyle.width
    : 0;

  target.push({
    coordinates: rings,
    style: {
      fillColor,
      fillOpacity: 1,
      strokeColor: strokeStyle.color,
      strokeWidth,
      strokeOpacity: hasStroke ? 1 : 0,
    },
    createdZoom: createdZoom ?? FIXED_WIDTH_ZOOM,
    // The build of retained mode does not use the global cache of earcut, so the featureId here
    // is held only for identification
    featureId: feature.id,
    partIndex,
  });
}
