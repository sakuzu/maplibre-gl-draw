// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DrawCircleMode
 *
 * Circle drawing mode. The center is set by a click, the radius is adjusted by moving the
 * mouse, and another click confirms it.
 */

import type { KeyNormalizedEvent, MouseNormalizedEvent } from '../../dispatcher/types.js';
import { haversineDistanceMeters, initialBearingDegrees } from '../../geometry/distance.js';
import { drawProperties } from '../../shared/properties.js';
import type { Coordinate, Feature, Mode } from '../../store/types.js';
import type { ModeContext, ModeHandler } from '../handler.js';
import { createdZoomProperty, resolveCommitLayer } from './commit-layer.js';

/** Default angle of the radius handle (toward the lower right) */
const DEFAULT_RADIUS_HANDLE_ANGLE = 135;

/** Minimum radius (in meters) */
const MIN_RADIUS_METERS = 1;

/**
 * DrawCircleMode implementation
 *
 * @internal
 */
export class DrawCircleMode implements ModeHandler {
  readonly modeName: Mode = 'draw_circle';
  readonly writesFeatures = true;

  private context!: ModeContext;

  /** Center coordinate of the circle */
  private center: Coordinate | null = null;

  /** Radius (in meters) */
  private radiusMeters: number = 0;

  /** Angle of the radius handle (in degrees) */
  private radiusHandleAngle: number = DEFAULT_RADIUS_HANDLE_ANGLE;

  /** Drawing phase: 'waiting' = the center is not set yet, 'adjusting' = adjusting the radius */
  private phase: 'waiting' | 'adjusting' = 'waiting';

  /** The Feature ID that is going to be created */
  private pendingFeatureId: string | null = null;

  onStart(context: ModeContext): void {
    this.context = context;
    // Change the cursor to a crosshair
    this.context.map.getCanvas().style.cursor = 'crosshair';
    // Clear the selection (not notified as a change)
    this.context.store.transact(() => {
      this.context.store.setSelection(null, []);
    }, 'silent');
    // Reset the state
    this.reset();
    // Generate the Feature ID in advance
    this.pendingFeatureId = this.context.generateFeatureId();
  }

  onStop(): void {
    // Restore the cursor
    this.context.map.getCanvas().style.cursor = '';
    // Clear the tentative state
    this.context.store.setTentative(null);
    this.reset();
  }

  /**
   * A double click while drawing is two clicks of the drawing; it never zooms the map
   * (consumed by preventing its default action)
   */
  onDoubleClick(event: MouseNormalizedEvent): void {
    event.originalEvent.preventDefault();
  }

  onClick(event: MouseNormalizedEvent): void {
    const coord: Coordinate = [event.lngLat.lng, event.lngLat.lat];

    if (this.phase === 'waiting') {
      // Set the center
      this.center = coord;
      this.phase = 'adjusting';
      this.radiusMeters = 0;

      // Update the tentative state
      this.updateTentative();
    } else if (this.phase === 'adjusting') {
      // Confirm if the radius is at least the minimum value
      if (this.radiusMeters >= MIN_RADIUS_METERS) {
        this.finishCircle();
      }
    }
  }

  onMouseMove(event: MouseNormalizedEvent): void {
    if (this.phase === 'adjusting' && this.center) {
      // Compute the distance from the center to the mouse position
      const mouseCoord: Coordinate = [event.lngLat.lng, event.lngLat.lat];
      this.radiusMeters = haversineDistanceMeters(this.center, mouseCoord);

      // The great-circle bearing from the center to the mouse position. The handle is placed
      // with destinationPoint, the inverse of this bearing, so it lands on the pointer
      this.radiusHandleAngle = initialBearingDegrees(this.center, mouseCoord);

      // Update the tentative state
      this.updateTentative();
    }
  }

  onKeyDown(event: KeyNormalizedEvent): void {
    if (event.key === 'Escape') {
      if (this.phase === 'adjusting') {
        // Cancel if drawing is in progress
        this.reset();
        this.context.store.setTentative(null);
      } else {
        // Return to the select mode if drawing is not in progress
        this.context.setMode('select');
      }
    }
  }

  /**
   * Called after an external state change
   *
   * Resets the state of the drawing in progress so that the next drawing operation can start
   * normally.
   */
  onExternalStateChange(): void {
    this.reset();
    this.context.store.setTentative(null);
  }

  /**
   * Confirms the circle
   */
  private finishCircle(): void {
    if (!this.center || this.radiusMeters < MIN_RADIUS_METERS) {
      return;
    }

    const { store, autoNameGenerator } = this.context;

    // Discard the drawing when no layer can be written any more
    const layerId = resolveCommitLayer(this.context);
    if (layerId === null) return;

    // Generate the automatic name
    const autoName = autoNameGenerator.generateName('Circle');

    // Use the ID generated in advance (generate a new one if there is none)
    const featureId = this.pendingFeatureId ?? this.context.generateFeatureId();

    // Create a new circle feature
    const feature: Feature = {
      id: featureId,
      type: 'Circle',
      coordinates: this.center,
      layerId,
      properties: {
        ...drawProperties({
          radiusMeters: this.radiusMeters,
          radiusHandleAngle: this.radiusHandleAngle,
        }),
        ...createdZoomProperty(this.context),
        // The polygon coordinates for rendering are computed at render time, so they are not saved
        ...(autoName !== undefined && { name: autoName }),
      },
      locked: false,
      visible: true,
    };

    // Bundle the feature creation and the selection into a single transaction
    // (so that both are undone at once on undo)
    store.transact(() => {
      store.createFeature(feature);

      // Clear the tentative state
      store.setTentative(null);

      // Select the created feature
      store.setSelection('feature', [feature.id]);
    });

    // Reset the state
    this.reset();

    // Return to the select mode
    this.context.setMode('select');
  }

  /**
   * Updates the tentative state
   */
  private updateTentative(): void {
    if (!this.center) {
      this.context.store.setTentative(null);
      return;
    }

    this.context.store.setTentative({
      type: 'Circle',
      coordinates: this.center,
      layerId: this.context.getCurrentLayerId(),
      radiusMeters: this.radiusMeters,
      radiusHandleAngle: this.radiusHandleAngle,
      pendingFeatureId: this.pendingFeatureId ?? undefined,
    });
  }

  /**
   * Resets the state
   */
  private reset(): void {
    this.center = null;
    this.radiusMeters = 0;
    this.radiusHandleAngle = DEFAULT_RADIUS_HANDLE_ANGLE;
    this.phase = 'waiting';
    this.pendingFeatureId = null;
  }
}
