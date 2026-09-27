// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MapLibre GL Draw - public entry point
 *
 * The caller accesses the whole public API through the single entry
 * `import { ... } from '@sakuzu/maplibre-gl-draw'`, plus three subpaths: the pure geometry
 * functions of `@sakuzu/maplibre-gl-draw/geometry`, which also run in Node, the building and
 * Worker-side preparation of tables of `@sakuzu/maplibre-gl-draw/table`, and the building
 * blocks for custom shaders of `@sakuzu/maplibre-gl-draw/webgl`. Tree-shaking is applied by
 * the ESM bundler, which looks at `"sideEffects": false` in package.json.
 *
 * Every public symbol of this entry is listed here by name (see "The public surface" in
 * CONTRIBUTING.md). They are layer 1, the public API: the factory, the instance and its
 * options, the data model, the events, the extension points and the pure functions. It
 * follows semver. Layer 2, the building blocks for custom shaders, is the webgl entry
 * (src/webgl/index.ts); it may change in a minor release.
 *
 * Anything that no entry lists is internal. Where it would otherwise appear in the emitted
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
  DatasetFeatureProvider,
  DatasetHoverPayload,
  DatasetRow,
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
