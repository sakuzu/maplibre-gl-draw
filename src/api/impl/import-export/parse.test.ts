// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests of parseGeoJSON and parseNative: the input is read with new IDs and written nowhere
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processImageDataUrl, UnsupportedImageTypeError } from '../../../shared/utils/image.js';
import { DrawError } from '../../errors.js';
import type { DrawDocument } from '../../model.js';
import { featuresToGeoJSON, parseGeoJSON, parseNative } from '../../model.js';

vi.mock('../../../shared/utils/image', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/utils/image.js')>()),
  processImageDataUrl: vi.fn(),
}));

/** A PNG header of the size given, larger than the texture limit when it is over 4096 */
function pngDataUrl(width: number, height: number): string {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

const SMALL = pngDataUrl(10, 10);
const LARGE = pngDataUrl(8192, 8192);

/** A generator that counts the IDs it makes */
function counter() {
  const minted: string[] = [];
  const generateId = () => {
    const id = `new-${minted.length + 1}`;
    minted.push(id);
    return id;
  };
  return { minted, generateId };
}

function image(dataURL: string, extra: Record<string, unknown> = {}): GeoJSON.Feature {
  return {
    type: 'Feature',
    properties: {
      'maplibre-gl-draw:featureType': 'Image',
      'maplibre-gl-draw:imageData': dataURL,
      'maplibre-gl-draw:imageMimeType': 'image/png',
      'maplibre-gl-draw:imageWidth': 10,
      'maplibre-gl-draw:imageHeight': 10,
      ...extra,
    },
    geometry: { type: 'Point', coordinates: [1, 1] },
  };
}

const input: GeoJSON.FeatureCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'a',
      properties: {
        name: 'A',
        'maplibre-gl-draw:groupId': 'g',
        'maplibre-gl-draw:layerId': 'elsewhere',
        'maplibre-gl-draw:style': { pointColor: '#ff0000' },
      },
      geometry: { type: 'Point', coordinates: [139.7, 35.6] },
    },
    {
      type: 'Feature',
      properties: {
        'maplibre-gl-draw:id': 'b',
        'maplibre-gl-draw:groupId': 'g',
        'maplibre-gl-draw:locked': true,
        note: 'two',
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      },
    },
    {
      type: 'Feature',
      id: 3,
      properties: { 'maplibre-gl-draw:visible': false, 'maplibre-gl-draw:radiusMeters': 50 },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
            [0, 0],
          ],
        ],
      },
    },
    image(SMALL, { 'maplibre-gl-draw:imageFileId': 'old-file', label: 'photo' }),
  ],
};

beforeEach(() => {
  vi.mocked(processImageDataUrl).mockReset();
});

