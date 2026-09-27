// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MapLibre GL Draw - public entry point
 *
 * The caller accesses the whole public API through the single entry
 * `import { ... } from '@sakuzu/maplibre-gl-draw'`, plus two subpaths that do not load
 * maplibre-gl: the pure geometry functions of `@sakuzu/maplibre-gl-draw/geometry`, which also
 * run in Node, and the Worker-side preparation of columnar data of
 * `@sakuzu/maplibre-gl-draw/columnar`. Tree-shaking is applied by the ESM bundler, which
 * looks at `"sideEffects": false` in package.json.
 *
 * Every public symbol is listed here by name, in one of two layers (see "The public
 * surface" in CONTRIBUTING.md and "The two layers of the public API" in
 * docs/reference/README.md):
 *
 *   - Layer 1, the public API: the factory, the instance and its options, the data model,
 *     the events, the extension points and the pure functions. It follows semver.
 *   - Layer 2, building blocks for extension authors: the rendering parts, the math and the
 *     core services that a plugin, a custom feature type or a custom mode may reuse. Its
 *     guarantee is weaker: it may change in a minor release.
 *
 * Anything not listed here is internal. Where it would otherwise appear in the emitted
 * declarations, its JSDoc carries the internal tag and `stripInternal` drops it from them.
 * The list is pinned by src/index.test.ts, so every addition or removal is deliberate.
 *
 * @module maplibre-gl-draw
 */

// biome-ignore-all assist/source/organizeImports: the exports are grouped by layer and topic

// ============================================================================
// Layer 1: the public API
// ============================================================================

// The factory and the instance
export type { EventPayloads, MapLibreGLDraw, Options } from './api/index.js';
export { createMapLibreGLDraw } from './maplibre-gl-draw.js';

// Options
export type {
  BoundingBoxStyle,
  BoxSelectionStyleConfig,
  CenterMarkerStyle,
  FeatureStyleConfig,
  FillStyle,
  LineStringFeatureStyle,
  MidpointHandleStyle,
  PointFeatureStyle,
  PolygonFeatureStyle,
  RadiusHandleStyle,
  RadiusLineStyle,
  RenderingConfig,
  ResizeHandleStyle,
  RotateHandleStyle,
  SelectionUIConfig,
  TentativeStyle,
  TopologyConfig,
  TraceOptions,
  VertexHandleStyle,
} from './shared/config/index.js';
export type {
  AutoNameConfig,
  AutoNameType,
  PixelRatioInput,
  PixelRatioProvider,
} from './shared/utils/index.js';
export type { SnapDisableKey, SnapOptions, SnapTargetKind } from './snapping/index.js';
export type { Color, LineStyle, PointShape, PointStyle, StrokeStyle } from './view/index.js';
export { MESSAGES_EN, type Messages } from './messages.js';

// The data model
export type {
  BoundingBox,
  BoundingBoxCoordsSimple,
  BoxSelection,
  Coordinate,
  Data,
  DragOperationType,
  DragState,
  ExportFormat,
  ExportOptions,
  ExportResult,
  Feature,
  FeatureCoordinates,
  FeatureInput,
  FeatureStyle,
  FeatureType,
  FileData,
  Group,
  ImageProperties,
  ImageStyle,
  Layer,
  LoadOptions,
  LoadResult,
  Metadata,
  Mode,
  RotateInfo,
  Selection,
  SelectionType,
  SkippedFeature,
  StateChanges,
  StyleRule,
  TentativeState,
  UpdateFeatureOptions,
  UpdateSource,
  VertexRef,
  VertexSelection,
} from './store/index.js';
export type { LegendEntry } from './view/index.js';

// The Store and its predicates
export type {
  DocumentStore,
  FeatureLockStore,
  InteractionGateStore,
  Store,
  StoreView,
  UiState,
} from './store/index.js';
export {
  isFeatureLocked,
  isGroupLocked,
  isInteractionBlocked,
  MemoryStore,
} from './store/index.js';

// Events
export type { MapClickEventPayload } from './dispatcher/index.js';
export type { DatasetClickEventPayload } from './dataset/index.js';
export type {
  EventListener,
  EventMap,
  FeaturesChangePayload,
  GeometryAppliedPayload,
  GeometryOperationName,
  LoadErrorPayload,
} from './shared/utils/index.js';

