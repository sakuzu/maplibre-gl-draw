// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The layer a drawing mode of the engine commits into
 */

import type { EngineModeContext } from '../handler.js';

/**
 * Resolves the layer a drawing mode commits a new feature into
 *
 * Applies the commit rule of `EngineModeContext.getCurrentLayerId`: it returns the writable layer,
 * and when no layer can be written any more (the layer was deleted, locked or hidden while
 * drawing), the drawing is discarded instead: the shapes it shows are removed and the mode
 * returns to select, which stops the current handler. The caller then returns without
 * creating anything, so no exception reaches the input handling. A plugin mode follows the
 * same rule through the EngineModeContext.
 */
export function resolveCommitLayer(context: EngineModeContext): string | null {
  const layerId = context.getCurrentLayerId();
  if (layerId !== '') return layerId;
  const drawings = context.sketches.ownDrawings();
  if (drawings.length > 0) context.sketches.removeMany(drawings.map((sketch) => sketch.id));
  context.setMode('select');
  return null;
}
