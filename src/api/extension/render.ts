// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Drawing: the renderers of custom feature types and overlays, the values they draw with,
 * and the shared renderers they can draw through
 */

import type { RenderContext } from '../plugin/types.js';

export type {
  FillRenderer,
  LineRenderer,
  PointRenderer,
  RenderContext,
} from '../plugin/types.js';

/**
 * A renderer that draws above the features, or between the layers, with the shared renderers: it
 * holds nothing on the GPU. What draws with WebGL of its own is added with `ctx.webgl.addOverlay`.
 */
export interface OverlayRenderer {
  /** The name it is registered under */
  readonly name: string;
  /**
   * The order among the overlays: a lower one is drawn first, below a higher one. Overlays of
   * the same order are drawn in the order they were added; 0 when it is left out.
   */
  readonly order?: number;
  /** Draws above every layer. */
  draw(ctx: RenderContext): void;
  /** Draws just above one layer, for an overlay drawn between the layers. */
  drawForLayer?(layerId: string, ctx: RenderContext): void;
  /**
   * Draws the vertices of what the overlay shows, above the features of every layer and the
   * selection, so that they stay visible over a layer further back.
   */
  drawVertices?(ctx: RenderContext): void;
  /** Whether some of its drawing has not finished yet. */
  hasPendingWork?(): boolean;
}
