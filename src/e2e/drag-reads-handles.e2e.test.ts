// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end tests of what every place that reads an edit in progress shows and answers, for the
 * handles of one feature drawn at sizes and distances of their own, over a Store of objects and the
 * Store of rows (see `drag-reads.ts`)
 */

import { describe } from 'vitest';
import { describeDragReads } from './drag-reads.js';

describe('the handles of one feature drawn at sizes and distances of their own', () => {
  describeDragReads('handles');
});
