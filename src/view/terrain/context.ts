// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The owner of the terrain rendering state (one per draw instance)
 *
 * The terrain state mixes two kinds of things: "values valid only for that frame" and
 * "records carried across frames". The former alone would be fine as a module global (the
 * same practice as `shaders/frame.ts`), but putting the latter in a global breaks when a page
 * has several rendering instances.
 *
 * How it actually broke: when a page has several maps (the main one, a thumbnail, a print
 * preview and so on) each has its own Map and CustomLayer. The subdivision generation counter
 * counts from 0 per CustomLayer, yet the place that value was written to was a single global.
 * Retained batches (`layer/store-retained.ts`) decide whether to re-bake by "the global
 * generation vs their own record", so whenever the counters of two instances happened to
 * coincide the change was invisible and flat geometry baked before the terrain came alive was
 * never rebuilt. The subdivision cache (`cache/terrain-fill.ts`) was shared by feature id as
 * well, so when the generations coincided by chance it returned triangles subdivided with
 * another instance's step (the shape where only the summit becomes a tent).
 *
 * So the whole state is collected into this class and each CustomLayer owns one. There is no
 * module-level "current" context: every reader (state.ts / anchor.ts / occlusion.ts /
 * polygon.ts) takes the context explicitly. The renderers of a CustomLayer receive their
 * instance's context at construction, extension renderers receive it in the draw context
 * (`FrameDrawContext.terrain`), hit testing uses the anchor projection bound per map
 * (`installAnchorProjector`), and plugins use the projection bound to their instance
 * (`PluginContext.projectAnchor`). A read from outside rendering therefore always sees its own
 * instance, never "the instance drawn last".
 */

import { TerrainFillCache } from '../cache/terrain-fill.js';
import type { OffsetUniforms } from '../shaders/helpers.js';
import type { TerrainLike } from './detect.js';
import type { QuadDrapeFrame } from './drape/quad.js';
import { TerrainCoverage, type TerrainElevationQuery } from './ground.js';
import type { TerrainShadeLight } from './shade.js';
import type { MercatorRect, TessellationTiling } from './tessellation.js';

/**
 * The terrain state of one frame: whether the terrain is drawn and the DEM atlas the shaders
 * read elevations from.
 */
export interface TerrainRenderState {
  /** Whether the terrain is enabled and the DEM atlas is usable */
  readonly active: boolean;
  /** The DEM atlas (not terrarium, but RGBA8 packing the elevation as 24-bit fixed point) */
  readonly atlasTexture: WebGLTexture | null;
  /** The Mercator rectangle the atlas covers, [x0, y0, 1/width, 1/height] */
  readonly atlasRect: readonly [number, number, number, number];
  /** The number of texels of the atlas, [width, height] */
  readonly atlasSize: readonly [number, number];
  /** The conversion factor from meters to Mercator z (represented by the latitude of the
   * screen center) */
  readonly elevationScale: number;
  /** The lift above the ground (in meters). A rendering implementation value to avoid
   * Z-fighting */
  readonly liftMeters: number;
  /** The subdivision step (in meters). 0 means no subdivision */
  readonly stepMeters: number;
  /**
   * The grid spacing of the subdivision (in Mercator units)
   *
   * The node spacing 1/(2^z * meshSize) of MapLibre's terrain mesh. Placing the subdivision
   * points on this grid makes our own polygons agree with MapLibre's terrain surface at the
   * nodes.
   */
  readonly stepGrid: number;
  /**
   * The range that may be subdivided (Mercator; null means no range)
   *
   * The rectangle the DEM atlas covers plus a margin. Outside it the elevation is clamped to
   * the edge value, so there is no point in subdividing and doing so only piles up cost
   * proportional to the number of features. The range is recomputed only when the atlas moves
   * outside it (hysteresis).
   *
   * @internal
   */
  readonly tessellationRegion: MercatorRect | null;
  /**
   * The index of the actual mesh step per terrain tile
   *
   * MapLibre draws the ground on a fixed grid per tile. Unless the subdivision step matches
   * that grid, it sinks in valley floors when too fine and dives under ridges when too coarse.
   *
   * @internal
   */
  readonly tessellationTiling: TessellationTiling | null;
  /**
   * The generation of the subdivision
   *
   * When the step changes, the subdivision baked on the CPU side (the fill and outline of
   * polygons) becomes stale. Retained batches rebuild on a change of this value. It is counted
   * per instance, so it is never compared with another instance's generation.
   */
  readonly generation: number;
}

