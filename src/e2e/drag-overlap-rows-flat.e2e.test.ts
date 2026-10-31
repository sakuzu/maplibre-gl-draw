// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end tests of every feature drawn once around a drag, over a Store of rows without terrain (see
 * `drag-overlap.ts`)
 */

import { describe } from 'vitest';
import { describeDrawnOnce } from './drag-overlap.js';

describe('the features drawn once over a Store of rows without terrain', () => {
  describeDrawnOnce('rows', false);
});
