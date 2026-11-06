// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared hit test helpers for SelectMode
 *
 * Provides "building the callback that enumerates the auxiliary handles provided by an
 * extension implementation", used in common by onMouseDown / onMouseMove / onDragStart.
 * There are 2 kinds of auxiliary handles: those bound to the selected feature (getHandles) and
 * those independent of the selection (getGlobalHandles).
 */

import { getDisplayFeatures } from '../../store/local-visibility.js';
import { isFeatureLocked } from '../../store/lock.js';
import type { Feature } from '../../store/types.js';
import type { AuxiliaryHandlesCallback } from '../../view/ui/handle-test.js';
import type { SelectionScope } from '../../view/ui/selection-scope.js';
import type { EngineModeContext } from '../handler.js';

/**
 * Whether the topmost feature at a point is one of these features and locked: a press on it moves
 * nothing, though the others of the selection it is in can be moved
 */
export function isLockedFeatureAt(
  point: { x: number; y: number },
  features: readonly Feature[],
  context: EngineModeContext,
): boolean {
  const { store } = context;
  const locked = features.filter((feature) => isFeatureLocked(feature, store));
  if (locked.length === 0) return false;
  const top = context.hitTestTopmost(point, { orderedFeatures: getDisplayFeatures(store) });
  const id = top?.kind === 'store' ? top.feature.id : top?.kind === 'row' ? top.id : undefined;
  return locked.some((feature) => feature.id === id);
}

/**
 * Obtain the callback that enumerates the auxiliary handles provided by extension
 * implementations.
 *
 * Every provider registered in this draw instance is gathered, only for a single selection.
 * When not a single provider is registered, undefined is
 * returned and the caller does not perform the auxiliary handle test at all (it takes the
 * conventional path).
 */
export function getAuxiliaryHandlesCallback(
  features: Feature[],
  scope: SelectionScope,
): AuxiliaryHandlesCallback | undefined {
  if (features.length !== 1) return undefined;

  const providers = scope.auxiliaryHandles.list();
  if (providers.length === 0) return undefined;

  const feature = features[0];

  return (context) =>
    providers.flatMap((provider) =>
      provider.getHandles(feature, context).map((handle) => ({ providerId: provider.id, handle })),
    );
}

/**
 * Obtain the callback that enumerates the "selection-independent auxiliary handles" provided by
 * extension implementations.
 *
 * It takes no argument because it does not care whether there is a selection. When not a single
 * provider implements getGlobalHandles, undefined is returned and the caller does not perform
 * the test at all (it takes the conventional path).
 */
export function getGlobalAuxiliaryHandlesCallback(
  scope: SelectionScope,
): AuxiliaryHandlesCallback | undefined {
  const providers = scope.auxiliaryHandles.list().filter((p) => p.getGlobalHandles !== undefined);
  if (providers.length === 0) return undefined;

  return (context) =>
    providers.flatMap(
      (provider) =>
        provider
          .getGlobalHandles?.(context)
          .map((handle) => ({ providerId: provider.id, handle })) ?? [],
    );
}
