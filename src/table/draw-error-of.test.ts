// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The errors of the tables of rows and of Tabane, as the error of the library
 */

import { createPageBuilder, KasaneError } from '@sakuzu/kasane';
import { TabaneError } from '@sakuzu/tabane';
import { describe, expect, it } from 'vitest';
import { DrawError } from '../shared/draw-error.js';
import { drawErrorOf } from './draw-error-of.js';

describe('drawErrorOf', () => {
  it('wraps an error of the tables or of Tabane in a DrawError of its reason and message', () => {
    for (const [error, code] of [
      [new KasaneError('alreadyExists', 'taken'), 'already-exists'],
      [new KasaneError('invalidState', 'not now'), 'invalid-state'],
      [new TabaneError('invalid-input', 'not a value'), 'invalid-input'],
    ] as const) {
      const wrapped = drawErrorOf(error) as DrawError;
      expect(wrapped).toBeInstanceOf(DrawError);
      expect(wrapped.code).toBe(code);
      expect(wrapped.message).toBe(error.message);
      expect((wrapped as { cause?: unknown }).cause).toBe(error);
    }
  });

  it('wraps an error Kasane throws itself: the library reads the one class of KasaneError', () => {
    const builder = createPageBuilder({ columns: { shape: 'shape' } });
    const row = { id: 'a', key: 'a0', values: {} };
    builder.add(row);
    let thrown: unknown;
    try {
      builder.add(row);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(KasaneError);
    const wrapped = drawErrorOf(thrown) as DrawError;
    expect(wrapped).toBeInstanceOf(DrawError);
    expect(wrapped.code).toBe('invalid-input');
    expect((wrapped as { cause?: unknown }).cause).toBe(thrown);
  });

  it('leaves a DrawError and any other error as they are', () => {
    const own = new DrawError('not-found', 'x');
    expect(drawErrorOf(own)).toBe(own);
    const other = new TypeError('x');
    expect(drawErrorOf(other)).toBe(other);
    expect(drawErrorOf('text')).toBe('text');
  });
});
