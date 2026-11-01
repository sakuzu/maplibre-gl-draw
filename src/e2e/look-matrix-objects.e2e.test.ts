// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end tests of many features of different looks drawn together, over a Store of objects
 * (see `look-matrix.ts`)
 */

import { describe } from 'vitest';
import { describeLookMatrix } from './look-matrix.js';

describe('the looks of many features over a Store of objects', () => {
  describeLookMatrix('objects', 'made');
});
