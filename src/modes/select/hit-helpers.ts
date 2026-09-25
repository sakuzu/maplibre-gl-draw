// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared hit test helpers for SelectMode
 *
 * Provides "building the callback that obtains the additional resize handles for a custom
 * feature" and "building the callback that enumerates the auxiliary handles provided by an
 * extension implementation", both used in common by onMouseDown / onMouseMove / onDragStart.
 * There are 2 kinds of auxiliary handles: those bound to the selected feature (getHandles) and
 * those independent of the selection (getGlobalHandles).
 */

import type { Feature } from '../../store/types.js';
import type { AuxiliaryHandlesCallback } from '../../view/ui/handle-test.js';
import type { HandleInfo } from '../../view/ui/handles.js';
import type { SelectionScope } from '../../view/ui/selection-scope.js';
import type { BoundingBoxCoords } from '../../view/ui/selection-ui/index.js';

/**
 * Obtain the callback that computes the additional resize handles of a custom feature.
 *
 * The additional handles are obtained from the custom feature handler only for a single
 * selection. The callback is uniformly shaped to receive the bbox after the margin is applied.
 */
export function getAdditionalResizeHandlesCallback(
  features: Feature[],
  scope: SelectionScope,
): ((marginedBbox: BoundingBoxCoords) => HandleInfo[]) | undefined {
  if (features.length !== 1) return undefined;

  const feature = features[0];
  const calculator = scope.extensions.getAdditionalResizeHandlesCalculator(feature.type);
  if (!calculator) return undefined;

  return (marginedBbox: BoundingBoxCoords) => calculator(feature, marginedBbox) as HandleInfo[];
}

/**
 * Obtain the callback that enumerates the auxiliary handles provided by extension
 * implementations.
 *
 * Every provider registered in this draw instance is gathered, only for a single selection (the same restriction as
 * for the additional resize handles). When not a single provider is registered, undefined is
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
