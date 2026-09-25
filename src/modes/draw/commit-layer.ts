// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a drawing mode writes when it commits: the layer, and the created zoom
 */

import type { ModeContext } from '../handler.js';

/**
 * Resolves the layer a drawing mode commits a new feature into
 *
 * Applies the commit rule of `ModeContext.getCurrentLayerId`: it returns the writable layer,
 * and when no layer can be written any more (the layer was deleted, locked or hidden while
 * drawing), the drawing is discarded instead: the tentative state is cleared and the mode
 * returns to select, which stops the current handler. The caller then returns without
 * creating anything, so no exception reaches the input handling. A plugin mode follows the
 * same rule through the ModeContext.
 */
export function resolveCommitLayer(context: ModeContext): string | null {
  const layerId = context.getCurrentLayerId();
  if (layerId !== '') return layerId;
  context.store.setTentative(null);
  context.setMode('select');
  return null;
}

/**
 * The created zoom a drawing mode writes into the properties of a new feature
 *
 * When the instance lets line widths follow the zoom (`ModeContext.scaleWithZoom`), it is the
 * zoom at the time of the commit, from which the widths grow and shrink with the map. Otherwise
 * nothing is written, and the feature keeps its widths on the screen like one added through
 * the API.
 */
export function createdZoomProperty(context: ModeContext): { createdZoom?: number } {
  return context.scaleWithZoom ? { createdZoom: context.map.getZoom() } : {};
}
