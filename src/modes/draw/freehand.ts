// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DrawFreehandMode
 *
 * Freehand drawing mode. A line is drawn continuously by dragging and confirmed on mouse up.
 * The mode is kept active, so several strokes can be drawn one after another.
 */

import type { DragNormalizedEvent, KeyNormalizedEvent } from '../../dispatcher/types.js';
import type { Coordinate, Feature, Mode } from '../../store/types.js';
import type { ModeContext, ModeHandler, SnapInputType } from '../handler.js';
import { createdZoomProperty, resolveCommitLayer } from './commit-layer.js';

/** Minimum distance for adding a coordinate (in degrees) */
const MIN_DISTANCE_DEGREES = 0.00001;

/**
 * The input types that are not passed through snapping (the points inside a stroke)
 *
 * The snapping tolerance is a value premised on "once per click", so applying it to dragmove,
 * which passes several hundred points in a single stroke, pulls the intermediate sample points
 * one after another to nearby vertices and edges, and a line the user meant to draw straight
 * ends up bent (this is conspicuous when dense administrative boundaries and the like are
 * displayed). Furthermore, when snapping collapses consecutive samples onto the same point,
 * they are discarded by the MIN_DISTANCE_DEGREES sieve, and the line jumps all at once the
 * moment it leaves the tolerance.
 *
 * The start and the end of the drag remain snapped, which keeps "start drawing exactly from a
 * corner of a boundary and end at a corner".
 */
const UNSNAPPED_INPUT_TYPES: ReadonlySet<SnapInputType> = new Set<SnapInputType>(['dragmove']);

/**
 * DrawFreehandMode implementation
 *
 * @internal
 */
export class DrawFreehandMode implements ModeHandler {
  readonly modeName: Mode = 'draw_freehand';
  readonly writesFeatures = true;

  private context!: ModeContext;

  /** Whether a drag is in progress */
  private isDrawing: boolean = false;

  /** Coordinates of the current stroke */
  private currentCoordinates: Coordinate[] = [];

  /** The Feature ID that is going to be created */
  private pendingFeatureId: string | null = null;

