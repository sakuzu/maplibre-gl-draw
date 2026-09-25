// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tracing API (the draw.tracing namespace)
 *
 * Enables or disables edge tracing (following the boundary of an existing feature while
 * drawing in order to take in its vertex sequence). The actual object is the trace
 * configuration held by the Context, and the drawing modes look at that same object, so a
 * switch takes effect from the next click or move.
 */

import type { TraceConfig } from '../shared/config/trace.js';
import type { MapLibreGLDraw } from './api.js';

/**
 * The edge tracing of a draw instance, reached as `draw.tracing`.
 *
 * In draw_line / draw_polygon, when the previous click and this click both snapped to the
 * boundary (a vertex or an edge) of the same feature, the boundary vertices between them are
 * inserted: the shortest path along the edges of the visible features nearby, across shared
 * vertices. It needs snapping, so it does not hold while snapping is off or released. The
 * path is previewed while the pointer moves.
 * The initial value comes from {@link Options.trace}; the path itself is computed by
 * {@link buildTraceGraph} and {@link findTracePath}.
 *
 * @example
 * ```typescript
 * draw.tracing.setEnabled(false);
 * draw.tracing.isEnabled(); // false
 * ```
 */
export interface TracingOperations {
  /**
   * Enables or disables tracing.
   *
   * The initial value is `options.trace.enabled` (default true). When it is disabled, the
   * clicks and the preview while drawing add only the point clicked. A change takes effect
   * from the next click or move.
   *
   * @param enabled whether to trace
   */
  setEnabled(enabled: boolean): void;

  /** Whether tracing is enabled */
  isEnabled(): boolean;
}

/** @internal */
export type TracingApi = Pick<MapLibreGLDraw, 'tracing'>;

/** @internal */
export interface TracingApiDeps {
  /** The trace configuration of the Context (the actual object that is rewritten) */
  trace: TraceConfig;
}

/** @internal */
export function createTracingApi(deps: TracingApiDeps): TracingApi {
  const { trace } = deps;

  return {
    tracing: {
      setEnabled(enabled: boolean): void {
        trace.enabled = enabled;
      },

      isEnabled(): boolean {
        return trace.enabled;
      },
    },
  };
}
