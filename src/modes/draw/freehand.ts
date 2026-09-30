// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The freehand drawing mode: a drag draws a line, which is created when the drag ends. The mode
 * stays, so several strokes can be drawn one after another.
 *
 * It is written to the extension contract, through the `ModeContext` alone.
 */

import type { Position } from 'geojson';
import type { ModeFactory } from '../../api/extension/mode.js';
import type { SnapPreference } from '../../api/state.js';

/** Minimum distance for adding a position (in degrees) */
const MIN_DISTANCE_DEGREES = 0.00001;

/**
 * The positions inside a stroke are not snapped
 *
 * The snapping tolerance is a value premised on "once per click", so applying it to the moves
 * of a drag, which pass several hundred points in a single stroke, pulls the points in the
 * middle one after another to nearby vertices and edges, and a line the user meant to draw
 * straight ends up bent (this is conspicuous when dense administrative boundaries and the like
 * are displayed). Furthermore, when snapping collapses consecutive samples onto the same point,
 * they are discarded by the MIN_DISTANCE_DEGREES sieve, and the line jumps all at once the
 * moment it leaves the tolerance.
 *
 * The start and the end of the drag remain snapped, which keeps "start drawing exactly from a
 * corner of a boundary and end at a corner".
 */
const SNAP_PREFERENCE: SnapPreference = { unsnapped: ['onDrag'] };

/** Whether a position is far enough from the last one to be added */
function farEnough(last: Position | undefined, next: Position): boolean {
  if (!last) return true;
  return Math.hypot(next[0] - last[0], next[1] - last[1]) >= MIN_DISTANCE_DEGREES;
}

/**
 * The factory of the freehand drawing mode
 *
 * @internal
 */
export const drawFreehandMode: ModeFactory = (ctx) => {
  const map = ctx.draw.getMap();
  /** The positions of the stroke being drawn, or null between strokes */
  let stroke: Position[] | null = null;

  const releasePan = (): void => {
    if (!map.dragPan.isEnabled()) map.dragPan.enable();
  };

  const dropStroke = (): void => {
    stroke = null;
    ctx.preview.clear();
  };

  const showPreview = (): void => {
    if (!stroke) return;
    ctx.preview.set({ type: 'Freehand', geometry: { type: 'LineString', coordinates: stroke } });
  };

  return {
    writes: true,
    snapPreference: SNAP_PREFERENCE,

    onEnter() {
      ctx.cursor.set('crosshair');
      ctx.draw.transact(() => ctx.draw.selection.clear(), { source: 'silent' });
      stroke = null;
    },

    onExit() {
      ctx.cursor.reset();
      dropStroke();
      releasePan();
    },

    // What was being drawn is dropped when the state is reset from outside
    onCancel: dropStroke,

    onPointerDown() {
      // The drag draws instead of panning the map; the press itself goes on to the map
      map.dragPan.disable();
      return false;
    },

    // A press released without a drag drew nothing: the map pans again
    onPointerUp() {
      if (!stroke) releasePan();
      return false;
    },

    // The two clicks of a double click drew nothing, and the map does not zoom
    onDoubleClick: () => true,

    onDragStart(event) {
      stroke = [event.snapped.lngLat];
      showPreview();
      return true;
    },

    onDrag(event) {
      if (!stroke) return false;
      const next = event.snapped.lngLat;
      if (farEnough(stroke[stroke.length - 1], next)) {
        stroke.push(next);
        showPreview();
      }
      return true;
    },

    onDragEnd(event) {
      if (!stroke) return false;
      const next = event.snapped.lngLat;
      if (farEnough(stroke[stroke.length - 1], next)) stroke.push(next);
      if (stroke.length >= 2) {
        // The line is not selected, so that drawing can go on
        ctx.commitFeature({
          type: 'Freehand',
          geometry: { type: 'LineString', coordinates: stroke },
          // The same default color as a line
          style: { strokeWidth: 3 },
        });
      }
      dropStroke();
      releasePan();
      return true;
    },

    // The press ended without a release (a second finger, or the browser cancelled the touch)
    onDragCancel() {
      dropStroke();
      releasePan();
      return true;
    },

    onKeyDown(event) {
      if (event.key !== 'Escape') return false;
      if (stroke) dropStroke();
      else ctx.setMode('select');
      return true;
    },
  };
};
