// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Making a sequence that fails as short as it goes on failing
 *
 * Runs of steps are taken out, half the sequence, then a quarter and smaller, as long as the
 * sequence still fails without them. The steps pick what they act on among what is there, and
 * one that cannot be done is left out, so any sequence left still runs.
 */

import type { ModelStep } from './types.js';

/**
 * The shortest sequence found that still fails
 *
 * @param fails - Whether a sequence fails (as the first one does)
 */
export function shrinkModelSteps(
  steps: readonly ModelStep[],
  fails: (steps: readonly ModelStep[]) => boolean,
): ModelStep[] {
  let current = [...steps];
  let size = Math.max(1, Math.floor(current.length / 2));
  while (size >= 1) {
    let removed = false;
    for (let start = 0; start < current.length; ) {
      const candidate = [...current.slice(0, start), ...current.slice(start + size)];
      if (candidate.length < current.length && fails(candidate)) {
        current = candidate;
        removed = true;
      } else {
        start += size;
      }
    }
    if (!removed || size === 1) size = Math.floor(size / 2);
  }
  return current;
}
