// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The generation of the ids of features, groups, layers and files
 *
 * An id is a ULID (the time in milliseconds followed by 80 random bits, in Crockford's Base32), so
 * ids of later milliseconds sort after earlier ones. The `ulid` package encodes it; the random
 * bytes are taken from `crypto.getRandomValues` in batches and handed out one by one, where the
 * package alone asks the crypto source once per character (16 calls per id, the larger part of
 * the time of a large import).
 */

import { ulid } from 'ulid';

/** The number of random bytes taken at once (256 ids) */
const POOL_SIZE = 4096;

let pool = new Uint8Array(POOL_SIZE);
let cursor = POOL_SIZE;

/**
 * A random fraction in [0, 1) from the pool, of the same distribution as the source of the
 * package (one byte divided by 256)
 */
function pooledRandom(): number {
  if (cursor >= POOL_SIZE) {
    pool = globalThis.crypto.getRandomValues(new Uint8Array(POOL_SIZE));
    cursor = 0;
  }
  return pool[cursor++] / 256;
}

/**
 * Creates a new ULID
 *
 * @internal
 */
export function createId(): string {
  return ulid(undefined, pooledRandom);
}
