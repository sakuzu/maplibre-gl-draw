// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The public types of the checks of the state of an instance (`DrawOptions.debug.checks`), apart
 * from what runs them so that their declarations name nothing internal
 */

/**
 * A check of the state of an instance: the ids of the rows (`id-index`), the selection
 * (`selection`), the marks the rows are written with (`write-marks`), what is drawn (`drawing`)
 *
 * @experimental
 */
export type ConsistencyCheck = 'id-index' | 'selection' | 'write-marks' | 'drawing';

/**
 * A check that failed, and what it found
 *
 * @experimental
 */
export interface ConsistencyFailure {
  /** The check */
  readonly check: ConsistencyCheck;
  /** What does not agree, one sentence each (the first ones, up to a number) */
  readonly problems: readonly string[];
}

/**
 * Which checks of the state run, and what a failure does
 *
 * @experimental
 */
export interface ConsistencyCheckOptions {
  /** The checks run (every check when omitted) */
  readonly run?: readonly ConsistencyCheck[];
  /** The checks that may fail: their failures are given to `onFailure`, not thrown */
  readonly allowed?: readonly ConsistencyCheck[];
  /** Called with every failure, before it is thrown */
  readonly onFailure?: (failure: ConsistencyFailure) => void;
}
