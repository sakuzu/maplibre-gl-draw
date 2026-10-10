// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the GeoJSON export: the text `document.toGeoJSON` writes is pinned character by
 * character, for a document that goes through every rule of the export (rounding, ring
 * orientation, the antimeridian, the added keys, images, the order of hidden features and an
 * unsupported geometry), and the public functions that write features without a drawing
 * write the same text
 */

import type { Geometry } from 'geojson';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../../store/memory.js';
import type { Feature, Layer } from '../../../store/types.js';
import { createResourceDeps } from '../../../test-utils.js';
import type { DocumentResource } from '../../document.js';
import { featuresToGeoJSON, featureToGeoJSON } from '../../model.js';
import { createDocument } from '../document.js';

const layer = (id: string, visible = true): Layer => ({
  id,
  name: id,
  visible,
  locked: false,
  opacity: 1,
  items: [],
  styleRule: undefined,
  metadata: undefined,
});

const feature = (
  id: string,
  geometry: Geometry,
  extra: Partial<Feature> = {},
  layerId = 'l1',
): Feature => ({
  id,
  type: geometry.type as Feature['type'],
  geometry,
  layerId,
  groupId: undefined,
  properties: {},
  style: {},
  visible: true,
  locked: false,
  ...extra,
});

/** A clockwise square with positions that need rounding */
const CLOCKWISE_SQUARE = [
  [139.123456789, 35.987654321],
  [139.223456789, 35.987654321],
  [139.223456789, 35.887654321],
  [139.123456789, 35.887654321],
  [139.123456789, 35.987654321],
];

