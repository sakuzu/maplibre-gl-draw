// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Copying of user-defined properties
 *
 * Property names come from the data being imported, so `__proto__` is an ordinary key there
 * (JSON.parse creates it as an own property). Assigning it with `target[key] = value` would
 * replace the prototype of the target instead, which hides the key, makes the other keys of
 * the value appear as inherited properties and loses the key on the next export. Properties
 * are therefore defined as own data properties, the same as JSON.parse does.
 */
export function setOwnProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}
