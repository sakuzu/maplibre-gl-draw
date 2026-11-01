// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The main entry. Every public symbol of it is listed below by name, grouped by topic (see
// "The public surface" in CONTRIBUTING.md), and the whole entry follows semver. Anything that
// no entry lists is internal: where it would otherwise appear in the emitted declarations, its
// JSDoc carries the internal tag and `stripInternal` drops it from them. The list is pinned by
// src/index.test.ts, so every addition or removal is deliberate. Tree-shaking is left to the
// ESM bundler, which reads `"sideEffects": false` in package.json.

/**
 * Draw and edit points, lines and areas on a MapLibre map, and show large data beside them.
 *
 * Import from here for everything an application does with a drawing: create the instance,
 * read and change its features, layers and groups, listen to what changes, save and load the
 * document, and add plugins, modes and feature types. Four subpaths cover the rest: geometry
 * that needs no map (`/geometry`), large tables read in a Worker (`/table`), the parts that hold
 * the features of a layer as rows of columns (`/kasane`, experimental) and custom shaders
 * (`/webgl`).
 *
 * ```ts
 * import { createDraw } from '@sakuzu/maplibre-gl-draw';
 *
 * const draw = createDraw(map);
 * draw.setMode('draw_polygon');
 * draw.on('feature.created', ({ feature }) => {
 *   console.log(feature.id, feature.geometry);
 * });
 * ```
 *
 * Where to find things: every resource of {@link Draw} is a field with its own methods.
 *
 * - `draw.features` (create, update, delete, move, union, split, restore): {@link FeaturesCollection}
 * - `draw.layers` (create, update, reorder, setActive): {@link LayersCollection}
 * - `draw.groups` (create, update, move): {@link GroupsCollection}
 * - `draw.datasets` (add, remove, move): {@link DatasetsCollection}
 * - `draw.sketches` (add, update, commit, remove): {@link SketchesCollection}
 * - `draw.selection` (set, add, clear, delete, group): {@link SelectionResource}
 * - `draw.vertexSelection` (set, clear, delete): {@link VertexSelectionResource}
 * - `draw.metadata` and `draw.options` (get, update): {@link MetadataResource}, {@link OptionsResource}
 * - `draw.document` (load, toJSON, toGeoJSON): {@link DocumentResource}
 * - `draw.drawing` (addVertex, finish, cancel): {@link DrawingResource}
 * - `draw.rendered` (get, getSelectionBox): {@link RenderedResource}
 * - `draw.extensions` (plugins, modes, feature types): {@link ExtensionsCollections}
 * - events with `draw.on`: {@link DrawEvents}; errors: {@link DrawError}
 *
 * Read next: [getting started](https://sakuzu.github.io/maplibre-gl-draw/getting-started),
 * then the guides for [drawing](https://sakuzu.github.io/maplibre-gl-draw/guides/drawing) and
 * [saving and loading](https://sakuzu.github.io/maplibre-gl-draw/guides/save-load). The
 * symbols used most are {@link createDraw}, {@link Draw}, {@link Feature} and
 * {@link DrawEvents}.
 *
 * @module maplibre-gl-draw
 */

// biome-ignore-all assist/source/organizeImports: the exports are grouped by topic

// Entry and options
export type { CaptureImageOptions, Draw, TransactOptions } from './api/draw.js';
export { createDraw } from './api/draw.js';
export type {
  AutoNameOptions,
  ConsistencyCheck,
  ConsistencyCheckOptions,
  ConsistencyFailure,
  DebugOptions,
  DrawOptions,
  OptionsResource,
  RenderingOptions,
  RuntimeOptions,
  SelectionStyleOptions,
  SnappingOptions,
  TopologyOptions,
  TracingOptions,
} from './api/options.js';
export type { Messages } from './messages.js';
export { defineMessages } from './messages.js';
export type { FeaturesCollection } from './api/features.js';
export type { LayersCollection } from './api/layers.js';
export type { GroupsCollection } from './api/groups.js';
export type { HiddenCollection } from './api/hidden.js';
export type {
  Sketch,
  SketchEdit,
  SketchEndReason,
  SketchInput,
  SketchPatch,
  SketchesCollection,
} from './api/sketches.js';
export type { RenderedResource } from './api/rendered.js';
export type { SelectionResource, VertexSelectionResource } from './api/selection.js';
export type { MetadataResource } from './api/metadata.js';
export type { DrawingResource } from './api/drawing.js';
export type { DocumentResource } from './api/document.js';

