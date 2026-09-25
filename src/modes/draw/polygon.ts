// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DrawPolygonMode
 *
 * Polygon drawing mode. Vertices are added by clicking, and it is confirmed by clicking the
 * first vertex or by pressing Enter.
 */

import type { KeyNormalizedEvent, MouseNormalizedEvent } from '../../dispatcher/types.js';
import type { Feature, Mode } from '../../store/types.js';
import type { ModeContext, ModeHandler } from '../handler.js';
import { createdZoomProperty, resolveCommitLayer } from './commit-layer.js';
import type { TraceAnchor } from './trace-support.js';
import { computeTracePath, isTraceEnabled, readTraceAnchor } from './trace-support.js';

/** Tolerance for deciding a vertex click (in pixels) */
const VERTEX_CLICK_TOLERANCE = 10;

/**
 * DrawPolygonMode implementation
 *
 * @internal
 */
export class DrawPolygonMode implements ModeHandler {
  readonly modeName: Mode = 'draw_polygon';
  readonly writesFeatures = true;

  private context!: ModeContext;

  private coordinates: [number, number][] = [];
  private isNearFirstVertex = false;
  /** The redo stack (holds the undone vertices) */
  private redoStack: [number, number][] = [];
  /** The last mouse coordinate (for displaying the dashed line on undo/redo) */
  private lastMouseCoord: [number, number] | null = null;
  /** The Feature ID that is going to be created */
  private pendingFeatureId: string | null = null;
  /**
   * The snap target of the previously confirmed click (the start point of the trace)
   *
   * It is reset to null for a click that did not snap and for a snap that cannot be traced.
   */
  private traceAnchor: TraceAnchor | null = null;
  /**
   * The trace path up to the cursor position (the unconfirmed vertices for the preview)
   *
   * They are inserted between the confirmed coordinates and the cursor point and drawn as
   * tentative.
   */
  private tracePreview: [number, number][] | null = null;

  onStart(context: ModeContext): void {
    this.context = context;
    // Change the cursor to a crosshair
    this.context.map.getCanvas().style.cursor = 'crosshair';
    // Clear the selection (not notified as a change)
    this.context.store.transact(() => {
      this.context.store.setSelection(null, []);
    }, 'silent');
    // Reset the state
    this.coordinates = [];
    this.isNearFirstVertex = false;
    this.redoStack = [];
    this.lastMouseCoord = null;
    this.traceAnchor = null;
    this.tracePreview = null;
    // Generate the Feature ID in advance
    this.pendingFeatureId = this.context.generateFeatureId();
  }

  onStop(): void {
    // Restore the cursor
    this.context.map.getCanvas().style.cursor = '';
    // Clear the tentative state
    this.context.store.setTentative(null);
    this.coordinates = [];
  }

  /**
   * Called after an external state change
   *
   * Resets the state of the drawing in progress so that the next drawing operation can start
   * normally.
   */
  onExternalStateChange(): void {
    // Reset the state
    this.coordinates = [];
    this.redoStack = [];
    this.lastMouseCoord = null;
    this.pendingFeatureId = null;
    this.isNearFirstVertex = false;
    this.traceAnchor = null;
    this.tracePreview = null;

    // Clear the tentative state
    this.context.store.setTentative(null);
  }

  /**
   * A double click while drawing is two clicks of the drawing; it never zooms the map
   * (consumed by preventing its default action)
   */
  onDoubleClick(event: MouseNormalizedEvent): void {
    event.originalEvent.preventDefault();
  }

  onClick(event: MouseNormalizedEvent): void {
    // Complete when there are at least three points and the click is near the first vertex
    if (this.coordinates.length >= 3 && this.isNearFirstVertex) {
      this.finishPolygon();
      return;
    }

    // Read the snap target of this click and first take in the sequence of boundary vertices
    // between it and the previously confirmed click (tracing)
    const anchor = readTraceAnchor(this.context, event);
    const path = computeTracePath(this.context, this.traceAnchor, anchor);
    if (path) {
      this.coordinates.push(...path);
    }
    this.traceAnchor = anchor;
    this.tracePreview = null;

    // Add the vertex
    const coord: [number, number] = [event.lngLat.lng, event.lngLat.lat];
    this.coordinates.push(coord);

    // Clear the redo stack when a new vertex is added
    this.redoStack = [];

    // Update the tentative state
    // Note: the redraw is triggered automatically by RenderCoordinator subscribing to Store changes
    this.updateTentative();
  }

  onMouseMove(event: MouseNormalizedEvent): void {
    // Save the last mouse coordinate (for displaying the dashed line on undo/redo)
    this.lastMouseCoord = [event.lngLat.lng, event.lngLat.lat];

    // Check whether it is near the first vertex
    this.isNearFirstVertex = this.checkNearFirstVertex(event.point);

    // When the snap target of the cursor is the same feature as the previously confirmed
    // click, hold the path that is going to be inserted as a preview
    this.tracePreview = computeTracePath(
      this.context,
      this.traceAnchor,
      readTraceAnchor(this.context, event),
    );

    // Update the cursor
    if (this.coordinates.length >= 3 && this.isNearFirstVertex) {
      this.context.map.getCanvas().style.cursor = 'pointer';
    } else {
      this.context.map.getCanvas().style.cursor = 'crosshair';
    }

    // When there is at least one vertex, display the line up to the mouse position
    if (this.coordinates.length > 0) {
      this.updateTentative(this.lastMouseCoord);
    }
  }

