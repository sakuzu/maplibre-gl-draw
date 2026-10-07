// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The retained chunks of a dataset (building, drawing and invalidation)
 *
 * The features of a dataset are split into spatial chunks (`chunk.ts`) and the GPU resources
 * (retained batches, `retained.ts`) are built per chunk and kept. What a frame does is only the
 * intersection test of the bbox of a chunk against the viewport and the draw calls of the chunks
 * that intersect; no batch is rebuilt and nothing is re-uploaded to the GPU. A chunk is rebuilt
 * only when it is invalidated (a change of the contents, the style or the rendering pixel ratio),
 * when the terrain it was baked for goes stale, or when it is seen far from its origin at high
 * zoom. A change of the rows the collision thinning draws rebuilds only the point part of a chunk
 * (`rebuildChunkPoints`), right before the chunk is drawn.
 */

import type { ProjectionData } from 'maplibre-gl';
import type { BoundingBox, Feature } from '../shared/types/model.js';
import type { PixelRatioInput } from '../shared/utils/pixel-ratio.js';
import { resolvePixelRatio } from '../shared/utils/pixel-ratio.js';
import { getSurfaceTessellationStep } from '../view/globe-subdivision.js';
import type { RetainedDrawFactors } from '../view/renderers/draw-factors.js';
import type { RetainedRendererSet } from '../view/renderers/retained.js';
import { boundsCenter, rebasedRetainedOrigin } from '../view/shaders/retained-origin.js';
import { getAnchorElevationGeneration } from '../view/terrain/anchor.js';
import type { TerrainContext } from '../view/terrain/context.js';
import { isTerrainCameraMoving, reportTerrainCoarsening } from '../view/terrain/state.js';
import { mercatorX, mercatorY, type TessellationStep } from '../view/terrain/tessellation.js';
import { tilingSignature } from '../view/terrain/tiling.js';
import { boundsIntersect, type DisplayChunk } from './chunk.js';
import {
  type ChunkBuildJob,
  type ChunkCollector,
  type CollectOptions,
  createChunkBuildJob,
  type DisplayChunkBatches,
  disposeChunkBatches,
  drawChunkBatches,
  rebuildChunkPoints,
} from './retained.js';
import { type DrawnRowMask, sameRowsInMasks } from './thinning.js';
import {
  createChunkTriangulator,
  globalTriangulationScheduler,
  type TriangulationScheduler,
} from './triangulation.js';
import type { DisplayBatchTarget } from './types.js';

/**
 * Whether this chunk has to be re-baked
 *
 * The decision is a single fingerprint of the tile composition. The fingerprint contains "the
 * zoom composition of the tiles that cover its patch", "the coarsening factor" and "the relation
 * to the region of the subdivision" (tilingSignature in view/terrain/tiling.ts).
 *
 * Moving the camera changes the zoom of the tiles used in the distance. Since the step is matched
 * to the real mesh of the tiles, a surface already baked is stale once the composition changes.
 * This was the truth behind the observation that the geometry is correct and yet "it is clean
 * only right after a reload, and reaching the same place by panning or zooming shows dotted
 * punch-through and seams on the ridges and the valleys".
 *
 * Conversely, nothing is re-baked while the composition is the same. Re-baking every chunk just
 * because the region shifted or the zoom moved slightly would give a frame of several hundred
 * milliseconds on every pan.
 */
export function needsRetessellation(
  state: { builtGrid: number; builtTilingKey: string | null; chunk: DisplayChunk },
  step: TessellationStep | null,
): boolean {
  if (!step) return false;
  // A shape baked uncut (no terrain, no globe) is re-baked once the terrain is alive or the globe
  // is drawn
  if (state.builtGrid <= 0) return true;

  return state.builtTilingKey !== chunkTilingKey(state.chunk, step);
}

/**
 * Fingerprint of the tile composition that covers the patch of a chunk
 */
