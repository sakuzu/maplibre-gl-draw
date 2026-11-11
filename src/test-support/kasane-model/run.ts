// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Running a sequence of steps on the model and on the tables, compared after every step
 */

import { TablesModel } from './model.js';
import type { ModelOperation, ModelSnapshot, ModelStep, ModelSubject, ModelUse } from './types.js';

/** Where a run first differed */
export interface ModelRunFailure {
  /** The number of the step, from 0 */
  readonly step: number;
  /** The operation the step was */
  readonly operation: ModelOperation;
  /** What differed: the path of the first value, or what the tables threw */
  readonly reason: string;
}

/**
 * Runs the steps on a new model and on the tables made for the run, comparing what is read after
 * every step. A step the model cannot do now is left out.
 *
 * @returns Where the run first differed (null when every step gave what the model gives)
 */
export function runModelSteps(
  use: ModelUse,
  steps: readonly ModelStep[],
  makeSubject: (use: ModelUse) => ModelSubject,
): ModelRunFailure | null {
  const model = new TablesModel(use);
  const subject = makeSubject(use);
  for (const [i, step] of steps.entries()) {
    const operation = model.resolve(step);
    if (!operation) continue;
    try {
      subject.apply(operation);
      subject.settle();
    } catch (error) {
      return { step: i, operation, reason: `the tables threw: ${messageOf(error)}` };
    }
    model.apply(operation);
    let read: ModelSnapshot;
    try {
      read = subject.read();
    } catch (error) {
      return {
        step: i,
        operation,
        reason: `the tables threw as they were read: ${messageOf(error)}`,
      };
    }
    const difference = firstDifference(model.snapshot(), read);
    if (difference) return { step: i, operation, reason: difference };
  }
  return null;
}

/**
 * Runs operations written by hand on a new model and on the tables, comparing what is read after
 * every one
 *
 * @returns Where the run first differed (null when every operation gave what the model gives),
 *   and what the model read last
 */
export function runModelOperations(
  use: ModelUse,
  operations: readonly ModelOperation[],
  makeSubject: (use: ModelUse) => ModelSubject,
): { readonly failure: ModelRunFailure | null; readonly last: ModelSnapshot } {
  const model = new TablesModel(use);
  const subject = makeSubject(use);
  for (const [i, operation] of operations.entries()) {
    try {
      subject.apply(operation);
      subject.settle();
    } catch (error) {
      const reason = `the tables threw: ${messageOf(error)}`;
      return { failure: { step: i, operation, reason }, last: model.snapshot() };
    }
    model.apply(operation);
    const difference = firstDifference(model.snapshot(), subject.read());
    if (difference) {
      return { failure: { step: i, operation, reason: difference }, last: model.snapshot() };
    }
  }
  return { failure: null, last: model.snapshot() };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The path of the first value that differs, with both values (null when they are equal). An
 * object key whose value is undefined counts as absent; NaN is equal to NaN
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
