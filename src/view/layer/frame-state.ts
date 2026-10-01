// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The state of one frame
 *
 * The first slot of a frame builds a `FrameState` (`buildFrameState`) and every slot of the
 * frame reads it. It holds only results that do not depend on GL (maplibre resets the GL state
 * for every slot): the zoom, the terrain state, the drape plan of the frame, the features of the
 * immediate path, the selection, the overlay renderers and the copies of the world in view. The
 * drawing of the slots is in frame-render.ts.
 */

import type { CustomRenderMethodInput, Map as MapLibreMap, ProjectionData } from 'maplibre-gl';
import type {
  EngineOverlayRenderer,
  FrameDrawContext,
  LayeredOverlayRenderer,
} from '../../extension/index.js';
import { isLocallyHidden } from '../../store/local-visibility.js';
import type { Store } from '../../store/store.js';
import type { Feature } from '../../store/types.js';
import {
  calculateOffsetUniforms,
  type OffsetUniforms,
  translateMatrixByLongitude,
} from '../shaders/helpers.js';
import { anchorViewportOf, clearAnchorFrame, setAnchorFrame } from '../terrain/anchor.js';
import type { TerrainContext, TerrainRenderState } from '../terrain/context.js';
import {
  getCameraMercator,
  getMapTerrain,
  getRenderableTerrainTiles,
  getTerrainMeshSize,
  getTerrainTileData,
  type RenderableTerrainTile,
  type TerrainTileData,
} from '../terrain/detect.js';
import type { QuadDrapeFrame } from '../terrain/drape/quad.js';
import { type DrapeLight, resolveDrapeLight } from '../terrain/drape/renderer.js';
import { setQuadDrapeFrame, setTerrainSurfacesFlattened } from '../terrain/state.js';
import { getSelectedFeatureIds } from '../ui/helper.js';
import { applyDrawBlendState } from './blend.js';
import type { DisplayListCache } from './display-list.js';
import {
  type DrapePlanner,
  type DrapeTileDrawEntry,
  type MapTerrain,
  type PendingQuad,
  TERRAIN_ANALYTIC_MIN_ZOOM,
} from './drape-planner.js';
import type { RenderLayersView } from './render.js';
import type { Renderers } from './renderers.js';
import type { RenderSegment } from './slots.js';

/**
 * One copy of the world drawn in this frame
 *
 * Away from the antimeridian a frame draws one copy, the stored one (lngShift 0). A view
 * across the antimeridian draws a second copy: the features stored on the other side of the
 * line, moved by 360 degrees, through a virtual camera (the center moved by -lngShift and the
 * matrix by +lngShift; `translateMatrixByLongitude` in shaders/helpers.ts). Everything that
 * is not pinned per terrain tile goes through it: the layers, the datasets, the
 * selection UI and the overlays. The analytic drape is drawn per terrain tile with the matrix
 * maplibre gives each tile (the tiles carry their wrap), so it is drawn once.
 */
export interface CopyPass {
  readonly lngShift: number;
  /** The part of the view on this copy (undefined = the expanded viewport, one copy) */
  readonly view: RenderLayersView | undefined;
  readonly projectionData: CustomRenderMethodInput['defaultProjectionData'];
  readonly offsetUniforms: OffsetUniforms;
  readonly customRendererContext: FrameDrawContext;
  /** The features drawn in immediate mode on this copy */
  readonly features: Feature[];
  /** The selected features whose selection UI is drawn on this copy */
  readonly selectedFeatures: Feature[];
  /** The terrain state with the DEM atlas placed in the frame of the virtual camera */
  readonly terrainState: TerrainRenderState;
}

/**
 * Shared state of one frame
 *
 * The first slot builds it in the preparation and the following slots read it. maplibre resets
 * the GL state for every slot, so only results that do not depend on GL are put here.
 */
