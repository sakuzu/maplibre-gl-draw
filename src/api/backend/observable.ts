// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A value that changes over time, of the shape the library gives its own (`Observable`), for a
 * storage or an extension to give one
 */

import type { Observable } from '../events.js';

/**
 * Makes a value that changes over time, of the same shape as the ones the library gives: the
 * value now, followed with `subscribe`, and changed with `set`.
 *
 * `set` with the value it holds (the same by `Object.is`) changes nothing and calls no one. Each
 * function given to `subscribe` is called with the value now at once, and again after each change,
 * in the order they were given; one that throws does not keep the others from being called, and
 * the first error is thrown again once they all were.
 *
 * @param initial - The value it holds first
 */
export function createObservable<T>(initial: T): Observable<T> & { set(value: T): void } {
  let value = initial;
  const runs = new Set<{ readonly run: (value: T) => void }>();
  return {
    get value() {
      return value;
    },
    subscribe(run) {
      // One entry per call, so that the same function given twice is called twice
      const entry = { run };
      runs.add(entry);
      run(value);
      return () => {
        runs.delete(entry);
      };
    },
    set(next) {
      if (Object.is(next, value)) return;
      value = next;
      let failed = false;
      let error: unknown;
      for (const entry of [...runs]) {
        // One that stopped while the others were called is not called
        if (!runs.has(entry)) continue;
        try {
          entry.run(next);
        } catch (thrown) {
          if (!failed) error = thrown;
          failed = true;
        }
      }
      if (failed) throw error;
    },
  };
}
