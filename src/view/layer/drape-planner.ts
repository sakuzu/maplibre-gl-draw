// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DrapePlanner
 *
 * Plans the analytic drape of a frame (the path that paints polygons and lines as ground
 * pixels): whether it is used in this frame, the tiles it draws, and the datasets that hand
 * their polygons and lines over to it. Every decision leaves its reason in the diagnostic values
 * of the terrain context (`getTerrainDrapeDebug`):
 *
 * - `terrain-off`: there is no terrain
 * - `wide-zoom`: the view is wider than the analytic band and the elements are too heavy for it
 * - `no-drapeable-features` / `vertex-budget`: nothing to drape, or too much
 * - `cell-overflow`: the tile index went over its budget
 * - `no-dem-tiles`: no tile of the view has a DEM or an index yet
 * - `stale-plan`: the previous plan is kept while the index of the view is being built
 * - `texture-limit`: the tables do not fit in the textures of this GPU
 * - `ok`: the plan was built from the tiles of this frame
 *
 * The state that carries over between frames (the collected elements, the tile index, the plan,
 * the counters that keep the hand-over from flapping) lives here. The planner is created once
 * per layer; the GPU side it holds (the drape renderers) is dropped by `releaseGpu`.
 */

import type { CustomRenderMethodInput, Map as MapLibreMap, ProjectionData } from 'maplibre-gl';
import { isLocallyHidden } from '../../store/local-visibility.js';
import type { Store } from '../../store/store.js';
import type { Feature } from '../../store/types.js';
import { layerDrawFactors } from '../renderers/draw-factors.js';
import type { RetainedStyleResolver } from '../renderers/retained.js';
import type { TerrainContext } from '../terrain/context.js';
import {
  type getMapTerrain,
  getRenderableTerrainTiles,
  getTerrainMeshSize,
  getTerrainTileData,
  type RenderableTerrainTile,
  type TerrainTileData,
} from '../terrain/detect.js';
import { DrapeTileStore } from '../terrain/drape/bin-store.js';
import { type DrapeTile, drapeSelectionKey } from '../terrain/drape/binning.js';
import {
  canDrape,
  collectDrapeElements,
  type DrapeCollectResult,
  type DrapeDatasetSource,
  type DrapeQuadBreak,
  drapeLayerSource,
} from '../terrain/drape/pass.js';
import { QuadDrapeRenderer } from '../terrain/drape/quad.js';
import { DRAPE_MAX_SOURCES, DrapeRenderer, type DrapeTileDraw } from '../terrain/drape/renderer.js';
import { buildTileKeySet, resolveTileEdges, wrappedTileKey } from '../terrain/drape/stitch.js';
import { circumferenceAtLatitude, tileCenterLatitude } from '../terrain/metrics.js';
import {
  getTerrainDrapeDebug,
  setDrapePaintedDatasets,
  setTerrainDrapeDebug,
} from '../terrain/state.js';

/** The terrain of the map as maplibre exposes it (null when there is none) */
export type MapTerrain = ReturnType<typeof getMapTerrain>;

/**
 * Lower bound of the zoom at which the analytic drape is used
 *
 * A view wider than this is handled by the vertex displacement path and the fills are drawn
 * without depth. There are three reasons.
 *
 * - Over a wide area the relief is only a dozen or so pixels on screen, so there is no benefit
 *   in solving it as ground pixels (with the depth off, the punch-through of the vertex
 *   displacement disappears by construction as well)
 * - A wide-area tile holds all of the features, so the budget of the analytic evaluation is
 *   often exceeded and it degenerates. Fixing the boundary by zoom keeps the paths from
 *   flapping within the band (every flap re-bakes the retained batches, so the fills disappear
 *   for a few seconds)
 * - Over a wide area, building the index costs on the order of 20 ms per tile. Not going
 *   through it reduces the stutter of zooming
 */
export const TERRAIN_ANALYTIC_MIN_ZOOM = 11;

/**
 * Time that may be spent building the tile index in one frame (milliseconds)
 *
 * Only the tiles that newly entered the view are built, so it is usually 1 to 3 tiles. What
 * exceeds the budget is deferred to the next frame (at least one tile is always built). With the
 * time slicing off (`timeSlicing: false` of the rendering settings) every tile is built in the
 * frame.
 */
const DRAPE_BIN_BUDGET_MS = 8;

/**
 * Number of consecutive frames before the analytic drape counts as "in use"
 *
 * A dataset drops its polygons and lines from the retained batch once it hands them to the
 * drape, so if the decision to hand over flickers, the re-baking goes back and forth and the
 * fills disappear. The hand-over happens only once things have settled, and it is taken back
 * immediately once the drape can no longer be used (only one side is relaxed).
 */