describe('parseGeoJSON', () => {
  it('gives every feature, group and file a new ID and rewires the references', async () => {
    const { minted, generateId } = counter();
    const parsed = await parseGeoJSON(input, { generateId, layerId: 'target' });

    const ids = parsed.features.map((feature) => feature.id);
    expect(ids).toHaveLength(4);
    for (const id of ids) expect(minted).toContain(id);
    expect(ids).not.toContain('a');
    expect(ids).not.toContain('b');
    expect(ids).not.toContain('3');
    expect(parsed.features.every((feature) => feature.layerId === 'target')).toBe(true);

    // The two features that name group g form one new group
    expect(parsed.groups).toHaveLength(1);
    const [group] = parsed.groups;
    expect(minted).toContain(group.id);
    expect(group.featureIds).toEqual([ids[0], ids[1]]);
    expect(parsed.features[0].groupId).toBe(group.id);
    expect(parsed.features[1].groupId).toBe(group.id);
    expect(parsed.features[2].groupId).toBeUndefined();

    // The image names its new file
    expect(parsed.files).toHaveLength(1);
    const [file] = parsed.files;
    expect(minted).toContain(file.id);
    expect(file).toMatchObject({ mimeType: 'image/png', dataURL: SMALL });
    expect(parsed.features[3].properties['maplibre-gl-draw:imageFileId']).toBe(file.id);

    expect(parsed.layers).toEqual([]);
    expect(parsed.skipped).toEqual([]);
    expect(new Set(minted).size).toBe(minted.length);

    // The IDs the input gave, each with its new ID; the image had none of its own
    expect(parsed.idMap).toEqual({
      features: { a: ids[0], b: ids[1], '3': ids[2] },
      groups: { g: group.id },
      files: { 'old-file': file.id },
      layers: {},
    });
  });

  it('leaves a reference it does not know as it is, for idMap to rewrite', async () => {
    const parsed = await parseGeoJSON({
      type: 'FeatureCollection',
      features: [
        input.features[0],
        {
          type: 'Feature',
          id: 'pointer',
          properties: { link: { featureId: 'a', at: 0.5 }, others: ['a', 'missing'] },
          geometry: {
            type: 'LineString',
            coordinates: [
              [0, 0],
              [1, 1],
            ],
          },
        },
      ],
    });
    const [target, pointer] = parsed.features;
    // The library does not know these keys: they keep the IDs of the input
    expect(pointer.properties).toEqual({
      link: { featureId: 'a', at: 0.5 },
      others: ['a', 'missing'],
    });
    // The application rewrites them with the map
    const { features } = parsed.idMap;
    expect(features.a).toBe(target.id);
    expect(features.pointer).toBe(pointer.id);
    expect(features.missing).toBeUndefined();
    const link = pointer.properties.link as { featureId: string };
    expect(features[link.featureId]).toBe(target.id);
  });

  it('maps an ID of the input to the first feature made from it, and keeps IDs as own keys', async () => {
    const point = (id: string, coordinates: number[]) => ({
      type: 'Feature' as const,
      id,
      properties: {},
      geometry: { type: 'Point' as const, coordinates },
    });
    const parsed = await parseGeoJSON(
      {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            id: 'multi',
            properties: {},
            geometry: {
              type: 'MultiPoint',
              coordinates: [
                [0, 0],
                [1, 1],
              ],
            },
          },
          point('twice', [2, 2]),
          point('twice', [3, 3]),
          point('__proto__', [4, 4]),
        ],
      },
      { flattenMulti: true },
    );
    const ids = parsed.features.map((feature) => feature.id);
    expect(ids).toHaveLength(5);
    const { features } = parsed.idMap;
    expect(features.multi).toBe(ids[0]);
    expect(features.twice).toBe(ids[2]);
    expect(Object.keys(features)).toEqual(['multi', 'twice', '__proto__']);
    expect(Object.getOwnPropertyDescriptor(features, '__proto__')?.value).toBe(ids[4]);
    expect(Object.getPrototypeOf(features)).toBe(Object.prototype);
  });

  it('keeps the order of the input, names nothing, and leaves the layer empty without layerId', async () => {
    const parsed = await parseGeoJSON(input);
    expect(parsed.features.map((feature) => feature.type)).toEqual([
      'Point',
      'LineString',
      'Polygon',
      'Image',
    ]);
    expect(parsed.features.map((feature) => feature.properties.name)).toEqual([
      'A',
      undefined,
      undefined,
      undefined,
    ]);
    expect(parsed.features.every((feature) => feature.layerId === '')).toBe(true);
  });

  it('reads a single feature and a geometry, and splits Multi geometries when asked', async () => {
    const one = await parseGeoJSON(input.features[0]);
    expect(one.features).toHaveLength(1);
    const multi = {
      type: 'MultiPoint',
      coordinates: [
        [0, 0],
        [1, 1],
      ],
    } as GeoJSON.MultiPoint;
    expect((await parseGeoJSON(multi)).features).toHaveLength(1);
    const split = await parseGeoJSON(multi, { flattenMulti: true });
    expect(split.features.map((feature) => feature.type)).toEqual(['Point', 'Point']);
    expect(split.features[0].id).not.toBe(split.features[1].id);
  });

  it('round-trips the geometry and the properties through featuresToGeoJSON', async () => {
    const parsed = await parseGeoJSON(input, { layerId: 'target' });
    const files = new Map(parsed.files.map((file) => [file.id, file]));
    const output = featuresToGeoJSON(parsed.features, { getFile: (id) => files.get(id) });

    // The IDs and the references are new; everything else comes back as it was
    const renamed = [
      'maplibre-gl-draw:id',
      'maplibre-gl-draw:layerId',
      'maplibre-gl-draw:groupId',
      'maplibre-gl-draw:imageFileId',
    ];
    const strip = (properties: GeoJSON.GeoJsonProperties) =>
      Object.fromEntries(
        Object.entries(properties ?? {}).filter(([key]) => !renamed.includes(key)),
      );
    expect(output.features).toHaveLength(input.features.length);
    output.features.forEach((feature, index) => {
      expect(feature.geometry).toEqual(input.features[index].geometry);
      expect(strip(feature.properties)).toEqual(strip(input.features[index].properties));
    });
  });

  it('reports a feature that cannot be read, and an invalid image, as invalid-input', async () => {
    const parsed = await parseGeoJSON({
      type: 'FeatureCollection',
      features: [
        input.features[0],
        { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [] } },
        image('data:image/png;base64,not-an-image'),
      ],
    } as GeoJSON.FeatureCollection);
    expect(parsed.features).toHaveLength(1);
    expect(parsed.files).toEqual([]);
    expect(parsed.skipped).toEqual([
      { index: 1, reason: 'invalid-input', detail: 'the Point has malformed coordinates' },
      {
        index: 2,
        reason: 'invalid-input',
        detail:
          'the image data is not an embedded PNG / JPEG / WebP / GIF data URL of its declared type',
      },
    ]);
  });

  it('reports an image the browser cannot encode as unsupported-format, without throwing', async () => {
    vi.mocked(processImageDataUrl).mockRejectedValue(new UnsupportedImageTypeError('image/bmp'));
    const parsed = await parseGeoJSON({
      type: 'FeatureCollection',
      features: [image(LARGE), input.features[0]],
    });
    expect(parsed.features.map((feature) => feature.type)).toEqual(['Point']);
    expect(parsed.files).toEqual([]);
    expect(parsed.skipped).toEqual([
      {
        index: 0,
        reason: 'unsupported-format',
        detail:
          'the image data cannot be stored: The browser returned an image of an unsupported type: image/bmp',
      },
    ]);
  });

  it('reports an image that cannot be decoded as invalid-input, without the raw error', async () => {
    vi.mocked(processImageDataUrl).mockRejectedValue(new Error('Failed to load image'));
    const parsed = await parseGeoJSON(image(LARGE));
    expect(parsed.skipped).toEqual([
      {
        index: 0,
        reason: 'invalid-input',
        detail: 'the image data cannot be decoded: Failed to load image',
      },
    ]);
  });

  it('keeps a scaled-down image with its new type', async () => {
    vi.mocked(processImageDataUrl).mockResolvedValue({
      dataUrl: 'data:image/webp;base64,UklGRg==',
      width: 4096,
      height: 4096,
      mimeType: 'image/webp',
    });
    const parsed = await parseGeoJSON(image(LARGE));
    expect(parsed.files).toMatchObject([
      { mimeType: 'image/webp', dataURL: 'data:image/webp;base64,UklGRg==' },
    ]);
  });

  it('throws unsupported-format for an input that is not GeoJSON, invalid-input for bad options', async () => {
    await expect(parseGeoJSON({ type: 'Nothing' } as never)).rejects.toMatchObject({
      name: 'DrawError',
      code: 'unsupported-format',
    });
    for (const options of [{ generateId: 'x' }, { layerId: '' }, { flattenMulti: 1 }, { x: 1 }]) {
      await expect(parseGeoJSON(input, options as never)).rejects.toMatchObject({
        name: 'DrawError',
        code: 'invalid-input',
      });
    }
  });

  it('throws a DrawError when the generator throws', async () => {
    const failure = parseGeoJSON(input, {
      generateId: () => {
        throw new Error('no more IDs');
      },
    });
    await expect(failure).rejects.toBeInstanceOf(DrawError);
    await expect(failure).rejects.toMatchObject({ code: 'invalid-input' });
  });
});