export interface FrameState {
  readonly segments: readonly RenderSegment[];
  readonly layerOrder: readonly string[];
  /** Number of the slot drawn most recently (a new frame when the next slot is at most this) */
  lastIndex: number;
  readonly shaderData: CustomRenderMethodInput['shaderData'];
  readonly defaultProjectionData: CustomRenderMethodInput['defaultProjectionData'];
  readonly getProjectionData: CustomRenderMethodInput['getProjectionData'];
  readonly zoom: number;
  readonly rawZoom: number;
  readonly dpr: number;
  readonly terrainState: TerrainRenderState;
  readonly mapTerrain: MapTerrain;
  readonly centerLngLat: [number, number];
  readonly mainMatrixArray: number[];
  readonly drapeUsable: boolean;
  readonly wideFallback: boolean;
  readonly useRetained: boolean;
  readonly features: Feature[];
  readonly selectedIdSet: Set<string>;
  readonly selectedFeatures: Feature[];
  readonly customRendererContext: FrameDrawContext;
  readonly layerAwareRenderers: LayeredOverlayRenderer[];
  readonly otherRenderers: EngineOverlayRenderer[];
  readonly quadDrapeFrame: QuadDrapeFrame | null;
  readonly restoreBlendState: () => void;
  /** Whether the drape can be drawn (the shaders and the plan are ready) */
  readonly drapeReady: boolean;
  readonly drapeLight: DrapeLight;
  readonly drapeTileDraws: DrapeTileDrawEntry[];
  readonly drapeElementsTotal: number;
  readonly drapeAboveStoreStart: number;
  readonly drapeEntryStarts: ReadonlyMap<string, number>;
  readonly pendingQuads: PendingQuad[];
  /**
   * When the drape could not be built, a slot is needed to draw the images that were to be
   * interleaved between the sections
   */
  readonly drapeFallbackQuads: Feature[];
  /** The stored copy (lngShift 0); what everything outside the copies is drawn with */
  readonly baseCopy: CopyPass;
  /** The copies of the world in view (one, or two across the antimeridian) */
  readonly copies: readonly CopyPass[];
}

/**
 * The style zoom (the zoom that the rendering reads; a value that absorbs the steps of the
 * elevation settlement)
 *
 * The elevation settlement of maplibre "rewrites the zoom number while keeping the spatial
 * position of the camera fixed". Since the screen does not move by a single pixel, nothing
 * should change size either. This rendering, however, derives the line widths, the labels,
 * the point sizes and the drape factors from the zoom number, so a step in the number is a
 * resize of every element, that is, a jolt that anyone can see. A first version that blended
 * it in with a time-constant smoothing turned into "a 250 ms breath on every settlement" and
 * was rejected.
 *
 * The correct rule is absorption: a change of the zoom number while the camera stays where it
 * is (= a settlement) is not reflected in the style zoom. During a real operation (zoom, pan,
 * inertia) it follows the raw increments. The difference from the settlements (the gap between
 * the style zoom and the raw zoom) is bounded at around ±0.3 as the elevation goes up and down,
 * and it matters more that the apparent sizes keep matching the real scale.
 *
 * A change of the zoom number with no operation in progress is not always a settlement: `jumpTo`
 * and `setZoom` move the camera at once, and the frame after them sees a camera that is not
 * moving. So the position of the camera tells them apart: when it moved, the style zoom takes
 * the raw zoom as it is (absorbing that change would keep every size at the old scale from then
 * on). When the position cannot be read, a change of the zoom number is not absorbed.
 *
 * The rule behind the test is an invariant, not a measurement: a settlement keeps the camera
 * where it is in space and only describes it again (a new zoom number and a new center on the
 * terrain under it), while any change of the zoom at the same pitch moves the camera along its
 * line of sight and changes its altitude by the factor `2^-Δzoom`. The altitude therefore
 * separates the two for any change of the zoom, and the tolerances only have to absorb the
 * floating-point noise of describing the same camera again (see `sameCameraPosition`).
 *
 * How the style zoom returns to the raw zoom follows from the same rule:
 *
 * - `jumpTo`, `setZoom` and any other move of the camera that changes the zoom within one frame:
 *   the frame after it sees the camera moved, and the style zoom takes the raw zoom as it is (the
 *   gap of earlier settlements is dropped; a jump that keeps the zoom number keeps the gap)
 * - an animated move (`easeTo`, `flyTo`, a gesture, inertia): the frames of the move follow the
 *   increments of the raw zoom and keep the gap of earlier settlements, so the sizes do not jump
 *   when the move starts; the gap stays after the move ends until a move of the first kind
 * - a settlement: absorbed, and the gap changes by its step (bounded by about ±0.3 as the
 *   elevation under the camera goes up and down)
 *
 * @internal
 */
