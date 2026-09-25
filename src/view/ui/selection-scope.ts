// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The selection scope of one draw instance
 *
 * What the selection UI (drawn by the CustomLayer) and the handle hit testing (run by the modes)
 * must share: the extension points of the custom feature types, the registered auxiliary
 * handles and the cache of the thinned handles. It is created once per draw instance and handed
 * to both sides, so two instances on the same page never see each other's registrations or
 * cached handle sets.
 */

import {
  type AuxiliaryHandleRegistry,
  createAuxiliaryHandleRegistry,
} from './auxiliary-handles.js';
import { HandleThinningCache } from './handle-thinning.js';
import {
  createSelectionExtensionRegistry,
  type SelectionExtensionRegistry,
} from './selection-ui/extension-registry.js';

/**
 * The registries the selection UI and the handle hit testing of one draw instance share:
 * the selection extension points of custom feature types and the auxiliary handle providers.
 *
 * A mode reaches it as {@link ModeContext.selectionScope}.
 */
export interface SelectionScope {
  /** Bounding box / resize / point frame extension points of the custom feature types */
  readonly extensions: SelectionExtensionRegistry;
  /** Providers of the auxiliary handles */
  readonly auxiliaryHandles: AuxiliaryHandleRegistry;
  /**
   * The thinned handle sets shared by rendering and hit testing
   *
   * @internal
   */
  readonly thinning: HandleThinningCache;
  /** Clears every registration and cached set (called when the draw instance is destroyed) */
  clear(): void;
}

/**
 * Creates the selection scope of one draw instance
 *
 * @internal
 */
export function createSelectionScope(): SelectionScope {
  const extensions = createSelectionExtensionRegistry();
  const auxiliaryHandles = createAuxiliaryHandleRegistry();
  const thinning = new HandleThinningCache();
  return {
    extensions,
    auxiliaryHandles,
    thinning,
    clear() {
      extensions.clear();
      auxiliaryHandles.clear();
      thinning.clear();
    },
  };
}