/** The state when the terrain is disabled */
export const INACTIVE_TERRAIN_STATE: TerrainRenderState = {
  active: false,
  atlasTexture: null,
  atlasRect: [0, 0, 1, 1],
  atlasSize: [1, 1],
  elevationScale: 0,
  liftMeters: 0,
  stepMeters: 0,
  stepGrid: 0,
  tessellationRegion: null,
  tessellationTiling: null,
  generation: 0,
};

/**
 * The sides of the cells the globe cuts the geometry into, in Mercator world units
 *
 * @internal
 */
export interface GlobeGrids {
  /** The cell of the fills and their outlines */
  readonly fill: number;
  /** The cell of the lines */
  readonly line: number;
}

/**
 * Which drape path drew the quads of the last frame, for diagnostics.
 *
 * It exists so that hands-on verification can confirm "which of the paths is running on the
 * screen right now". It is not used for rendering.
 */
export interface TerrainDrapeDebug {
  /** Whether the analytic drape was used */
  used: boolean;
  /** The reason it was not used */
  reason: string;
  /** The number of features put on the drape */
  featureCount: number;
  /** The total number of edges */
  edgeCount: number;
  /** The number of tiles drawn */
  tileCount: number;
  /** The maximum number of runs per cell */
  maxRunsPerCell: number;
  /** The maximum number of edges per cell */
  maxEdgesPerCell: number;
  /** The maximum number of edges involved in a single tile of the view */
  maxTileEdges: number;
  /** The number of cells truncated for exceeding the budget (a local degradation) */
  truncatedCells: number;
  /** The number of tiles that could not be put through the analytic evaluation and were not
   * drawn */
  unfitTiles: number;
  /** The number of runs whose cell origin was inside the feature */
  insideRuns: number;
  /** The number of features that did not go on the drape and were routed to the previous
   * path */
  excluded: number;
  /** The number of features actually handed to the previous path */
  immediate: number;
}

/** The initial diagnostic values */
export const INITIAL_DRAPE_DEBUG: TerrainDrapeDebug = {
  used: false,
  reason: 'not-evaluated',
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
};

/**
 * The values needed for this frame's anchor projection
 */
export interface AnchorFrame {
  terrain: TerrainLike | null;
  /**
   * The map the ground elevation is asked from (`map.queryTerrainElevation`, `ground.ts`).
   * null where there is none (tests); then the elevation of the current zoom level is used
   */
  elevationQuery: TerrainElevationQuery | null;
  /** The same value as MapLibre's transform.tileZoom (the zoom level of the fallback) */
  tileZoom: number;
  /** The factor from meters to Mercator z (represented by the latitude of the screen
   * center) */
  elevationScale: number;
  /** The projection matrix being handed to the vertex shader */
  mainMatrix: number[] | null;
  /** The uniforms of offset mode (the center of the linearization) */
  offsetUniforms: OffsetUniforms | null;
  /** Whether offset mode is used (the same as the shader's u_use_offset_mode) */
  useOffsetMode: boolean;
  /** The viewport (in CSS pixels, the same unit as map.project) */
  width: number;
  height: number;
  /**
   * The camera position (Mercator; z is meters converted into Mercator)
   *
   * Used to decide whether a symbol is occluded by the terrain, along the segment from the
   * camera to the anchor (`occlusion.ts`). It is null in environments where it cannot be
   * obtained, and is then treated as not occluded.
   */
  cameraMercator: readonly [number, number, number] | null;
}

/** The frame used when the anchor projection is unavailable */
export const INACTIVE_ANCHOR_FRAME: AnchorFrame = {
  terrain: null,
  elevationQuery: null,
  tileZoom: 0,
  elevationScale: 0,
  mainMatrix: null,
  offsetUniforms: null,
  useOffsetMode: false,
  width: 0,
  height: 0,
  cameraMercator: null,
};

/**
 * The terrain state of one draw instance.
 *
 * Treat it as an opaque handle: a custom renderer receives it as
 * `FrameDrawContext.terrain` and passes it to the renderers and to the terrain
 * functions (such as {@link drawQuadSurfaceOnTerrain} and {@link terrainTessellationStep}).
 * Constructing one gives a state with no terrain.
 */
export class TerrainContext {
  /** This frame's terrain state (read by the shaders' projection uniforms) */
  renderState: TerrainRenderState = INACTIVE_TERRAIN_STATE;

