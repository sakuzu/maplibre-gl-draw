// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests of the rows read from features of GeoJSON: each row has the values of the feature a load
 * (`document.load`) makes of the same feature of GeoJSON
 */

import type { FeatureCollection, Feature as GeoJSONFeature } from 'geojson';
import { describe, expect, it } from 'vitest';
import { AutoNameGenerator } from '../shared/utils/name-generator.js';
import { MemoryStore } from '../store/memory.js';
import { createResourceDeps } from '../test-utils.js';
import { DrawError } from './errors.js';
import { rowsOfGeoJSON } from './geojson-rows.js';
import { createDocument } from './impl/document.js';

const SQUARE = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
  [0, 0],
];

function feature(geometry: unknown, properties: unknown = {}, id?: unknown): GeoJSONFeature {
  return {
    type: 'Feature',
    geometry,
    properties,
    ...(id !== undefined && { id }),
  } as GeoJSONFeature;
}

const VALID = feature({ type: 'Point', coordinates: [0, 0] });

/** A store with one layer, and the document over it, naming nothing automatically */
function documentOf(): { store: MemoryStore; doc: ReturnType<typeof createDocument> } {
  const store = new MemoryStore();
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
  const deps = {
    ...createResourceDeps(store),
    autoNameGenerator: new AutoNameGenerator(store, false),
  };
  return { store, doc: createDocument(deps) };
}

/** The features of GeoJSON the rules of a load read in their own way */
const FEATURES: GeoJSONFeature[] = [
  // Plain attributes, and a position of three numbers, kept (a load cuts it to two)
  feature({ type: 'Point', coordinates: [1, 2, 30] }, { name: 'a', n: 1, nested: { x: [1, 2] } }),
  // simplestyle-spec read as the style, and its keys kept as attributes
  feature(
    {
      type: 'LineString',
      coordinates: [
        [0, 0],
        [1, 1],
      ],
    },
    { stroke: '#ff0000', 'stroke-width': 3, 'stroke-opacity': 0.5 },
  ),
  // The style of the library wins over simplestyle-spec, its bad keys dropped
  feature(
    { type: 'Polygon', coordinates: [SQUARE] },
    {
      fill: '#00ff00',
      'maplibre-gl-draw:style': { fillColor: '#0000ff', fillOpacity: 5, strokeWidth: 2 },
    },
  ),
  // The type from its marker, the values of the library kept with their prefix, an earlier
  // radius without the prefix read as the value of the library
  feature(
    { type: 'Point', coordinates: [3, 4] },
    { 'maplibre-gl-draw:featureType': 'Circle', radiusMeters: 50, 'maplibre-gl-draw:rotation': 10 },
  ),
  // A custom type on a line, and a marker naming a geometry type, ignored
  feature(
    {
      type: 'LineString',
      coordinates: [
        [0, 0],
        [2, 2],
      ],
    },
    { 'maplibre-gl-draw:featureType': 'Arrow' },
  ),
  feature({ type: 'Polygon', coordinates: [SQUARE] }, { 'maplibre-gl-draw:featureType': 'point' }),
  // Hidden and locked; the layer, the group and the keys that are not values of the library left
  // out of the attributes
  feature(
    { type: 'Point', coordinates: [5, 6] },
    {
      'maplibre-gl-draw:visible': false,
      'maplibre-gl-draw:locked': true,
      'maplibre-gl-draw:layerId': 'l9',
      'maplibre-gl-draw:groupId': 'g9',
      'maplibre-gl-draw:unknown': 1,
      kept: true,
    },
  ),
  // The id of the library wins over the id of the Feature; a number is its text
  feature({ type: 'Point', coordinates: [7, 8] }, { 'maplibre-gl-draw:id': 'p1' }, 'other'),
  feature({ type: 'Point', coordinates: [9, 10] }, null, 42),
  // A Multi geometry is one feature, a GeometryCollection one per kind
  feature(
    {
      type: 'MultiPolygon',
      coordinates: [[SQUARE], [SQUARE.map(([x, y]) => [x + 2, y])]],
    },
    { m: 1 },
  ),
  feature(
    {
      type: 'GeometryCollection',
      geometries: [
        { type: 'Point', coordinates: [0, 0] },
        { type: 'Polygon', coordinates: [SQUARE] },
        { type: 'Point', coordinates: [1, 1] },
      ],
    },
    { gc: 'yes' },
    'gc',
  ),
  // An Image of an earlier export without its data: the style of 1.0 folded
  feature(
    { type: 'Point', coordinates: [0, 0] },
    {
      'maplibre-gl-draw:featureType': 'Image',
      'maplibre-gl-draw:style': { width: 20, height: 10, opacity: 0.5 },
      'maplibre-gl-draw:imageFileId': 'f1',
    },
  ),
  // A key __proto__ stays an attribute of its own
  JSON.parse(
    '{"type":"Feature","geometry":{"type":"Point","coordinates":[1,1]},"properties":{"__proto__":{"x":1}}}',
  ) as GeoJSONFeature,
  // Left out, as a load leaves them out
  feature(null),
  feature({ type: 'Point', coordinates: [Number.NaN, 0] }),
  feature({ type: 'Point', coordinates: [0, 0] }, [1, 2]),
  feature({ type: 'GeometryCollection', geometries: [] }),
  'not a feature' as unknown as GeoJSONFeature,
];

