// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Hit Test Strategies
 */

// Base interfaces
export type { HitTestOptions, HitTestResult, HitTestStrategy, VertexHit } from './base.js';
export { DEFAULT_HIT_TEST_OPTIONS, HitTestStrategyRegistry } from './base.js';

// Strategies per geometry type
export { CircleHitTestStrategy } from './circle.js';
export { ImageHitTestStrategy } from './image.js';
export { LineHitTestStrategy } from './line.js';
export {
  MultiLineStringHitTestStrategy,
  MultiPointHitTestStrategy,
  MultiPolygonHitTestStrategy,
} from './multi.js';
export { PointHitTestStrategy } from './point.js';
export { PolygonHitTestStrategy } from './polygon.js';
