// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Dispatcher module
 *
 * Responsible for accepting user input and routing it to modes.
 * The input handling layer of the Flux architecture.
 *
 * Only the symbols that src/index.ts publishes are listed here (see "The public
 * surface" in CONTRIBUTING.md). Internal code imports from the defining file.
 */

export type {
  BoxSelectionStrategy,
  BoxSelectionStrategyRegistry,
} from './hit-test/box-strategy.js';
export type { HitTestService, UnprojectFunction } from './hit-test/service.js';
export type {
  HitTestOptions,
  HitTestResult,
  HitTestStrategy,
  VertexHit,
} from './hit-test/strategies/base.js';
export { PointHitTestStrategy } from './hit-test/strategies/point.js';
export type { HitTestTopmost, TopHit, TopmostHitTestOptions } from './hit-test/topmost.js';
export type {
  DragNormalizedEvent,
  KeyNormalizedEvent,
  MapClickEventPayload,
  ModifierKeys,
  MouseNormalizedEvent,
  NormalizedEvent,
  PointerOriginalEvent,
  PointerType,
} from './types.js';
