// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The contracts of the engine for the feature types that are not built in and for the
 * overlays. The extension contract of `api/extension/` is installed into them.
 */

export type {
  FeatureTypeHandler,
  TypeResizeCalculator,
  TypeResizeResult,
} from './feature-handler.js';
export type {
  EngineOverlayRenderer,
  FeatureTypeRenderer,
  FrameDrawContext,
  LayeredOverlayRenderer,
} from './renderers.js';