function chunkTilingKey(chunk: DisplayChunk, step: TessellationStep): string {
  const bounds = chunk.bounds;
  return tilingSignature(
    step.tiling ?? null,
    step.region ?? null,
    step.coarsen && step.coarsen > 1 ? step.coarsen : 1,
    step.grid,
    mercatorX(bounds.minX),
    // The mercator y decreases as the latitude increases
    mercatorY(bounds.maxY),
    mercatorX(bounds.maxX),
    mercatorY(bounds.minY),
  );
}

/**
 * Time that may be spent building the retained batches in one frame (milliseconds)
 *
 * The weight of building a chunk changes by orders of magnitude with its contents. With terrain
 * the work of cutting the surfaces along the grid of the terrain mesh is added, and without it
 * there is still earcut and the packing of the arrays. Slicing by the number of features would
 * make it wait for nothing when it is light and blow a frame with a single chunk when it is
 * heavy.
 *
 * It is therefore sliced by "the time spent". What exceeds the budget is deferred to the next
 * frame and the chunks not built yet appear over several frames (looking the same as tiles
 * arriving one after another). A chunk whose step has merely gone stale keeps drawing the
 * retained batch of the previous step until it is re-baked.
 *
 * Building everything without a budget made a single frame reach 3.2 seconds (terrain off) to
 * over 30 seconds (terrain on) on this map (8,172 administrative boundaries, 64 chunks).
 * Exactly one chunk is always built (progress is made even with a budget of 0).
 *
 * A host that draws a frame to read it back turns the time slicing off (`buildBudgetMs` of the
 * host is then infinite): every chunk in view is built in the frame.
 */
const CHUNK_BUILD_BUDGET_MS = 12;

/**
 * A monotonic clock (it works even when the test environment has no performance)
 */
function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * A chunk and the state of its retained batches
 *
 * batches being null means "not built yet, or a rebuild is needed".
 */
interface DisplayChunkState {
  readonly chunk: DisplayChunk;
  batches: DisplayChunkBatches | null;
  /**
   * The step of the terrain subdivision when this chunk was baked (mercator; 0 = baked without
   * terrain)
   */
  builtGrid: number;
  /**
   * The build in progress (advanced in slices by the budget of the frame)
   *
   * `batches` (the previous version) keeps being drawn while it runs.
   */
  job: ChunkBuildJob | null;
  /** The step that the build in progress assumes */
  jobGrid: number;
  /** The fingerprint of the tile composition that the build in progress assumes */
  jobTilingKey: string | null;
  /**
   * Whether "the polygons and lines were handed to the analytic drape" when this chunk was baked
   *
   * A chunk that handed them over holds only points and the things drawn immediately. It is
   * re-baked once the way they are handed over changes.
   */
  builtDraped: boolean;
  /** The way of handing over that the build in progress assumes */
  jobDraped: boolean;
  /**
   * The fingerprint of the tile composition of its patch when this chunk was baked
   *
   * Moving the camera changes the zoom of the tiles used in the distance. Re-baking only the
   * chunks whose fingerprint changed leaves no surface cut with the step of the old composition.
   */
  builtTilingKey: string | null;
  /** The origin the batches were built with (null before the first build) */
  origin: [number, number] | null;
  /** The origin the build in progress uses */
  jobOrigin: [number, number] | null;
  /**
   * The origin chosen for the view (null = the center of the chunk bounds)
   *
   * Seen at high zoom, a chunk that spreads widely leaves a visible Float32 error far from its
   * origin, so it is built again around the view (`view/shaders/retained-origin.ts`).
   */
  viewOrigin: [number, number] | null;
  /**
   * The receiver of the completion notification of the triangulation (only the chunks that
   * contain a huge polygon have one)
   *
   * It is remembered so that it can be taken off the scheduler when the dataset is removed.
   */
  onTriangulated: (() => void) | null;
  /** The drawn rows the point part of `batches` was built with (meaningful with `batches`) */
  pointsMask: DrawnRowMask;
  /** The drawn rows the build in progress collects */
  jobMask: DrawnRowMask;
}

