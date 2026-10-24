// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Making a sequence that fails as short as it goes on failing
 *
 * Runs of steps are taken out, half the sequence, then a quarter and smaller, as long as the
 * sequence still fails without them (delta debugging); then the steps one at a time. The steps
 * pick what they act on among what is there, and one that cannot be done does nothing, so any
 * sequence left still runs. The sequence it gives is written down as a fixed sequence.
 */

import type { TableStep } from './types.js';

/**
 * The shortest sequence found that still fails
 *
 * @param fails - Whether a sequence fails (as the first one does)
 */
export function shrinkSteps(
  steps: readonly TableStep[],
  fails: (steps: readonly TableStep[]) => boolean,
): TableStep[] {
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
  // Then the steps inside the transactions left, one at a time
  for (let i = 0; i < current.length; i++) {
    const step = current[i];
    if (step.kind !== 'transact') continue;
    for (let j = 0; j < step.steps.length; j++) {
      const inner = [...step.steps.slice(0, j), ...step.steps.slice(j + 1)];
      const candidate = [
        ...current.slice(0, i),
        { kind: 'transact' as const, steps: inner },
        ...current.slice(i + 1),
      ];
      if (inner.length > 0 && fails(candidate)) {
        current = candidate;
        return shrinkSteps(current, fails);
      }
    }
  }
  return current;
}
