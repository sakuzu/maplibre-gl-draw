// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Running a sequence of steps on the model and on a subject, compared after every step
 */

import { TableModel } from './model.js';
import type { TableOperation, TableSnapshot, TableStep, TableSubject } from './types.js';

/** Where a run first differed */
export interface RunFailure {
  /** The number of the step, from 0 */
  readonly step: number;
  /** The operation the step was */
  readonly operation: TableOperation;
  /** What differed: the path of the first value, or what the subject threw */
  readonly reason: string;
}

/** The result of a run: null when every step gave what the model gives */
export type RunResult = RunFailure | null;

/**
 * Runs the steps on a new model and on the subject made for the run, comparing what is read
 * after every step (and once before the first). A step the model cannot do now is left out.
 */
export function runSteps(steps: readonly TableStep[], makeSubject: () => TableSubject): RunResult {
  const model = new TableModel();
  const subject = makeSubject();
  try {
    for (const [i, step] of steps.entries()) {
      const operation = model.resolve(step);
      if (!operation) continue;
      try {
        subject.apply(operation);
      } catch (error) {
        return { step: i, operation, reason: `the subject threw: ${messageOf(error)}` };
      }
      model.apply(operation);
      subject.settle?.();
      let read: TableSnapshot;
      try {
        read = subject.read();
      } catch (error) {
        return {
          step: i,
          operation,
          reason: `the subject threw as it was read: ${messageOf(error)}`,
        };
      }
      const difference = firstDifference(model.snapshot(), read);
      if (difference) return { step: i, operation, reason: difference };
    }
    return null;
  } finally {
    subject.dispose?.();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The path of the first value that differs, with both values (null when they are equal). An
 * object key whose value is undefined counts as absent
 */
export function firstDifference(expected: unknown, actual: unknown, path = ''): string | null {
  if (Object.is(expected, actual)) return null;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
      const d = firstDifference(expected[i], actual[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (
    isObject(expected) &&
    isObject(actual) &&
    !Array.isArray(expected) &&
    !Array.isArray(actual)
  ) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of [...keys].sort()) {
      const d = firstDifference(expected[key], actual[key], path ? `${path}.${key}` : key);
      if (d) return d;
    }
    return null;
  }
  return `${path || '(root)'}: expected ${show(expected)}, got ${show(actual)}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function show(value: unknown): string {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text.length > 160 ? `${text.slice(0, 160)}...` : text;
}