export const DRAPE_STABLE_FRAMES = 10;

/**
 * Upper limit of the frames that may keep drawing with the previous plan while waiting for the
 * index
 *
 * Even if the index stays unbuildable, the old plan must not be kept forever. Beyond 60 frames
 * (about a second) it is redrawn with whatever could be built.
 */
export const DRAPE_STALE_PLAN_MAX_FRAMES = 60;

/**
 * Number of edges for which the analytic drape is allowed in a wide band
 *
 * Over a wide area one tile holds all of the features, so the cost of building the index is
 * determined by the number of edges. A few thousand can be built in under a millisecond per
 * tile.
 */
export const DRAPE_WIDE_EDGE_BUDGET = 20_000;

/**
 * Zoom used to estimate the margin of the index
 *
 * The thickness of a line changes with the factor from its base zoom, so the margin changes
 * with the zoom too. The index cannot be rebuilt for the fraction of every frame, however, so
 * it is rounded to one step and pushed to the safe side (half a step thicker).
 */
const marginZoom = (zoom: number): number => Math.round(zoom) + 0.5;

/** One tile of the plan (the DEM is looked up again on every draw, so it is not held here) */
interface DrapePlanTile {
  tile: RenderableTerrainTile;
  cellOffset: number;
  grid: number;
  groundMeters: number;
}

/**
 * The most recent binning result (the tiles to draw and the features that did not fit on the
 * drape)
 *
 * The set of DEM textures (`TerrainTileData`) is not held here. While the DEM of the target
 * zoom has not arrived, MapLibre returns the texture and the matrix of the parent tile and
 * swaps them once the real one arrives. The sequence of tile ids does not change, so baking
 * them in here would keep drawing "a ground solved with the coarse elevation of the parent",
 * which disagrees with the terrain mesh of MapLibre and makes the polygons and lines lose the
 * depth and disappear (holes really do open in the fills). Looking them up every frame is the
 * correct thing to do.
 */
interface DrapePlan {
  tiles: DrapePlanTile[];
  excluded: Set<string>;
  usable: boolean;
  meshSize: number;
}

/** Per-tile draw instruction of the drape for this frame (with the stitching resolved) */
export interface DrapeTileDrawEntry {
  readonly draw: DrapeTileDraw;
  readonly projection: ProjectionData;
}

/** An image interleaved into the stacking order (position in the element list and feature) */
export interface PendingQuad {
  readonly at: number;
  readonly feature: Feature;
}

/** A dataset as the planner sees it (the drape part and its factors) */
export interface DrapePlannerDataset extends DrapeDatasetSource {
  /** The factors of the source at a zoom (opacity and size) */
  drapeFactors(zoom: number): { scale: number; opacity: number };
}

/**
 * The datasets as the planner sees them
 *
 * The manager in `dataset/manager.ts` satisfies this shape. Only the structure is declared here,
 * so that the planner does not read a type from dataset/ (which sits above view/).
 */
export interface DrapePlannerDatasets {
  listInternal(): readonly DrapePlannerDataset[];
  /** Reports the datasets that hand their polygons and lines over to the drape */
  setDrapedDatasets(ids: ReadonlySet<string> | null): void;
}

/** What the planner needs for the whole life of the layer */
export interface DrapePlannerDeps {
  map: MapLibreMap;
  store: Store;
  terrain: TerrainContext;
  datasets?: DrapePlannerDatasets;
  /**
   * Whether the work that does not fit in a frame is spread over later frames (true when
   * omitted; the `timeSlicing` of the rendering settings)
   */
  timeSlicing?: boolean;
}

/** The inputs of one frame */
export interface DrapeFrameInput {
  gl: WebGL2RenderingContext;
  /** The style resolver the elements are collected with (called only when they are collected) */
  resolveStyles: () => RetainedStyleResolver;
  /** The terrain of the map (null when the terrain state of the frame is inactive) */
  mapTerrain: MapTerrain;
  /** The rendering pixel ratio, for widths fixed in screen pixels (the rendering scale included) */
  dpr: number;
  /** The rendering pixel ratio for widths that follow the zoom (the rendering scale not applied) */
  contentDpr: number;
  /** The style zoom (what the rendering reads) */
  zoom: number;
  /** The real zoom of the camera (the band is decided with it) */
  rawZoom: number;
}

