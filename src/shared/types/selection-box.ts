// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The corners of a selection box
 */

import type { Coordinate } from './model.js';

/**
 * The four corners and the center of a selection box, as geographic coordinates
 *
 * The box may be rotated with its feature (an Image, or a custom type that returns an
 * oriented box), so the corners are named in the box's own orientation: `topLeft` is the
 * top-left corner before the rotation.
 */
export interface BoundingBoxCoords {
  /** The top-left corner */
  topLeft: Coordinate;
  /** The top-right corner */
  topRight: Coordinate;
  /** The bottom-right corner */
  bottomRight: Coordinate;
  /** The bottom-left corner */
  bottomLeft: Coordinate;
  /** The center */
  center: Coordinate;
}
