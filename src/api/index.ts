// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * API module
 *
 * Only the symbols that src/index.ts publishes are listed here (see "The public
 * surface" in CONTRIBUTING.md). Internal code imports from the defining file.
 */

export type {
  CustomFeatureHandler,
  CustomFeatureRenderer,
  CustomOverlayRenderer,
  CustomRendererDrawContext,
  CustomResizeResult,
  LayerAwareOverlayRenderer,
} from '../extension/index.js';
export type {
  EventPayloads,
  MapLibreGLDraw,
  TerrainDiagnostics,
  TerrainRenderDiagnostics,
} from './api.js';
export type { Options } from './context.js';
export type {
  GeometryApi,
  GeometryApiDeps,
  GeometryBufferOptions,
  GeometryOperations,
} from './geometry-operations.js';
export { createGeometryApi } from './geometry-operations.js';
export type {
  InputOperations,
  SyntheticInputOptions,
  SyntheticKeyOptions,
  SyntheticLngLat,
  SyntheticModifiers,
} from './input-api.js';
export type { SnappingOperations } from './snapping-api.js';
export type { TopologyOperations } from './topology-api.js';
export type { TracingOperations } from './tracing-api.js';
