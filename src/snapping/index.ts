// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Snapping module
 *
 * It provides snapping (SnapService) and its extension point (SnapProvider).
 * The replacement of the coordinates is done by InputRouter.
 *
 * Only the symbols that src/index.ts publishes are listed here (see "The public
 * surface" in CONTRIBUTING.md). Internal code imports from the defining file.
 */

export type { SnapIndicatorStyles } from './indicator.js';
export { DEFAULT_SNAP_GUIDE_LINE_STYLE, DEFAULT_SNAP_INDICATOR_STYLES } from './indicator.js';
export type { GuideSnapProviderDeps, GuideSnapProviderOptions } from './providers/guide.js';
export { createGuideSnapProvider } from './providers/guide.js';
export type {
  ResolvedSnapOptions,
  SnapCandidate,
  SnapContext,
  SnapDisableKey,
  SnapExcludeVertex,
  SnapLngLat,
  SnapOptions,
  SnapPointCandidate,
  SnapProvider,
  SnapProviderContext,
  SnapResult,
  SnapSegmentCandidate,
  SnapTarget,
  SnapTargetKind,
  SnapTargetSegment,
} from './types.js';
