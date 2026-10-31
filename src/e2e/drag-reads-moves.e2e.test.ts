// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end tests of what every place that reads an edit in progress shows and answers, for the
 * drags of one feature that move or turn it as a whole, and the arrow keys, over a Store of objects
 * and the Store of rows (see `drag-reads.ts`)
 */

import { describe } from 'vitest';
import { describeDragReads } from './drag-reads.js';

describe('the drags of one feature that move or turn it as a whole, and the arrow keys', () => {
  describeDragReads('moves');
});
