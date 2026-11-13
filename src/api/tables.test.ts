// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The values of rows as core makes and checks them: by their handles, refused in the words of core
 */

import { describe, expect, it } from 'vitest';
import { DrawError } from '../shared/draw-error.js';
import { checkRowValues, createRowValues } from './tables.js';

describe('createRowValues and checkRowValues', () => {
  it('keep the handles, the fields and the deletion', () => {
    const made = createRowValues({
      handles: Int32Array.of(3),
      fields: new Map([['key', ['a0']]]),
      deleted: Uint8Array.of(0),
    });
    expect([...made.handles]).toEqual([3]);
    expect(made.fields.get('key')).toEqual(['a0']);
    expect([...(made.deleted ?? [])]).toEqual([0]);
    expect(checkRowValues(made)).toBe(made);
  });

  it('refuse handles that are not an Int32Array, saying handles', () => {
    for (const make of [
      () => createRowValues({ handles: [3], fields: new Map() } as never),
      () => checkRowValues({ handles: [3], fields: new Map() }),
    ]) {
      expect(make).toThrow(DrawError);
      expect(make).toThrow(/handles/);
    }
  });

  it('refuse a deletion that is not a Uint8Array, null among them', () => {
    expect(() =>
      createRowValues({ handles: Int32Array.of(3), fields: new Map(), deleted: null } as never),
    ).toThrow(expect.objectContaining({ code: 'invalidInput' }));
  });
});
