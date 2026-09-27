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
 * Every public symbol of this entry is listed here by name, grouped by topic (see "The public
 * surface" in CONTRIBUTING.md): the entry and its options, the document model, the inputs,
 * the state, the events, the errors, the datasets, the Store, the extension contract and the
 * style rule functions. The whole entry follows semver. The building blocks for custom
 * shaders are the webgl entry (src/webgl/index.ts); it may change in a minor release.
 *
 * Anything that no entry lists is internal. Where it would otherwise appear in the emitted
 * declarations, its JSDoc carries the internal tag and `stripInternal` drops it from them.
 * The list is pinned by src/index.test.ts, so every addition or removal is deliberate.
 *
 * @module maplibre-gl-draw
 */

// biome-ignore-all assist/source/organizeImports: the exports are grouped by topic

// Entry and options
export type { Draw } from './api/draw.js';
export { createDraw } from './api/draw.js';
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
} from './api/options.js';
export type { Messages } from './messages.js';
export type { FeaturesCollection } from './api/features.js';
export type { LayersCollection } from './api/layers.js';
export type { GroupsCollection } from './api/groups.js';
export type { HiddenCollection } from './api/hidden.js';
export type { SelectionResource, VertexSelectionResource } from './api/selection.js';
export type { MetadataResource } from './api/metadata.js';
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
  PointShape,
  StyleRule,
} from './api/model.js';
export { DRAW_PROPERTY_PREFIX, isDrawProperty } from './api/model.js';

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
} from './api/model.js';

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
} from './api/state.js';
export { MODES } from './api/state.js';

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
export type { Store, StoreView, UpdateSource } from './api/extension/store.js';

// Extensions
export type {
  ExtensionContext,
  HitTestContext,
  ModeContext,
  NameGenerator,
  PluginContext,
  ScreenContext,
  SnapContext,
  TerrainAnchors,
} from './api/extension/context.js';
export type { FeatureTypeDefinition, Handle } from './api/extension/feature-type.js';
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
  OffsetUniforms,
  OverlayRenderer,
  PointRenderer,
  RenderContext,
  ShaderData,
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
export { deriveLegend, evaluateStyleRule, getStyleRuleChannel } from './api/model.js';
