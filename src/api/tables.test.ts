// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The values of rows as core makes and checks them: by their references, refused in the words of core
 */

import { describe, expect, it } from 'vitest';
import { DrawError } from '../shared/draw-error.js';
import { checkRowValues, createRowValues } from './tables.js';

describe('createRowValues and checkRowValues', () => {
  it('keep the rows, the fields and the deletion', () => {
    const made = createRowValues({
      rows: Int32Array.of(3),
      fields: new Map([['key', ['a0']]]),
      deleted: Uint8Array.of(0),
    });
    expect([...made.rows]).toEqual([3]);
    expect(made.fields.get('key')).toEqual(['a0']);
    expect([...(made.deleted ?? [])]).toEqual([0]);
    expect(checkRowValues(made)).toBe(made);
  });

  it('refuse rows that are not an Int32Array, saying rows', () => {
    for (const make of [
      () => createRowValues({ rows: [3], fields: new Map() } as never),
      () => checkRowValues({ rows: [3], fields: new Map() }),
    ]) {
      expect(make).toThrow(DrawError);
      expect(make).toThrow(/rows/);
    }
  });

  it('refuse a deletion that is not a Uint8Array, null among them', () => {
    expect(() =>
      createRowValues({ rows: Int32Array.of(3), fields: new Map(), deleted: null } as never),
    ).toThrow(expect.objectContaining({ code: 'invalidInput' }));
  });
});
