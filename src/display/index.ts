// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Display module
 *
 * Read-only layers that show large amounts of data (datasets). They are a
 * path independent of the Store and do not go through the mechanisms of editing,
 * undo or events.
 *
 * Only the symbols that src/index.ts publishes are listed here (see "The public
 * surface" in CONTRIBUTING.md). Internal code imports from the defining file.
 */

export type {
  DatasetColumn,
  DatasetColumnarGeometry,
  DatasetColumnarGeometryType,
  DatasetColumnarInput,
  DatasetColumnarPrepared,
  DatasetDictionaryCodes,
  DatasetDictionaryColumn,
} from './columnar/types.js';
export type {
  DatasetCollisionThinning,
  DatasetThinningStats,
  ResolvedCollisionThinning,
} from './thinning.js';
export type {
  Dataset,
  DatasetBaseStyle,
  DatasetChangePayload,
  DatasetClickEventPayload,
  DatasetClickPayload,
  DatasetEventMap,
  DatasetFeatureInput,
  DatasetFeatureProvider,
  DatasetHoverPayload,
  DatasetOptions,
  DatasetOrder,
  DatasetPlacement,
  DatasetZoomScale,
} from './types.js';
