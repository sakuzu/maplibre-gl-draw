// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The parts of the editing benchmark that run without a map: the documents it makes and the
// list of its scenes (`npx vitest run --root bench`). The measurements are not tested.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  countFromSearch,
  DEFAULT_COUNT,
  dashedFromSearch,
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
      'panInterleaved',
      'panTerrain',
      'selectAll',
      'selectOne',
      'hideOne',
      'clickOne',
      'boxSelect',
      'updateOne',
      'updateAll',
      'drag',
      'translateAll',
      'rotateAll',
      'scaleAll',
      'restoreLayerMove',
      'translateLayer',
      'delete',
      'deleteLayerFeatures',
      'deleteLayer',
      'writeLayerFeatures',
      'duplicateLayerFeatures',
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
      'gpuMemory',
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

describe('the documents with dash=1 in the address', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** The document of the page with an address */
  function documentAt(search: string, n: number, interleaved = false) {
    vi.stubGlobal('location', { search });
    try {
      return makeDocument(n, interleaved);
    } finally {
      vi.unstubAllGlobals();
    }
  }

  const isDashed = (feature: { style: unknown }) =>
    JSON.stringify(feature.style) === JSON.stringify({ lineStyle: 'dashed' });

  it('is read from the address', () => {
    expect(dashedFromSearch('?dash=1')).toBe(true);
    expect(dashedFromSearch('?n=1000&dash=1')).toBe(true);
    expect(dashedFromSearch('')).toBe(false);
    expect(dashedFromSearch('?dash=0')).toBe(false);
  });

  it.each([false, true])(
    'dash one polygon in ten and one line in ten, each kind counted apart, and no point (interleaved: %s)',
    (interleaved) => {
      const document = documentAt('?dash=1', 1_000, interleaved);
      const seen: Record<string, number> = { Polygon: 0, LineString: 0, Point: 0 };
      let dashed = 0;
      for (const feature of document.features) {
        const number = seen[feature.type]++;
        const expected = feature.type !== 'Point' && number % 10 === 0;
        expect(isDashed(feature), feature.id).toBe(expected);
        if (!expected) expect(feature.style, feature.id).toEqual({});
        if (expected) dashed++;
      }
      // 50 polygons in 500 and 30 lines in 300
      expect(dashed).toBe(80);
    },
  );

  it.each([1_000, 2_000, 20_000])(
    'dash the features that are not points whose number is a multiple of 10, for %i features one kind after the other',
    (n) => {
      const document = documentAt('?dash=1', n);
      document.features.forEach((feature, i) => {
        expect(isDashed(feature), feature.id).toBe(feature.type !== 'Point' && i % 10 === 0);
      });
    },
  );

  it('are the documents of before without it, to the byte', () => {
    /** The length of the text of a value and its FNV-1a hash */
    const fingerprint = (value: unknown): string => {
      const text = JSON.stringify(value);
      let hash = 0x811c9dc5;
      for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
      return `${text.length}:${hash.toString(16).padStart(8, '0')}`;
    };
    expect(fingerprint(makeDocument(1_000))).toBe('327508:5d8d7223');
    expect(fingerprint(makeDocument(1_000, true))).toBe('327306:9cf4e053');
    expect(fingerprint(makeDocument(2_000))).toBe('705639:4f3b6a0a');
    expect(fingerprint(documentAt('?n=1000', 1_000))).toBe(fingerprint(makeDocument(1_000)));
  });
});
