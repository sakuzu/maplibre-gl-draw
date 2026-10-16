// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Plugins: bundles of other extensions and state
 */

import type { Feature } from '../model.js';
import type { VertexRef } from '../state.js';
import type { LayerTableView } from '../tables.js';
import type { PluginContext } from './context.js';
import type { DrawPointerEvent, InputHandlers } from './mode.js';

/**
 * A plugin: a bundle of modes, feature types, overlays, providers and state, added with
 * `draw.extensions.plugins.add`. What it adds through its context is removed by itself when
 * the plugin is removed. Plugins talk to each other through their `api`.
 *
 * @typeParam Api - The API the plugin offers to others
 */
export interface Plugin<Api = unknown> {
  /** The name it is registered under */
  readonly name: string;
  /** Called when the plugin is added; add its extensions and subscribe to events here. */
  onAdd(ctx: PluginContext): void;
  /** Called when the plugin is removed. */
  onRemove?(): void;
  /** The API others get with `draw.extensions.plugins.getApi(name)` */
  readonly api?: Api;
  /**
   * Receivers of the input, called before those of the mode. Returning true consumes the
   * event, so that the mode does not get it.
   */
  readonly input?: Partial<InputHandlers>;
  /** The hooks of the select mode, and an exclusive interaction of the plugin */
  readonly interaction?: {
    /** Narrows the candidates of a selection to the IDs it returns */
    filterSelection?(candidateIds: readonly string[]): string[];
    /**
     * Narrows the rows of a layer held as rows a selection of many features would select (a box
     * over many features), to the handles it returns, without making features of them. Its type
     * is in `@sakuzu/maplibre-gl-draw/kasane`. A plugin without it narrows no row.
     *
     * @experimental
     */
    filterSelectionRows?(view: LayerTableView, handles: Int32Array): Int32Array;
    /**
     * Whether a drag of the select mode may grab what it moves of a feature: some of its
     * vertices (`vertices`: the vertices it moves, empty for a vertex it adds between two), or
     * the feature whole (`vertices` absent: a move, a resize, a rotation, a drag of a radius).
     * Asked before the drag starts, for every feature it would change (the features that follow
     * a vertex shared with the one grabbed included); false for any of them keeps the drag from
     * starting, as for a locked feature. A plugin without it lets every drag start. The drags of
     * features selected in bulk (`Selection.bulk`) and of the handles of providers are not asked
     */
    canDrag?(featureId: string, vertices?: readonly VertexRef[]): boolean;
    /** A selected feature was clicked again; returning true means the plugin handled it */
    onFeatureClick?(feature: Feature, event: DrawPointerEvent): boolean;
    /** A feature was double-clicked; returning true means the plugin handled it */
    onFeatureDoubleClick?(feature: Feature, event: DrawPointerEvent): boolean;
    /**
     * A drawing mode created a feature: a commit of `ModeContext.commitFeature`, which the
     * built-in drawing modes use too, or the image placed by the load that follows a request
     * of the image mode
     */
    onDrawCommit?(feature: Feature): void;
    /** Whether the plugin is in an exclusive interaction, during which the mode stays still */
    isBusy?(): boolean;
    /** Completes the exclusive interaction */
    finish?(): void;
    /** Cancels the exclusive interaction */
    cancel?(): void;
    /** The element of the exclusive interaction; clicks inside it are left to the plugin */
    container?(): HTMLElement | null;
  };
}