/**
 * What the chunk set reads from its dataset
 *
 * @internal
 */
export interface DisplayChunkSetHost {
  /**
   * Walks the rows of a chunk into the intermediate data of its build (the drawing targets with
   * the rule colors and the base style applied, in draw order). The walk is advanced by the
   * budget of the frame
   *
   * @param drawn The rows to draw (a row that is 0 in it is skipped; null = every row)
   */
  collector(rows: Int32Array, options: CollectOptions, drawn: DrawnRowMask): ChunkCollector;
  /** The rows to draw now (the collision thinning; null = every row) */
  drawnRows(): DrawnRowMask;
  /**
   * The predicate that picks out the points drawn by an external renderer (undefined when it is
   * not injected; the path without a predicate is as before)
   */
  externalPointFilter(): ((feature: Feature) => boolean) | undefined;
  /** Whether the polygons and lines are handed to the analytic drape (decided per frame) */
  drapedFills(): boolean;
  /** Requests a repaint */
  requestRepaint(): void;
  /**
   * Called whenever every chunk is discarded
   *
   * The reasons for discarding the retained batches (a change of the contents, the style or the
   * rendering pixel ratio) are also the reasons for rebuilding the index of the analytic drape.
   */
  onInvalidateAll(): void;
  /**
   * The time the building of the chunks may take in one frame (ms; `CHUNK_BUILD_BUDGET_MS` when
   * omitted). Infinity builds every chunk in view in the frame (the time slicing is off)
   */
  buildBudgetMs?: number;
  /** Rendering pixel ratio (read from window every time when not injected) */
  pixelRatio?: PixelRatioInput;
  /** The scheduler of the triangulation of huge polygons (the global one when omitted) */
  triangulationScheduler?: TriangulationScheduler;
}

/**
 * What one frame of the retained chunks is drawn with
 *
 * @internal
 */
export interface DisplayChunkFrame {
  target: DisplayBatchTarget;
  renderers: RetainedRendererSet;
  terrain: TerrainContext;
  projectionData: ProjectionData;
  zoom: number;
  bounds: BoundingBox;
  /** The zoom-dependent drawing factors of this frame */
  factors: RetainedDrawFactors;
}

/**
 * The retained chunks of one dataset
 *
 * @internal
 */
export class DisplayChunkSet {
  /** The chunks (in draw order) */
  private chunks: DisplayChunkState[] = [];
  /**
   * The full set of renderers used in the most recent draw
   *
   * It is remembered so that the GPU resources can be released on dispose and when the layer is
   * disposed.
   */
  private renderers: RetainedRendererSet | null = null;
  /** The devicePixelRatio the retained batches were built with (null when not built) */
  private builtDevicePixelRatio: number | null = null;
  /** The generation of the anchor elevation baked into the retained batches (-1 = not yet) */
  private builtAnchorElevationGeneration = -1;
  /**
   * Generation of the set of features
   *
   * The completion notification of the triangulation arrives seconds or tens of seconds later.
   * If the contents have been replaced by then (if the generation has advanced), nothing is done.
   */
  private featuresGeneration = 0;
  private disposed = false;
  /** Whether the most recent draw left a chunk unbuilt */
  private lastPending = false;

  constructor(private readonly host: DisplayChunkSetHost) {}

  /** Generation of the set of features (advances on every `replace`) */
  get generation(): number {
    return this.featuresGeneration;
  }

  /** The renderers used in the most recent draw (null before the first draw or after release) */
  get retainedRenderers(): RetainedRendererSet | null {
    return this.renderers;
  }

