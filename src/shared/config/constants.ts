// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Constant definitions
 *
 * UI configuration constants.
 */

/**
 * The handle of the selection UI being dragged
 *
 * `resize-*` are the resize handles by compass direction (the corners, and the edge midpoints
 * that a custom feature type can add), `rotate` the rotate handle, `vertex` and `midpoint`
 * the handles of a line or a polygon, and `radius` and `center` those of a Circle.
 */
export type HandleType =
  | 'resize-nw'
  | 'resize-n'
  | 'resize-ne'
  | 'resize-e'
  | 'resize-se'
  | 'resize-s'
  | 'resize-sw'
  | 'resize-w'
  | 'rotate'
  | 'vertex'
  | 'midpoint'
  | 'radius'
  | 'center';