// The operation groups of the instance
export type {
  GeometryBufferOptions,
  GeometryOperations,
  InputOperations,
  SnappingOperations,
  SyntheticInputOptions,
  SyntheticKeyOptions,
  SyntheticLngLat,
  SyntheticModifiers,
  TopologyOperations,
  TracingOperations,
} from './api/index.js';

// Datasets
export type {
  DatasetBaseStyle,
  DatasetChangePayload,
  DatasetClickPayload,
  Dataset,
  DatasetEventMap,
  DatasetOptions,
  DatasetOrder,
  DatasetPlacement,
  DatasetCollisionThinning,
  DatasetColumn,
  DatasetColumnarGeometry,
  DatasetColumnarGeometryType,
  DatasetColumnarInput,
  DatasetColumnarMixedGeometry,
  DatasetColumnarPrepared,
  DatasetDictionaryCodes,
  DatasetDictionaryColumn,
  DatasetFeatureInput,
  DatasetFeatureProvider,
  DatasetHoverPayload,
  DatasetThinningStats,
  DatasetZoomScale,
  ResolvedCollisionThinning,
} from './dataset/index.js';

// Snapping
export type {
  GuideSnapProviderDeps,
  GuideSnapProviderOptions,
  ResolvedSnapOptions,
  SnapCandidate,
  SnapContext,
  SnapExcludeVertex,
  SnapIndicatorStyles,
  SnapLngLat,
  SnapPointCandidate,
  SnapProvider,
  SnapProviderContext,
  SnapResult,
  SnapSegmentCandidate,
  SnapTarget,
  SnapTargetSegment,
} from './snapping/index.js';
export {
  createGuideSnapProvider,
  DEFAULT_SNAP_GUIDE_LINE_STYLE,
  DEFAULT_SNAP_INDICATOR_STYLES,
} from './snapping/index.js';

// Tracing
export type {
  TraceGraph,
  TraceGraphEdge,
  TraceGraphEndpoint,
  TraceGraphNode,
} from './operations/index.js';
export { buildTraceGraph, findTracePath } from './operations/index.js';

// Style rules (pure functions)
export type { StyleRuleChannel } from './view/index.js';
export {
  applyRuleColor,
  deriveLegend,
  evaluateStyleRule,
  getStyleRuleChannel,
  resolveFeatureStyle,
  resolveRuleColor,
} from './view/index.js';

// Property accessors
export {
  getCreatedZoom,
  getRotation,
  getScale,
  setCreatedZoom,
  setRotation,
} from './shared/utils/index.js';

// Extension points
export type {
  CustomFeatureHandler,
  CustomFeatureRenderer,
  CustomOverlayRenderer,
  CustomRendererDrawContext,
  CustomResizeResult,
  LayerAwareOverlayRenderer,
} from './extension/index.js';
export type {
  BoxSelectionStrategy,
  DragNormalizedEvent,
  HitTestOptions,
  HitTestResult,
  HitTestStrategy,
  KeyNormalizedEvent,
  ModifierKeys,
  MouseNormalizedEvent,
  NormalizedEvent,
  PointerOriginalEvent,
  PointerType,
  VertexHit,
} from './dispatcher/index.js';
export type { ModeContext, ModeFactory, ModeHandler, SnapInputType } from './modes/index.js';
export type { ResizeState } from './operations/index.js';
export type {
  DragEndData,
  DragStartData,
  Hooks,
  HoverEvent,
  MouseLeaveEvent,
  MutationContext,
  Plugin,
  PluginContext,
} from './plugins/index.js';
export type { HandleType } from './shared/config/index.js';
export type { LngLat, ScreenPoint } from './shared/math/index.js';
export type {
  AdditionalHandleInfo,
  AdditionalResizeHandlesCalculator,
  AuxiliaryHandle,
  AuxiliaryHandleContext,
  AuxiliaryHandleHit,
  AuxiliaryHandleProvider,
  BoundingBoxCoords,
  CompanionHit,
  CompanionHitContext,
  CustomBoundingBoxCalculator,
  CustomResizeCalculator,
  FeatureCompanionProvider,
  HandleInfo,
  PointFrameExtent,
  PointFrameExtentProvider,
  RenderSlot,
  ResizeStrategy,
} from './view/index.js';