/** The draw instructions of the analytic drape for one frame */
export interface DrapeFrameDraws {
  /** Whether the drape can be drawn (the shaders and the plan are ready) */
  readonly ready: boolean;
  readonly tileDraws: DrapeTileDrawEntry[];
  readonly pendingQuads: PendingQuad[];
  /**
   * When the drape could not be built, a slot is needed to draw the images that were to be
   * interleaved between the sections
   */
  readonly fallbackQuads: Feature[];
}

/** The diagnostic values of a frame without terrain */
const TERRAIN_OFF_DEBUG = {
  used: false,
  reason: 'terrain-off',
  featureCount: 0,
  edgeCount: 0,
  tileCount: 0,
  maxRunsPerCell: 0,
  maxEdgesPerCell: 0,
  maxTileEdges: 0,
  truncatedCells: 0,
  unfitTiles: 0,
  insideRuns: 0,
  excluded: 0,
  immediate: 0,
} as const;

/**
 * Plans the analytic drape frame by frame
 *
 * @internal
 */
export class DrapePlanner {
  private readonly deps: DrapePlannerDeps;

  /**
   * Store of the binning results per tile
   *
   * The index only changes on an edit or when the view is swapped, so it is cached per tile and
   * only the tiles that newly entered the view are built within the budget of the frame (there is
   * no re-binning every frame).
   */
  readonly tileStore = new DrapeTileStore();
  /** Factors per source (x = opacity, y = size). Rewritten every frame */
  readonly sourceFactors = new Float32Array(DRAPE_MAX_SOURCES * 2);

  /**
   * The analytic drape (the path that paints features as ground pixels)
   *
   * It is used only when the terrain is active and the features fit in the budget. When it
   * cannot be used, it falls back to the previous vertex displacement path (two stages).
   */
  private drapeRenderer: DrapeRenderer | null = null;
  /**
   * Analytic drape of the textured quads (Image, and the fill of a quad that carries text)
   *
   * It holds independently of the drape of polygons and lines. A quad does not need its style
   * packed into a texture and can be drawn with the uniforms of its four corners and a single
   * texture, so it can be used even in a frame where a dataset makes the polygons
   * and lines degenerate.
   */
  private quadDrapeRenderer: QuadDrapeRenderer | null = null;

  /** Revision of the features and styles (advanced by a Store change; triggers re-binning) */
  private revision = 0;
  /** Key of the conditions under which the elements were collected most recently */
  private collectKey = '';
  /** The set of elements collected most recently */
  private collected: DrapeCollectResult | null = null;
  /**
   * Whether it is light enough to use the analytic drape even in a wide band
   *
   * It is decided by the number of edges of the elements collected last. It does not hold for
   * heavy data such as administrative boundaries, and always holds on a map with only freehand
   * lines or a few polygons. It does not hold before collecting (the first time), so it switches
   * one frame late.
   */
  private lightEnough = false;
  /** The most recent plan */
  private plan: DrapePlan | null = null;
  /** Identifies the pack the current plan was built from (a new pack invalidates it) */
  private planPackId = -1;
  /** Number of frames in which the analytic drape has stayed usable */
  private stableFrames = 0;
  /** Number of consecutive frames that keep drawing with the previous plan */
  private stalePlanFrames = 0;
  /** The set of hand-overs currently reported to the datasets (kept to prevent flapping) */
  private handoff: ReadonlySet<string> | null = null;
  /** Whether the most recent frame left work for later frames (see `hasPendingWork`) */
  private pendingWork = false;

  constructor(deps: DrapePlannerDeps) {
    this.deps = deps;
  }

  /**
   * Whether the most recent frame left work that later frames finish on their own: tiles of the
   * index not built yet (the previous plan drawn meanwhile), or a hand-over to the datasets
   * waiting for the drape to stay usable (`DRAPE_STABLE_FRAMES`). A repaint is requested for
   * each, so the work finishes without the host doing anything
   */
  get hasPendingWork(): boolean {
    return this.pendingWork;
  }

  /** The drape renderer (null until a frame needed it, and after the GPU side was dropped) */
  get renderer(): DrapeRenderer | null {
    return this.drapeRenderer;
  }

  /**
   * The Store features that do not go on the drape (drawn by the other paths)
   *
   * Empty when there is no plan.
   */
  get excluded(): Set<string> {
    return this.plan?.excluded ?? new Set<string>();
  }

