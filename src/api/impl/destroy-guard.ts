// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The guard of a destroyed instance: once `destroy()` has run, every method of the draw instance
 * and of its collections throws `DrawError('invalid-state')` instead of reaching an engine that
 * has released everything
 */

import { DrawError } from '../errors.js';

/** The error of a call made after destroy */
function destroyedError(path: string): DrawError {
  return new DrawError(
    'invalid-state',
    `The draw instance is destroyed: ${path} cannot be called`,
    {
      member: path,
    },
  );
}

/** Whether the value is a plain object whose members are guarded in turn */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Copies an object with every method (at any depth of plain objects) guarded: a call after
 * `isDestroyed()` turned true throws `DrawError('invalid-state')`, or rejects with it for a
 * method that returns a promise. A getter is guarded the same way.
 *
 * @param target - The object to guard
 * @param isDestroyed - Whether the instance is destroyed
 * @param options - `asyncMembers` names the methods (by their path, such as `document.load`)
 *   that reject instead of throwing; `skip` names the members that are copied unguarded
 * @internal
 */
export function guardAfterDestroy<T extends object>(
  target: T,
  isDestroyed: () => boolean,
  options: { asyncMembers?: ReadonlySet<string>; skip?: ReadonlySet<string> } = {},
  prefix = '',
): T {
  const guarded: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(target))) {
    const path = `${prefix}${key}`;
    if (options.skip?.has(path)) {
      Object.defineProperty(guarded, key, descriptor);
      continue;
    }
    if (descriptor.get) {
      const get = descriptor.get;
      Object.defineProperty(guarded, key, {
        enumerable: descriptor.enumerable,
        get() {
          if (isDestroyed()) throw destroyedError(path);
          return get.call(target);
        },
      });
      continue;
    }
    const value: unknown = descriptor.value;
    if (typeof value === 'function') {
      const rejects = options.asyncMembers?.has(path) === true;
      guarded[key] = (...args: unknown[]): unknown => {
        if (isDestroyed()) {
          const error = destroyedError(path);
          if (rejects) return Promise.reject(error);
          throw error;
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    } else if (isPlainObject(value)) {
      guarded[key] = guardAfterDestroy(value, isDestroyed, options, `${path}.`);
    } else {
      guarded[key] = value;
    }
  }
  return guarded as T;
}
