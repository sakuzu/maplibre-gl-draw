// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createObservable } from './observable.js';
import { applyOperations, createStoredDocument, type StoredDocument } from './values.js';

const KEY = (name: string) => `maplibre-gl-draw:${name}`;

function documentWith(): StoredDocument {
  const document = createStoredDocument();
  applyOperations(document, [
    {
      type: 'create',
      kind: 'layer',
      id: 'a',
      record: {
        name: 'A',
        visible: true,
        locked: false,
        opacity: 1,
        style: {},
        styleRule: null,
        key: 'V',
      },
    },
    {
      type: 'create',
      kind: 'layer',
      id: 'b',
      record: {
        name: 'B',
        visible: true,
        locked: false,
        opacity: 1,
        style: {},
        styleRule: null,
        key: 'W',
      },
    },
    {
      type: 'create',
      kind: 'group',
      id: 'g',
      record: {
        name: 'G',
        layerId: 'b',
        parentId: null,
        visible: true,
        locked: false,
        key: 'V',
      },
    },
    {
      type: 'create',
      kind: 'feature',
      id: 'f',
      record: {
        geometry: { type: 'Point', coordinates: [1, 2] },
        properties: {
          [KEY('layerId')]: 'a',
          h: 1,
          old: 'x',
          [KEY('style')]: { pointColor: '#ff0000', pointRadius: 4 },
        },
        key: 'V',
      },
    },
  ]);
  return document;
}

describe('applyOperations', () => {
  it('merges the properties and the keys of the style, then removes the keys unset', () => {
    const document = documentWith();
    const { skipped } = applyOperations(document, [
      {
        type: 'set',
        kind: 'feature',
        ids: ['f'],
        set: { properties: { h: 3, [KEY('style')]: { pointColor: '#00ff00' } } },
        unset: { properties: ['old'], style: ['pointRadius'] },
      },
    ]);
    expect(skipped).toEqual([]);
    expect(document.features.get('f')).toEqual({
      geometry: { type: 'Point', coordinates: [1, 2] },
      properties: {
        [KEY('layerId')]: 'a',
        h: 3,
        [KEY('style')]: { pointColor: '#00ff00' },
      },
      key: 'V',
    });
  });

  it('holds no style key once the style has no key, and replaces the geometry', () => {
    const document = documentWith();
    applyOperations(document, [
      {
        type: 'set',
        kind: 'feature',
        ids: ['f'],
        set: { geometry: { type: 'Point', coordinates: [5, 6] } },
        unset: { style: ['pointColor', 'pointRadius'] },
      },
    ]);
    const record = document.features.get('f');
    expect(record?.geometry).toEqual({ type: 'Point', coordinates: [5, 6] });
    expect(record?.properties).not.toHaveProperty([KEY('style')]);
  });

  it('writes the layer and the group of a feature from its parent', () => {
    const document = documentWith();
    applyOperations(document, [
      { type: 'place', kind: 'feature', ids: ['f'], parentId: 'g', keys: ['k'] },
    ]);
    expect(document.features.get('f')?.properties).toMatchObject({
      [KEY('layerId')]: 'b',
      [KEY('groupId')]: 'g',
    });
    expect(document.features.get('f')?.key).toBe('k');
    applyOperations(document, [
      { type: 'place', kind: 'feature', ids: ['f'], parentId: 'a', keys: ['m'] },
    ]);
    expect(document.features.get('f')?.properties).not.toHaveProperty([KEY('groupId')]);
    expect(document.features.get('f')?.properties[KEY('layerId')]).toBe('a');
  });

  it('puts a group in a layer and a layer among the layers', () => {
    const document = documentWith();
    applyOperations(document, [
      { type: 'place', kind: 'group', ids: ['g'], parentId: 'a', keys: ['Z'] },
      { type: 'place', kind: 'layer', ids: ['b'], parentId: null, keys: ['U'] },
    ]);
    expect(document.groups.get('g')).toMatchObject({ layerId: 'a', parentId: null, key: 'Z' });
    expect(document.layers.get('b')?.key).toBe('U');
  });

  it('skips the IDs it has no record of, and keeps a record made again', () => {
    const document = documentWith();
    const { skipped } = applyOperations(document, [
      { type: 'set', kind: 'feature', ids: ['none', 'f'], set: { properties: { h: 2 } } },
      { type: 'place', kind: 'feature', ids: ['f'], parentId: 'gone', keys: ['k'] },
      { type: 'set', kind: 'group', ids: ['none'], set: { name: 'x' } },
      {
        type: 'create',
        kind: 'file',
        id: 'i',
        record: { mediaType: 'image/png', content: 'AA==' },
      },
      {
        type: 'create',
        kind: 'file',
        id: 'i',
        record: { mediaType: 'image/webp', content: 'AQ==' },
      },
      { type: 'delete', kind: 'feature', ids: ['nothing'] },
    ]);
    expect(skipped).toEqual(['none', 'f', 'i']);
    expect(document.features.get('f')?.properties.h).toBe(2);
    expect(document.files.get('i')?.mediaType).toBe('image/png');
  });

  it('writes the layers, the groups and the document', () => {
    const document = documentWith();
    applyOperations(document, [
      {
        type: 'set',
        kind: 'layer',
        ids: ['a'],
        set: { name: 'A2', locked: true, opacity: 0.5, style: { fillColor: '#000000' } },
      },
      { type: 'set', kind: 'group', ids: ['g'], set: { visible: false } },
      { type: 'set', kind: 'document', set: { title: 'T' } },
      { type: 'delete', kind: 'layer', ids: ['b'] },
    ]);
    expect(document.layers.get('a')).toMatchObject({
      name: 'A2',
      locked: true,
      opacity: 0.5,
      style: { fillColor: '#000000' },
    });
    expect(document.groups.get('g')?.visible).toBe(false);
    expect(document.title).toBe('T');
    expect(document.description).toBe('');
    expect(document.layers.has('b')).toBe(false);
  });
});

describe('createObservable', () => {
  it('calls each function at once and after each change, not for the same value', () => {
    const value = createObservable(1);
    const seen: number[] = [];
    const stop = value.subscribe((v) => seen.push(v));
    value.set(1);
    value.set(2);
    stop();
    value.set(3);
    expect(seen).toEqual([1, 2]);
    expect(value.value).toBe(3);
  });

  it('calls the others when one throws, and throws the first error after', () => {
    const value = createObservable('a');
    const seen: string[] = [];
    value.subscribe((v) => {
      if (v === 'b') throw new Error('first');
    });
    value.subscribe((v) => seen.push(v));
    expect(() => value.set('b')).toThrow('first');
    expect(seen).toEqual(['a', 'b']);
  });
});