export class StyleZoom {
  /** The style zoom. null = not initialized */
  private value: number | null = null;
  /** The raw zoom of the previous frame (recorded to follow the increments during an operation) */
  private raw: number | null = null;
  /** The position of the camera in the previous frame (null = unknown) */
  private camera: CameraPosition | null = null;

  /**
   * Advances by one frame and returns the style zoom of that frame
   *
   * @param camera The position of the camera in this frame (null when it cannot be read)
   */
  update(rawZoom: number, cameraBusy: boolean, camera: CameraPosition | null = null): number {
    if (this.value === null || this.raw === null) {
      this.value = rawZoom;
    } else if (cameraBusy) {
      this.value += rawZoom - this.raw;
    } else if (rawZoom !== this.raw && !sameCameraPosition(this.camera, camera)) {
      this.value = rawZoom;
    }
    this.raw = rawZoom;
    this.camera = camera;
    return this.value;
  }
}

/** The position of the camera: mercator x and y (0..1) and the altitude in meters */
export type CameraPosition = readonly [number, number, number];

/**
 * Mercator distance under which the camera has not moved sideways (about 40 m on the ground)
 *
 * The camera maplibre reports after a settlement is computed back from the new zoom and center,
 * and its position on the ground drifts by the rounding of that computation (1 to 2 m seen over
 * steep terrain at pitch 60). The altitude is the test that tells a settlement from a jump (any
 * change of the zoom changes it); this bound only keeps a jump far sideways at the same altitude
 * from being taken for a settlement, so it is set well above the drift and far below any jump a
 * host makes on purpose.
 */
const CAMERA_STILL_MERCATOR = 1e-6;
/**
 * Altitude difference (m) under which the camera has not moved up or down, for a camera close to
 * the ground (the floor of the relative tolerance below)
 */
const CAMERA_STILL_METERS = 0.01;
/**
 * The same, relative to the altitude
 *
 * A change of the zoom by Δ changes the altitude by the factor `2^-Δ`, a relative change of about
 * `0.69 * Δ`: this tolerance takes any change of the zoom above about 1.5e-7 for a move of the
 * camera, at every altitude, while the noise of describing the same camera again (float64
 * arithmetic on a few terms) stays orders of magnitude below it.
 */
const CAMERA_STILL_RELATIVE = 1e-7;

/** Whether two positions of the camera are the same place (false when either is unknown) */
function sameCameraPosition(a: CameraPosition | null, b: CameraPosition | null): boolean {
  if (!a || !b) return false;
  const altitudeTolerance = Math.max(CAMERA_STILL_METERS, Math.abs(a[2]) * CAMERA_STILL_RELATIVE);
  return (
    Math.abs(a[0] - b[0]) <= CAMERA_STILL_MERCATOR &&
    Math.abs(a[1] - b[1]) <= CAMERA_STILL_MERCATOR &&
    Math.abs(a[2] - b[2]) <= altitudeTolerance
  );
}

/** What building a frame reads */
export interface FrameBuildInput {
  gl: WebGL2RenderingContext;
  renderers: Renderers;
  map: MapLibreMap;
  store: Store;
  terrainContext: TerrainContext;
  displayList: DisplayListCache;
  drape: DrapePlanner;
  renderOptions: CustomRenderMethodInput;
  /** The style zoom of the frame */
  zoom: number;
  /** The real zoom of the camera */
  rawZoom: number;
  /** The rendering pixel ratio, for sizes fixed in screen pixels (the rendering scale included) */
  dpr: number;
  /** The rendering pixel ratio for sizes that follow the zoom (the rendering scale not applied) */
  contentDpr: number;
  /** The terrain state of the frame (already set on the terrain context) */
  terrainState: TerrainRenderState;
  /** Whether the retained batches of the Store rendering exist */
  retainedAvailable: boolean;
  overlayRenderers: readonly EngineOverlayRenderer[];
  segments: readonly RenderSegment[];
}

