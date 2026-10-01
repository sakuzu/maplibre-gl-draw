// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Scales a time limit of a test that runs a browser
 *
 * The page renders on software WebGL, which is several times slower on a CI runner than on a
 * development machine. The CI workflow sets `BROWSER_TEST_TIMEOUT_SCALE`; without it the limit
 * is used as written.
 */
export function browserTimeout(ms: number): number {
  const scale = Number(process.env.BROWSER_TEST_TIMEOUT_SCALE ?? '1');
  return Number.isFinite(scale) && scale > 0 ? ms * scale : ms;
}
