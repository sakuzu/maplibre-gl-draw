// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MapLibre GL Draw - the declarations of the public API of the main entry
 *
 * Every public symbol of the main entry is listed here by name, grouped by topic. The whole
 * main entry follows semver.
 *
 * @module maplibre-gl-draw
 */

// biome-ignore-all assist/source/organizeImports: the exports are grouped by topic

// Entry and options
export type { CreateDraw, Draw } from './draw.js';
export { createDraw } from './draw.js';
export type {
  AutoNameOptions,
  DrawOptions,
  OptionsResource,
  RenderingOptions,
  RuntimeOptions,
  SelectionStyleOptions,
  SnappingOptions,
  TopologyOptions,
  TracingOptions,
} from './options.js';
export type { Messages } from '../../messages.js';
export type { FeaturesCollection } from './features.js';
export type { LayersCollection } from './layers.js';
export type { GroupsCollection } from './groups.js';
export type { HiddenCollection } from './hidden.js';
export type { SelectionResource, VertexSelectionResource } from './selection.js';
export type { MetadataResource } from './metadata.js';
export type { DocumentResource } from './document.js';

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
  PointShape,
  StyleRule,
} from './model.js';
export { DRAW_PROPERTY_PREFIX, isDrawProperty } from './model.js';

// Inputs, patches and filters
export type {
  FeatureFilter,
  FeatureInput,
  FeaturePatch,
  GroupFilter,
  GroupInput,
  GroupPatch,
  LayerFilter,
  LayerInput,
  LayerPatch,
  LoadOptions,
  LoadResult,
  LoadSource,
  MoveTarget,
  SkippedFeature,
} from './model.js';

// State
export type {
  LayerStackEntry,
  Mode,
  Selection,
  SelectionType,
  SnapPreference,
  SnapResult,
  TerrainDiagnostics,
  VertexRef,
  VertexSelection,
} from './state.js';
export { MODES } from './state.js';

// Events
export type { DocumentChange, DrawEventListener, DrawEvents, ScreenPoint } from './events.js';
export type { Position } from 'geojson';

// Errors
export type { DrawErrorCode } from './errors.js';
export { DrawError } from './errors.js';

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
} from './datasets.js';

// Store
export type { Store, StoreView, UpdateSource } from './extension/index.js';

// Extensions
export type {
  CompanionProvider,
  DrawKeyEvent,
  DrawPointerEvent,
  ExtensionContext,
  FeatureRenderer,
  FeatureTypeDefinition,
  FillRenderer,
  Handle,
  HandleProvider,
  Hit,
  HitTestContext,
  InputHandlers,
  LineRenderer,
  ModeContext,
  ModeFactory,
  ModeHandler,
  Modifiers,
  NameGenerator,
  OffsetUniforms,
  OverlayRenderer,
  Plugin,
  PluginContext,
  PointRenderer,
  RenderContext,
  ScreenContext,
  ShaderData,
  SnapCandidate,
  SnapContext,
  SnapProvider,
  TerrainAnchors,
} from './extension/index.js';
export type {
  ExtensionsCollections,
  FeatureTypesCollection,
  ModesCollection,
  OverlaysCollection,
  PluginsCollection,
  ProvidersCollection,
} from './extensions.js';

// Style rule functions
export { deriveLegend, evaluateStyleRule, getStyleRuleChannel } from './model.js';
