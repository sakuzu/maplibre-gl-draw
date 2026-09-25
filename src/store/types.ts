// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The data model of the Store
 *
 * The types are defined in shared/types/model.ts, below every layer, so that shared/ and
 * display/ can use them without depending on store/. This file re-exports them for the code
 * that already imports them from here.
 */

export type * from '../shared/types/model.js';
