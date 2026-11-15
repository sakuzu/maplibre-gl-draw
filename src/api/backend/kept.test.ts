// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How the document of a storage is read when its records no longer fit in one tree: a member is
 * in the layer of its group, a feature whose group is gone is in its own layer, what is in a layer
 * that is gone is kept and comes back with it, a group with no member is not shown
 */

import { describe, expect, it } from 'vitest';
import { readStoredDocument } from './kept.js';
import {
  applyOperations,
  createStoredDocument,
  type FeatureRecord,
  type StoredDocument,
  type ValueOperation,
} from './values.js';

const LAYER = 'maplibre-gl-draw:layerId';
const GROUP = 'maplibre-gl-draw:groupId';

const layer = (id: string, key: string): ValueOperation => ({
  type: 'create',
  kind: 'layer',
  id,
  record: {
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    style: {},
    styleRule: null,
    key,
  },
});

const group = (id: string, layerId: string, key: string): ValueOperation => ({
  type: 'create',
  kind: 'group',
  id,
  record: { name: id, layerId, parentId: null, visible: true, locked: false, key },
});

const feature = (id: string, layerId: string, key: string, groupId?: string): ValueOperation => ({
  type: 'create',
  kind: 'feature',
  id,
  record: {
    geometry: { type: 'Point', coordinates: [0, 0] },
    properties: { [LAYER]: layerId, ...(groupId !== undefined && { [GROUP]: groupId }) },
    key,
  },
});

/** A document with a layer `a` of a group `g` of `f1` and `f2`, and `f3`, and a layer `b` */
function documentOf(): StoredDocument {
  const document = createStoredDocument();
  applyOperations(document, [
    layer('a', 'V'),
    layer('b', 'W'),
    group('g', 'a', 'V'),
    feature('f1', 'a', 'V', 'g'),
    feature('f2', 'a', 'W', 'g'),
    feature('f3', 'a', 'W'),
  ]);
  return document;
}

/** Where each feature is shown (its layer and group), and which are kept */
function readOf(document: StoredDocument) {
  const { shown, kept } = readStoredDocument(document);
  const place = (record: FeatureRecord) => [record.properties[LAYER], record.properties[GROUP]];
  return {
    features: Object.fromEntries([...shown.features].map(([id, record]) => [id, place(record)])),
    groups: [...shown.groups.keys()],
    kept: { features: [...kept.features.keys()], groups: [...kept.groups.keys()] },
  };
}

