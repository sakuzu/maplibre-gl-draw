// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The sets of IDs the instance hands out (`IdSet`): the set as it was when it was given, read
 * through its methods only
 *
 * A set keeps its own copy of the IDs, taken once when it is made, so that nothing done to the
 * state it was read from afterwards changes it. Its methods read that copy without making a new
 * one (`toArray` alone gives a new array, as the caller may change it). How the copy is kept is
 * the business of this file only: the methods are the whole of what a reader sees.
 */

import { DrawError } from '../errors.js';
import type { IdSet } from '../model.js';

/** The most IDs `toArray` gives in one array */
const ARRAY_LIMIT = 10_000;

/** A set of IDs over a copy of them, in order, each once */
class CopiedIdSet implements IdSet {
  /** The IDs, in the order of the set; never changed */
  readonly #ids: readonly string[];
  /** The same IDs for `has`, made at the first call */
  #lookup: Set<string> | null = null;

  constructor(ids: readonly string[]) {
    this.#ids = ids;
  }

  count(): number {
    return this.#ids.length;
  }

  has(id: string): boolean {
    this.#lookup ??= new Set(this.#ids);
    return this.#lookup.has(id);
  }

  iterate(): IterableIterator<string> {
    return this.#ids[Symbol.iterator]();
  }

  toArray(): string[] {
    if (this.#ids.length > ARRAY_LIMIT) {
      throw new DrawError(
        'tooManyItems',
        `The set holds ${this.#ids.length} IDs, more than ${ARRAY_LIMIT} for one array; read them with iterate`,
      );
    }
    return [...this.#ids];
  }
}

/**
 * Makes a set of the IDs given, in the order given, each once: a copy, so that changing what
 * they were read from afterwards does not change the set
 *
 * @internal
 */
export function makeIdSet(ids: Iterable<string>): IdSet {
  return new CopiedIdSet([...new Set(ids)]);
}