  /**
   * Whether snapping is to be applied, per input type
   *
   * Snapping is refused only inside a stroke (dragmove); the start point (dragstart) and the
   * end point (dragend) are snapped.
   */
  isSnapEnabledFor(inputType: SnapInputType): boolean {
    return !UNSNAPPED_INPUT_TYPES.has(inputType);
  }

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
  }

  onStop(): void {
    // Restore the cursor
    this.context.map.getCanvas().style.cursor = '';
    // Clear the tentative state
    this.context.store.setTentative(null);
    this.reset();
    // Re-enable the dragPan of MapLibre
    if (!this.context.map.dragPan.isEnabled()) {
      this.context.map.dragPan.enable();
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
   * Disables dragPan on a mouse down
   * @returns true consumes the event (blocks the subsequent processing)
   */
  onMouseDown(): boolean {
    // Disable the dragPan of MapLibre so that dragging is enabled
    this.context.map.dragPan.disable();
    return false;
  }

  onDragStart(event: DragNormalizedEvent): void {
    // Start drawing
    this.isDrawing = true;
    this.currentCoordinates = [[event.lngLat.lng, event.lngLat.lat]];
    // Generate the Feature ID in advance (for each stroke)
    this.pendingFeatureId = this.context.generateFeatureId();

    // Update the tentative state
    this.updateTentative();
  }

  onDragMove(event: DragNormalizedEvent): void {
    if (!this.isDrawing) return;

    const newCoord: Coordinate = [event.lngLat.lng, event.lngLat.lat];

    // Check the distance from the last coordinate
    if (this.currentCoordinates.length > 0) {
      const lastCoord = this.currentCoordinates[this.currentCoordinates.length - 1];
      const dx = newCoord[0] - lastCoord[0];
      const dy = newCoord[1] - lastCoord[1];
      const distance = Math.sqrt(dx * dx + dy * dy);

      // Do not add it if it is below the minimum distance
      if (distance < MIN_DISTANCE_DEGREES) {
        return;
      }
    }

    // Add the coordinate
    this.currentCoordinates.push(newCoord);

    // Update the tentative state
    this.updateTentative();
  }

  onDragEnd(event: DragNormalizedEvent): void {
    if (!this.isDrawing) return;

    // Add the last coordinate
    const endCoord: Coordinate = [event.lngLat.lng, event.lngLat.lat];
    if (this.currentCoordinates.length > 0) {
      const lastCoord = this.currentCoordinates[this.currentCoordinates.length - 1];
      const dx = endCoord[0] - lastCoord[0];
      const dy = endCoord[1] - lastCoord[1];
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance >= MIN_DISTANCE_DEGREES) {
        this.currentCoordinates.push(endCoord);
      }
    }

    // Confirm the stroke
    this.finishStroke();

    // End the drawing (the mode is kept active)
    this.isDrawing = false;
    this.currentCoordinates = [];
    this.context.store.setTentative(null);

    // Re-enable the dragPan of MapLibre (until the next drag)
    this.context.map.dragPan.enable();
  }

  /**
   * The press ended without a release (a second finger, or the browser cancelled the touch)
   *
   * The stroke in progress is discarded, and the pan goes back to MapLibre.
   */
  onDragCancel(): void {
    if (this.isDrawing) {
      this.reset();
      this.context.store.setTentative(null);
    }
    if (!this.context.map.dragPan.isEnabled()) {
      this.context.map.dragPan.enable();
    }
  }

  onKeyDown(event: KeyNormalizedEvent): void {
    if (event.key === 'Escape') {
      if (this.isDrawing) {
        // Cancel if drawing is in progress
        this.isDrawing = false;
        this.currentCoordinates = [];
        this.context.store.setTentative(null);
      } else {
        // Return to the select mode if drawing is not in progress
        this.context.setMode('select');
      }
    }
  }

  /**
   * Confirms the stroke and creates the feature
   */
  private finishStroke(): void {
    // At least two points are required
    if (this.currentCoordinates.length < 2) {
      return;
    }

    const { store, autoNameGenerator } = this.context;

    // Discard the drawing when no layer can be written any more
    const layerId = resolveCommitLayer(this.context);
    if (layerId === null) return;

    // Generate the automatic name
    const autoName = autoNameGenerator.generateName('Freehand');

    // Use the ID generated in advance (generate a new one if there is none)
    const featureId = this.pendingFeatureId ?? this.context.generateFeatureId();

    // Create a new freehand feature
    const feature: Feature = {
      id: featureId,
      type: 'Freehand',
      coordinates: [...this.currentCoordinates],
      layerId,
      properties: {
        ...createdZoomProperty(this.context),
        ...(autoName !== undefined && { name: autoName }),
      },
      style: {
        // Uses the same default color as LineString
        // (lineString.stroke.color of feature-style-config)
        strokeWidth: 3,
      },
      locked: false,
      visible: true,
    };

    // Create the feature inside a transaction (notified as a single change)
    store.transact(() => {
      store.createFeature(feature);
    });

    // Clear pendingFeatureId
    this.pendingFeatureId = null;

    // Note: the feature is not selected after creation (so that drawing can continue)
  }

  /**
   * Updates the tentative state
   */
  private updateTentative(): void {
    if (this.currentCoordinates.length === 0) {
      this.context.store.setTentative(null);
      return;
    }

    this.context.store.setTentative({
      type: 'Freehand',
      coordinates: [...this.currentCoordinates],
      layerId: this.context.getCurrentLayerId(),
      pendingFeatureId: this.pendingFeatureId ?? undefined,
    });
  }

  /**
   * Resets the state
   */
  private reset(): void {
    this.isDrawing = false;
    this.currentCoordinates = [];
    this.pendingFeatureId = null;
  }
}
