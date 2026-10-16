// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Coordinates written as integers of a power of ten, when they read back to the same bits
 *
 * A value `v` is decimal at `d` digits (0 to 13) when the integer `k` nearest to `v × 10^d`
 * (`floor(x)`, plus 1 when `x - floor(x) >= 0.5`, where `x` is the float64 product) has at most
 * 2^51 in magnitude and `k / 10^d` (a float64 division) is `v`, bit for bit. `-0`, NaN and the
 * infinities are never decimal. `10^d` is the float64 of the power (exact up to 10^22).
 *
 * Every step is one rounded float64 operation, so every implementation gives the same `k`.
 *
 * A pure module: it depends on nothing, so it runs in a Worker as well.
 */

/** The most decimal digits tried */
export const MAX_DECIMALS = 13;

/** The powers of ten, exact */
export const POW10: readonly number[] = (() => {
  const out = [1];
  for (let d = 1; d <= MAX_DECIMALS; d++) out.push(out[d - 1] * 10);
  return out;
})();

/** The largest integer of a decimal value */
const MAX_DECIMAL_INTEGER = 2 ** 51;

/**
 * The integer of `v` at `d` digits when it reads back to `v` (null when it does not)
 *
 * @internal
 */
export function decimalAt(v: number, d: number): number | null {
  if (v === 0 && 1 / v < 0) return null;
  if (!Number.isFinite(v)) return null;
  const p = POW10[d];
  const x = v * p;
  let k = Math.floor(x);
  if (x - k >= 0.5) k += 1;
  if (Math.abs(k) > MAX_DECIMAL_INTEGER) return null;
  // k + 0 turns a -0 into 0 (a -0 never reads back to a value that is not -0)
  return (k + 0) / p === v ? k + 0 : null;
}

/**
 * The fewest digits `v` is decimal at (-1 when none)
 *
 * @internal
 */
export function fewestDecimals(v: number): number {
  for (let d = 0; d <= MAX_DECIMALS; d++) if (decimalAt(v, d) !== null) return d;
  return -1;
}
