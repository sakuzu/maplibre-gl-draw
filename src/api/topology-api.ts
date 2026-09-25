// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Topology API (the draw.topology namespace)
 *
 * Switches, at runtime, the settings that keep editing from breaking boundaries shared by
 * adjacent features, such as simultaneous movement of shared vertices. The actual object is
 * the topology configuration held by the Context, and the drag handler of the select mode
 * looks at that same object, so a switch takes effect from the next drag start (it does not
 * affect a drag already in progress).
 */

import type { TopologyConfig } from '../shared/config/topology.js';
import type { MapLibreGLDraw } from './api.js';

/**
 * The topology settings of a draw instance, reached as `draw.topology`: switching at runtime
 * the settings that keep editing from breaking boundaries shared by adjacent features.
 *
 * The initial values come from {@link Options.topology}. A switch takes effect from the next
 * drag start and does not affect a drag in progress.
 *
 * @example
 * ```typescript
 * sharedVertexToggle.onchange = () => {
 *   draw.topology.setSharedVertexDrag(sharedVertexToggle.checked);
 * };
 * ```
 */
export interface TopologyOperations {
  /**
   * Enables or disables simultaneous movement of shared vertices.
   *
   * The initial value is `options.topology.sharedVertexDrag` (the core default is false).
   * While it is enabled, dragging a vertex also moves other features that have a vertex at
   * an exact match (tolerance 0), and the following vertices are highlighted during the drag.
   * The following features must be visible and unlocked, and be of a type whose vertices can
   * be edited (not Circle, Image or Freehand). The drag commits as one change, one notification.
   *
   * @param enabled whether shared vertices move together
   */
  setSharedVertexDrag(enabled: boolean): void;

  /** Whether simultaneous movement of shared vertices is enabled */
  isSharedVertexDrag(): boolean;
}

/** @internal */
export type TopologyApi = Pick<MapLibreGLDraw, 'topology'>;

/** @internal */
export interface TopologyApiDeps {
  /** The topology configuration of the Context (the actual object that is rewritten) */
  topology: TopologyConfig;
}

/** @internal */
export function createTopologyApi(deps: TopologyApiDeps): TopologyApi {
  const { topology } = deps;

  return {
    topology: {
      setSharedVertexDrag(enabled: boolean): void {
        topology.sharedVertexDrag = enabled;
      },

      isSharedVertexDrag(): boolean {
        return topology.sharedVertexDrag;
      },
    },
  };
}
