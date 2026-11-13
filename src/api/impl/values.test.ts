// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The values of the properties through the API: what features take and hold, the JSON of a load,
 * and the references of what was read with new IDs
 */

import {
  BigInteger,
  Bytes,
  CalendarDate,
  DateTime,
  Reference,
  sameValue,
  type Value,
} from '@sakuzu/tabane';
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../../store/memory.js';
import { createResourceDeps } from '../../test-utils.js';
import { DrawError } from '../errors.js';
import type { DrawDocument } from '../model.js';
import { parseGeoJSON, parseNative } from '../model.js';
import { createDocument } from './document.js';
import type { DocumentLoads as DocumentResource } from './document-resource.js';
import type { FeatureResource as FeaturesCollection } from './feature-resource.js';
import { createFeatures } from './features.js';

let store: MemoryStore;
let features: FeaturesCollection;
let doc: DocumentResource;

beforeEach(() => {
  store = new MemoryStore();
  store.createLayer({
    id: 'l1',
    name: 'l1',
    visible: true,
    locked: false,
    opacity: 1,
    items: [],
    styleRule: undefined,
    metadata: undefined,
  });
  const deps = createResourceDeps(store);
  features = createFeatures(deps);
  doc = createDocument(deps);
});

const POINT = { type: 'Point', geometry: { type: 'Point' as const, coordinates: [0, 0] } };

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof DrawError) return error.code;
    throw error;
  }
  return undefined;
}

describe('the properties of a feature', () => {
  it('hold every kind of value, a bigint and a Uint8Array in the one form of a value', () => {
    const created = features.create({
      ...POINT,
      id: 'a',
      properties: {
        opened: CalendarDate.of(1998, 4, 1),
        at: DateTime.parse('2026-10-16T09:30:00+09:00'),
        target: new Reference('b'),
        small: 5n,
        osm: 2n ** 60n,
        raw: new Uint8Array([1, 2]),
        gone: undefined,
      } as never,
    });
    const p = created?.properties as Record<string, Value>;
    expect(p.small).toBe(5);
    expect(p.osm).toBeInstanceOf(BigInteger);
    expect(p.raw).toBeInstanceOf(Bytes);
    expect('gone' in p).toBe(false);
    expect(sameValue(p.target, new Reference('b'))).toBe(true);
    expect(JSON.stringify(p.opened)).toBe('{"$date":"1998-04-01"}');
  });

  it('refuse what is not a value, on create and on update, and change nothing', () => {
    expect(
      codeOf(() => features.create({ ...POINT, properties: { at: new Date() } as never })),
    ).toBe('invalidInput');
    expect(features.list()).toEqual([]);
    features.create({ ...POINT, id: 'a', properties: { name: 'x' } });
    expect(codeOf(() => features.update('a', { properties: { m: new Map() } as never }))).toBe(
      'invalidInput',
    );
    expect(codeOf(() => features.update('a', { properties: { s: 'a\ud800' } }))).toBe(
      'invalidInput',
    );
    expect(features.get('a')?.properties).toEqual({ name: 'x' });
    const updated = features.update('a', {
      properties: { big: 2n ** 60n, name: undefined } as never,
    });
    expect(updated?.properties.big).toBeInstanceOf(BigInteger);
    expect('name' in (updated?.properties ?? {})).toBe(false);
  });
});

describe('the JSON of a load', () => {
  it('keeps an integer outside the range of a number as a big integer', async () => {
    const text =
      '{"type":"FeatureCollection","features":[{"type":"Feature","id":"x","geometry":{"type":"Point","coordinates":[0,0]},"properties":{"osm":12345678901234567890,"tagged":{"$date":"2026-10-16"}}}]}';
    await doc.load(text);
    const p = features.get('x')?.properties as Record<string, Value>;
    expect(sameValue(p.osm, new BigInteger(12345678901234567890n))).toBe(true);
    // A tag of a GeoJSON file is an object of its own, not a date
    expect(p.tagged).toEqual({ $date: '2026-10-16' });
  });

  it('reads the values of a document of the library from their JSON form', async () => {
    features.create({
      ...POINT,
      id: 'a',
      properties: { opened: CalendarDate.of(1998, 4, 1), target: new Reference('a') },
    });
    const text = JSON.stringify(doc.toJSON());
    const parsed = await parseNative(JSON.parse(text) as DrawDocument, {
      generateId: (() => {
        let n = 0;
        return () => `new-${++n}`;
      })(),
    });
    const p = parsed.features[0].properties;
    expect(p.opened).toBeInstanceOf(CalendarDate);
    // The reference to the feature read names its new ID
    expect(sameValue(p.target, new Reference(parsed.features[0].id))).toBe(true);
    expect(parsed.features[0].id).not.toBe('a');
  });
});

describe('the references of what was read with new IDs', () => {
  it('name the new IDs in a parse of GeoJSON', async () => {
    const parsed = await parseGeoJSON(
      {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            id: 'a',
            geometry: { type: 'Point', coordinates: [0, 0] },
            properties: { target: new Reference('b') as never, other: new Reference('z') as never },
          },
          {
            type: 'Feature',
            id: 'b',
            geometry: { type: 'Point', coordinates: [1, 1] },
            properties: {},
          },
        ],
      },
      {
        generateId: (() => {
          let n = 0;
          return () => `new-${++n}`;
        })(),
      },
    );
    const [a, b] = parsed.features;
    expect(sameValue(a.properties.target, new Reference(b.id))).toBe(true);
    expect(sameValue(a.properties.other, new Reference('z'))).toBe(true);
  });

  it('name the new IDs of the features of a load whose IDs were taken', async () => {
    features.create({ ...POINT, id: 'b' });
    await doc.load({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 'a',
          geometry: { type: 'Point', coordinates: [0, 0] },
          properties: { target: new Reference('b') as never },
        },
        {
          type: 'Feature',
          id: 'b',
          geometry: { type: 'Point', coordinates: [1, 1] },
          properties: {},
        },
      ],
    });
    const loaded = features.list().filter((f) => f.id !== 'b');
    const a = loaded.find((f) => f.id === 'a');
    const copy = loaded.find((f) => f.id !== 'a');
    expect(copy).toBeDefined();
    expect(sameValue(a?.properties.target as Value, new Reference(copy?.id as string))).toBe(true);
  });
});