let store: MemoryStore;
let doc: DocumentResource;

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  store = new MemoryStore();
  store.createLayer(layer('l1'));
  store.createLayer(layer('l2'));
  store.createLayer(layer('l3', false));
  store.createFile({ id: 'file-1', mimeType: 'image/png', dataURL: 'data:image/png;base64,AAAA' });

  store.createFeature(
    feature(
      'point',
      { type: 'Point', coordinates: [139.76712345678, 35.68112345678] },
      {
        // An own key named __proto__ is written out as a key
        properties: JSON.parse(
          '{"name":"Station","__proto__":{"x":1},"maplibre-gl-draw:createdZoom":14}',
        ),
        style: { pointRadius: 8 },
      },
    ),
  );
  store.createFeature(
    feature('polygon', { type: 'Polygon', coordinates: [CLOCKWISE_SQUARE] }, { locked: true }),
  );
  store.createFeature(
    feature('across', {
      type: 'LineString',
      coordinates: [
        [170, 10],
        [190.000000004, 12],
      ],
    }),
  );
  store.createFeature(
    feature(
      'multi',
      {
        type: 'MultiPolygon',
        coordinates: [[CLOCKWISE_SQUARE], [CLOCKWISE_SQUARE.map(([x, y]) => [x + 1, y])]],
      },
      {},
      'l2',
    ),
  );
  store.createFeature(
    feature(
      'image',
      { type: 'Point', coordinates: [139.7, 35.6] },
      {
        type: 'Image',
        properties: {
          'maplibre-gl-draw:imageFileId': 'file-1',
          'maplibre-gl-draw:imageWidth': 2,
          'maplibre-gl-draw:imageHeight': 1,
        },
      },
      'l2',
    ),
  );
  store.createFeature(
    feature(
      'image-without-file',
      { type: 'Point', coordinates: [139.8, 35.6] },
      { type: 'Image', properties: { 'maplibre-gl-draw:imageFileId': 'missing' } },
      'l2',
    ),
  );
  store.createFeature(
    feature(
      'custom',
      {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [-0.00000000001, 1],
        ],
      },
      { type: 'MyShape' },
      'l2',
    ),
  );
  store.createFeature(
    feature('hidden', { type: 'Point', coordinates: [1, 1] }, { visible: false }, 'l1'),
  );
  store.createFeature(feature('in-hidden-layer', { type: 'Point', coordinates: [2, 2] }, {}, 'l3'));
  store.createFeature(feature('locally-hidden', { type: 'Point', coordinates: [3, 3] }, {}, 'l1'));
  store.createFeature(
    feature(
      'multi-point',
      {
        type: 'MultiPoint',
        coordinates: [
          [4, 4],
          [5, 5],
        ],
      },
      { type: 'MultiPoint' },
      'l1',
    ),
  );
  store.createFeature(
    feature(
      'multi-line',
      {
        type: 'MultiLineString',
        coordinates: [
          [
            [6, 6],
            [7, 7],
          ],
        ],
      },
      { type: 'MultiLineString' },
      'l1',
    ),
  );
  store.createFeature(
    feature(
      'collection',
      { type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [0, 0] }] },
      { type: 'Point' },
      'l1',
    ),
  );
  store.createGroup({
    id: 'g1',
    layerId: 'l1',
    name: 'g1',
    featureIds: ['polygon'],
    visible: true,
    locked: false,
  });
  store.setLocallyHidden('locally-hidden', true);
  doc = createDocument(createResourceDeps(store));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('document.toGeoJSON', () => {
  it('writes the text pinned here', () => {
    expect(JSON.stringify(doc.toGeoJSON(), null, 2)).toMatchInlineSnapshot(`
      "{
        "type": "FeatureCollection",
        "bbox": [
          -170,
          0,
          170,
          35.9876543
        ],
        "features": [
          {
            "type": "Feature",
            "id": "point",
            "geometry": {
              "type": "Point",
              "coordinates": [
                139.7671235,
                35.6811235
              ]
            },
            "properties": {
              "name": "Station",
              "__proto__": {
                "x": 1
              },
              "maplibre-gl-draw:createdZoom": 14,
              "maplibre-gl-draw:id": "point",
              "maplibre-gl-draw:layerId": "l1",
              "maplibre-gl-draw:style": {
                "pointRadius": 8
              }
            }
          },
          {
            "type": "Feature",
            "id": "polygon",
            "geometry": {
              "type": "Polygon",
              "coordinates": [
                [
                  [
                    139.1234568,
                    35.9876543
                  ],
                  [
                    139.1234568,
                    35.8876543
                  ],
                  [
                    139.2234568,
                    35.8876543
                  ],
                  [
                    139.2234568,
                    35.9876543
                  ],
                  [
                    139.1234568,
                    35.9876543
                  ]
                ]
              ]
            },
            "properties": {
              "maplibre-gl-draw:id": "polygon",
              "maplibre-gl-draw:layerId": "l1",
              "maplibre-gl-draw:groupId": "g1",
              "maplibre-gl-draw:locked": true
            }
          },
          {
            "type": "Feature",
            "id": "across",
            "geometry": {
              "type": "LineString",
              "coordinates": [
                [
                  170,
                  10
                ],
                [
                  -170,
                  12
                ]
              ]
            },
            "properties": {
              "maplibre-gl-draw:id": "across",
              "maplibre-gl-draw:layerId": "l1"
            }
          },
          {
            "type": "Feature",
            "id": "locally-hidden",
            "geometry": {
              "type": "Point",
              "coordinates": [
                3,
                3
              ]
            },
            "properties": {
              "maplibre-gl-draw:id": "locally-hidden",
              "maplibre-gl-draw:layerId": "l1"
            }
          },
          {
            "type": "Feature",
            "id": "multi-point",
            "geometry": {
              "type": "MultiPoint",
              "coordinates": [
                [
                  4,
                  4
                ],
                [
                  5,
                  5
                ]
              ]
            },
            "properties": {
              "maplibre-gl-draw:id": "multi-point",
              "maplibre-gl-draw:layerId": "l1"
            }
          },
          {
            "type": "Feature",
            "id": "multi-line",
            "geometry": {
              "type": "MultiLineString",
              "coordinates": [
                [
                  [
                    6,
                    6
                  ],
                  [
                    7,
                    7
                  ]
                ]
              ]
            },
            "properties": {
              "maplibre-gl-draw:id": "multi-line",
              "maplibre-gl-draw:layerId": "l1"
            }
          },
          {
            "type": "Feature",
            "id": "multi",
            "geometry": {
              "type": "MultiPolygon",
              "coordinates": [
                [
                  [
                    [
                      139.1234568,
                      35.9876543
                    ],
                    [
                      139.1234568,
                      35.8876543
                    ],
                    [
                      139.2234568,
                      35.8876543
                    ],
                    [
                      139.2234568,
                      35.9876543
                    ],
                    [
                      139.1234568,
                      35.9876543
                    ]
                  ]
                ],
                [
                  [
                    [
                      140.1234568,
                      35.9876543
                    ],
                    [
                      140.1234568,
                      35.8876543
                    ],
                    [
                      140.2234568,
                      35.8876543
                    ],
                    [
                      140.2234568,
                      35.9876543
                    ],
                    [
                      140.1234568,
                      35.9876543
                    ]
                  ]
                ]
              ]
            },
            "properties": {
              "maplibre-gl-draw:id": "multi",
              "maplibre-gl-draw:layerId": "l2"
            }
          },
          {
            "type": "Feature",
            "id": "image",
            "geometry": {
              "type": "Point",
              "coordinates": [
                139.7,
                35.6
              ]
            },
            "properties": {
              "maplibre-gl-draw:imageFileId": "file-1",
              "maplibre-gl-draw:imageWidth": 2,
              "maplibre-gl-draw:imageHeight": 1,
              "maplibre-gl-draw:id": "image",
              "maplibre-gl-draw:layerId": "l2",
              "maplibre-gl-draw:featureType": "Image",
              "maplibre-gl-draw:imageData": "data:image/png;base64,AAAA",
              "maplibre-gl-draw:imageMimeType": "image/png"
            }
          },
          {
            "type": "Feature",
            "id": "image-without-file",
            "geometry": {
              "type": "Point",
              "coordinates": [
                139.8,
                35.6
              ]
            },
            "properties": {
              "maplibre-gl-draw:imageFileId": "missing",
              "maplibre-gl-draw:id": "image-without-file",
              "maplibre-gl-draw:layerId": "l2",
              "maplibre-gl-draw:featureType": "Image"
            }
          },
          {
            "type": "Feature",
            "id": "custom",
            "geometry": {
              "type": "LineString",
              "coordinates": [
                [
                  0,
                  0
                ],
                [
                  0,
                  1
                ]
              ]
            },
            "properties": {
              "maplibre-gl-draw:id": "custom",
              "maplibre-gl-draw:layerId": "l2",
              "maplibre-gl-draw:featureType": "MyShape"
            }
          },
          {
            "type": "Feature",
            "id": "hidden",
            "geometry": {
              "type": "Point",
              "coordinates": [
                1,
                1
              ]
            },
            "properties": {
              "maplibre-gl-draw:id": "hidden",
              "maplibre-gl-draw:layerId": "l1",
              "maplibre-gl-draw:visible": false
            }
          },
          {
            "type": "Feature",
            "id": "in-hidden-layer",
            "geometry": {
              "type": "Point",
              "coordinates": [
                2,
                2
              ]
            },
            "properties": {
              "maplibre-gl-draw:id": "in-hidden-layer",
              "maplibre-gl-draw:layerId": "l3"
            }
          }
        ]
      }"
    `);
  });
});

