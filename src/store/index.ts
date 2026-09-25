// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Store module
 *
 * Only the symbols that src/index.ts publishes are listed here (see "The public
 * surface" in CONTRIBUTING.md). Internal code imports from the defining file.
 */

export type { FeatureLockStore, InteractionGateStore } from './lock.js';
export { isFeatureLocked, isGroupLocked, isInteractionBlocked } from './lock.js';
export { MemoryStore } from './memory.js';
export type { SpatialQuery } from './spatial/spatial-index.js';
export type { DocumentStore, Store, StoreView, UiState } from './store.js';
export type {
  BoundingBox,
  BoundingBoxCoordsSimple,
  BoxSelection,
  Coordinate,
  Data,
  DragOperationType,
  DragState,
  ExportFormat,
  ExportOptions,
  ExportResult,
  Feature,
  FeatureCoordinates,
  FeatureInput,
  FeatureStyle,
  FeatureType,
  FileData,
  Group,
  ImageProperties,
  ImageStyle,
  Layer,
  LoadOptions,
  LoadResult,
  Metadata,
  Mode,
  RotateInfo,
  Selection,
  SelectionType,
  SkippedFeature,
  StateChanges,
  StyleRule,
  TentativeState,
  UpdateFeatureOptions,
  UpdateSource,
  VertexRef,
  VertexSelection,
} from './types.js';
