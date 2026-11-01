// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Plugins: bundles of other extensions and state
 */

import type { Feature } from '../model.js';
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
  /**
   * A drawing mode created a feature: a commit of `ModeContext.commitFeature`, which the
   * built-in drawing modes use too, or the image placed by the load that follows a request of the
   * image mode.
   */
  onFeatureCommit?(feature: Feature): void;
  /** The hooks of the select mode: the clicks on a feature it offers the plugins */
  readonly selectMode?: {
    /**
     * The feature selected alone was clicked again (not with Shift, and not by the click that
     * finished an exclusive interaction); returning true means the plugin handled it
     */
    onSelectedFeatureClick?(feature: Feature, event: DrawPointerEvent): boolean;
    /**
     * A feature was double-clicked, selected or not: the select mode selects it, then asks;
     * returning true means the plugin handled it
     */
    onFeatureDoubleClick?(feature: Feature, event: DrawPointerEvent): boolean;
  };
  /**
   * An exclusive interaction of the plugin on the map, such as a form it shows over a feature:
   * while it is active, the select mode stays still.
   */
  readonly exclusive?: {
    /** Whether the interaction is active; the select mode stays still while it is */
    isActive(): boolean;
    /** Completes the interaction: a click outside its container, or the select mode left */
    finish?(): void;
    /** Cancels the interaction: an Escape */
    cancel?(): void;
    /** The element of the interaction; a press inside it is left to the plugin */
    container?(): HTMLElement | null;
  };
}