  /**
   * Whether the most recent draw left a chunk unbuilt (a later frame builds it)
   *
   * It stays true while the chunks are being built over several frames and turns false at the
   * first frame that leaves nothing unbuilt, so a caller can tell when everything is drawn.
   */
  get hasPendingBuild(): boolean {
    return this.lastPending;
  }

  /**
   * Takes new contents split into chunks (the old chunks and their GPU resources are released)
   *
   * @param chunks The spatial chunks of the contents (in draw order)
   */
  replace(chunks: readonly DisplayChunk[]): void {
    this.disposeChunks();
    this.featuresGeneration++;
    this.lastPending = chunks.length > 0;
    this.chunks = chunks.map((chunk) => ({
      chunk,
      batches: null,
      job: null,
      jobGrid: 0,
      jobTilingKey: null,
      builtGrid: 0,
      builtTilingKey: null,
      builtDraped: false,
      jobDraped: false,
      origin: null,
      jobOrigin: null,
      viewOrigin: null,
      onTriangulated: null,
      pointsMask: null,
      jobMask: null,
    }));
  }

  /**
   * Draws the chunks that intersect the viewport
   *
   * It only draws the retained batches of the chunks that intersect (building them the first time
   * when necessary). The features that cannot be retained are sent to the immediate-mode path per
   * chunk.
   */
  draw(frame: DisplayChunkFrame): void {
    const { target, renderers, terrain, projectionData, zoom, bounds, factors } = frame;
    this.renderers = renderers;
    this.syncDevicePixelRatio();
    this.syncAnchorElevationGeneration(terrain);

    // The building of the retained batches is limited to one chunk in this frame (the build
    // budget of a frame, see the time budget above). While the camera is moving, the old step keeps
    // being drawn and the re-bake is deferred (it would be redone anyway once the movement ends).
    // A limit on the slices is needed only when there is terrain. Without terrain, building is
    // just earcut and the packing of the arrays, and building every visible chunk at once takes a
    // few milliseconds (the behaviour before is kept).
    // The step of the terrain, or on the globe the cell of its fills
    const step = getSurfaceTessellationStep(terrain, 'fill');
    const drapedFills = this.host.drapedFills();
    const drawn = this.host.drawnRows();
    const budget = this.host.buildBudgetMs ?? CHUNK_BUILD_BUDGET_MS;
    const budgetStart = nowMs();
    let builtHere = 0;
    /** Whether more may still be built in this frame (at least one is built) */
    const canBuild = (): boolean => builtHere === 0 || nowMs() - budgetStart < budget;
    const settled = !isTerrainCameraMoving(terrain);
    /** Whether anything is left over (the next frame is requested by itself) */
    let pending = false;

    for (const state of this.chunks) {
      if (!boundsIntersect(state.chunk.bounds, bounds)) continue;

      // Whether a rebuild is needed. If it is, a job is started and advanced by the budget of the
      // frame. The batches of the previous version keep being drawn until the job finishes, so
      // even a large surface covering the view does not stall a frame and the picture being drawn
      // is not missing anything.
      // A chunk whose way of handing over the polygons and lines changed is re-baked as well (the
      // analytic drape being switched on or off)
      // A chunk seen far from its origin at high zoom is built again around the view (the batches
      // it has keep being drawn until then)
      const rebased =
        state.batches !== null && !state.job
          ? rebasedRetainedOrigin(chunkOrigin(state), state.chunk.bounds, bounds, zoom)
          : null;
      if (rebased) state.viewOrigin = rebased;
      const stale =
        state.batches !== null &&
        (needsRetessellation(state, step) || state.builtDraped !== drapedFills || rebased !== null);
      // Building a new chunk is also deferred until the camera stops (treated the same as a
      // re-bake). Zooming out lets new chunks enter all at once as the view widens (137 of them
      // measured), and a build of 20 to 50 ms per step while moving makes the gesture stutter
      // (measured). Starting to build while moving leaves a blank until it is finished anyway, so
      // building after it stops costs only one beat at the start. The drawing of the existing
      // batches continues below as before (the appearance is unchanged).
      if (!settled && (state.job || !state.batches || stale)) pending = true;
      if (settled && !state.job && (!state.batches || stale)) {
        const origin = state.viewOrigin ?? boundsCenter(state.chunk.bounds);
        state.jobOrigin = origin;
        // Nothing is walked here: the job walks the rows of the chunk when it is stepped, within
        // the budget of the frame (walking every visible chunk at once would put the resolution
        // of the styles of the whole view on one frame)
        state.job = createChunkBuildJob(
          this.host.collector(
            state.chunk.rows,
            {
              isExternallyRenderedPoint: this.host.externalPointFilter(),
              skipDrapedFills: drapedFills,
            },
            drawn,
          ),
          renderers,
          origin,
          this.chunkTriangulator(state),
        );
        state.jobMask = drawn;
        state.jobGrid = step?.grid ?? 0;
        state.jobTilingKey = step ? chunkTilingKey(state.chunk, step) : null;
        state.jobDraped = drapedFills;
      }

      // A job in progress is not advanced while the camera is moving either (a single step can
      // blow through the budget, and paying it during a gesture always stutters).
      if (state.job && !settled) pending = true;
      if (state.job && settled) {
        if (canBuild()) {
          builtHere++;
          const done = state.job.step(budgetStart + budget, nowMs);
          if (done) {
            const built = state.job.take();
            state.job = null;
            if (built) {
              // The old version is discarded only after the new one is complete (no flicker)
              if (state.batches) disposeChunkBatches(state.batches, renderers);
              state.batches = built;
              state.origin = state.jobOrigin;
              state.builtGrid = state.jobGrid;
              state.builtTilingKey = state.jobTilingKey;
              state.builtDraped = state.jobDraped;
              state.pointsMask = state.jobMask;
            }
            // When it could not be built (the shaders are not initialized) it is rebuilt on the
            // next frame
          } else {
            pending = true;
          }
        } else {
          pending = true;
        }
      }

      // A chunk that has never been built has nothing to draw at this point
      if (!state.batches) continue;

      // The points follow the rows drawn now before the chunk is drawn, in every frame, while
      // the camera moves as well: until they do, the points of another zoom band would be drawn
      // at this scale (after a large zoom out, piled up into a solid patch). Only the point part
      // is rebuilt, so the cost is a walk over the rows of the chunk plus the packing of the
      // points it draws, which the thinning bounds by what fits on screen. A chunk whose rows are
      // drawn alike in both masks (no point, or no change of its points) rebuilds nothing
      if (state.pointsMask !== drawn && !this.rebuildPoints(state, renderers, drawn)) {
        pending = true;
      }

      // Report to the depth bias how coarse the shape being drawn is. If the step has got finer
      // than when it was baked, the shape being drawn is coarse by that ratio
      if (step && state.builtGrid > step.grid) {
        reportTerrainCoarsening(terrain, state.builtGrid / step.grid);
      }

      drawChunkBatches(state.batches, renderers, zoom, projectionData, factors);

      // The features that cannot be retained are drawn immediately, right after the retained
      // batches of the chunk, the points last (with the same factors as the retained batches)
      const { fallback, pointFallback } = state.batches;
      if (fallback.length > 0 || pointFallback.length > 0) {
        target.beginFrame(projectionData, zoom, undefined, factors);
        for (const feature of fallback) target.processFeature(feature, false);
        for (const feature of pointFallback) target.processFeature(feature, false);
        target.endFrame();
      }
    }

    // If any chunk was left unbuilt, one more frame is asked for
    this.lastPending = pending;
    if (pending) this.host.requestRepaint();
  }

