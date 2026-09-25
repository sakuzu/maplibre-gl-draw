// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Frozen copies for the in-memory document
 *
 * MemoryStore keeps its own copy of what it is given and freezes it, so that a caller's
 * array is never shared with the store and a write into a returned object throws instead of
 * changing the store behind its notifications and its derived index.
 */

import type { Feature } from '../types.js';

/**
 * Returns a deeply frozen copy of a JSON-like value
 *
 * Arrays and plain objects are copied and frozen. A value that is already frozen is taken
 * as it is (the store's own objects, passed back in an update). Other objects (a Date, a
 * typed array, a class instance) are kept as they are.
 */
export function frozenCopy<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    const copy = new Array(value.length);
    for (let i = 0; i < value.length; i++) copy[i] = frozenCopy(value[i]);
    return Object.freeze(copy) as T;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const copy: Record<string, unknown> = prototype === null ? Object.create(null) : {};
  for (const key of Object.keys(value)) {
    const item = frozenCopy((value as Record<string, unknown>)[key]);
    if (key === '__proto__') {
      // An own key named __proto__ stays an ordinary key (an assignment would replace the
      // prototype of the copy)
      Object.defineProperty(copy, key, {
        value: item,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    } else {
      copy[key] = item;
    }
  }
  return Object.freeze(copy) as T;
}

/**
 * Returns a frozen feature built from a base and a set of changes, copying only the fields
 * the changes carry (the base is already the store's frozen feature)
 */
export function frozenFeature(base: Feature | undefined, changes: Partial<Feature>): Feature {
  const feature = { ...base } as Record<string, unknown>;
  for (const key of Object.keys(changes)) {
    feature[key] = frozenCopy((changes as Record<string, unknown>)[key]);
  }
  return Object.freeze(feature) as unknown as Feature;
}