/**
 * Builds the state of a frame (done once by the first slot)
 *
 * It sets up the shaders and the anchor projection of the frame, plans the analytic drape,
 * picks the features of the immediate path and the selection, and plans the copies of the world.
 */
export function buildFrameState(input: FrameBuildInput): FrameState {
  const { gl, renderers: r, map, store, terrainContext, drape, renderOptions } = input;
  const { zoom, rawZoom, dpr, contentDpr, terrainState } = input;
  const { shaderData, defaultProjectionData } = renderOptions;
  const mapTerrain = terrainState.active ? getMapTerrain(map) : null;

  // Shader initialization
  const center = map.getCenter();
  const centerLngLat: [number, number] = [center.lng, center.lat];
  r.shaderInitializer.incrementSdfLineFrame();
  r.shaderInitializer.ensureShaders(shaderData);
  r.shaderInitializer.setProjectionData(defaultProjectionData);
  const mainMatrixArray = Array.from(defaultProjectionData.mainMatrix as Iterable<number>);
  const baseOffsetUniforms = calculateOffsetUniforms(centerLngLat, mainMatrixArray);
  r.shaderInitializer.applyOffsetUniforms(baseOffsetUniforms);

  // Shader initialization of the BoxSelectionRenderer
  r.boxSelectionRenderer.ensureShader(shaderData);
  const boxOffsetUniforms = calculateOffsetUniforms(centerLngLat, mainMatrixArray);
  r.boxSelectionRenderer.setOffsetUniforms(boxOffsetUniforms);

  // Establish the anchor projection (the single source shared by the positions of the points
  // and the handles and by the hit testing) with the values of this frame. The matrix, the
  // offsets and the elevation scale used for rendering are passed through as they are, so the
  // projection on the CPU side uses the same formula and the same branches as the vertex
  // shader. When the terrain is inactive it is removed and hit testing goes back to the project
  // of MapLibre (exactly the same path as before the terrain was introduced).
  if (terrainState.active && mapTerrain) {
    const viewport = anchorViewportOf(map);
    setAnchorFrame(terrainContext, {
      terrain: mapTerrain,
      // The elevation of the surface maplibre draws (terrain/ground.ts)
      elevationQuery: map,
      zoom,
      elevationScale: terrainState.elevationScale,
      mainMatrix: mainMatrixArray,
      offsetUniforms: boxOffsetUniforms,
      width: viewport.width,
      height: viewport.height,
      // Used by the occlusion test of the symbols (ghost) to trace the segment from the camera
      // to the anchor
      cameraMercator: getCameraMercator(map, terrainState.elevationScale),
    });
  } else {
    clearAnchorFrame(terrainContext);
  }

  // Decide first whether retained mode can draw (whether the renderers support it). Retained
  // mode draws the batches prepared per layer, so neither walking the feature list nor the
  // per-feature viewport filtering is needed. The off-screen thinning is done by renderLayers
  // per chunk (the bbox of the expanded viewport is computed once per frame).
  // Whether the analytic drape can be used (the path that paints features as ground pixels).
  // When it can, the polygons and lines are drawn there and only the rest (points and so on)
  // goes through the previous path (drape-planner.ts).
  const drapeUsable = drape.planFrame({
    gl,
    resolveStyles: () => r.batchManager.getRetainedRenderers()?.styles ?? r.featureDrawer,
    mapTerrain,
    dpr,
    contentDpr,
    zoom,
    rawZoom,
  });

  const useRetained =
    !drapeUsable && input.retainedAvailable && r.batchManager.getRetainedRenderers() !== undefined;

  // Viewport filtering. The display list is "the list that should be shown", which
  // excludes the local visibility of this client in addition to the shared visible flag.
  const excluded = drapeUsable ? drape.excluded : null;
  // An image interleaved into the stacking order is drawn between the sections of the drape,
  // so it is excluded from the later layer rendering (drawing it in both would double it)
  const drawnQuadBreaks = drapeUsable ? drape.quadBreaks : [];
  const interleavedQuadIds = new Set<string>();
  for (const brk of drawnQuadBreaks) interleavedQuadIds.add(brk.featureId);
  // The features in view come from the spatial index and are put in draw order by the kept
  // display list (display-list.ts), so the cost follows what is on screen
  const features = useRetained
    ? []
    : input.displayList
        .inOrder(r.viewportFilter.getVisibleIds())
        .filter(
          (feature) =>
            excluded === null || (excluded.has(feature.id) && !interleavedQuadIds.has(feature.id)),
        );

  // The single source of truth of the selection carries a kind. A group / layer selection is
  // resolved to its members and reflected on the map (getSelectedFeatureIds absorbs
  // feature / group / layer).
  const selectedIds = getSelectedFeatureIds(store);
  const selectedIdSet = new Set(selectedIds);

  // The features for the selection UI are resolved directly from the selected ids. This keeps
  // them independent of the rendering path (retained / immediate mode), so the selection UI is
  // the same either way. They used to be picked from the features after the viewport filter, so
  // a selected feature off the screen got no selection UI. Now it does (it is drawn correctly
  // when part of the selection box reaches into the screen).
  const selectedFeatures: Feature[] = [];
  for (const id of selectedIds) {
    const feature = store.getFeature(id);
    if (!feature?.visible || isLocallyHidden(feature, store)) continue;
    selectedFeatures.push(feature);
  }

  // Compositing of translucency (alpha blending; the reason is written in blend.ts)
  //
  // This state is a contract for the whole frame. An external renderer (a custom feature type,
  // an overlay) may rewrite the blend function for its own purposes, and if it comes back
  // having left it rewritten, everything drawn afterwards is composited wrongly. This function
  // is called again at the point control comes back, to establish the contract again.
  const restoreBlendState = (): void => applyDrawBlendState(gl);

  // The degenerate band of a wide view is drawn without depth
  //
  // Over a wide area the relief of the terrain is tiny on screen (at z8.6 a 1,000 m ridge is a
  // dozen or so pixels), so turning off the occlusion hardly changes how the distance looks. On
  // the other hand the vertex displacement path has the property that "the fill sinks into the
  // ground where it disagrees with the terrain mesh", and that punch-through stands out as
  // white dots in areas dense with polygons, such as a city center
  // (repro = 8.60/35.54609/139.46385/0.0/17.0). With the depth off, sinking cannot happen by
  // construction. It is not applied in the band where the analytic drape is running (there the
  // features are ground pixels themselves, so the occlusion works correctly).
  const wideFallback = !drapeUsable && rawZoom <= TERRAIN_ANALYTIC_MIN_ZOOM;

  // In a wide band the polygons and lines are drawn flat (the reason is surfacesFlattened in
  // terrain/context.ts). It is the same band and the same reason as turning off the depth.
  // Symbols (points, handles, text quads) are out of scope, so stopping it here does not
  // break the agreement between the anchor projection and the hit testing.
  setTerrainSurfacesFlattened(terrainContext, terrainState.active && wideFallback);

  const quadDrapeFrame = buildQuadDrapeFrame(input, mapTerrain);

  // Context for the custom renderers
  const customRendererContext: FrameDrawContext = {
    shaderData,
    centerLngLat,
    mainMatrixArray,
    pixelRatio: dpr,
    terrain: terrainContext,
    // An overlay does not belong to a layer. The layer loop passes each layer its own opacity
    opacity: 1,
    sdfLineRenderer: r.sdfLineRenderer,
    fillShaderManager: r.fillShaderManager,
    pointShapeRenderer: r.pointShapeRenderer,
  };

  // Separate the layer-aware overlay renderers from the rest
  const layerAwareRenderers: LayeredOverlayRenderer[] = [];
  const otherRenderers: EngineOverlayRenderer[] = [];
  for (const renderer of input.overlayRenderers) {
    if ('drawForLayer' in renderer && typeof renderer.drawForLayer === 'function') {
      layerAwareRenderers.push(renderer as LayeredOverlayRenderer);
    } else {
      otherRenderers.push(renderer);
    }
  }

  if (drapeUsable) drape.reportImmediate(features.length);

  const drapeLight = resolveDrapeLight(map.getBearing());
  const drapeDraws = drape.buildDraws({
    drapeUsable,
    shaderData,
    mapTerrain,
    getProjectionData: renderOptions.getProjectionData,
  });

  // The copies of the world in view
  const baseCopy: CopyPass = {
    lngShift: 0,
    view: undefined,
    projectionData: defaultProjectionData,
    offsetUniforms: baseOffsetUniforms,
    customRendererContext,
    features,
    selectedFeatures,
    terrainState,
  };
  const copies = planCopies(baseCopy, {
    renderers: r,
    displayList: input.displayList,
    center: centerLngLat,
    mainMatrixArray,
    useRetained,
    excluded,
    interleavedQuadIds,
    transition: defaultProjectionData.projectionTransition ?? 0,
  });

  return {
    segments: input.segments.slice(),
    layerOrder: store.getLayerOrder(),
    lastIndex: -1,
    shaderData,
    defaultProjectionData,
    getProjectionData: renderOptions.getProjectionData,
    zoom,
    rawZoom,
    dpr,
    terrainState,
    mapTerrain,
    centerLngLat,
    mainMatrixArray,
    drapeUsable,
    wideFallback,
    useRetained,
    features,
    selectedIdSet,
    selectedFeatures,
    customRendererContext,
    layerAwareRenderers,
    otherRenderers,
    quadDrapeFrame,
    restoreBlendState,
    drapeReady: drapeDraws.ready,
    drapeLight,
    drapeTileDraws: drapeDraws.tileDraws,
    drapeElementsTotal: drape.tileStore.elementCount,
    drapeAboveStoreStart: drape.tileStore.aboveStoreStart,
    drapeEntryStarts: drape.tileStore.entryStarts,
    pendingQuads: drapeDraws.pendingQuads,
    drapeFallbackQuads: drapeDraws.fallbackQuads,
    baseCopy,
    copies,
  };
}