describe('rowsOfGeoJSON', () => {
  it('reads each feature as the values of the features a load makes of it', async () => {
    const { store, doc } = documentOf();
    const loaded = await doc.load({ type: 'FeatureCollection', features: FEATURES });
    const { rows, skipped } = rowsOfGeoJSON(FEATURES);

    expect(skipped).toEqual(loaded?.skipped);
    const ids = loaded?.featureIds ?? [];
    const made = (i: number) => store.getFeature(ids[i] as string)?.geometry;
    expect(rows).toHaveLength(ids.length);
    rows.forEach((row, i) => {
      const made = store.getFeature(ids[i] as string);
      expect({
        type: row.type,
        // A Feature holds x and y: the rows keep the z a load cuts
        geometry: i === 0 ? { type: 'Point', coordinates: [1, 2] } : row.geometry,
        style: row.style,
        properties: row.properties,
        visible: row.visible,
        locked: row.locked,
      }).toEqual({
        type: made?.type,
        geometry: made?.geometry,
        style: made?.style,
        properties: made?.properties,
        visible: made?.visible,
        locked: made?.locked,
      });
    });

    // The values the cases are about, read the same way by both
    expect(rows[0]?.geometry).toEqual({ type: 'Point', coordinates: [1, 2, 30] });
    expect(made(0)).toEqual({ type: 'Point', coordinates: [1, 2] });
    expect(rows[1]?.style).toEqual({ strokeColor: '#ff0000', strokeWidth: 3, strokeOpacity: 0.5 });
    expect(rows[1]?.properties).toMatchObject({ stroke: '#ff0000' });
    expect(rows[2]?.style).toEqual({ fillColor: '#0000ff', strokeWidth: 2 });
    expect(rows[3]).toMatchObject({
      type: 'Circle',
      properties: { 'maplibre-gl-draw:radiusMeters': 50, 'maplibre-gl-draw:rotation': 10 },
    });
    expect(rows[4]?.type).toBe('Arrow');
    expect(rows[5]?.type).toBe('Polygon');
    expect(rows[6]).toMatchObject({ visible: false, locked: true, properties: { kept: true } });
    expect(Object.keys(rows[6]?.properties ?? {})).toEqual(['kept']);
    expect(rows.slice(10, 12).map((row) => row.type)).toEqual(['MultiPoint', 'MultiPolygon']);
    expect(rows[12]).toMatchObject({
      type: 'Image',
      style: { imageOpacity: 0.5 },
      properties: {
        'maplibre-gl-draw:imageWidth': 20,
        'maplibre-gl-draw:imageHeight': 10,
        'maplibre-gl-draw:imageFileId': 'f1',
      },
    });
    expect(Object.getOwnPropertyNames(rows[13]?.properties)).toEqual(['__proto__']);
    expect(skipped.map((s) => s.index)).toEqual([13, 14, 15, 16, 17]);
  });

  it('keeps the z and the m of the positions, and says the dimensions of the rows', () => {
    const line = (positions: number[][]) => feature({ type: 'LineString', coordinates: positions });
    const flat = rowsOfGeoJSON([
      VALID,
      line([
        [0, 0],
        [1, 1],
      ]),
    ]);
    expect(flat.dimensions).toBe('xy');
    expect(flat.rows.map((row) => row.dimensions)).toEqual(['xy', 'xy']);

    const read = rowsOfGeoJSON([
      VALID,
      // A position of three values (its z) beside one of two
      line([
        [0, 0, 5],
        [1, 1],
      ]),
      // Four values: x, y, z and m
      feature({ type: 'Point', coordinates: [1, 2, 3, 4] }),
      // A GeometryCollection: every row of it has the dimensions of the feature
      feature({
        type: 'GeometryCollection',
        geometries: [
          { type: 'Point', coordinates: [0, 0, 7] },
          { type: 'Polygon', coordinates: [SQUARE] },
        ],
      }),
      // More values than a row holds: left out, not cut
      feature({ type: 'Point', coordinates: [1, 2, 3, 4, 5] }),
    ]);
    expect(read.dimensions).toBe('xyzm');
    expect(read.rows.map((row) => [row.index, row.dimensions])).toEqual([
      [0, 'xy'],
      [1, 'xyz'],
      [2, 'xyzm'],
      [3, 'xyz'],
      [3, 'xyz'],
    ]);
    expect(read.rows[1]?.geometry).toEqual({
      type: 'LineString',
      coordinates: [
        [0, 0, 5],
        [1, 1],
      ],
    });
    expect(read.rows[2]?.geometry).toEqual({ type: 'Point', coordinates: [1, 2, 3, 4] });
    expect(read.rows[3]?.geometry).toEqual({ type: 'MultiPoint', coordinates: [[0, 0, 7]] });
    expect(read.skipped).toEqual([
      { index: 4, reason: expect.stringMatching(/a position of 5 values/) },
    ]);
  });

  it('names the ID of the input on the first row read from its feature', () => {
    const { rows } = rowsOfGeoJSON(FEATURES);
    expect(rows.map((row) => [row.index, row.inputId])).toEqual([
      [0, undefined],
      [1, undefined],
      [2, undefined],
      [3, undefined],
      [4, undefined],
      [5, undefined],
      [6, undefined],
      [7, 'p1'],
      [8, '42'],
      [9, undefined],
      [10, 'gc'],
      [10, undefined],
      [11, undefined],
      [12, undefined],
    ]);
    // The rows of one feature do not share their attributes
    expect(rows[10]?.properties).toEqual(rows[11]?.properties);
    expect(rows[10]?.properties).not.toBe(rows[11]?.properties);
  });

  it('leaves out a single Image point that embeds its image, which a load makes a file of', async () => {
    const image = feature(
      { type: 'Point', coordinates: [0, 0] },
      {
        'maplibre-gl-draw:featureType': 'Image',
        'maplibre-gl-draw:imageData': 'data:image/png;base64,iVBORw0KGgo=',
        'maplibre-gl-draw:imageMimeType': 'image/png',
      },
    );
    const { rows, skipped } = rowsOfGeoJSON([VALID, image]);
    expect(rows).toHaveLength(1);
    expect(skipped).toEqual([{ index: 1, reason: expect.stringMatching(/embeds an image/) }]);
  });

  it('throws as a load throws when a value of the properties is not a value', async () => {
    const bad = [VALID, feature({ type: 'Point', coordinates: [0, 0] }, { s: '\uD800' })];
    const { doc } = documentOf();
    const collection: FeatureCollection = { type: 'FeatureCollection', features: bad };
    await expect(doc.load(collection)).rejects.toMatchObject({ code: 'invalidInput' });
    expect(() => rowsOfGeoJSON(bad)).toThrow(DrawError);
    expect(() => rowsOfGeoJSON(bad)).toThrow(/lone surrogate/);
  });
});
