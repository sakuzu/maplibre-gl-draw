// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end tests of many features of different looks drawn together, over a Store of rows: rows
 * made by `features.createMany`, and rows of a page (see `look-matrix.ts`)
 */

import { describe } from 'vitest';
import { describeLookMatrix } from './look-matrix.js';

describe('the looks of many features over a Store of rows, of rows made', () => {
  describeLookMatrix('rows', 'made');
});

describe('the looks of many features over a Store of rows, of rows of a page', () => {
  describeLookMatrix('rows', 'block');
});
