// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The parts of the editing benchmark that run without a map: the documents it makes and the
// list of its scenes (`npx vitest run --root bench`). The measurements are not tested.

import { describe, expect, it } from 'vitest';
import {
  countFromSearch,
  DEFAULT_COUNT,
  EDIT_COUNTS,
  featureIdsOf,
  LAYER_ID,
  MAX_COUNT,
  makeDocument,
  makeEmptyDocument,
  makeFeatureCollection,
} from './edit-document';
import { SCENES } from './edit-scenes';

describe('the scenes', () => {
  it('each has a name, a label and the functions it runs', () => {
    expect(SCENES.length).toBeGreaterThan(0);
    for (const scene of SCENES) {
      expect(scene.name).toMatch(/^[A-Za-z]+$/);
      expect(scene.label.length).toBeGreaterThan(0);
      expect(typeof scene.prepare).toBe('function');
      expect(typeof scene.run).toBe('function');
    }
  });

  it('have names of their own', () => {
    const names = SCENES.map((scene) => scene.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('are the scenes the library has the calls for, in the order of the page', () => {
    expect(SCENES.map((scene) => scene.name)).toEqual([
      'open',
      'pan',
      'selectAll',
      'selectOne',
      'hideOne',
      'boxSelect',
      'drag',
      'delete',
      'import',
      'export',
      'iterate',
      'getProperty',
      'storeParts',
      'storeRead',
      'storeMoveBefore',
      'storePages',
      'storeStyleKey',
      'storePropertyKeys',
    ]);
  });
});

describe('the documents', () => {
  it.each(EDIT_COUNTS)('have the number of features asked for (%i)', (n) => {
    const document = makeDocument(n);
    expect(document.features).toHaveLength(n);
    expect(document.layers?.[0].items).toHaveLength(n);
    expect(makeFeatureCollection(n).features).toHaveLength(n);
    expect(featureIdsOf(n)).toHaveLength(n);
  });

  it('change with the number of features', () => {
    expect(makeDocument(10).features).toHaveLength(10);
    expect(makeDocument(11).features).toHaveLength(11);
  });

  it('hold the features in the order of their IDs, every ID once', () => {
    const n = 1_000;
    const document = makeDocument(n);
    const ids = featureIdsOf(n);
    expect(document.features.map((f) => f.id)).toEqual(ids);
    expect(document.layers?.[0].items).toEqual(ids);
    expect(new Set(ids).size).toBe(n);
    expect(
      makeFeatureCollection(n).features.map((f) => f.properties?.['maplibre-gl-draw:id']),
    ).toEqual(ids);
  });

  it('are half polygons, three in ten lines and the rest points, in one layer', () => {
    const document = makeDocument(1_000);
    const count = (type: string) => document.features.filter((f) => f.type === type).length;
    expect(count('Polygon')).toBe(500);
    expect(count('LineString')).toBe(300);
    expect(count('Point')).toBe(200);
    expect(document.layerOrder).toEqual([LAYER_ID]);
    expect(new Set(document.features.map((f) => f.layerId))).toEqual(new Set([LAYER_ID]));
  });

  it('are the same on every call', () => {
    expect(makeDocument(500)).toEqual(makeDocument(500));
  });

  it('can be empty, with the one layer', () => {
    const document = makeEmptyDocument();
    expect(document.features).toHaveLength(0);
    expect(document.layerOrder).toEqual([LAYER_ID]);
  });
});

describe('the number of features from the address', () => {
  it('is the default without n', () => {
    expect(countFromSearch('')).toEqual({ n: DEFAULT_COUNT });
  });

  it('is n when it is a whole number in range', () => {
    expect(countFromSearch('?n=100000')).toEqual({ n: 100_000 });
    expect(countFromSearch(`?n=${MAX_COUNT}`)).toEqual({ n: MAX_COUNT });
  });

  it('is an error otherwise', () => {
    for (const value of ['0', '-5', '1.5', 'abc', String(MAX_COUNT + 1)]) {
      expect(countFromSearch(`?n=${value}`)).toHaveProperty('error');
    }
  });
});
