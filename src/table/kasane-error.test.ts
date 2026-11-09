// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The error of the tables of rows, and an error of Tabane held as its cause
 */

import { TabaneError } from '@sakuzu/tabane';
import { describe, expect, it } from 'vitest';
import { KasaneError, kasaneErrorOf } from './kasane-error.js';

describe('KasaneError', () => {
  it('holds its code, its message and the error it is thrown for', () => {
    const cause = new Error('below');
    const error = new KasaneError('not-found', 'no such row', { cause });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('KasaneError');
    expect(error.code).toBe('not-found');
    expect(error.message).toBe('no such row');
    expect(error.cause).toBe(cause);
    expect(new KasaneError('invalid-state', 'x').cause).toBeUndefined();
  });

  it('holds an error of Tabane as the cause of one of the same code, and leaves any other', () => {
    const tabane = new TabaneError('unsupported-format', 'Tabane: the bytes end early');
    const wrapped = kasaneErrorOf(tabane) as KasaneError;
    expect(wrapped).toBeInstanceOf(KasaneError);
    expect(wrapped.code).toBe('unsupported-format');
    expect(wrapped.message).toBe('Tabane: the bytes end early');
    expect(wrapped.cause).toBe(tabane);
    const own = new KasaneError('invalid-input', 'x');
    expect(kasaneErrorOf(own)).toBe(own);
    const other = new RangeError('x');
    expect(kasaneErrorOf(other)).toBe(other);
  });
});
