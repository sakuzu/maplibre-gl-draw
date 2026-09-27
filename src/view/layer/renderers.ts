// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Initialization and disposal of the renderers
 *
 * Lifecycle management of every renderer that CustomLayer uses
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import type { FeatureTypeHandler } from '../../extension/index.js';
import type { FeatureStyleConfig } from '../../shared/config/feature-style.js';
import type { RenderingConfig } from '../../shared/config/rendering.js';
import type { SelectionUIConfig } from '../../shared/config/selection.js';
import type { PixelRatioInput } from '../../shared/utils/pixel-ratio.js';
import type { SpatialIndex } from '../../store/spatial/spatial-index.js';
import type { Store } from '../../store/store.js';
import { TextureCache } from '../cache/texture.js';
import { BatchManager } from '../renderers/batch-manager.js';
import { FeatureDrawer } from '../renderers/drawer.js';
import { type ImageErrorFn, ImageRenderer } from '../renderers/image.js';
import { SDFLineRenderer } from '../renderers/line/sdf-line.js';
import { PointInstanceRenderer } from '../renderers/point/point-instance.js';
import { PointShapeRenderer } from '../renderers/point/point-shape.js';
import { PolygonBatchRenderer } from '../renderers/polygon/batch.js';
import { FillShaderManager } from '../renderers/polygon/fill.js';
import { SDFPolygonRenderer } from '../renderers/polygon/sdf-polygon.js';
import { StrokeRenderer } from '../renderers/stroke.js';
import { ShaderInitializer } from '../shaders/initializer.js';
import { QuadShader } from '../shaders/quad.js';
import { BoxSelectionRenderer } from '../ui/box-selection.js';
import { SelectionHandlesRenderer, SelectionUIRenderer } from '../ui/index.js';
import { TentativeRenderer } from '../ui/tentative.js';
import { ViewportFilter } from '../viewport.js';
import type { RenderScope } from './render-scope.js';

/**
 * The initialized renderers
 */
export interface Renderers {
  textureCache: TextureCache;
  quadShader: QuadShader;
  imageRenderer: ImageRenderer;
  strokeRenderer: StrokeRenderer;
  sdfLineRenderer: SDFLineRenderer;
  pointShapeRenderer: PointShapeRenderer;
  pointInstanceRenderer: PointInstanceRenderer;
  polygonBatchRenderer: PolygonBatchRenderer;
  sdfPolygonRenderer: SDFPolygonRenderer;
  fillShaderManager: FillShaderManager;
  selectionUIRenderer: SelectionUIRenderer;
  selectionHandlesRenderer: SelectionHandlesRenderer;
  featureDrawer: FeatureDrawer;
  tentativeRenderer: TentativeRenderer;
  boxSelectionRenderer: BoxSelectionRenderer;
  viewportFilter: ViewportFilter;
  shaderInitializer: ShaderInitializer;
  batchManager: BatchManager;
}

/**
 * What the renderers of one CustomLayer are built from
 */
export interface InitRenderersDeps {
  gl: WebGL2RenderingContext;
  map: MapLibreMap;
  store: Store;
  spatialIndex: SpatialIndex;
  featureStyle: FeatureStyleConfig;
  selectionConfig: SelectionUIConfig;
  renderingConfig: RenderingConfig;
  customFeatureHandlers: FeatureTypeHandler[] | undefined;
  /** Injected rendering pixel ratio (when omitted, read from window every time) */
  pixelRatio?: PixelRatioInput;
  /** The state and the caches owned by the draw instance (never shared between instances) */
  scope: RenderScope;
  /** Where the failure to load the image of an Image feature is reported */
  onImageError?: ImageErrorFn;
}

/**
 * Initialize the renderers
 */