  /**
   * Suppression of adding elevation to vertices
   *
   * UI drawn as a rectangle on the screen (the rubber band of a box selection) stops being a
   * rectangle once it is pasted onto the ground. The elevation is stopped only for such
   * rendering.
   *
   * @internal
   */
  elevationSuppressed = false;

  /**
   * Whether this is a frame that draws polygons and lines flat (the band where they cannot be
   * made to follow the ground)
   *
   * In the zoomed-out band (z <= TERRAIN_ANALYTIC_MIN_ZOOM) the analytic drape is not used and
   * polygons and lines are drawn by vertex displacement. In that band, however, the
   * subdivision range (the DEM atlas intersected with the view) covers only a tiny part of the
   * screen. Triangles outside the range are emitted without being subdivided, so only their
   * vertices pick up an elevation while their interior pierces the mountain, and in a pitched
   * view this becomes a vertical curtain (a cliff). The baked shape is not rebuilt until the
   * camera stops, so during a zoom gesture the shape of an even older range is drawn.
   *
   * Over a wide area the relief amounts to only a dozen or so pixels on screen (the same
   * reason the depth test is turned off). So polygons and lines are drawn without adding an
   * elevation. The picture simply becomes the same as with the terrain off, and the cliff
   * disappears by construction.
   *
   * Points, handles and symbols are out of scope. A symbol decided by a single vertex does not
   * interpolate anything in between and so creates no cliff, and stopping its elevation would
   * make it disagree with hit testing (the anchor projection).
   *
   * @internal
   */
  surfacesFlattened = false;

  /**
   * The IDs of the datasets whose polygons and lines the analytic drape paints in this
   * frame
   *
   * The decision "was it handed over to the drape" (whether to pile polygons and lines into
   * the retained batch) is switched only after it has settled for several frames, to avoid
   * flapping. That creates a window of several frames in which "the drape is already painting
   * but the hand-over decision has not come back yet". If the immediate path draws the
   * selection highlight during that window, everything outside the subdivision range becomes a
   * flat slab floating above the terrain. Which way the highlight is drawn is therefore
   * decided not by the decision but by whether it is actually being painted right now.
   *
   * @internal
   */
  drapePaintedDatasets: ReadonlySet<string> | null = null;

  /**
   * The light source of this frame's shading (null in a frame with no terrain)
   *
   * Read by the polygon fill of the vertex displacement path (`shaders/projection.ts` writes
   * it into the uniforms). The analytic drape carries the light source in its own draw
   * instructions, so this exists only to "deliver the same light to the other path as well".
   * The light changes with the bearing, so it is set again every frame.
   *
   * @internal
   */
  shadeLight: TerrainShadeLight | null = null;

  /**
   * The diagnostic values of the analytic drape
   *
   * @internal
   */
  drapeDebug: TerrainDrapeDebug = INITIAL_DRAPE_DEBUG;

  /**
   * The entry point of this frame's quad analytic drape (null when the terrain is disabled)
   *
   * Images and the fill of text quads are drawn by QuadShader. CustomLayer puts it here
   * every frame and QuadShader reads it and enters the path that "pastes it as ground pixels".
   * It is always reset to null at the end of the frame, so it is never read from outside
   * rendering.
   *
   * @internal
   */
  quadDrapeFrame: QuadDrapeFrame | null = null;

  /**
   * The subdivision grid spacing of the previous frame (Mercator). 0 means no terrain
   *
   * Used to decide whether to advance the generation. It is a per-instance value.
   *
   * This must not be looked at in meters. The conversion of the step into meters involves the
   * latitude (`stepGrid * circumferenceAtLatitude(centerLat)`), so the value changes even when
   * a pan moves the latitude by a single millidegree, and the generation advances every frame.
   * Retained batches re-bake on a change of generation, so this amounts to "re-baking
   * everything on every pan" (measured, frames during a pan reached 90 to 120 milliseconds).
   * The grid spacing is a power of 2 in Mercator, so it changes only when a zoom level is
   * crossed.
   *
   * @internal
   */
  stepGrid = 0;

  /**
   * The generation of the subdivision (a serial number closed within this instance)
   *
   * @internal
   */
  generation = 0;