  /**
   * The breaks of the stacking order (images) of the pack being drawn
   *
   * They are taken from "the pack being drawn". Taking them from the pack that was just
   * collected would make the numbers disagree with the element list while the index is being
   * rebuilt (while the old pack is still being drawn), and the sectioned drawing would paint
   * different elements or nothing at all.
   */
  get quadBreaks(): readonly DrapeQuadBreak[] {
    return this.tileStore.quadBreaks;
  }

  /** Whether some element of the pack being drawn is selected */
  get hasSelection(): boolean {
    return (this.tileStore.pack?.markedCount ?? 0) > 0;
  }

  /**
   * Marks the collected elements stale (a change of the geometry, the style, the membership or
   * the order)
   */
  invalidate(): void {
    this.revision++;
  }

  /** The quad drape renderer (created on first use) */
  quadRenderer(gl: WebGL2RenderingContext): QuadDrapeRenderer {
    if (!this.quadDrapeRenderer) this.quadDrapeRenderer = new QuadDrapeRenderer(gl);
    return this.quadDrapeRenderer;
  }

  /**
   * Decides whether the analytic drape is used in this frame
   *
   * It also reports the datasets that hand their polygons and lines over to the drape, and
   * those it is actually painting in this frame.
   */
  planFrame(input: DrapeFrameInput): boolean {
    const { terrain } = this.deps;
    const { mapTerrain, dpr, contentDpr, zoom, rawZoom } = input;
    let drapeUsable = false;
    this.pendingWork = false;
    // The analytic drape is used even in a wide band when building the index is light. Cutting
    // uniformly by zoom alone would swap "a picture pinned to the ground" and "a flat picture" at
    // the boundary of the band, making the positions and the look of the features jump. It is
    // heavy only when the features are many, so it is decided by cost (the test on the amount is
    // inside prepare; here only the band is looked at)
    // The band is decided with the real zoom. The zoom that the rendering reads is a value that
    // absorbs the settlements while at rest, and it drifts up to about 0.2 from the real zoom.
    // Deciding the band with it would take the path out of the band while the real zoom is inside
    // it, making the features look peeled off the ground (beaded lines, flat polygons)
    // The elements are collected before the band is decided (the band is decided by cost, so the
    // cost has to be known first). The collected result is folded behind a key, so there is no
    // cost as long as the contents do not change
    if (mapTerrain !== null) this.collect(input.resolveStyles, dpr, contentDpr, zoom);
    const analyticBand = rawZoom > TERRAIN_ANALYTIC_MIN_ZOOM || this.lightEnough;
    if (mapTerrain !== null && analyticBand) {
      drapeUsable = this.prepare(input.gl, mapTerrain, input.resolveStyles, dpr, contentDpr, zoom);
    } else if (mapTerrain !== null) {
      // A wide band is handled by the vertex displacement path (no index is built either)
      this.plan = null;
      if (getTerrainDrapeDebug(terrain).reason !== 'wide-zoom') {
        setTerrainDrapeDebug(terrain, {
          ...getTerrainDrapeDebug(terrain),
          used: false,
          reason: 'wide-zoom',
        });
      }
    } else if (getTerrainDrapeDebug(terrain).reason !== 'terrain-off') {
      setTerrainDrapeDebug(terrain, { ...TERRAIN_OFF_DEBUG });
    }

    // Report the datasets that hand their polygons and lines to the analytic drape. A
    // dataset that handed them over does not push solid polygons and lines onto its retained
    // batch (the same thing is not drawn twice). The decision to hand over is made only once
    // things have settled (DRAPE_STABLE_FRAMES). It is released immediately only for a reason
    // that settles "the analytic path will not be used any more" (terrain off, wide band, budget
    // exceeded and so on), while a transient failure (an unresolved DEM) keeps the previous
    // decision. Releasing the hand-over on a single frame of jitter would run a storm of
    // re-baking polygons and lines on every pan.
    this.stableFrames = drapeUsable ? this.stableFrames + 1 : 0;
    if (drapeUsable && this.stableFrames >= DRAPE_STABLE_FRAMES) {
      this.handoff = this.collected?.drapedDatasets ?? null;
    } else if (drapeUsable) {
      // The hand-over is decided by the frames to come: they are asked for, so that it settles
      // on a map that is not moving as well
      this.pendingWork = true;
      this.deps.map?.triggerRepaint?.();
    } else {
      const reason = getTerrainDrapeDebug(terrain).reason;
      if (reason !== 'no-dem-tiles') this.handoff = null;
    }
    this.deps.datasets?.setDrapedDatasets(this.handoff);
    // "Whether it is actually painting right now" is reported as well. The hand-over decision
    // waits until things settle, so for the few frames between the drape starting to paint and
    // the decision coming back, only the selection highlight falls to the immediate path and
    // becomes a billboard (the reason is drapePaintedDatasets in terrain/context.ts)
    setDrapePaintedDatasets(terrain, drapeUsable ? (this.collected?.drapedDatasets ?? null) : null);
    return drapeUsable;
  }