export function initRenderers(deps: InitRenderersDeps): Renderers {
  const {
    gl,
    map: mapInstance,
    store,
    spatialIndex,
    featureStyle,
    selectionConfig,
    renderingConfig,
    customFeatureHandlers,
    pixelRatio,
    scope,
    onImageError,
  } = deps;
  const textureCache = new TextureCache(gl);
  const terrain = scope.terrain;
  const quadShader = new QuadShader(gl, terrain);
  const imageRenderer = new ImageRenderer(
    mapInstance,
    gl,
    textureCache,
    quadShader,
    (fileId) => store.getFile(fileId),
    onImageError,
  );

  const strokeRenderer = new StrokeRenderer(mapInstance, gl, pixelRatio, terrain);
  const sdfLineRenderer = new SDFLineRenderer(mapInstance, gl, pixelRatio, terrain);
  const pointShapeRenderer = new PointShapeRenderer(mapInstance, gl, pixelRatio, terrain);
  const pointInstanceRenderer = new PointInstanceRenderer(mapInstance, gl, pixelRatio, terrain);
  const polygonScope = { terrain, earcut: scope.earcut };
  const polygonBatchRenderer = new PolygonBatchRenderer(gl, polygonScope);
  const sdfPolygonRenderer = new SDFPolygonRenderer(gl, pixelRatio, polygonScope);
  const fillShaderManager = new FillShaderManager(gl, terrain);

  const selectionExtensions = scope.selection.extensions;
  const selectionUIRenderer = new SelectionUIRenderer(
    strokeRenderer,
    selectionConfig,
    selectionExtensions,
  );

  // The tile size of this instance's map (read by the custom bounding box calculators)
  const tileSize =
    (mapInstance as unknown as { transform?: { tileSize?: number } }).transform?.tileSize ?? 512;
  selectionExtensions.setTileSize(tileSize);

  // Register the bounding box functions used by the selection UI for custom feature handlers
  if (customFeatureHandlers) {
    for (const handler of customFeatureHandlers) {
      if (handler.getSelectionBoundingBox) {
        selectionExtensions.registerBoundingBox(handler.type, handler.getSelectionBoundingBox);
      }
    }
  }

  const selectionHandlesRenderer = new SelectionHandlesRenderer(
    strokeRenderer,
    pointShapeRenderer,
    selectionConfig,
  );
  selectionHandlesRenderer.setPointInstanceRenderer(pointInstanceRenderer);

  const featureDrawer = new FeatureDrawer({
    gl,
    map: mapInstance,
    sdfLineRenderer,
    pointShapeRenderer,
    imageRenderer,
    featureStyle,
    styleRules: scope.styleRules,
    terrain,
  });

  const tentativeRenderer = new TentativeRenderer({
    gl,
    map: mapInstance,
    sdfLineRenderer,
    pointShapeRenderer,
    tentativeStyle: featureStyle.tentative,
    terrain,
  });

  const boxSelectionRenderer = new BoxSelectionRenderer(
    mapInstance,
    gl,
    renderingConfig.boxSelectionStyle,
    pixelRatio,
  );

  const viewportFilter = new ViewportFilter({ map: mapInstance, spatialIndex });

  const shaderInitializer = new ShaderInitializer({
    featureDrawer,
    tentativeRenderer,
    quadShader,
    strokeRenderer,
    pointShapeRenderer,
    pointInstanceRenderer,
    sdfLineRenderer,
    polygonBatchRenderer,
    sdfPolygonRenderer,
  });

  const batchManager = new BatchManager({
    gl,
    featureDrawer,
    pointInstanceRenderer,
    sdfLineRenderer,
    polygonBatchRenderer,
    sdfPolygonRenderer,
    terrain,
  });

  return {
    textureCache,
    quadShader,
    imageRenderer,
    strokeRenderer,
    sdfLineRenderer,
    pointShapeRenderer,
    pointInstanceRenderer,
    polygonBatchRenderer,
    sdfPolygonRenderer,
    fillShaderManager,
    selectionUIRenderer,
    selectionHandlesRenderer,
    featureDrawer,
    tentativeRenderer,
    boxSelectionRenderer,
    viewportFilter,
    shaderInitializer,
    batchManager,
  };
}

/** A member that owns GPU resources and releases them with dispose() */
interface GpuOwner {
  dispose(): void;
}

/** The keys of the members of Renderers that own GPU resources */
type GpuOwnerKey = {
  [K in keyof Renderers]: Renderers[K] extends GpuOwner ? K : never;
}[keyof Renderers];

/**
 * Every member that owns GPU resources, in the order they are released
 *
 * The list is checked against the type: a member with a dispose() that is missing here is a
 * compile error (see `UNRELEASED` below), so a renderer added to Renderers cannot leak its
 * programs, buffers and textures when the layer is removed and added again.
 */
const GPU_OWNERS = [
  'featureDrawer',
  'tentativeRenderer',
  'boxSelectionRenderer',
  'textureCache',
  'quadShader',
  'strokeRenderer',
  'pointShapeRenderer',
  'pointInstanceRenderer',
  'sdfLineRenderer',
  'polygonBatchRenderer',
  'sdfPolygonRenderer',
  'fillShaderManager',
] as const satisfies readonly GpuOwnerKey[];

/** The members with a dispose() that GPU_OWNERS leaves out (must be never) */
type Unreleased = Exclude<GpuOwnerKey, (typeof GPU_OWNERS)[number]>;
const UNRELEASED: [Unreleased] extends [never] ? true : Unreleased = true;
void UNRELEASED;

/**
 * Dispose the renderers
 */
export function disposeRenderers(r: Renderers): void {
  for (const key of GPU_OWNERS) r[key].dispose();
}
