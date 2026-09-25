// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The render scope of one draw instance
 *
 * Everything the rendering of one CustomLayer keeps between frames and that must never be seen
 * by another draw instance: the selection scope shared with the modes, the terrain state, and
 * the caches of triangulation and style evaluation keyed by feature id. Two instances on the
 * same page (a print preview next to the editor, a duplicated document with the same ids)
 * therefore never read each other's triangles, styles or terrain.
 *
 * The CustomLayer creates it (the selection scope is handed in, because the modes use the same
 * one) and passes the parts each renderer needs at construction.
 */

import { EarcutCache } from '../cache/earcut.js';
import { StyleRuleCache } from '../cache/style-rule.js';
import { TerrainContext } from '../terrain/context.js';
import type { SelectionScope } from '../ui/selection-scope.js';

export interface RenderScope {
  /** The selection scope of the draw instance (shared with the modes) */
  readonly selection: SelectionScope;
  /** The terrain state of the draw instance */
  readonly terrain: TerrainContext;
  /** Triangulation results keyed by feature id */
  readonly earcut: EarcutCache;
  /** Evaluated style rules keyed by feature id */
  readonly styleRules: StyleRuleCache;
}

/**
 * Creates the render scope of one draw instance
 */
export function createRenderScope(selection: SelectionScope): RenderScope {
  return {
    selection,
    terrain: new TerrainContext(),
    earcut: new EarcutCache(),
    styleRules: new StyleRuleCache(),
  };
}
