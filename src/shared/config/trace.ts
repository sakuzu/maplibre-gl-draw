// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Trace configuration
 *
 * Whether to enable the feature that follows the boundary of an existing feature while drawing
 * and takes in its vertex sequence (edge tracing). It is enabled by default; when disabled,
 * drawing behaves exactly as it did before tracing was introduced.
 *
 * The configuration object is shared as the same instance between the context of the engine
 * and the modes. When `draw.options.update` rewrites this object, the drawing modes run with the new
 * value from the next click or move onward.
 */

/**
 * The setting of edge tracing: following the boundary of an existing feature while drawing
 *
 * The engine reads it from the `tracing` option of `createDraw`, which
 * `draw.options.update` changes later.
 */
export interface TraceOptions {
  /**
   * Whether tracing is on
   *
   * @defaultValue `true`
   */
  enabled?: boolean;
}

/**
 * The setting of edge tracing with its default filled in, as the drawing modes read it
 */
export interface TraceConfig {
  /** Whether to enable tracing */
  enabled: boolean;
}

/**
 * Default trace configuration (enabled)
 */
export const DEFAULT_TRACE_CONFIG: TraceConfig = {
  enabled: true,
};

/**
 * Helper function that merges configurations
 */
export function mergeTraceConfig(base: TraceConfig, override: TraceOptions): TraceConfig {
  return {
    ...base,
    ...override,
  };
}
