// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Config module
 *
 * Exports configuration-related types and constants.
 */

export type { HandleType } from './constants.js';
export {
  CURSOR_STYLES,
  HANDLE_POSITIONS,
  MOUSE_STATE,
} from './constants.js';
export type {
  FeatureStyleConfig,
  FillStyle,
  LineStringFeatureStyle,
  PointFeatureStyle,
  PolygonFeatureStyle,
  TentativeStyle,
} from './feature-style.js';
export { DEFAULT_FEATURE_STYLE_CONFIG, mergeFeatureStyleConfig } from './feature-style.js';
export type {
  BoxSelectionStyleConfig,
  RenderingConfig,
} from './rendering.js';
export {
  DEFAULT_BOX_SELECTION_STYLE_CONFIG,
  DEFAULT_RENDERING_CONFIG,
  mergeRenderingConfig,
} from './rendering.js';
export type {
  BoundingBoxStyle,
  CenterMarkerStyle,
  MidpointHandleStyle,
  RadiusHandleStyle,
  RadiusLineStyle,
  ResizeHandleStyle,
  RotateHandleStyle,
  SelectionUIConfig,
  VertexHandleStyle,
} from './selection.js';
export {
  DEFAULT_SELECTION_CONFIG,
  DRAGGING_STYLE_MODIFIERS,
  HOVER_STYLE_MODIFIERS,
  mergeSelectionUIConfig,
} from './selection.js';
export type { TopologyConfig } from './topology.js';
export { DEFAULT_TOPOLOGY_CONFIG, mergeTopologyConfig } from './topology.js';
export type { TraceConfig, TraceOptions } from './trace.js';
export { DEFAULT_TRACE_CONFIG, mergeTraceConfig } from './trace.js';
