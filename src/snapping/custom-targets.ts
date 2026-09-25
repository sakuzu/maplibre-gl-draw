// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Registry of the snapping candidates of custom feature types
 *
 * It holds CustomFeatureHandler.getSnapTargets per type. The built-in providers consult it
 * for the type of the target feature (a registered type contributes its own candidates and is
 * skipped by the standard vertex, edge and intersection candidates).
 *
 * One registry belongs to one draw instance (created by createContext), so two instances on
 * the same page never see each other's registrations, and destroying an instance clears it.
 */

import type { SnapTargetsProvider } from './types.js';

/** @internal */
export interface SnapTargetsRegistry {
  /**
   * Registers a function that provides snapping candidates for a type
   *
   * @returns A function that cancels the registration (it does not remove a later
   *   registration of the same type)
   */
  register(type: string, provider: SnapTargetsProvider): () => void;
  /** Gets the registered function for a type */
  get(type: string): SnapTargetsProvider | undefined;
  /** Cancels every registration (called when the draw instance is destroyed) */
  clear(): void;
}

/**
 * Creates the snapping candidate registry of one draw instance
 *
 * @internal
 */
export function createSnapTargetsRegistry(): SnapTargetsRegistry {
  const providers = new Map<string, SnapTargetsProvider>();
  return {
    register(type, provider) {
      providers.set(type, provider);
      return () => {
        if (providers.get(type) === provider) providers.delete(type);
      };
    },
    get: (type) => providers.get(type),
    clear: () => providers.clear(),
  };
}
