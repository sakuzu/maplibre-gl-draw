// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, expectTypeOf, it } from 'vitest';
import { DrawError, type DrawErrorCode } from './errors.js';

describe('DrawErrorCode', () => {
  it('is the six codes, tooManyItems among them', () => {
    expectTypeOf<DrawErrorCode>().toEqualTypeOf<
      | 'notFound'
      | 'alreadyExists'
      | 'invalidInput'
      | 'unsupportedFormat'
      | 'invalidState'
      | 'tooManyItems'
    >();
    expectTypeOf<'tooManyItems'>().toExtend<DrawErrorCode>();
  });

  it('is the code a DrawError carries, tooManyItems included', () => {
    const error = new DrawError('tooManyItems', 'more than one array holds');
    expect(error).toBeInstanceOf(DrawError);
    expect(error.code).toBe('tooManyItems');
  });
});
