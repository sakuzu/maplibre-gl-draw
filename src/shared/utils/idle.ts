// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Work done while the page is idle: `requestIdleCallback` where there is one, a timer and a fixed
 * budget elsewhere (a Worker, a server, a browser without it)
 */

/**
 * The time given to one idle task where `requestIdleCallback` is missing (ms): a slice that
 * does not blow a frame
 */
const IDLE_FALLBACK_BUDGET_MS = 8;
/** How long to wait for an idle period where `requestIdleCallback` is missing (ms) */
const IDLE_FALLBACK_MS = 100;

/**
 * Runs a task when the page is idle, with the time at which the idle period ends (`idleNow`)
 *
 * @returns Cancels it
 * @internal
 */
export type IdleScheduler = (task: (deadline: number) => void) => () => void;

/**
 * The clock the idle deadlines are measured with
 *
 * @internal
 */
export function idleNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * Runs `task` when the page is idle, with the time at which the idle period ends (a timer and a
 * fixed budget where `requestIdleCallback` is missing)
 *
 * @returns Cancels it
 * @internal
 */
export const whenIdle: IdleScheduler = (task) => {
  if (typeof globalThis.requestIdleCallback === 'function') {
    const handle = globalThis.requestIdleCallback((idle) => task(idleNow() + idle.timeRemaining()));
    return () => globalThis.cancelIdleCallback(handle);
  }
  const handle = setTimeout(() => task(idleNow() + IDLE_FALLBACK_BUDGET_MS), IDLE_FALLBACK_MS);
  return () => clearTimeout(handle);
};
