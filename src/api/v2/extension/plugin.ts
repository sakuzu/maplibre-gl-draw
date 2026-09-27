// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Plugins: bundles of other extensions and state
 */

import type { FeatureType } from '../model.js';
import type { PluginContext } from './context.js';
import type { InputHandlers } from './mode.js';

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
  /** Hooks into the select mode, and an exclusive interaction of the plugin */
  // TODO(api-2): confirm the members and their signatures (carried over from the interaction hooks of the previous plugins)
  readonly interaction?: {
    /** Narrows the candidates of a selection to the IDs it returns */
    filterSelection?(candidateIds: string[]): string[];
    /** A selected feature was clicked again; returning true means the plugin handled it */
    onFeatureClick?(featureId: string): boolean;
    /** A feature was double-clicked; returning true means the plugin handled it */
    onFeatureDoubleClick?(featureId: string): boolean;
    /** A drawing mode created a feature */
    onDrawCommit?(featureId: string, type: FeatureType): void;
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
