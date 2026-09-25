// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Circle rendering utilities
 *
 * Functions for rendering a circle by approximating it with a polygon (64 vertices).
 */

// The actual generation of a geodesic circle lives in the geometry module (single
// implementation)
export { generateCirclePolygon } from '../../geometry/index.js';