  /** Records how many features went to the immediate path in a frame that used the drape */
  reportImmediate(count: number): void {
    const { terrain } = this.deps;
    setTerrainDrapeDebug(terrain, { ...getTerrainDrapeDebug(terrain), immediate: count });
  }

  /**
   * The draw instructions of the analytic drape (the stitching per tile is derived exactly
   * once)
   *
   * The sectioned drawing (interleaving the images, drawing a segment per slot) draws the same
   * tile several times, so the derivation is done once per frame.
   */
  buildDraws(input: {
    drapeUsable: boolean;
    shaderData: CustomRenderMethodInput['shaderData'];
    mapTerrain: MapTerrain;
    getProjectionData: CustomRenderMethodInput['getProjectionData'];
  }): DrapeFrameDraws {
    const { store, terrain } = this.deps;
    const { mapTerrain, getProjectionData } = input;
    let ready = false;
    const tileDraws: DrapeTileDrawEntry[] = [];
    const fallbackQuads: Feature[] = [];
    const pendingQuads: PendingQuad[] = [];
    const drawnQuadBreaks = input.drapeUsable ? this.tileStore.quadBreaks : [];
    const drapeRenderer = this.drapeRenderer;
    const drapePlan = this.plan;
    if (input.drapeUsable && drapeRenderer && drapePlan) {
      ready = drapeRenderer.ensure(input.shaderData, drapePlan.meshSize);
      if (!ready) {
        setTerrainDrapeDebug(terrain, {
          ...getTerrainDrapeDebug(terrain),
          used: false,
          reason: drapeRenderer.lastError || 'ensure-failed',
        });
        // The images that were to be interleaved between the sections are drawn by the first
        // slot. They are excluded from the later layer rendering, so without a drawer only the
        // images would disappear
        for (const brk of drawnQuadBreaks) {
          const quadFeature = store.getFeature(brk.featureId);
          if (!quadFeature?.visible || isLocallyHidden(quadFeature, store)) continue;
          fallbackQuads.push(quadFeature);
        }
      } else {
        // The DEM is looked up once per tile in this frame. The same tile also shows up as the
        // constraint source of a neighbour, so the repeated lookups are folded here
        const frameTerrain = new Map<RenderableTerrainTile, TerrainTileData | null>();
        const terrainOf = (tile: RenderableTerrainTile): TerrainTileData | null => {
          const hit = frameTerrain.get(tile);
          if (hit !== undefined) return hit;
          const data = mapTerrain ? getTerrainTileData(mapTerrain, tile) : null;
          frameTerrain.set(tile, data);
          return data;
        };

        // Fix the tiles that are actually drawn in this frame first. The "neighbour" of the
        // stitching is taken from here. Treating a tile that is not drawn as a neighbour would
        // constrain to a polyline that nobody draws
        const drawable: Array<{
          plan: DrapePlanTile;
          terrain: TerrainTileData;
          projection: ProjectionData;
        }> = [];
        for (const planTile of drapePlan.tiles) {
          // The DEM texture and matrix are the values of this frame. Baking them in would keep
          // solving the ground with the coarse elevation of the moment the parent tile stood in.
          const data = terrainOf(planTile.tile);
          if (!data) continue;

          // getProjectionData throws when the shape of tileID does not match. This keeps the
          // whole rendering from failing if it changes between versions.
          let tileProjection: ProjectionData | null = null;
          try {
            tileProjection = getProjectionData({
              tileID: planTile.tile.tileID as Parameters<typeof getProjectionData>[0]['tileID'],
            });
          } catch {
            tileProjection = null;
          }
          if (!tileProjection) continue;
          drawable.push({ plan: planTile, terrain: data, projection: tileProjection });
        }

        const drawnKeys = buildTileKeySet(drawable.map((d) => d.plan.tile));
        const drawnByKey = new Map<string, RenderableTerrainTile>();
        for (const item of drawable) drawnByKey.set(wrappedTileKey(item.plan.tile), item.plan.tile);

        // The step, the coordinate transform, the spacing and the DEM of the constraint target
        // are all derived here. They all come from the same single moment of the terrain tile
        // state, so the mismatch "the DEM is new but the step is old" cannot happen. An edge
        // whose neighbour DEM cannot be looked up drops the constraint itself (keeping only the
        // spacing would constrain to a polyline that samples its own DEM coarsely, and the crack
        // would come back just there)
        const segmentMeshSize = drapePlan.meshSize;
        for (const item of drawable) {
          const edges = resolveTileEdges(drawnKeys, item.plan.tile, segmentMeshSize, (n) => {
            const neighbor = drawnByKey.get(wrappedTileKey(n));
            return neighbor ? terrainOf(neighbor) : null;
          });
          tileDraws.push({
            draw: {
              tileID: item.plan.tile.tileID,
              terrain: item.terrain,
              cellOffset: item.plan.cellOffset,
              grid: item.plan.grid,
              groundMeters: item.plan.groundMeters,
              edges,
            },
            projection: item.projection,
          });
        }

        // The breaks of the stacking order (images). The element list is cut at the positions of
        // the images, each section is drawn as a range, and the quad drape of the image is
        // interleaved in between.
        const elementsTotal = this.tileStore.elementCount;
        for (const brk of drawnQuadBreaks) {
          const quadFeature = store.getFeature(brk.featureId);
          if (!quadFeature?.visible || isLocallyHidden(quadFeature, store)) continue;
          pendingQuads.push({
            at: Math.min(brk.afterElements, elementsTotal),
            feature: quadFeature,
          });
        }
      }
    }
    return { ready, tileDraws, pendingQuads, fallbackQuads };
  }