  /**
   * Discards the retained batches of every chunk (the splitting is kept and they are rebuilt on
   * the next draw)
   *
   * The queue of the triangulation is not touched. Discarding the work in progress on every
   * rebuild would keep the triangulation of a huge polygon from ever finishing.
   */
  invalidateAll(): void {
    this.host.onInvalidateAll();
    for (const state of this.chunks) {
      this.invalidate(state);
    }
  }

  /**
   * Releases only the GPU resources (the chunks are built again on the next draw)
   *
   * It is called when the rendering layer is disposed.
   */
  releaseRetained(): void {
    this.invalidateAll();
    this.renderers = null;
  }

  /**
   * Releases everything: the GPU resources, the chunks and the waiting for the triangulation
   *
   * A notification of the triangulation that arrives afterwards does nothing.
   */
  dispose(): void {
    this.disposed = true;
    this.forgetTriangulation();
    this.disposeChunks();
    this.renderers = null;
  }

  /**
   * Discards the retained batches of a single chunk (they are rebuilt on the next draw)
   */
  private invalidate(state: DisplayChunkState): void {
    // The build in progress is discarded too. Now that the contents changed, what is half built
    // is stale
    if (state.job) {
      if (this.renderers) state.job.dispose(this.renderers);
      state.job = null;
    }
    if (!state.batches) return;
    if (this.renderers) {
      disposeChunkBatches(state.batches, this.renderers);
    }
    state.batches = null;
  }

