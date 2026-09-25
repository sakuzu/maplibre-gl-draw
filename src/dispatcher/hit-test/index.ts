// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Hit Test module
 */

// OBB (Oriented Bounding Box) - re-exported from shared/math
// Hit testing service
export type { OBB, ScreenPoint } from '../../shared/math/index.js';
export {
  createOBB,
  distanceToOBB,
  getOBBAABB,
  getOBBCorners,
  pointInOBB,
} from '../../shared/math/index.js';
// Box selection strategies
export {
  createCoreBoxSelectionStrategies,
  ImageBoxSelectionStrategy,
  LineStringBoxSelectionStrategy,
  MultiLineStringBoxSelectionStrategy,
  MultiPointBoxSelectionStrategy,
  MultiPolygonBoxSelectionStrategy,
  PointBoxSelectionStrategy,
  PolygonBoxSelectionStrategy,
} from './box-strategies.js';
export type { BoxSelectionStrategy } from './box-strategy.js';
export { BoxSelectionStrategyRegistry } from './box-strategy.js';
export type { HitTestService, UnprojectFunction } from './service.js';
export { HitTestServiceImpl } from './service.js';
// Hit testing strategies
export type {
  HitTestOptions,
  HitTestResult,
  HitTestStrategy,
  VertexHit,
} from './strategies/index.js';
export {
  CircleHitTestStrategy,
  DEFAULT_HIT_TEST_OPTIONS,
  HitTestStrategyRegistry,
  ImageHitTestStrategy,
  LineHitTestStrategy,
  MultiLineStringHitTestStrategy,
  MultiPointHitTestStrategy,
  MultiPolygonHitTestStrategy,
  PointHitTestStrategy,
  PolygonHitTestStrategy,
} from './strategies/index.js';
// Unified z traversal (walks the Store and the datasets in visual
// stacking order)
export type {
  HitTestTopmost,
  TopHit,
  TopmostHitTestDeps,
  TopmostHitTestOptions,
} from './topmost.js';
export { createTopmostHitTester } from './topmost.js';
