// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end tests of how every axis of a look is drawn while a drag goes on, over a Store of
 * rows, without terrain (see `drag-look-axes.ts`)
 */

import { describe } from 'vitest';
import { describeLookAxes } from './drag-look-axes.js';

describe('the looks dragged over a Store of rows without terrain', () => {
  describeLookAxes('rows', false);
});
