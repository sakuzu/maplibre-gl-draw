// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The box of the tables of rows (`BBox`), the one declaration of a box: the entries of the
 * library give it again
 */

/**
 * An axis-aligned box as `[minX, minY, maxX, maxY]`, in the units of the coordinates it bounds.
 *
 * `minX <= maxX` and `minY <= maxY` hold for a box of positions.
 */
export type BBox = [number, number, number, number];
