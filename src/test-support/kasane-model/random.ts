// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Sequences of steps made from a seed: the same seed makes the same sequence
 */

import type { TableStep } from './types.js';

/** Numbers from 0 to 1 made from a seed (mulberry32) */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The options of {@link randomSteps} */
export interface RandomStepsOptions {
  /** The number of steps */
  readonly length: number;
  /** The share of the steps that are a transaction of a few steps (0 to 1; 0.1 when omitted) */
  readonly transactions?: number;
}

/** A sequence of steps made from a seed */
export function randomSteps(seed: number, options: RandomStepsOptions): TableStep[] {
  const random = seededRandom(seed);
  const int = (n: number): number => Math.floor(random() * n);
  const transactions = options.transactions ?? 0.1;
  const one = (): TableStep => {
    const r = random();
    if (r < 0.06) return { kind: 'createLayer' };
    if (r < 0.1) {
      const fields = ['name', 'visible', 'locked', 'opacity'] as const;
      return { kind: 'updateLayer', layer: int(8), field: fields[int(4)], value: int(100) };
    }
    if (r < 0.12) return { kind: 'deleteLayer', layer: int(8) };
    if (r < 0.15) return { kind: 'reorderLayers', from: int(8), to: int(8) };
    if (r < 0.35) {
      return {
        kind: 'createFeature',
        layer: int(8),
        group: random() < 0.3 ? int(8) : null,
        shape: int(3),
        x: int(20) - 10,
      };
    }
    if (r < 0.55) {
      const fields = ['geometry', 'properties', 'style', 'visible', 'locked'] as const;
      return { kind: 'updateFeature', feature: int(64), field: fields[int(5)], value: int(100) };
    }
    if (r < 0.62) return { kind: 'deleteFeature', feature: int(64) };
    if (r < 0.74) {
      return {
        kind: 'moveItems',
        items: Array.from({ length: 1 + int(3) }, () => int(64)),
        layer: int(8),
        group: random() < 0.3 ? int(8) : null,
        near: random() < 0.25 ? null : int(64),
        byBelow: random() < 0.5,
      };
    }
    if (r < 0.8) {
      return { kind: 'createGroup', features: Array.from({ length: 1 + int(3) }, () => int(64)) };
    }
    if (r < 0.84) {
      const fields = ['name', 'visible', 'locked'] as const;
      return { kind: 'updateGroup', group: int(8), field: fields[int(3)], value: int(100) };
    }
    if (r < 0.88) return { kind: 'deleteGroup', group: int(8) };
    if (r < 0.97)
      return { kind: 'select', features: Array.from({ length: 1 + int(3) }, () => int(64)) };
    return { kind: 'clearSelection' };
  };
  // A layer to start with, so that the first steps have somewhere to go
  const steps: TableStep[] = [{ kind: 'createLayer' }];
  while (steps.length < options.length) {
    if (random() < transactions) {
      steps.push({ kind: 'transact', steps: Array.from({ length: 2 + int(3) }, one) });
    } else {
      steps.push(one());
    }
  }
  return steps;
}