// Document model
export type {
  DrawDocument,
  DrawProperties,
  Feature,
  FeatureStyle,
  FeatureStyleResolved,
  FeatureType,
  FileData,
  Group,
  Layer,
  LegendEntry,
  LineStyle,
  Metadata,
  ObjectGroup,
  ObjectLayer,
  PointShape,
  StyleRule,
  TableGroup,
  TableLayer,
} from './api/model.js';
export { DRAW_PROPERTY_PREFIX, isDrawProperty } from './api/model.js';

// Inputs, patches and filters
export type { BBox } from './geometry/types.js';
export type {
  EditResult,
  EditTarget,
  FeatureEdit,
  FeatureFilter,
  FeatureInput,
  FeatureListOptions,
  FeaturePatch,
  FeatureStyleSample,
  GroupFilter,
  GroupInput,
  GroupPatch,
  ItemListOptions,
  LayerFilter,
  LayerInput,
  LayerPatch,
  LoadOptions,
  LoadResult,
  LoadSource,
  MoveTarget,
  SkippedFeature,
} from './api/model.js';

// The stacking order of the items
export type {
  FeatureValues,
  ItemListChange,
  ItemMove,
  ItemOrderChange,
  ItemPlacement,
  ItemPosition,
  RestoreToken,
} from './api/model.js';

// State
export type {
  LayerStackEntry,
  Mode,
  Selection,
  SelectionBulk,
  SelectionType,
  SnapPreference,
  SnapResult,
  TerrainDiagnostics,
  GpuMemoryDiagnostics,
  VertexId,
  VertexRef,
  VertexSelection,
  VertexTarget,
} from './api/state.js';
export { MODES } from './api/state.js';

// Memory
export type { DocumentSize, MemoryBytes, MemoryResource, MemoryUsage } from './api/memory.js';

// Events
export type { DocumentChange, DrawEventListener, DrawEvents, ScreenPoint } from './api/events.js';
export type { Position } from 'geojson';

// Errors
export type { DrawErrorCode } from './api/errors.js';
export { DrawError } from './api/errors.js';

// Datasets
export type {
  Dataset,
  DatasetBaseStyle,
  DatasetCollisionThinning,
  DatasetEvents,
  DatasetOptions,
  DatasetOrder,
  DatasetPlacement,
  DatasetProvider,
  DatasetRow,
  DatasetsCollection,
  DatasetThinningStats,
  DatasetZoomScale,
} from './api/datasets.js';

// Store
export type {
  GeometryTransforms,
  Store,
  StoreView,
  TransformEdit,
  TransformFields,
  TransformValues,
  UpdateSource,
} from './api/extension/store.js';
export { diffItemOrder } from './api/model.js';

// Extensions
export type {
  ExtensionContext,
  FootprintContext,
  HandleContext,
  ModeContext,
  NameGenerator,
  PluginContext,
  PointContext,
  ScreenContext,
  TerrainSurface,
} from './api/extension/context.js';
export type {
  CustomHandle,
  FeatureTypeDefinition,
  Footprint,
  GroundFootprint,
  Handle,
  ResizeHandle,
  ScreenFootprint,
} from './api/extension/feature-type.js';
export type {
  DrawKeyEvent,
  DrawPointerEvent,
  InputHandlers,
  ModeFactory,
  ModeHandler,
  Modifiers,
} from './api/extension/mode.js';
export type { Plugin } from './api/extension/plugin.js';
export type {
  CompanionProvider,
  HandleProvider,
  Hit,
  SnapCandidate,
  SnapProvider,
} from './api/extension/provider.js';
export type {
  FeatureRenderer,
  FillRenderer,
  LineRenderer,
  OverlayRenderer,
  PointRenderer,
  RenderContext,
} from './api/extension/render.js';
export type {
  ExtensionsCollections,
  FeatureTypesCollection,
  ModesCollection,
  OverlaysCollection,
  PluginsCollection,
  ProvidersCollection,
} from './api/extensions.js';

// Style rule functions
export { deriveLegend, evaluateStyleRule } from './api/model.js';

// Color functions
export { parseCssColor } from './api/model.js';

// GeoJSON functions
export type { ToGeoJSONOptions } from './api/model.js';
export { featuresToGeoJSON, featureToGeoJSON } from './api/model.js';

// Parse functions
export type { ParsedDocument, ParseOptions } from './api/model.js';
export { parseGeoJSON, parseNative } from './api/model.js';
