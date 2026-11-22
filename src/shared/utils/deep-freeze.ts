// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Freezing a table at every level
 *
 * A table of the top level of a module (a table of defaults, of names, of constants) is read by
 * every instance on the page, so a write into it, at any depth, would change what every other
 * instance reads. Wrapped in `deepFreeze`, such a write throws at once (the modules run in
 * strict mode). The type is not changed: the table keeps the type it is read with.
 */

/**
 * Freezes an object or an array and everything in it, and returns it
 *
 * Objects and arrays are frozen at every depth; functions and primitives are left as they are.
 * A typed array (and an `ArrayBuffer` or a `DataView`) cannot be frozen while it holds
 * elements, so it is left as it is. A `Set`, a `Map`, a `WeakSet` and a `WeakMap` would still
 * take entries once frozen, so they throw: a table of them is typed read-only instead
 * (`ReadonlySet`, `ReadonlyMap`).
 *
 * @param value The table
 * @returns The same table, frozen
 * @throws TypeError When the table holds a `Set`, a `Map`, a `WeakSet` or a `WeakMap`
 */
export function deepFreeze<T>(value: T): T {
  freezeInto(value, new Set());
  return value;
}

function freezeInto(value: unknown, seen: Set<object>): void {
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (
    value instanceof Set ||
    value instanceof Map ||
    value instanceof WeakSet ||
    value instanceof WeakMap
  ) {
    throw new TypeError(
      'deepFreeze: a Set or a Map cannot be frozen (it still takes entries); type it read-only',
    );
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return;
  for (const key of Reflect.ownKeys(value)) {
    freezeInto((value as Record<PropertyKey, unknown>)[key], seen);
  }
  Object.freeze(value);
}
