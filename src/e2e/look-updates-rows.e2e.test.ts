// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end tests of the looks changed after the features are made, over a Store of rows: rows
 * made by `features.createMany`, and rows of a page, which a change writes in place (see
 * `look-updates.ts`)
 */

import { describe } from 'vitest';
import { describeLookUpdates } from './look-updates.js';

describe('the looks changed over a Store of rows, of rows made', () => {
  describeLookUpdates('rows', 'made');
});

describe('the looks changed over a Store of rows, of rows of a page', () => {
  describeLookUpdates('rows', 'block');
});