  /**
   * Discards the chunks themselves (the GPU resources are released as well)
   */
  private disposeChunks(): void {
    this.invalidateAll();
    this.chunks = [];
  }

  /**
   * Creates the receiver of the triangulation for a single chunk
   *
   * A polygon whose vertex count exceeds the threshold is not triangulated on the spot but queued
   * into the time-sliced list (the fill of that polygon does not appear yet). Once the
   * triangulation is finished, only the retained batches of this chunk are rebuilt and a repaint
   * is requested.
   */
  private chunkTriangulator(state: DisplayChunkState) {
    // The contents may have been replaced by the time the notification arrives. The generation
    // watches for that
    const generation = this.featuresGeneration;
    const onReady = (): void => {
      if (this.disposed || generation !== this.featuresGeneration) return;
      this.invalidate(state);
      this.host.requestRepaint();
    };
    state.onTriangulated = onReady;

    return createChunkTriangulator(onReady, this.scheduler());
  }

  /**
   * Takes the receivers of this chunk set off the queue of the triangulation
   *
   * The scheduler discards a job nobody waits for any more (the triangulation is not kept running
   * for a dataset that has been removed). It is called only on disposal (not on a rebuild).
   */
  private forgetTriangulation(): void {
    const scheduler = this.scheduler();
    for (const state of this.chunks) {
      if (!state.onTriangulated) continue;
      scheduler.forget(state.onTriangulated);
      state.onTriangulated = null;
    }
  }

  private scheduler(): TriangulationScheduler {
    return this.host.triangulationScheduler ?? globalTriangulationScheduler;
  }

  /**
   * Follows the changes of the rendering pixel ratio
   *
   * Line widths and point sizes are converted to physical pixels and baked into the retained
   * batches, so they have to be rebuilt when the display scale or the display itself changes. It
   * is an insurance against a change of the rendering environment rather than of the features or
   * the rules, and it normally never happens. When the ratio is injected it is a fixed value, so
   * it is always "unchanged" and nothing is ever rebuilt.
   */
  private syncDevicePixelRatio(): void {
    const dpr = resolvePixelRatio(this.host.pixelRatio);
    if (this.builtDevicePixelRatio === dpr) return;

    if (this.builtDevicePixelRatio !== null) {
      this.invalidateAll();
    }
    this.builtDevicePixelRatio = dpr;
  }

