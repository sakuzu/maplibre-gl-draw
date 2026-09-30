// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.drawing`: the shape the current drawing mode is drawing, driven from outside the
 * pointer and the keys
 */

import type { Position } from 'geojson';

/**
 * The shape the current drawing mode is drawing, driven from code: to draw from typed
 * coordinates, from another input device, or in an automated run.
 *
 * `addVertex`, `moveTo` and `finish` act as the input they stand for would: they are made into
 * the same pointer and key events the map gives, at the point of the screen the position
 * projects to, and go the same way as that input, through the `input` receivers of the plugins
 * first and then to the mode. The position is used as it is: nothing snaps it, and the event
 * carries it as its snapped position. A mode that ignores clicks, or a plugin that consumes
 * them, ignores or consumes these as well.
 *
 * Extensions reach the same object as `ctx.drawing`.
 */
export interface DrawingResource {
  /**
   * Whether a drawing mode is drawing: a shape is in progress, or the mode is ready to place its
   * first vertex (the current mode writes features).
   */
  isActive(): boolean;
  /**
   * Whether a shape is in progress: the mode shows a shape that is not created yet. False
   * while a drawing mode waits for its first vertex.
   */
  isDrawing(): boolean;
  /**
   * Places a vertex at a position, as a click there would: the pointer moves there, then
   * clicks. It does not snap. What the click does is up to the mode: the point mode creates the
   * point, and a click on the closing vertex of a line or an area finishes it. The position is
   * exact, so the click tolerance of the pointer (10 px) does not apply: a vertex a few pixels
   * from the last one is placed, and one near the closing vertex does not finish the shape.
   * Only a position exactly equal to the closing vertex (the last vertex of a line, the first
   * of an area) finishes it, and one exactly equal to the last vertex of an area is not placed
   * again.
   *
   * @param position - The position, as `[longitude, latitude]` in degrees
   * @returns True when the mode (or a plugin) took the click; false when no drawing mode is
   *   active or nothing took it
   * @throws `DrawError` with the code `invalid-input` when the position is not two finite
   *   numbers
   */
  addVertex(position: Position): boolean;
  /**
   * Moves the pointer to a position, as a pointer move there would: the preview of the shape
   * follows it. It does not snap, and, as with `addVertex`, the position is exact. It does
   * nothing when no drawing mode is active.
   *
   * @param position - The position, as `[longitude, latitude]` in degrees
   * @throws `DrawError` with the code `invalid-input` when the position is not two finite
   *   numbers
   */
  moveTo(position: Position): void;
  /**
   * Completes the shape in progress, as a double click on its last vertex or Enter would: the
   * mode creates the feature from the vertices placed so far, as soon as there are enough of
   * them (2 for a line, 3 for an area), wherever the last one is.
   *
   * @returns True when the shape was completed; false when no shape is in progress, or the mode
   *   did not complete it (too few vertices)
   */
  finish(): boolean;
  /**
   * Cancels the shape in progress, as an Escape does while drawing: the mode drops it
   * (`ModeHandler.onCancel`), the preview is cleared and the mode stays the current one. When
   * no shape is in progress it does nothing; unlike an Escape, it does not leave the mode.
   *
   * @returns True when a shape was in progress and was cancelled
   */
  cancel(): boolean;
  /**
   * Removes the last vertex of the shape in progress.
   *
   * @returns True when a vertex was removed; false when nothing is being drawn or the mode has
   *   no vertex to remove
   */
  undoVertex(): boolean;
  /**
   * Puts back the vertex the last `undoVertex` removed.
   *
   * @returns True when a vertex was put back
   */
  redoVertex(): boolean;
}