/**
 * Installs the entry point that pins the textured quads (Image, the fill of a quad that
 * carries text) to the ground
 *
 * A billboard of four corner vertices always cuts in when the terrain inside pokes out of the
 * plane through those corners. With this entry point present, QuadShader takes the path that
 * pins it as "ground pixels" instead of a billboard. In a frame without it (no terrain, the
 * DEM has not arrived, the shaders cannot be built) it falls back to the subdivision path or
 * to the previous billboard.
 */
function buildQuadDrapeFrame(
  input: FrameBuildInput,
  mapTerrain: MapTerrain,
): QuadDrapeFrame | null {
  const { terrainState, renderOptions, map } = input;
  if (!terrainState.active || !mapTerrain) return null;
  const quadTerrain = mapTerrain;
  const quadDrapeRenderer = input.drape.quadRenderer(input.gl);
  const quadTiles = getRenderableTerrainTiles(quadTerrain);
  if (quadTiles.length === 0) return null;
  // The DEM and the ProjectionData are looked up once per tile in this frame (baking them
  // in would keep drawing the coarse elevation of the parent tile)
  const terrainDataCache = new Map<unknown, TerrainTileData | null>();
  const projectionCache = new Map<unknown, ProjectionData | null>();
  const quadDrapeFrame: QuadDrapeFrame = {
    renderer: quadDrapeRenderer,
    shaderData: renderOptions.shaderData,
    tiles: quadTiles,
    meshSize: getTerrainMeshSize(quadTerrain),
    light: resolveDrapeLight(map.getBearing()),
    // The depth test stays on through the layer rendering, whether or not the drape was used,
    // and goes off from the foreground on (renderForeground)
    keepDepthTest: true,
    getTerrainData(tile: RenderableTerrainTile): TerrainTileData | null {
      const hit = terrainDataCache.get(tile.tileID);
      if (hit !== undefined) return hit;
      const data = getTerrainTileData(quadTerrain, tile);
      terrainDataCache.set(tile.tileID, data);
      return data;
    },
    getProjectionData(tile: RenderableTerrainTile): ProjectionData | null {
      const hit = projectionCache.get(tile.tileID);
      if (hit !== undefined) return hit;
      // getProjectionData throws when the shape of tileID does not match. This keeps the
      // whole rendering from failing if it changes between versions.
      let data: ProjectionData | null = null;
      try {
        data = renderOptions.getProjectionData({
          tileID: tile.tileID as Parameters<typeof renderOptions.getProjectionData>[0]['tileID'],
        });
      } catch {
        data = null;
      }
      projectionCache.set(tile.tileID, data);
      return data;
    },
  };
  setQuadDrapeFrame(input.terrainContext, quadDrapeFrame);
  return quadDrapeFrame;
}

