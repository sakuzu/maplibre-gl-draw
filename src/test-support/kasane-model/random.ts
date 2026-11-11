// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Sequences of steps made from a seed: the same seed makes the same sequence
 */

import { seededRandom } from './model.js';
import type { ModelStep } from './types.js';

/** A sequence of steps made from a seed */
export function randomModelSteps(seed: number, length: number): ModelStep[] {
  const random = seededRandom(seed);
  const int = (n: number): number => Math.floor(random() * n);
  const rows = (): number[] => Array.from({ length: 1 + int(3) }, () => int(64));
  const one = (): ModelStep => {
    const r = random();
    if (r < 0.2) return { kind: 'create', row: int(64), parent: int(16), seed: int(1e9) };
    if (r < 0.26) return { kind: 'addBlock', table: int(3), rows: int(8), seed: int(1e9) };
    if (r < 0.52) {
      const fields = ['shape', 'look', 'type', 'key', 'parent', 'flag', 'attr', 'unattr'] as const;
      return { kind: 'write', row: int(64), field: fields[int(fields.length)], seed: int(1e9) };
    }
    if (r < 0.62) return { kind: 'delete', rows: rows(), keep: random() < 0.6 };
    if (r < 0.68) return { kind: 'restore', token: int(16) };
    if (r < 0.73) return { kind: 'release', token: int(16) };
    if (r < 0.77) return { kind: 'forget', rows: rows() };
    if (r < 0.84) return { kind: 'createGroup', group: int(16), table: int(3), seed: int(1e9) };
    if (r < 0.93) {
      const fields = ['key', 'parent', 'flag'] as const;
      return { kind: 'writeGroup', group: int(16), field: fields[int(3)], seed: int(1e9) };
    }
    if (r < 0.97) return { kind: 'deleteGroup', group: int(16), keep: random() < 0.5 };
    return { kind: 'restoreGroup', token: int(16) };
  };
  return Array.from({ length }, one);
}