// ============================================================================
// Layer 2: building blocks for extension authors (may change in a minor release)
// ============================================================================

// Core services reached through ModeContext and CustomRendererDrawContext
export type {
  BoxSelectionStrategyRegistry,
  HitTestService,
  HitTestTopmost,
  TopHit,
  TopmostHitTestOptions,
  UnprojectFunction,
} from './dispatcher/index.js';
export type { HookName, PluginManager } from './plugins/index.js';
export type { TraceConfig } from './shared/config/index.js';
export type { AutoNameGenerator, EventEmitter } from './shared/utils/index.js';
export type { SpatialQuery } from './store/index.js';
export type {
  AuxiliaryHandleRegistry,
  FeatureCompanionHitResult,
  FeatureCompanionRegistry,
  FillShaderManager,
  PointShapeRenderer,
  SDFLineRenderer,
  SDFStrokeOptions,
  SDFStrokeStyle,
  SelectionExtensionRegistry,
  SelectionScope,
  TerrainContext,
  TerrainRenderState,
  WidthUnit,
} from './view/index.js';

// Diagnostics (their fields follow the rendering)
export type { TerrainDiagnostics, TerrainRenderDiagnostics } from './api/index.js';
export type { TerrainDrapeDebug } from './view/index.js';

// WebGL building blocks
export { resolvePixelRatio } from './shared/utils/index.js';
export type {
  BlendCapableGL,
  DashSegment,
  DrapeQuadCorners,
  OffsetUniforms,
  ProjectionUniformLocations,
  QuadDrapeColor,
  QuadDrapeFill,
  QuadDrapeSurface,
  QuadDrapeGlyphs,
  QuadVertices,
  ShaderData,
} from './view/index.js';
export {
  applyDrawBlendState,
  calculateLngLatOffset,
  calculateOffsetUniforms,
  computeQuadVertices,
  createProgram,
  drawBillboardsWithoutDepth,
  drawQuadSurfaceOnTerrain,
  getProjectionTransitionUniform,
  getStrokeDashPattern,
  OFFSET_MODE_GLSL,
  ProjectionUniformManager,
  QUAD_GLYPH_STRIDE,
  QuadShader,
  splitIntoDashes,
} from './view/index.js';

// Terrain anchoring
export type { MercatorRect, TessellationStep, TessellationTiling } from './view/index.js';
export {
  anchorElevationMeters,
  anchorGhostOpacity,
  densifyPath,
  getAnchorElevationGeneration,
  getTerrainTessellationStep,
  metersToMercatorScale,
} from './view/index.js';

// Geometry and projection math
export type { MercatorCoord, OBB, OBBCorners } from './shared/math/index.js';
export {
  createOBB,
  DEFAULT_TILE_SIZE,
  distanceToOBB,
  getOBBAABB,
  lngLatToMercator,
  metersToDegreesLat,
  metersToDegreesLng,
  pixelsToDegreesLat,
  pixelsToDegreesLng,
  rectangleIntersectsOBB,
} from './shared/math/index.js';
export { getContrastColor } from './shared/utils/index.js';

import { generateCirclePolygon as generateCirclePolygonOfGeometry } from './geometry/index.js';

/**
 * Approximates a geodesic circle with a polygon
 *
 * @deprecated Import `generateCirclePolygon` from `@sakuzu/maplibre-gl-draw/geometry`, where
 * the geometry functions live; it is the same function. This export will be removed in the next
 * major release.
 */
export const generateCirclePolygon = generateCirclePolygonOfGeometry;

// Selection UI, hit testing and viewport helpers
export { PointHitTestStrategy } from './dispatcher/index.js';
export { createGeometryApi, type GeometryApi, type GeometryApiDeps } from './api/index.js';
export {
  computeBoundingBox,
  createFeatureCompanionRegistry,
  createSelectionExtensionRegistry,
  DEFAULT_POINT_FRAME_SIZE,
  DEFAULT_VIEWPORT_EXPANSION_FACTOR,
  getExpandedViewportBounds,
  getSelectedFeatureIds,
  hasZeroArea,
} from './view/index.js';
