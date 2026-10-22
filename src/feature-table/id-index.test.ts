// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { utf8ColumnFromStrings } from '@sakuzu/tabane';
import { describe, expect, it, vi } from 'vitest';
import { IdIndex } from './id-index.js';

describe('IdIndex', () => {
  it('gives a handle to every new id and the same handle to an id seen before', () => {
    const index = new IdIndex();
    const first = index.allocate(utf8ColumnFromStrings(['a', 'b', 'c']));
    expect(Array.from(first)).toEqual([0, 1, 2]);
    const second = index.allocate(utf8ColumnFromStrings(['c', 'd', 'a']));
    expect(Array.from(second)).toEqual([2, 3, 0]);
    expect(index.size).toBe(4);
    expect(index.idOf(3)).toBe('d');
    expect(index.handleOf('b')).toBe(1);
    expect(index.handleOf('zz')).toBe(-1);
  });

  it('tells ids apart whose hashes collide', () => {
    const index = new IdIndex();
    const ids = utf8ColumnFromStrings(['x', 'y', 'z']);
    const same = new Uint32Array([7, 7, 7]);
    expect(Array.from(index.allocate(ids, same))).toEqual([0, 1, 2]);
    expect(Array.from(index.allocate(ids, same))).toEqual([0, 1, 2]);
    expect(index.handleOfEntry(ids, 1, 7)).toBe(1);
  });

  it('keeps ids that are not ASCII as their bytes', () => {
    const index = new IdIndex();
    const handles = index.allocate(utf8ColumnFromStrings(['東京', 'Zürich', '🗾']));
    expect(index.idOf(handles[0])).toBe('東京');
    expect(index.handleOf('Zürich')).toBe(handles[1]);
    expect(index.handleOf('🗾')).toBe(handles[2]);
  });

  it('gives a removed id a new handle the next time it is seen', () => {
    const index = new IdIndex();
    index.allocate(utf8ColumnFromStrings(['a', 'b']));
    index.remove(0);
    expect(index.has(0)).toBe(false);
    expect(index.idOf(0)).toBeUndefined();
    expect(index.handleOf('a')).toBe(-1);
    expect(index.handleOf('b')).toBe(1);
    expect(Array.from(index.allocate(utf8ColumnFromStrings(['a'])))).toEqual([2]);
    expect(index.handleOf('a')).toBe(2);
  });

  it('keeps every id through the growth of the table', () => {
    const index = new IdIndex();
    const ids = Array.from({ length: 20_000 }, (_, i) => `id-${i}`);
    const handles = index.allocate(utf8ColumnFromStrings(ids));
    // Removing every other one leaves removed slots behind the others
    for (let i = 0; i < 20_000; i += 2) index.remove(handles[i]);
    const more = index.allocate(utf8ColumnFromStrings(ids.slice(0, 100)));
    for (let i = 1; i < 20_000; i += 2) expect(index.handleOf(ids[i])).toBe(handles[i]);
    for (let i = 0; i < 100; i += 2) expect(index.handleOf(ids[i])).toBe(more[i]);
    expect(more[0]).toBe(20_000);
  });

  it('records where the row of a handle is', () => {
    const index = new IdIndex();
    const [handle] = index.allocate(utf8ColumnFromStrings(['a']));
    expect(index.mainGroup(handle)).toBe(-1);
    expect(index.deltaSlot(handle)).toBe(-1);
    index.setMain(handle, 4, 17);
    expect(index.mainGroup(handle)).toBe(4);
    expect(index.mainRow(handle)).toBe(17);
    const column = utf8ColumnFromStrings(['other', 'a']);
    index.rehome(handle, column, 1);
    expect(index.idOf(handle)).toBe('a');
    expect(index.handleOfEntry(column, 1)).toBe(handle);
  });
});

describe('IdIndex.handleOf', () => {
  it('finds ids of every length and script without making anything per look-up', () => {
    const long = 'x'.repeat(500);
    const ids = ['a', 'b', '東京都庁', 'émoji 🗺️', long, ''];
    const index = new IdIndex();
    const handles = index.allocate(utf8ColumnFromStrings(ids));
    const encode = vi.spyOn(TextEncoder.prototype, 'encode');
    for (let round = 0; round < 3; round++) {
      ids.forEach((id, i) => {
        expect(index.handleOf(id)).toBe(handles[i]);
      });
      expect(index.handleOf('missing')).toBe(-1);
      expect(index.handleOf(`${long}y`)).toBe(-1);
    }
    expect(encode).not.toHaveBeenCalled();
    encode.mockRestore();
  });

  it('answers again once an id gets a handle or loses it', () => {
    const index = new IdIndex();
    expect(index.handleOf('a')).toBe(-1);
    const [a] = index.allocate(utf8ColumnFromStrings(['a']));
    expect(index.handleOf('a')).toBe(a);
    expect(index.handleOf('a')).toBe(a);
    index.unlink(a);
    expect(index.handleOf('a')).toBe(-1);
    const [again] = index.allocate(utf8ColumnFromStrings(['a']));
    expect(again).not.toBe(a);
    expect(index.handleOf('a')).toBe(again);
    index.free(again);
    expect(index.handleOf('a')).toBe(-1);
    // Many ids: the table is built again as it grows, and every id is still found
    const many = Array.from({ length: 5000 }, (_, i) => `id${i}`);
    const handles = index.allocate(utf8ColumnFromStrings(many));
    expect(index.handleOf('id4999')).toBe(handles[4999]);
    expect(index.handleOf('id0')).toBe(handles[0]);
  });
});