describe('parseNative', () => {
  const layer = (id: string, items: string[]) => ({
    id,
    name: id.toUpperCase(),
    visible: true,
    locked: false,
    opacity: 0.5,
    items,
    styleRule: undefined,
    metadata: undefined,
  });
  const feature = (id: string, layerId: string, extra: Record<string, unknown> = {}) => ({
    id,
    type: 'Point',
    geometry: { type: 'Point', coordinates: [0, 0] },
    layerId,
    groupId: undefined,
    properties: {},
    style: {},
    visible: true,
    locked: false,
    ...extra,
  });
  const doc = {
    version: '2.0.0',
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
    layers: [layer('front', ['p']), layer('back', ['g', 'img'])],
    layerOrder: ['app-entry', 'back', 'front'],
    groups: [
      { id: 'g', name: 'G', visible: false, locked: true, layerId: 'back', featureIds: ['q', 'r'] },
    ],
    features: [
      feature('p', 'front'),
      feature('q', 'back', { groupId: 'g' }),
      feature('r', 'back', { groupId: 'g' }),
      feature('img', 'back', {
        type: 'Image',
        properties: { 'maplibre-gl-draw:imageFileId': 'f' },
      }),
    ],
    files: { f: { id: 'f', mimeType: 'image/png', dataURL: SMALL } },
  } as unknown as DrawDocument;

  it('gives every layer, group, feature and file a new ID and rewires the references', async () => {
    const { minted, generateId } = counter();
    const parsed = await parseNative(doc, { generateId });

    // The layers from the back, without the entries of the application
    expect(parsed.layers.map((l) => l.name)).toEqual(['BACK', 'FRONT']);
    expect(parsed.layers[0]).toEqual({
      id: parsed.layers[0].id,
      name: 'BACK',
      visible: true,
      locked: false,
      opacity: 0.5,
    });
    const [back, front] = parsed.layers.map((l) => l.id as string);
    const [p, q, r, img] = parsed.features;
    expect(p.layerId).toBe(front);
    expect([q.layerId, r.layerId, img.layerId]).toEqual([back, back, back]);

    expect(parsed.groups).toEqual([
      { id: q.groupId, name: 'G', visible: false, locked: true, featureIds: [q.id, r.id] },
    ]);
    expect(r.groupId).toBe(q.groupId);

    expect(parsed.files).toEqual([
      { id: expect.any(String), mimeType: 'image/png', dataURL: SMALL },
    ]);
    expect(img.properties['maplibre-gl-draw:imageFileId']).toBe(parsed.files[0].id);

    const all = [
      ...parsed.layers.map((l) => l.id as string),
      ...parsed.groups.map((g) => g.id as string),
      ...parsed.features.map((f) => f.id),
      ...parsed.files.map((f) => f.id),
    ];
    expect(all).toHaveLength(8);
    expect(new Set(all).size).toBe(8);
    for (const id of all) expect(minted).toContain(id);
    expect(parsed.skipped).toEqual([]);
    expect(parsed.idMap).toEqual({
      features: { p: p.id, q: q.id, r: r.id, img: img.id },
      groups: { g: q.groupId },
      files: { f: parsed.files[0].id },
      layers: { back, front },
    });
    // The input is not changed
    expect(doc.features[0].id).toBe('p');
  });

  it('puts every feature into the layer given, without layers', async () => {
    const parsed = await parseNative(doc, { layerId: 'target' });
    expect(parsed.layers).toEqual([]);
    expect(parsed.features.every((f) => f.layerId === 'target')).toBe(true);
    expect(parsed.groups).toHaveLength(1);
    expect(parsed.idMap.layers).toEqual({});
  });

  it('leaves out a feature whose image cannot be imported, and a group left empty', async () => {
    vi.mocked(processImageDataUrl).mockRejectedValue(new UnsupportedImageTypeError('image/bmp'));
    const broken = {
      ...doc,
      groups: [{ ...doc.groups?.[0], featureIds: ['img'] }],
      features: [
        doc.features[0],
        { ...doc.features[3], groupId: 'g' },
        { ...doc.features[1], groupId: undefined },
      ],
      files: { f: { id: 'f', mimeType: 'image/png', dataURL: LARGE } },
    } as DrawDocument;
    const parsed = await parseNative(broken);
    expect(parsed.features).toHaveLength(2);
    expect(parsed.files).toEqual([]);
    expect(parsed.groups).toEqual([]);
    // What was left out has no new ID
    expect(parsed.idMap).toMatchObject({ groups: {}, files: {} });
    expect(Object.keys(parsed.idMap.features)).toEqual(['p', 'q']);
    expect(parsed.skipped).toEqual([
      {
        index: 1,
        reason: 'unsupported-format',
        detail:
          'the image of file "f" cannot be stored: The browser returned an image of an unsupported type: image/bmp',
      },
    ]);
  });

  it('throws for an input that is not a document of the library, or a malformed one', async () => {
    await expect(parseNative({} as never)).rejects.toMatchObject({ code: 'unsupported-format' });
    await expect(
      parseNative({ ...doc, layerOrder: ['front'] } as DrawDocument),
    ).rejects.toMatchObject({ name: 'DrawError', code: 'invalid-input' });
  });
});
