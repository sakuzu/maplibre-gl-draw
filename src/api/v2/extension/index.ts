// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The extension contract: the contexts, plugins, modes, custom feature types, renderers,
 * providers and the Store
 */

export type {
  ExtensionContext,
  HitTestContext,
  ModeContext,
  NameGenerator,
  PluginContext,
  ScreenContext,
  SnapContext,
  TerrainAnchors,
} from './context.js';
export type { FeatureTypeDefinition, Handle } from './feature-type.js';
export type {
  DrawKeyEvent,
  DrawPointerEvent,
  InputHandlers,
  ModeFactory,
  ModeHandler,
  Modifiers,
} from './mode.js';
export type { Plugin } from './plugin.js';
export type {
  CompanionProvider,
  HandleProvider,
  Hit,
  SnapCandidate,
  SnapProvider,
} from './provider.js';
export type {
  FeatureRenderer,
  FillRenderer,
  LineRenderer,
  OffsetUniforms,
  OverlayRenderer,
  PointRenderer,
  RenderContext,
  ShaderData,
} from './render.js';
export type { StateChanges, Store, StoreView, UpdateSource } from './store.js';
