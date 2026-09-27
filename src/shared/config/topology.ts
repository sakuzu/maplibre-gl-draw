// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Topology configuration
 *
 * Settings that keep the "boundary" where adjacent features share coordinates from breaking
 * when it is edited. Everything is disabled by default, and is layered on top of the existing
 * editing behavior only when enabled.
 */

/**
 * Settings that keep a boundary shared by adjacent features intact while it is edited
 *
 * The engine reads them from the `topology` option of `createDraw`, which
 * `draw.options.update` changes later. Everything is off by default.
 */
export interface TopologyConfig {
  /**
   * Whether dragging a vertex also moves the vertices of other features at the same position
   *
   * When true, dragging a vertex in the select mode also moves, by the same amount, any other
   * feature that has a vertex exactly matching (tolerance 0) the dragged vertex.
   * This lets the boundary of adjacent polygons be edited without creating gaps or overlaps.
   *
   * @defaultValue `false`
   */
  sharedVertexDrag: boolean;
}

/**
 * Default topology configuration (everything disabled)
 */
export const DEFAULT_TOPOLOGY_CONFIG: TopologyConfig = {
  sharedVertexDrag: false,
};

/**
 * Helper function that merges configurations
 */
export function mergeTopologyConfig(
  base: TopologyConfig,
  override: Partial<TopologyConfig>,
): TopologyConfig {
  return {
    ...base,
    ...override,
  };
}
