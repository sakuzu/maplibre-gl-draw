// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Constant definitions
 *
 * Property prefixes and UI configuration constants.
 */

/**
 * Keys of the internal meta properties
 *
 * createdZoom/rotation/scale are stored in feature.properties and round-trip through GeoJSON
 * with the maplibre-gl-draw: prefix (this library's own data, required to reproduce the
 * rendering).
 */
export const INTERNAL_PROPERTIES = {
  /** Zoom level at creation time */
  CREATED_ZOOM: 'createdZoom',
  /** Rotation angle (degrees) */
  ROTATION: 'rotation',
  /** Scale */
  SCALE: 'scale',
} as const;

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

/**
 * Handle positions
 */
export const HANDLE_POSITIONS = {
  RESIZE: ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const,
  ROTATE: 'rotate' as const,
  VERTEX: 'vertex' as const,
  MIDPOINT: 'midpoint' as const,
} as const;

/**
 * Cursor styles
 */
export const CURSOR_STYLES = {
  DEFAULT: 'default',
  POINTER: 'pointer',
  MOVE: 'move',
  GRAB: 'grab',
  GRABBING: 'grabbing',
  CROSSHAIR: 'crosshair',
  TEXT: 'text',
  RESIZE_NW: 'nw-resize',
  RESIZE_N: 'n-resize',
  RESIZE_NE: 'ne-resize',
  RESIZE_E: 'e-resize',
  RESIZE_SE: 'se-resize',
  RESIZE_S: 's-resize',
  RESIZE_SW: 'sw-resize',
  RESIZE_W: 'w-resize',
  ROTATE: 'grab',
} as const;

/**
 * Mouse event states
 */
export const MOUSE_STATE = {
  IDLE: 'idle',
  HOVER: 'hover',
  DRAGGING: 'dragging',
} as const;