  /**
   * The coarseness of the step actually used in this generation (1 = the terrain mesh nodes
   * themselves)
   *
   * When a batch is subdivided coarsely for budget reasons, the chords of the coarse triangles
   * dive under the hills of the terrain. The amount they dive grows in proportion to the step,
   * so the depth bias is increased in proportion as well (gl.polygonOffset in view/layer/gl-state.ts).
   * The renderer reports it on every build, and it is returned to 1 when the generation
   * changes.
   *
   * @internal
   */
  tessellationCoarsening = 1;

  /**
   * The most recently decided subdivision range (Mercator)
   *
   * It is not recomputed while the atlas stays inside this rectangle. Recomputing it every
   * frame to match the atlas would cause retained batches to be re-baked on every pan.
   *
   * @internal
   */
  tessellationRegion: MercatorRect | null = null;

  /**
   * The most recently built index of tile steps (recomputed at the same time as the range)
   *
   * @internal
   */
  tessellationTiling: TessellationTiling | null = null;

  /**
   * The frame of the anchor projection
   *
   * @internal
   */
  anchorFrame: AnchorFrame = INACTIVE_ANCHOR_FRAME;

  /**
   * The elevation cache within a single frame
   *
   * Hit testing calls project on the same vertex many times (hit testing, thinning, bbox). It
   * costs about 3.5us per point, so it is worth reusing within a frame. It is thrown away
   * every frame because the value may change once the DEM arrives in a new frame.
   *
   * @internal
   */
  elevationCache = new Map<string, number>();

  /**
   * The generation of the DEM coverage
   *
   * When the set of DEM tiles being drawn changes (a tile arrives, or the zoom changes), the
   * already baked elevations become stale. Retained batches fetch the elevations again on a
   * change of this value.
   *
   * @internal
   */
  elevationGeneration = 0;

  /**
   * The terrain tiles maplibre drew in the most recent frame (where the anchors read the drawn
   * surface, `ground.ts`)
   *
   * @internal
   */
  readonly coverage = new TerrainCoverage();

  /**
   * The identifier of the DEM tile set seen most recently
   *
   * @internal
   */
  get coverageKey(): string {
    return this.coverage.key;
  }

  /**
   * Whether the camera is in motion (custom-layer writes it every frame)
   *
   * While it is moving, re-baking of retained batches is deferred. Re-baking during a gesture
   * makes that one frame take several hundred milliseconds and the gesture catch, and it would
   * have to be redone once the motion ends anyway.
   *
   * @internal
   */
  cameraMoving = false;

  /**
   * The cache of occlusion tests within a single frame
   *
   * The same anchor is looked up many times in one frame (rendering and collision testing).
   * The result changes once the camera moves, so it is thrown away every frame just like the
   * elevation cache.
   *
   * @internal
   */
  occlusionCache = new Map<string, boolean>();

  /**
   * The Mercator cells the globe asks the geometry to be cut into in this frame (null on a
   * flat map)
   *
   * The context carries it because it is what every renderer of the instance holds: the cut
   * of the globe goes through the same subdivision as the terrain (`view/globe-subdivision.ts`
   * gives the step to the renderers when the terrain gives none).
   *
   * @internal
   */
  globeGrids: GlobeGrids | null = null;

  /**
   * The generation of the globe cells (a serial number closed within this instance)
   *
   * It advances when the globe starts or stops being drawn and when a cell changes size, so
   * the retained batches that baked the old cut are rebuilt.
   *
   * @internal
   */
  globeGeneration = 0;

  /**
   * The subdivision cache of polygon fills
   *
   * It depends on the generation and the step, so it is held per instance. Sharing it by
   * feature id would pick up triangles subdivided with another instance's step.
   *
   * @internal
   */
  readonly fillCache = new TerrainFillCache();

  /**
   * Returns the state to its initial values (when the layer is destroyed)
   *
   * @internal
   */
  reset(): void {
    this.renderState = INACTIVE_TERRAIN_STATE;
    this.elevationSuppressed = false;
    this.shadeLight = null;
    this.drapeDebug = INITIAL_DRAPE_DEBUG;
    this.stepGrid = 0;
    this.tessellationRegion = null;
    this.tessellationTiling = null;
    this.tessellationCoarsening = 1;
    this.anchorFrame = INACTIVE_ANCHOR_FRAME;
    this.elevationCache = new Map();
    this.occlusionCache = new Map();
    this.coverage.clear();
    this.fillCache.clear();
    this.globeGrids = null;
  }
}

/**
 * Releases an instance's terrain state (when the layer is destroyed)
 */
export function releaseTerrainContext(context: TerrainContext): void {
  context.reset();
}
