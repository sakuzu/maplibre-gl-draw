// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The guard of the methods of the draw instance: an error of the tables of rows a method reaches
 * is thrown as a DrawError, anything else as it is
 */

import { KasaneError } from '@sakuzu/kasane';
import { TabaneError } from '@sakuzu/tabane';
import { describe, expect, it } from 'vitest';
import { DrawError } from '../errors.js';
import { guardAfterDestroy } from './destroy-guard.js';

describe('guardAfterDestroy', () => {
  it('throws an error of the tables a method or a getter reaches as a DrawError, held as the cause', () => {
    const tables = new KasaneError('invalidState', 'the row is not read');
    const guarded = guardAfterDestroy(
      {
        features: {
          read: (): never => {
            throw tables;
          },
        },
        get count(): number {
          throw tables;
        },
      },
      () => false,
    );
    for (const call of [() => guarded.features.read(), () => guarded.count]) {
      let thrown: unknown;
      try {
        call();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(DrawError);
      expect((thrown as DrawError).code).toBe('invalidState');
      expect((thrown as DrawError).message).toBe('the row is not read');
      expect((thrown as { cause?: unknown }).cause).toBe(tables);
    }
  });

  it('lets through a DrawError and what a function given to a method throws', () => {
    const own = new DrawError('invalidInput', 'x');
    const caller = new TabaneError('invalidInput', 'an error of the caller');
    const guarded = guardAfterDestroy(
      {
        check: (): never => {
          throw own;
        },
        run: (fn: () => void): void => fn(),
      },
      () => false,
    );
    const thrown = (fn: () => void): unknown => {
      try {
        fn();
      } catch (error) {
        return error;
      }
      return undefined;
    };
    expect(thrown(() => guarded.check())).toBe(own);
    expect(
      thrown(() =>
        guarded.run(() => {
          throw caller;
        }),
      ),
    ).toBe(caller);
  });
});