/**
 * Plans the copies of the world drawn in this frame
 *
 * One copy (the base one, unchanged) unless the view crosses the antimeridian. Across it,
 * each copy gets its range of the view, the features of that range, the virtual camera
 * (center and matrix moved by the copy's shift, computed in 64 bits) and the DEM atlas in the
 * frame of that camera. The globe draws with maplibre's projectTile, which has no seam, so it
 * keeps one copy.
 */
export function planCopies(
  baseCopy: CopyPass,
  options: {
    renderers: Renderers | null;
    displayList: DisplayListCache;
    center: [number, number];
    mainMatrixArray: number[];
    useRetained: boolean;
    excluded: Set<string> | null;
    interleavedQuadIds: Set<string>;
    transition: number;
  },
): CopyPass[] {
  const filter = options.renderers?.viewportFilter;
  if (!filter || typeof filter.getCopies !== 'function' || options.transition > 0) {
    return [baseCopy];
  }
  const viewCopies = filter.getCopies();
  if (viewCopies.length === 1 && viewCopies[0].lngShift === 0) return [baseCopy];

  return viewCopies.map((viewCopy) => {
    let visibleIds: Set<string> | null = null;
    const getVisibleIds = (): Set<string> => {
      if (!visibleIds) visibleIds = filter.getVisibleIdsIn(viewCopy.bounds);
      return visibleIds;
    };
    const view: RenderLayersView = { bounds: viewCopy.bounds, getVisibleIds };
    const features = options.useRetained
      ? []
      : options.displayList
          .inOrder(getVisibleIds())
          .filter(
            (feature) =>
              options.excluded === null ||
              (options.excluded.has(feature.id) && !options.interleavedQuadIds.has(feature.id)),
          );
    const selected = baseCopy.selectedFeatures.filter((feature) => getVisibleIds().has(feature.id));

    const shift = viewCopy.lngShift;
    if (shift === 0) {
      return { ...baseCopy, view, features, selectedFeatures: selected };
    }

    // The virtual camera of this copy
    const matrix = translateMatrixByLongitude(options.mainMatrixArray, shift);
    const center: [number, number] = [options.center[0] - shift, options.center[1]];
    // The same array type as the matrix maplibre hands over (it is uploaded as it is)
    const baseMatrix = baseCopy.projectionData.mainMatrix as unknown;
    const projectionData = {
      ...baseCopy.projectionData,
      mainMatrix: (baseMatrix instanceof Float32Array
        ? new Float32Array(matrix)
        : new Float64Array(matrix)) as unknown as CopyPass['projectionData']['mainMatrix'],
    };
    const base = baseCopy.terrainState;
    const terrainState: TerrainRenderState = base.active
      ? {
          ...base,
          atlasRect: [
            base.atlasRect[0] - shift / 360,
            base.atlasRect[1],
            base.atlasRect[2],
            base.atlasRect[3],
          ],
        }
      : base;
    return {
      lngShift: shift,
      view,
      projectionData,
      offsetUniforms: calculateOffsetUniforms(center, matrix),
      customRendererContext: {
        ...baseCopy.customRendererContext,
        centerLngLat: center,
        mainMatrixArray: matrix,
      },
      features,
      selectedFeatures: selected,
      terrainState,
    };
  });
}
