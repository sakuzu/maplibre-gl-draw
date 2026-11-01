// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end tests of the looks changed after the features are made, over a Store of objects (see
 * `look-updates.ts`)
 */

import { describe } from 'vitest';
import { describeLookUpdates } from './look-updates.js';

describe('the looks changed over a Store of objects', () => {
  describeLookUpdates('objects', 'made');
});