  /**
   * Drops the GPU side (the drape renderers) and what points into it
   *
   * The plan and the index point into the pack uploaded to the drape renderer, so they go with
   * it (the next frame collects and uploads again).
   */
  releaseGpu(): void {
    if (this.drapeRenderer) {
      this.drapeRenderer.dispose();
      this.drapeRenderer = null;
    }
    if (this.quadDrapeRenderer) {
      this.quadDrapeRenderer.dispose();
      this.quadDrapeRenderer = null;
    }
    this.plan = null;
    this.planPackId = -1;
    this.collectKey = '';
    this.collected = null;
    this.tileStore.clear();
  }

  /**
   * Collects the elements (called before the band is decided)
   *
   * The band (the range of zooms where the analytic drape is used) is decided by "the cost of
   * building the index", so the elements have to be collected first for the cost to be known. If
   * they were collected only inside the band, a map opened at a wide zoom would never learn the
   * cost and would stay outside the band even when it is light (in the field this appeared as
   * "polygons are not drawn at low zooms"). The collected result is folded behind a key, so from
   * the second time on nothing happens as long as the contents do not change.
   */
  private collect(
    resolveStyles: () => RetainedStyleResolver,
    dpr: number,
    contentDpr: number,
    zoom: number,
  ): DrapeCollectResult {
    const { store, datasets: manager } = this.deps;
    const datasets = manager?.listInternal() ?? [];
    const key = [
      this.revision,
      dpr,
      contentDpr,
      marginZoom(zoom),
      store.getLayerOrder().join('/'),
      datasets.map((c) => `${c.id}:${c.drapeRevision}:${c.visible ? 1 : 0}:${c.order}`).join(','),
      bakedLayerOpacityKey(store, datasets.length),
    ].join('|');

    let collected = this.collected;
    if (key !== this.collectKey || !collected) {
      collected = collectDrapeElements(store, resolveStyles(), dpr, contentDpr, datasets);
      this.collectKey = key;
      this.collected = collected;
      this.lightEnough = collected.edgeCount <= DRAPE_WIDE_EDGE_BUDGET;
      this.tileStore.sync(
        key,
        collected.elements,
        collected.quadBreaks,
        collected.entryStarts,
        collected.aboveStoreStart,
      );
    }
    return collected;
  }

