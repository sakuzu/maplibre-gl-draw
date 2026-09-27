// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The circle drawing mode: a click sets the center, moving the pointer adjusts the radius, and
 * another click creates the circle
 *
 * It is written to the extension contract, through the `ModeContext` alone.
 */

import type { Position } from 'geojson';
import type { ModeFactory } from '../../api/v2/extension/mode.js';
import { haversineDistanceMeters, initialBearingDegrees } from '../../geometry/distance.js';
import { drawProperties } from '../../shared/properties.js';

/** Default angle of the radius handle (toward the lower right) */
const DEFAULT_RADIUS_HANDLE_ANGLE = 135;

/** Minimum radius (in meters) */
const MIN_RADIUS_METERS = 1;

/**
 * The factory of the circle drawing mode
 *
 * @internal
 */
export const drawCircleMode: ModeFactory = (ctx) => {
  /** The center, once the first click set it */
  let center: Position | null = null;
  let radiusMeters = 0;
  let radiusHandleAngle = DEFAULT_RADIUS_HANDLE_ANGLE;

  /** The values of the circle as it stands */
  const circleProperties = () => drawProperties({ radiusMeters, radiusHandleAngle });

  const reset = (): void => {
    center = null;
    radiusMeters = 0;
    radiusHandleAngle = DEFAULT_RADIUS_HANDLE_ANGLE;
    ctx.preview.clear();
  };

  const showPreview = (): void => {
    if (!center) return;
    ctx.preview.set({
      type: 'Circle',
      geometry: { type: 'Point', coordinates: center },
      properties: circleProperties(),
    });
  };

  const finish = (): void => {
    if (!center || radiusMeters < MIN_RADIUS_METERS) return;
    const at = center;
    ctx.draw.transact(() => {
      const feature = ctx.commitFeature({
        type: 'Circle',
        geometry: { type: 'Point', coordinates: at },
        properties: circleProperties(),
      });
      if (feature) ctx.draw.selection.set('feature', [feature.id]);
    });
    reset();
    ctx.setMode('select');
  };

  return {
    writes: true,

    onEnter() {
      ctx.cursor.set('crosshair');
      ctx.draw.transact(() => ctx.draw.selection.clear(), { source: 'silent' });
      reset();
    },

    onExit() {
      ctx.cursor.reset();
      reset();
    },

    // What was being drawn is dropped when the state is reset from outside
    onCancel: reset,

    // A double click while drawing is two clicks of the drawing; it never zooms the map
    onDoubleClick: () => true,

    onClick(event) {
      if (!center) {
        center = event.snapped.lngLat;
        radiusMeters = 0;
        showPreview();
      } else if (radiusMeters >= MIN_RADIUS_METERS) {
        finish();
      }
      return true;
    },

    onPointerMove(event) {
      if (!center) return false;
      const from: [number, number] = [center[0], center[1]];
      const to: [number, number] = [event.snapped.lngLat[0], event.snapped.lngLat[1]];
      radiusMeters = haversineDistanceMeters(from, to);
      radiusHandleAngle = initialBearingDegrees(from, to);
      showPreview();
      return false;
    },

    onKeyDown(event) {
      if (event.key !== 'Escape') return false;
      if (center) reset();
      else ctx.setMode('select');
      return true;
    },
  };
};