  /**
   * Rebuilds the retained batches of the points as the DEMs arrive
   *
   * A point bakes the elevation of its anchor into the instance (a_instance_elevation_m of
   * point-instance). DEM tiles arrive asynchronously, so at the moment of the first bake most of
   * the points still have an elevation of 0. Without a re-bake, only the points are left behind
   * at sea level and stay buried in the terrain.
   *
   * core advances the generation by one whenever the coverage of the DEM changes
   * (getAnchorElevationGeneration). The retained cache on the store side (syncTerrainGeneration
   * of store-retained) and the retained batches of custom renderers look at the same
   * generation; only the datasets did not.
   *
   * The first time (= nothing has been baked yet) nothing is rebuilt. It is about to be baked, so
   * there is nothing to discard.
   *
   * Polygons and lines do not refer to the terrain elevation at all, so they are not touched when
   * the DEM coverage changes. Discarding the whole retained batches regardless of the type
   * (`invalidateAll`) would, for a dataset with large surfaces, stall the main thread for
   * seconds on every change of the DEM coverage by rebuilding every chunk including earcut. Only
   * the retained batches of the points are rebuilt with `rebuildChunkPoints`.
   */
  private syncAnchorElevationGeneration(terrain: TerrainContext): void {
    const generation = getAnchorElevationGeneration(terrain);
    if (this.builtAnchorElevationGeneration === generation) return;

    if (this.builtAnchorElevationGeneration !== -1) {
      this.refreshPointElevations();
    }
    this.builtAnchorElevationGeneration = generation;
  }

  /**
   * Rebuilds only the retained batches of the points with the latest DEM elevations
   *
   * For a chunk whose retained batches have never been built (`state.batches === null`) nothing
   * happens here, because the build of the next draw uses the latest elevations of that moment
   * directly. The rows drawn are those the point part was built with (a change of them is the
   * business of the draw loop).
   */
  private refreshPointElevations(): void {
    const renderers = this.renderers;
    if (!renderers) return;

    for (const state of this.chunks) {
      if (!state.batches) continue;
      // A chunk without a single baked point has nothing to rewrite when the elevations change.
      // For a dataset of polygons only (administrative boundaries, for example) every chunk
      // drops out here and a change of the DEM coverage costs nothing. The points drawn in
      // immediate mode look their elevation up every frame, so they are never left behind.
      if (state.batches.points.length === 0) continue;
      this.rebuildPointPart(state, renderers, state.pointsMask);
    }
  }

  /**
   * Brings the point part of a built chunk to the rows `drawn`
   *
   * @returns false when it could not be rebuilt (the shaders are not ready; the previous point
   *   part is kept and it is tried again on the next draw)
   */
  private rebuildPoints(
    state: DisplayChunkState,
    renderers: RetainedRendererSet,
    drawn: DrawnRowMask,
  ): boolean {
    if (!sameRowsInMasks(state.pointsMask, drawn, state.chunk.rows)) {
      if (!this.rebuildPointPart(state, renderers, drawn)) return false;
    }
    state.pointsMask = drawn;
    return true;
  }

  /** Rebuilds the point part of a built chunk with the rows `drawn` */
  private rebuildPointPart(
    state: DisplayChunkState,
    renderers: RetainedRendererSet,
    drawn: DrawnRowMask,
  ): boolean {
    return rebuildChunkPoints(
      state.batches as DisplayChunkBatches,
      this.host.collector(
        state.chunk.rows,
        { isExternallyRenderedPoint: this.host.externalPointFilter(), pointsOnly: true },
        drawn,
      ),
      renderers,
      chunkOrigin(state),
    );
  }
}

/**
 * The origin of the relative coordinates of the built batches of a chunk
 *
 * The coordinates of a retained batch are baked relative to this origin. Passing a different
 * origin to the re-bake of the points alone (rebuildChunkPoints) than to the build would shift
 * every re-baked point by the difference of the origins, so both read the origin recorded with
 * the batches. A build starts from the center of the chunk bounds, or from the origin chosen for
 * the view.
 */
function chunkOrigin(state: DisplayChunkState): [number, number] {
  return state.origin ?? boundsCenter(state.chunk.bounds);
}
