// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The option and dependency types of the operations on areas of `draw.features`
 */

import type { Store } from '../../store/store.js';

/**
 * The options of `draw.features.buffer`
 *
 * @internal
 */
export interface BufferOptions {
  /**
   * The buffer distance (in meters). A negative value shrinks (area types only); 0 or a value
   * that is not finite does nothing
   */
  distanceMeters: number;
  /**
   * The number of segments of a full circle for the rounded parts (64 by default). It is
   * rounded down and clamped to 3-1024
   */
  segments?: number;
}

/**
 * The dependencies of the geometry operations (a bare Store is enough for tests)
 *
 * @internal
 */
export interface GeometryDeps {
  store: Store;
  generateFeatureId: () => string;
}