describe('the document of a storage, read by the rules', () => {
  it('shows what fits in one tree as it is, the records not copied', () => {
    const document = documentOf();
    const { shown, kept } = readStoredDocument(document);
    expect(shown.features.get('f1')).toBe(document.features.get('f1'));
    expect(kept.empty).toBe(true);
  });

  it('puts a member in the layer of its group, whatever its layer key says', () => {
    const document = documentOf();
    // The group moved, naming f1 only: f2 still says it is in `a`
    applyOperations(document, [
      { type: 'place', kind: 'group', ids: ['g'], parentId: 'b', keys: ['V'] },
      { type: 'place', kind: 'feature', ids: ['f1'], parentId: 'g', keys: ['V'] },
    ]);
    expect(document.features.get('f2')?.properties[LAYER]).toBe('a');
    const read = readStoredDocument(document);
    expect(readOf(document).features.f2).toEqual(['b', 'g']);
    expect(read.kept.placements.get('f2')).toEqual({ layerId: 'a', groupId: 'g' });
  });

  it('puts a feature whose group is gone in its own layer, and back in the group when it comes back', () => {
    const document = documentOf();
    const deleted = document.groups.get('g');
    if (!deleted) throw new Error('no group g');
    applyOperations(document, [{ type: 'delete', kind: 'group', ids: ['g'] }]);
    expect(readOf(document)).toEqual({
      features: { f1: ['a', undefined], f2: ['a', undefined], f3: ['a', undefined] },
      groups: [],
      kept: { features: [], groups: [] },
    });
    expect(readStoredDocument(document).kept.placements.get('f1')).toEqual({
      layerId: 'a',
      groupId: 'g',
    });
    applyOperations(document, [{ type: 'create', kind: 'group', id: 'g', record: deleted }]);
    expect(readOf(document).features.f1).toEqual(['a', 'g']);
  });

  it('keeps what is in a layer gone, and shows it again with the layer, what was made in it meanwhile included', () => {
    const document = documentOf();
    const a = document.layers.get('a');
    if (!a) throw new Error('no layer a');
    // A deletes the layer, naming what it holds there (f1, f2, the group); B made f4 in it at the
    // same time, and wrote f3 before (A had not received it)
    applyOperations(document, [
      { type: 'delete', kind: 'feature', ids: ['f1', 'f2'] },
      { type: 'delete', kind: 'group', ids: ['g'] },
      { type: 'delete', kind: 'layer', ids: ['a'] },
    ]);
    applyOperations(document, [feature('f4', 'a', 'X')]);
    expect(readOf(document)).toEqual({
      features: {},
      groups: [],
      kept: { features: ['f3', 'f4'], groups: [] },
    });
    // A takes the deletion back: the layer comes back with what was in it
    applyOperations(document, [
      { type: 'create', kind: 'layer', id: 'a', record: a },
      group('g', 'a', 'V'),
      feature('f1', 'a', 'V', 'g'),
      feature('f2', 'a', 'W', 'g'),
    ]);
    expect(readOf(document)).toEqual({
      features: {
        f1: ['a', 'g'],
        f2: ['a', 'g'],
        f3: ['a', undefined],
        f4: ['a', undefined],
      },
      groups: ['g'],
      kept: { features: [], groups: [] },
    });
  });

  it('does not show a group with no member, and shows it once one comes', () => {
    const document = documentOf();
    applyOperations(document, [{ type: 'delete', kind: 'feature', ids: ['f1', 'f2'] }]);
    expect(readOf(document).groups).toEqual([]);
    expect(readOf(document).kept.groups).toEqual(['g']);
    applyOperations(document, [feature('f5', 'a', 'X', 'g')]);
    expect(readOf(document).groups).toEqual(['g']);
  });

  it('skips a move of a feature in a layer that is gone, which comes back with the layer', () => {
    const document = documentOf();
    const a = document.layers.get('a');
    if (!a) throw new Error('no layer a');
    // B deletes `a` naming `f1`, `f2`, `g` only: `f3` was made at the same time by A
    applyOperations(document, [
      { type: 'delete', kind: 'feature', ids: ['f1', 'f2'] },
      { type: 'delete', kind: 'group', ids: ['g'] },
      { type: 'delete', kind: 'layer', ids: ['a'] },
    ]);
    // A, who has not seen the deletion, moves `f3` to `b`: it is not live, the move is skipped
    const { skipped } = applyOperations(document, [
      { type: 'place', kind: 'feature', ids: ['f3'], parentId: 'b', keys: ['V'] },
    ]);
    expect(skipped).toEqual(['f3']);
    expect(readOf(document)).toEqual({
      features: {},
      groups: [],
      kept: { features: ['f3'], groups: [] },
    });
    applyOperations(document, [{ type: 'create', kind: 'layer', id: 'a', record: a }]);
    expect(readOf(document).features).toEqual({ f3: ['a', undefined] });
  });

  it('skips a move of a group in a layer that is gone, which comes back with its members', () => {
    const document = documentOf();
    const a = document.layers.get('a');
    if (!a) throw new Error('no layer a');
    applyOperations(document, [{ type: 'delete', kind: 'layer', ids: ['a'] }]);
    const { skipped } = applyOperations(document, [
      { type: 'place', kind: 'group', ids: ['g'], parentId: 'b', keys: ['V'] },
    ]);
    expect(skipped).toEqual(['g']);
    expect(readOf(document)).toEqual({
      features: {},
      groups: [],
      kept: { features: ['f1', 'f2', 'f3'], groups: ['g'] },
    });
    applyOperations(document, [{ type: 'create', kind: 'layer', id: 'a', record: a }]);
    expect(readOf(document).features).toEqual({
      f1: ['a', 'g'],
      f2: ['a', 'g'],
      f3: ['a', undefined],
    });
  });

  it('skips a move into a layer that is gone, or into a group whose layer is gone', () => {
    const document = documentOf();
    applyOperations(document, [
      layer('c', 'X'),
      group('h', 'c', 'V'),
      feature('f4', 'c', 'V', 'h'),
      { type: 'delete', kind: 'layer', ids: ['c'] },
    ]);
    const { skipped } = applyOperations(document, [
      { type: 'place', kind: 'feature', ids: ['f3'], parentId: 'c', keys: ['V'] },
      { type: 'place', kind: 'feature', ids: ['f2'], parentId: 'h', keys: ['V'] },
      { type: 'place', kind: 'group', ids: ['g'], parentId: 'c', keys: ['V'] },
    ]);
    expect(skipped).toEqual(['f3', 'f2', 'g']);
    expect(readOf(document).features).toEqual({
      f1: ['a', 'g'],
      f2: ['a', 'g'],
      f3: ['a', undefined],
    });
  });

  it('moves a feature whose group is gone, shown in its own layer', () => {
    const document = documentOf();
    // A deletes `g` with `f1` (members: delete); B moves `f3` into `g` at the same time
    applyOperations(document, [
      { type: 'delete', kind: 'feature', ids: ['f1'] },
      { type: 'delete', kind: 'group', ids: ['g'] },
    ]);
    expect(readOf(document).features).toEqual({ f2: ['a', undefined], f3: ['a', undefined] });
    // A move into the group is skipped (its parent is not there); a move of `f2`, live in its
    // own layer, is not
    const { skipped } = applyOperations(document, [
      { type: 'place', kind: 'feature', ids: ['f3'], parentId: 'g', keys: ['V'] },
      { type: 'place', kind: 'feature', ids: ['f2'], parentId: 'b', keys: ['V'] },
    ]);
    expect(skipped).toEqual(['f3']);
    // A feature made in the group at the same time is shown in its own layer
    applyOperations(document, [feature('f5', 'a', 'X', 'g')]);
    expect(readOf(document).features).toEqual({
      f2: ['b', undefined],
      f3: ['a', undefined],
      f5: ['a', undefined],
    });
  });
});
