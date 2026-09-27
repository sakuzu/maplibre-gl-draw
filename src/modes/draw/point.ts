// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The point drawing mode: a click creates a point, selects it and returns to select
 *
 * It is written to the extension contract, through the `ModeContext` alone.
 */

import type { ModeFactory } from '../../api/extension/mode.js';

/**
 * The factory of the point drawing mode
 *
 * @internal
 */
export const drawPointMode: ModeFactory = (ctx) => ({
  writes: true,

  onEnter() {
    ctx.cursor.set('crosshair');
    // Entering a drawing mode clears the selection, as a change nobody records
    ctx.draw.transact(() => ctx.draw.selection.clear(), { source: 'silent' });
  },

  onExit() {
    ctx.cursor.reset();
  },

  // A double click while drawing is two clicks of the drawing; it never zooms the map
  onDoubleClick: () => true,

  onClick(event) {
    ctx.draw.transact(() => {
      const feature = ctx.commitFeature({
        type: 'Point',
        geometry: { type: 'Point', coordinates: event.snapped.lngLat },
      });
      if (feature) ctx.draw.selection.set('feature', [feature.id]);
    });
    ctx.setMode('select');
    return true;
  },

  onKeyDown(event) {
    if (event.key !== 'Escape') return false;
    ctx.setMode('select');
    return true;
  },
});
