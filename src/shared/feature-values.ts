// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Values of rows made by the library as values of features
 */

import type { FeatureValues, RowValues } from './types/model.js';

/**
 * Values of rows the library made of rows of features (read from its tables, or checked), as the
 * values of features it notifies and `features.restore` returns: the same object
 *
 * @internal
 */
export function asFeatureValues(rows: RowValues): FeatureValues {
  return rows as unknown as FeatureValues;
}
