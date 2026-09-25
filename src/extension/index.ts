// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The contracts an extension implements
 *
 * The types a plugin, a custom feature type or an overlay implements to plug into the
 * extension points of a draw instance. The registration itself is on the instance
 * (`registerFeatureHandler`, `addOverlayRenderer` and so on).
 */

export type {
  CustomFeatureHandler,
  CustomResizeCalculator,
  CustomResizeResult,
} from './feature-handler.js';
export type {
  CustomFeatureRenderer,
  CustomOverlayRenderer,
  CustomRendererDrawContext,
  LayerAwareOverlayRenderer,
} from './renderers.js';