  onKeyDown(event: KeyNormalizedEvent): void {
    if (event.key === 'Escape') {
      // Cancel
      this.cancelPolygon();
    } else if (event.key === 'Enter') {
      // Confirm
      this.finishPolygon();
    } else if (event.key === 'Backspace' || event.key === 'Delete') {
      // Remove the last vertex
      this.removeLastVertex();
    }
  }

  /**
   * The feature to prefer when snapping candidates are tied (the boundary that tracing started
   * along)
   */
  getSnapPreference(): { featureId: string; datasetId?: string } | null {
    if (!this.traceAnchor || !isTraceEnabled(this.context)) return null;
    return {
      featureId: this.traceAnchor.featureId,
      datasetId: this.traceAnchor.datasetId,
    };
  }

  /**
   * Checks whether it is near the first vertex
   */
  private checkNearFirstVertex(screenPoint: { x: number; y: number }): boolean {
    if (this.coordinates.length === 0) return false;

    const firstCoord = this.coordinates[0];
    const firstScreenPoint = this.context.map.project(firstCoord);

    const dx = screenPoint.x - firstScreenPoint.x;
    const dy = screenPoint.y - firstScreenPoint.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    return distance <= VERTEX_CLICK_TOLERANCE;
  }

  /**
   * Confirms the polygon
   */
  private finishPolygon(): void {
    // At least three points are required
    if (this.coordinates.length < 3) {
      return;
    }

    const { store, autoNameGenerator } = this.context;

    // Discard the drawing when no layer can be written any more
    const layerId = resolveCommitLayer(this.context);
    if (layerId === null) return;

    // Generate the automatic name
    const autoName = autoNameGenerator.generateName('Polygon');

    // Create the closed ring (append the first point at the end)
    const ring: [number, number][] = [...this.coordinates, this.coordinates[0]];

    // Use the ID generated in advance (generate a new one if there is none)
    const featureId = this.pendingFeatureId ?? this.context.generateFeatureId();

    // Create a new polygon feature
    const feature: Feature = {
      id: featureId,
      type: 'Polygon',
      coordinates: [ring],
      layerId,
      properties: {
        ...createdZoomProperty(this.context),
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
    this.coordinates = [];
    this.isNearFirstVertex = false;
    this.pendingFeatureId = null;
    this.traceAnchor = null;
    this.tracePreview = null;

    // Return to the select mode
    this.context.setMode('select');
  }

  /**
   * Cancels the creation of the polygon
   */
  private cancelPolygon(): void {
    if (this.coordinates.length > 0) {
      this.coordinates = [];
      this.pendingFeatureId = null;
      this.traceAnchor = null;
      this.tracePreview = null;
      this.context.store.setTentative(null);
    } else {
      // Return to the select mode if drawing is not in progress
      this.context.setMode('select');
    }
  }

  /**
   * Removes the last vertex
   */
  private removeLastVertex(): void {
    if (this.coordinates.length > 0) {
      this.coordinates.pop();
      // A vertex removed with Backspace/Delete cannot be redone
      this.redoStack = [];
      // The previously confirmed click changes, so the start point of the trace is discarded too
      this.clearTrace();
      this.updateTentative();
    }
  }

  /**
   * Undoes a vertex while drawing
   */
  undoVertex(): boolean {
    if (this.coordinates.length === 0) {
      return false;
    }
    const removed = this.coordinates.pop()!;
    this.redoStack.push(removed);
    this.clearTrace();
    // Pass the mouse coordinate to keep the dashed line
    this.updateTentative(this.lastMouseCoord ?? undefined);
    return true;
  }

  /**
   * Redoes a vertex that was undone
   */
  redoVertex(): boolean {
    if (this.redoStack.length === 0) {
      return false;
    }
    const restored = this.redoStack.pop()!;
    this.coordinates.push(restored);
    this.clearTrace();
    // Pass the mouse coordinate to keep the dashed line
    this.updateTentative(this.lastMouseCoord ?? undefined);
    return true;
  }

  /**
   * Discards the state of the trace
   *
   * On an undo / redo of a vertex the "previously confirmed click" changes, so the snap target
   * that was held as the start point is not kept in use as it is.
   */
  private clearTrace(): void {
    this.traceAnchor = null;
    this.tracePreview = null;
  }

  /**
   * Updates the tentative state
   */
  private updateTentative(mouseCoord?: [number, number]): void {
    if (this.coordinates.length === 0) {
      this.context.store.setTentative(null);
      return;
    }

    // The coordinate array including the mouse position and the trace path up to it
    // (the confirmed ones remain the leading coordinates.length entries)
    const coords = mouseCoord
      ? [...this.coordinates, ...(this.tracePreview ?? []), mouseCoord]
      : [...this.coordinates];

    // Highlight it when the cursor is near the first vertex (only when it can be closed with
    // three or more points)
    const highlightedVertexIndex =
      this.coordinates.length >= 3 && this.isNearFirstVertex ? 0 : undefined;

    // Display it as a polygon (a closed shape) when there are at least two points
    if (coords.length >= 2) {
      // Display it as a closed ring
      const ring = [...coords, coords[0]];
      this.context.store.setTentative({
        type: 'Polygon',
        coordinates: [ring],
        layerId: this.context.getCurrentLayerId(),
        confirmedCount: this.coordinates.length, // Number of confirmed coordinates (before closing)
        highlightedVertexIndex,
        pendingFeatureId: this.pendingFeatureId ?? undefined,
      });
    } else {
      // Display it as a marker when there is only one point
      this.context.store.setTentative({
        type: 'Point',
        coordinates: coords[0],
        layerId: this.context.getCurrentLayerId(),
        pendingFeatureId: this.pendingFeatureId ?? undefined,
      });
    }
  }
}