describe('featuresToGeoJSON and featureToGeoJSON', () => {
  /** The features of the store in the order document.toGeoJSON writes them */
  const inExportOrder = (): Feature[] =>
    doc.toGeoJSON().features.map((f) => store.getFeature(String(f.id)) as Feature);

  it('write the same text as document.toGeoJSON for the same features', () => {
    const features = [...inExportOrder(), store.getFeature('collection') as Feature];
    const getFile = (id: string) => store.getFile(id);
    expect(JSON.stringify(featuresToGeoJSON(features, { getFile }), null, 2)).toBe(
      JSON.stringify(doc.toGeoJSON(), null, 2),
    );
    expect(JSON.stringify(features.map((f) => featureToGeoJSON(f, { getFile })))).toBe(
      JSON.stringify([...doc.toGeoJSON().features, null]),
    );
  });

  it('write the features in the order given', () => {
    const features = inExportOrder().reverse();
    expect(featuresToGeoJSON(features).features.map((f) => f.id)).toEqual(
      features.map((f) => f.id),
    );
  });

  it('write an Image without its pixels when the file is not read', () => {
    const image = store.getFeature('image') as Feature;
    const written = featureToGeoJSON(image)?.properties ?? {};
    expect(written['maplibre-gl-draw:featureType']).toBe('Image');
    expect(written).not.toHaveProperty('maplibre-gl-draw:imageData');
    expect(written).not.toHaveProperty('maplibre-gl-draw:imageMimeType');
    expect(featureToGeoJSON(image, { getFile: () => undefined })?.properties).toEqual(written);
  });

  it('write an empty collection without a bbox', () => {
    expect(featuresToGeoJSON([])).toEqual({ type: 'FeatureCollection', features: [] });
  });

  it('write no group for a feature whose groupId is null', () => {
    const polygon = {
      ...(store.getFeature('polygon') as Feature),
      groupId: null as unknown as undefined,
    };
    expect(featureToGeoJSON(polygon)?.properties).not.toHaveProperty('maplibre-gl-draw:groupId');
  });

  it('write a style that is not the object of the feature given', () => {
    const point = feature(
      'styled',
      { type: 'Point', coordinates: [139, 35] },
      { style: { pointRadius: 8, fillColor: '#123456' } },
    );
    const written = featureToGeoJSON(point)?.properties?.['maplibre-gl-draw:style'] as Record<
      string,
      unknown
    >;
    expect(written).toEqual(point.style);
    written.pointRadius = 1;
    expect(point.style).toEqual({ pointRadius: 8, fillColor: '#123456' });
  });

  it('do not change the features given', () => {
    const polygon = structuredClone(store.getFeature('polygon') as Feature);
    const before = structuredClone(polygon);
    featuresToGeoJSON([polygon]);
    expect(polygon).toEqual(before);
  });
});