  /**
   * Preparation of the analytic drape (indexing the tiles)
   *
   * The elements are collected only "when the contents, the styles or the stacking order
   * changed", and the tiles are indexed only "when a new tile entered the view". The elements are
   * not collected again just because the view moved (collecting them again would mean rebuilding
   * the whole index).
   */
  private prepare(
    gl: WebGL2RenderingContext,
    terrain: NonNullable<MapTerrain>,
    resolveStyles: () => RetainedStyleResolver,
    dpr: number,
    contentDpr: number,
    zoom: number,
  ): boolean {
    const { map, datasets: manager } = this.deps;
    const context = this.deps.terrain;

    const tiles = getRenderableTerrainTiles(terrain);
    if (tiles.length === 0) return false;

    const datasets = manager?.listInternal() ?? [];
    const collected = this.collect(resolveStyles, dpr, contentDpr, zoom);

    // The factors per source (which follow the zoom) are rewritten every frame, because baking
    // them into the elements would mean rebuilding the index on every zoom movement
    const drapeSourceFactors = this.sourceFactors;
    drapeSourceFactors.fill(1);
    for (let i = 0; i < datasets.length && i + 1 < DRAPE_MAX_SOURCES; i++) {
      const factors = datasets[i].drapeFactors(zoom);
      drapeSourceFactors[(i + 1) * 2] = factors.opacity;
      drapeSourceFactors[(i + 1) * 2 + 1] = factors.scale;
    }
    // The opacity of each Store layer goes into its own source (read from the Store every frame,
    // so a change of the opacity does not rebuild the index)
    for (const [layerId, source] of collected.layerSources) {
      drapeSourceFactors[source * 2] = layerDrawFactors(this.deps.store.getLayer(layerId)).opacity;
    }

    // The selection highlight is reported every frame too. It does not touch the index
    // (binning); only one texel of the style table changes. Mixing the selection into the key of
    // the dataset would rebuild the index of every tile on every single click.
    const selectionKeys = new Set<string>();
    for (const dataset of datasets) {
      for (const id of dataset.getSelectedIds()) {
        selectionKeys.add(drapeSelectionKey(dataset.id, id));
      }
    }
    this.tileStore.setSelection(selectionKeys);

    const usable = canDrape({ vertexCount: collected.vertexCount });
    const debugBase = {
      featureCount: collected.elements.length,
      edgeCount: collected.edgeCount,
      tileCount: tiles.length,
      maxRunsPerCell: 0,
      maxEdgesPerCell: 0,
      maxTileEdges: 0,
      truncatedCells: 0,
      unfitTiles: 0,
      insideRuns: 0,
      excluded: collected.excluded.size,
      immediate: 0,
    };
    if (!usable || collected.elements.length === 0) {
      setTerrainDrapeDebug(context, {
        ...debugBase,
        used: false,
        reason: collected.elements.length === 0 ? 'no-drapeable-features' : 'vertex-budget',
      });
      this.plan = { tiles: [], excluded: collected.excluded, usable: false, meshSize: 128 };
      return false;
    }

    // Prepare the tile index (only the new tiles, within the budget of the frame). Skipping it
    // while moving was introduced once and then withdrawn: during a zoom almost every tile
    // becomes a "new tile", so the fills vanish entirely and are seen coming back one tile at a
    // time after the movement stops. The occasional build hitch (27 to 59 ms on a huge wide-area
    // tile) remains, but it is milder than fills that keep disappearing.
    const drapeTiles: DrapeTile[] = tiles.map((t) => ({ x: t.x, y: t.y, z: t.z }));
    const budget = this.deps.timeSlicing === false ? Number.POSITIVE_INFINITY : DRAPE_BIN_BUDGET_MS;
    const prepared = this.tileStore.prepare(drapeTiles, budget, marginZoom(zoom));
    if (prepared.pending) {
      this.pendingWork = true;
      map?.triggerRepaint?.();
    }
    debugBase.maxTileEdges = prepared.maxTileEdges;
    debugBase.truncatedCells = prepared.truncatedCells;
    debugBase.unfitTiles = prepared.unfitTiles;
    debugBase.maxEdgesPerCell = prepared.maxEdgesPerCell;
    debugBase.maxRunsPerCell = prepared.maxRunsPerCell;
    if (prepared.overflow) {
      setTerrainDrapeDebug(context, { ...debugBase, used: false, reason: 'cell-overflow' });
      this.plan = { tiles: [], excluded: collected.excluded, usable: false, meshSize: 128 };
      return false;
    }

    if (!this.drapeRenderer) this.drapeRenderer = new DrapeRenderer(gl);
    const meshSize = getTerrainMeshSize(terrain);

    const planTiles: DrapePlanTile[] = [];
    // The number of tiles that have a DEM but whose index could not be built yet. When the zoom
    // step changes, the tiles of the view are replaced wholesale and, within the budget
    // (DRAPE_BIN_BUDGET_MS), they can only be built over several frames. Such a tile cannot be
    // drawn meanwhile, so a single missing coarse tile in the distance blanks a wide part of the
    // screen for a moment
    let unindexed = 0;
    // An edge whose neighbour is a coarser tile constrains its elevation to the polyline of the
    // coarse side (this removes the gap of a T junction by construction; terrain/drape/stitch.ts)
    for (const tile of tiles) {
      // A tile without a single DEM cannot be drawn later either, so it is dropped. The texture
      // itself is looked up again on every draw, so it is not held here.
      if (!getTerrainTileData(terrain, tile)) continue;
      const entry = this.tileStore.entryOf(tile);
      // A tile whose index is not built yet appears on a later frame (drawing continues with the
      // previous pack, so what is already shown never disappears)
      if (!entry) {
        unindexed++;
        continue;
      }
      // "The ground size of that tile", used for the gradient of the shading
      const tileLat = tileCenterLatitude(tile.y, tile.z);
      const groundMeters = circumferenceAtLatitude(tileLat) / 2 ** tile.z;
      // The stitching per edge is not decided here. The step, the coordinate transform and the
      // spacing are derived at the same single moment as the DEM they are bundled with (right
      // before drawing)
      planTiles.push({ tile, cellOffset: entry.cellOffset, grid: entry.grid, groundMeters });
    }
    const pack = this.tileStore.pack;
    const drapePlan = this.plan;
    if (planTiles.length === 0 || !pack) {
      // In a transient state (only the DEM / index of a new region entered by panning is
      // unresolved) the previous plan is kept and drawing continues. Falling back to an empty
      // plan here would make drapeUsable false for one frame, so the "hand-over" of the
      // datasets would flap between released and restored, and a storm of re-baking polygons
      // and lines (chunk.step on the order of 30 ms) plus a re-collection of drape.collect would
      // run on every pan (measured). The tiles of the previous plan look their DEM up again at
      // draw time, so what is still in view keeps coming out correctly and what disappeared is
      // replaced at the next resolution.
      if (drapePlan?.usable && drapePlan.tiles.length > 0) {
        setTerrainDrapeDebug(context, { ...debugBase, used: true, reason: 'stale-plan' });
        return true;
      }
      setTerrainDrapeDebug(context, { ...debugBase, used: false, reason: 'no-dem-tiles' });
      this.plan = { tiles: [], excluded: collected.excluded, usable: false, meshSize };
      return false;
    }

    // While the index is incomplete, drawing continues with the previous plan if that one covers
    // more of the view. Drawing with only the tiles that could be built makes the distance drop
    // out for one frame in the middle of a zoom, which looks like a flash. The tiles of the
    // previous plan look their DEM up again on every draw, so their positions are correct and
    // only the index is coarse. To keep it from settling into the previous plan forever, it is
    // kept for a limited number of frames only
    if (
      unindexed > 0 &&
      drapePlan?.usable &&
      drapePlan.tiles.length > planTiles.length &&
      // The positions of the previous plan are positions within the pack it was built from.
      // Drawing with the previous plan after the pack was swapped would point into the index of
      // a different pack
      this.planPackId === pack.id
    ) {
      this.stalePlanFrames++;
      if (this.stalePlanFrames <= DRAPE_STALE_PLAN_MAX_FRAMES) {
        setTerrainDrapeDebug(context, {
          ...debugBase,
          used: true,
          reason: 'stale-plan',
          tileCount: drapePlan.tiles.length,
        });
        this.pendingWork = true;
        map?.triggerRepaint?.();
        return true;
      }
    } else {
      this.stalePlanFrames = 0;
    }

    const uploaded = this.drapeRenderer?.upload(pack) ?? false;
    if (!uploaded) {
      // The tables do not fit in the textures of this GPU: the frame is drawn without the
      // analytic drape, like an index over its budget
      setTerrainDrapeDebug(context, { ...debugBase, used: false, reason: 'texture-limit' });
      this.plan = { tiles: [], excluded: collected.excluded, usable: false, meshSize };
      return false;
    }
    setTerrainDrapeDebug(context, {
      ...debugBase,
      used: true,
      reason: 'ok',
      tileCount: planTiles.length,
    });
    this.plan = { tiles: planTiles, excluded: collected.excluded, usable: true, meshSize };
    this.planPackId = pack.id;
    return true;
  }
}

/**
 * The opacities of the Store layers that have no drape source of their own
 *
 * Those layers have their opacity baked into the colors of their elements, so a change of it
 * has to collect the elements again. Empty while every layer has a source (the usual case).
 */
function bakedLayerOpacityKey(store: Store, datasetCount: number): string {
  let key = '';
  let layerIndex = 0;
  for (const layerId of store.getLayerOrder()) {
    const layer = store.getLayer(layerId);
    if (!layer) continue;
    if (drapeLayerSource(layerIndex++, datasetCount) === 0) {
      key += `${layerId}:${layerDrawFactors(layer).opacity},`;
    }
  }
  return key;
}
