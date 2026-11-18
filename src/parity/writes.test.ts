// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The table of what the instance does: the writes
 *
 * Each scene builds the document of `fillParityDocument`, makes one write through the public
 * API, and reads what it returned, the document, the state of this client and the events
 * (`observeParity`). See `parityTable` in src/test-utils.ts for how the rows are recorded.
 */

import { describe } from 'vitest';
import type { Draw, FeatureInput } from '../index.js';
import {
  createParityInstance,
  fillParityDocument,
  observeParity,
  type ParityInstance,
  parityQuiet,
  parityRing,
  parityTable,
} from '../test-utils.js';

const table = parityTable('writes');

/** The instance of a scene with the document filled in */
function filled(): ParityInstance {
  const t = createParityInstance({ initDefaultLayer: false });
  fillParityDocument(t);
  return t;
}

/** A scene: the document, then `setup` (not observed), then the write `act` (observed) */
function writes(
  name: string,
  act: (draw: Draw, t: ParityInstance) => unknown,
  setup?: (draw: Draw, t: ParityInstance) => void,
): void {
  table.scene(name, async () => {
    const t = filled();
    if (setup) parityQuiet(() => setup(t.draw, t));
    return observeParity(t, () => act(t.draw, t));
  });
}

const point = (x: number, y: number): FeatureInput => ({
  type: 'Point',
  geometry: { type: 'Point', coordinates: [x, y] },
});
const square = (x: number, y: number, size: number): FeatureInput => ({
  type: 'Polygon',
  geometry: { type: 'Polygon', coordinates: [parityRing(x, y, size)] },
});

describe('features.create and createMany', () => {
  const inputs: [string, FeatureInput][] = [
    ['a Point', point(0.5, -0.5)],
    [
      'a LineString',
      {
        type: 'LineString',
        geometry: {
          type: 'LineString',
          coordinates: [
            [0, -1],
            [1, -1.5],
          ],
        },
      },
    ],
    ['a Polygon', square(-0.5, -2.8, 0.5)],
    [
      'a MultiPoint',
      {
        type: 'MultiPoint',
        geometry: {
          type: 'MultiPoint',
          coordinates: [
            [0, -2],
            [0.2, -2],
          ],
        },
      },
    ],
    [
      'a MultiLineString',
      {
        type: 'MultiLineString',
        geometry: {
          type: 'MultiLineString',
          coordinates: [
            [
              [0, -2.5],
              [0.5, -2.5],
            ],
          ],
        },
      },
    ],
    [
      'a MultiPolygon',
      {
        type: 'MultiPolygon',
        geometry: { type: 'MultiPolygon', coordinates: [[parityRing(2, 0, 0.3)]] },
      },
    ],
    [
      'a Circle',
      {
        type: 'Circle',
        geometry: { type: 'Point', coordinates: [2, 1] },
        properties: { 'maplibre-gl-draw:radiusMeters': 5_000 },
      },
    ],
    [
      'a Freehand',
      {
        type: 'Freehand',
        geometry: {
          type: 'LineString',
          coordinates: [
            [2, -0.5],
            [2.2, -0.6],
            [2.4, -0.5],
          ],
        },
      },
    ],
    [
      'an Image',
      {
        type: 'Image',
        geometry: { type: 'Point', coordinates: [3, 0] },
        properties: {
          'maplibre-gl-draw:imageFileId': 'file-2',
          'maplibre-gl-draw:imageWidth': 20,
          'maplibre-gl-draw:imageHeight': 10,
        },
      },
    ],
    ['in layer lb', { ...point(1, -1), layerId: 'lb' }],
    ['in group g1', { ...point(3.2, -1.2), groupId: 'g1' }],
    ['in a locked layer', { ...point(1, 1), layerId: 'lc' }],
    ['in a hidden layer', { ...point(1, 1), layerId: 'ld' }],
    ['in a missing layer', { ...point(1, 1), layerId: 'none' }],
    ['in a missing group', { ...point(1, 1), groupId: 'none' }],
    ['with an ID in use', { ...point(1, 1), id: 'pt' }],
    ['with an ID of its own', { ...point(1, 1), id: 'mine' }],
    ['locked and hidden', { ...point(1, 1), locked: true, visible: false }],
    [
      'with a style and properties',
      { ...point(1, 1), style: { pointRadius: 9 }, properties: { a: 1, b: 'x' } },
    ],
    [
      'with a geometry of another type',
      { type: 'Point', geometry: { type: 'LineString', coordinates: [[0, 0]] } } as FeatureInput,
    ],
    [
      'with coordinates that are not numbers',
      { type: 'Point', geometry: { type: 'Point', coordinates: [Number.NaN, 0] } },
    ],
    ['of an unknown type', { ...point(1, 1), type: 'Unknown' }],
  ];
  for (const [label, input] of inputs) {
    writes(`features.create ${label}`, (draw) => draw.features.create(input));
  }
  writes(
    'features.create in read-only',
    (draw) => draw.features.create(point(1, 1)),
    (draw) => draw.setReadOnly(true),
  );
  writes('features.createMany of two', (draw) =>
    draw.features.createMany([point(1, 1), { ...point(1.2, 1), layerId: 'lb' }]),
  );
  writes('features.createMany with one in use', (draw) =>
    draw.features.createMany([point(1, 1), { ...point(1.2, 1), id: 'pt' }]),
  );
  writes('features.createMany of none', (draw) => draw.features.createMany([]));
});

describe('features.update and updateMany', () => {
  writes('features.update the geometry', (draw) =>
    draw.features.update('pt', { geometry: { type: 'Point', coordinates: [-3.2, 2.2] } }),
  );
  writes('features.update the properties', (draw) =>
    draw.features.update('pt', { properties: { n: 2, extra: true } }),
  );
  writes('features.update a property to undefined', (draw) =>
    draw.features.update('pt', { properties: { n: undefined } }),
  );
  writes('features.update the style', (draw) =>
    draw.features.update('ln', { style: { strokeWidth: 8 } }),
  );
  writes(
    'features.update visible false of a selected feature',
    (draw) => draw.features.update('pt', { visible: false }),
    (draw) => draw.selection.set('feature', ['pt', 'ln']),
  );
  writes('features.update locked true', (draw) => draw.features.update('pt', { locked: true }));
  writes('features.update of a locked feature', (draw) =>
    draw.features.update('lck', { properties: { a: 1 } }),
  );
  writes('features.update locked false of a locked feature', (draw) =>
    draw.features.update('lck', { locked: false }),
  );
  writes('features.update of a feature in a locked layer', (draw) =>
    draw.features.update('pc', { properties: { a: 1 } }),
  );
  writes(
    'features.update of a feature in a locked group',
    (draw) => draw.features.update('ga', { properties: { a: 1 } }),
    (draw) => draw.groups.update('g1', { locked: true }),
  );
  writes('features.update of a missing feature', (draw) =>
    draw.features.update('none', { properties: { a: 1 } }),
  );
  writes('features.update with a geometry of another type', (draw) =>
    draw.features.update('pt', {
      geometry: {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      },
    }),
  );
  writes(
    'features.update in read-only',
    (draw) => draw.features.update('pt', { properties: { a: 1 } }),
    (draw) => draw.setReadOnly(true),
  );
  writes(
    'features.update the geometry of a feature with selected vertices',
    (draw) =>
      draw.features.update('ln', {
        geometry: {
          type: 'LineString',
          coordinates: [
            [-2, 1.8],
            [-1, 1.8],
            [-1, 2.5],
          ],
        },
      }),
    (draw) => {
      draw.selection.set('feature', ['ln']);
      draw.vertexSelection.set('ln', [{ ring: 0, index: 1 }]);
    },
  );
  writes('features.updateMany of two', (draw) =>
    draw.features.updateMany([
      { id: 'pt', patch: { properties: { n: 3 } } },
      { id: 'pb', patch: { style: { pointRadius: 3 } } },
    ]),
  );
  writes('features.updateMany with a missing one', (draw) =>
    draw.features.updateMany([
      { id: 'pt', patch: { properties: { n: 3 } } },
      { id: 'none', patch: { properties: { n: 3 } } },
    ]),
  );
  writes('features.updateMany with a locked one', (draw) =>
    draw.features.updateMany([
      { id: 'pt', patch: { properties: { n: 3 } } },
      { id: 'lck', patch: { properties: { n: 3 } } },
    ]),
  );
});

describe('features.delete and deleteMany', () => {
  writes('features.delete a feature', (draw) => draw.features.delete('pt'));
  writes(
    'features.delete a selected feature',
    (draw) => draw.features.delete('pt'),
    (draw) => draw.selection.set('feature', ['pt', 'ln']),
  );
  writes('features.delete a feature hidden by this client', (draw) => draw.features.delete('loc'));
  writes('features.delete one feature of a group of two', (draw) => draw.features.delete('ga'));
  writes('features.delete a locked feature', (draw) => draw.features.delete('lck'));
  writes('features.delete a feature in a locked layer', (draw) => draw.features.delete('pc'));
  writes('features.delete a missing feature', (draw) => draw.features.delete('none'));
  writes(
    'features.delete in read-only',
    (draw) => draw.features.delete('pt'),
    (draw) => draw.setReadOnly(true),
  );
  writes(
    'features.delete a feature with selected vertices',
    (draw) => draw.features.delete('ln'),
    (draw) => {
      draw.selection.set('feature', ['ln']);
      draw.vertexSelection.set('ln', [{ ring: 0, index: 1 }]);
    },
  );
  writes('features.deleteMany of two', (draw) => draw.features.deleteMany(['pt', 'pb']));
  writes('features.deleteMany of the whole group', (draw) =>
    draw.features.deleteMany(['ga', 'gb']),
  );
  writes('features.deleteMany with a locked one', (draw) =>
    draw.features.deleteMany(['pt', 'lck']),
  );
  writes('features.deleteMany with a missing one', (draw) =>
    draw.features.deleteMany(['pt', 'none']),
  );
});

describe('features.move and moveMany', () => {
  writes('features.move to another layer', (draw) => draw.features.move('pt', { layerId: 'lb' }));
  writes('features.move to another layer at index 0', (draw) =>
    draw.features.move('pt', { layerId: 'lb', index: 0 }),
  );
  writes('features.move in its layer to index 0', (draw) =>
    draw.features.move('ln', { layerId: 'la', index: 0 }),
  );
  writes('features.move in its layer to the end', (draw) =>
    draw.features.move('pt', { layerId: 'la' }),
  );
  writes('features.move into a group', (draw) => draw.features.move('pt', { groupId: 'g1' }));
  writes('features.move into a group at index 0', (draw) =>
    draw.features.move('pt', { groupId: 'g1', index: 0 }),
  );
  writes('features.move in its group to index 0', (draw) =>
    draw.features.move('gb', { groupId: 'g1', index: 0 }),
  );
  writes('features.move out of its group', (draw) => draw.features.move('ga', { groupId: null }));
  writes(
    'features.move the last feature out of its group',
    (draw) => draw.features.move('gb', { groupId: null }),
    (draw) => draw.features.move('ga', { groupId: null }),
  );
  writes('features.move a grouped feature to another layer', (draw) =>
    draw.features.move('ga', { layerId: 'lb' }),
  );
  writes('features.move to a locked layer', (draw) => draw.features.move('pt', { layerId: 'lc' }));
  writes('features.move a locked feature', (draw) => draw.features.move('lck', { layerId: 'lb' }));
  writes('features.move to a missing layer', (draw) =>
    draw.features.move('pt', { layerId: 'none' }),
  );
  writes('features.move a missing feature', (draw) =>
    draw.features.move('none', { layerId: 'lb' }),
  );
  writes(
    'features.move in read-only',
    (draw) => draw.features.move('pt', { layerId: 'lb' }),
    (draw) => draw.setReadOnly(true),
  );
  writes('features.moveMany to another layer', (draw) =>
    draw.features.moveMany(['pt', 'ln'], { layerId: 'lb', index: 1 }),
  );
  writes('features.moveMany into a group', (draw) =>
    draw.features.moveMany(['pt', 'ln'], { groupId: 'g1' }),
  );
  writes('features.moveMany the whole group out', (draw) =>
    draw.features.moveMany(['ga', 'gb'], { groupId: null }),
  );
  writes('features.moveMany with a locked one', (draw) =>
    draw.features.moveMany(['pt', 'lck'], { layerId: 'lb' }),
  );
});

describe('the geometry operations', () => {
  const overlap = (draw: Draw) => {
    draw.features.create({ ...square(-2.5, 0.5, 1), id: 'sq' });
  };
  writes('features.union of two polygons', (draw) => draw.features.union(['pg', 'sq']), overlap);
  writes('features.union of a polygon and a point', (draw) => draw.features.union(['pg', 'pt']));
  writes(
    'features.union of a locked polygon',
    (draw) => draw.features.union(['pg', 'sq']),
    (draw) => {
      overlap(draw);
      draw.features.update('sq', { locked: true });
    },
  );
  writes('features.difference', (draw) => draw.features.difference('pg', ['sq']), overlap);
  writes(
    'features.difference that leaves nothing',
    (draw) => draw.features.difference('sq', ['sq2']),
    (draw) => {
      overlap(draw);
      draw.features.create({ ...square(-3, -0.5, 3), id: 'sq2' });
    },
  );
  writes('features.intersection', (draw) => draw.features.intersection(['pg', 'sq']), overlap);
  writes('features.intersection of polygons apart', (draw) =>
    draw.features.intersection(['pg', 'hole']),
  );
  writes(
    'features.split a polygon by a line',
    (draw) => draw.features.split('pg', 'cut'),
    (draw) =>
      draw.features.create({
        id: 'cut',
        type: 'LineString',
        geometry: {
          type: 'LineString',
          coordinates: [
            [-2.5, -0.5],
            [-2.5, 1.5],
          ],
        },
      }),
  );
  writes(
    'features.split a line by a line',
    (draw) => draw.features.split('ln', 'cut'),
    (draw) =>
      draw.features.create({
        id: 'cut',
        type: 'LineString',
        geometry: {
          type: 'LineString',
          coordinates: [
            [-1.5, 1.5],
            [-1.5, 2.5],
          ],
        },
      }),
  );
  writes('features.split by a line that does not cross', (draw) => draw.features.split('pg', 'ln'));
  writes('features.buffer a point and a line', (draw) =>
    draw.features.buffer(['pt', 'ln'], { distanceMeters: 10_000, segments: 4 }),
  );
  writes('features.buffer a polygon', (draw) =>
    draw.features.buffer(['pg'], { distanceMeters: 5_000 }),
  );
  writes('features.buffer by a distance that is not positive', (draw) =>
    draw.features.buffer(['pt'], { distanceMeters: -1 }),
  );
  writes(
    'features.union in read-only',
    (draw) => draw.features.union(['pg', 'sq']),
    (draw) => {
      overlap(draw);
      draw.setReadOnly(true);
    },
  );
});

describe('the writes of the layers', () => {
  writes('layers.create', (draw) => draw.layers.create({ name: 'New' }));
  writes('layers.create with every field', (draw) =>
    draw.layers.create({
      id: 'le',
      name: 'E',
      visible: false,
      locked: true,
      opacity: 0.3,
      styleRule: { kind: 'single', color: '#0000ff' },
      metadata: { a: 1 },
    }),
  );
  writes('layers.create at index 1', (draw) => draw.layers.create({ id: 'le', index: 1 }));
  writes('layers.create with an ID in use', (draw) => draw.layers.create({ id: 'la' }));
  writes('layers.create with the ID of a group', (draw) => draw.layers.create({ id: 'g1' }));
  writes(
    'layers.create in read-only',
    (draw) => draw.layers.create({ id: 'le' }),
    (draw) => draw.setReadOnly(true),
  );
  writes('layers.createMany', (draw) =>
    draw.layers.createMany([{ id: 'le' }, { id: 'lf', name: 'F' }]),
  );
  writes('layers.update the name and the opacity', (draw) =>
    draw.layers.update('la', { name: 'A2', opacity: 0.7 }),
  );
  writes(
    'layers.update visible false with a selection in it',
    (draw) => draw.layers.update('la', { visible: false }),
    (draw) => draw.selection.set('feature', ['pt', 'pb']),
  );
  writes(
    'layers.update locked true with a selection in it',
    (draw) => draw.layers.update('la', { locked: true }),
    (draw) => draw.selection.set('feature', ['pt']),
  );
  writes('layers.update the style rule and the metadata', (draw) =>
    draw.layers.update('lb', {
      styleRule: { kind: 'single', color: '#000000' },
      metadata: { m: 2 },
    }),
  );
  writes('layers.update of a locked layer', (draw) => draw.layers.update('lc', { name: 'C2' }));
  writes('layers.update of a missing layer', (draw) => draw.layers.update('none', { name: 'x' }));
  writes('layers.updateMany', (draw) =>
    draw.layers.updateMany([
      { id: 'la', patch: { name: 'A3' } },
      { id: 'lb', patch: { visible: false } },
    ]),
  );
  writes(
    'layers.delete a layer with features and a group',
    (draw) => draw.layers.delete('la'),
    (draw) => draw.selection.set('feature', ['pt', 'pb']),
  );
  writes('layers.delete the active layer', (draw) => draw.layers.delete('la'));
  writes('layers.delete a locked layer', (draw) => draw.layers.delete('lc'));
  writes('layers.delete a missing layer', (draw) => draw.layers.delete('none'));
  writes(
    'layers.delete in read-only',
    (draw) => draw.layers.delete('lb'),
    (draw) => draw.setReadOnly(true),
  );
  writes('layers.deleteMany', (draw) => draw.layers.deleteMany(['lb', 'ld']));
  writes('layers.deleteMany of every layer', (draw) =>
    draw.layers.deleteMany(['la', 'lb', 'lc', 'ld']),
  );
  writes('layers.reorder', (draw) => draw.layers.reorder(['ld', 'lc', 'lb', 'la']));
  writes('layers.reorder with a layer left out', (draw) => draw.layers.reorder(['lb', 'la']));
  writes('layers.reorder with an entry that is not a layer', (draw) =>
    draw.layers.reorder(['la', 'lb', 'lc', 'ld', 'other']),
  );
  writes(
    'layers.reorder in read-only',
    (draw) => draw.layers.reorder(['ld', 'lc', 'lb', 'la']),
    (draw) => draw.setReadOnly(true),
  );
  writes('layers.setActive', (draw) => draw.layers.setActive('lb'));
  writes('layers.setActive a locked layer', (draw) => draw.layers.setActive('lc'));
  writes('layers.setActive a hidden layer', (draw) => draw.layers.setActive('ld'));
  writes('layers.setActive a missing layer', (draw) => draw.layers.setActive('none'));
});

describe('the writes of the groups', () => {
  writes('groups.create', (draw) => draw.groups.create({ featureIds: ['pt', 'ln'] }));
  writes('groups.create with every field', (draw) =>
    draw.groups.create({
      id: 'g2',
      name: 'Two',
      featureIds: ['pt', 'ln'],
      visible: false,
      locked: true,
    }),
  );
  writes('groups.create of features of two layers', (draw) =>
    draw.groups.create({ featureIds: ['pt', 'pb'] }),
  );
  writes('groups.create of a grouped feature', (draw) =>
    draw.groups.create({ featureIds: ['pt', 'ga'] }),
  );
  writes('groups.create of a locked feature', (draw) =>
    draw.groups.create({ featureIds: ['pt', 'lck'] }),
  );
  writes('groups.create of no features', (draw) => draw.groups.create({ featureIds: [] }));
  writes('groups.create of a missing feature', (draw) =>
    draw.groups.create({ featureIds: ['pt', 'none'] }),
  );
  writes('groups.create with an ID in use', (draw) =>
    draw.groups.create({ id: 'la', featureIds: ['pt'] }),
  );
  writes('groups.createMany', (draw) =>
    draw.groups.createMany([{ featureIds: ['pt'] }, { featureIds: ['ln', 'pg'] }]),
  );
  writes('groups.update the name', (draw) => draw.groups.update('g1', { name: 'G2' }));
  writes(
    'groups.update visible false with its feature selected',
    (draw) => draw.groups.update('g1', { visible: false }),
    (draw) => draw.selection.set('feature', ['ga', 'pt']),
  );
  writes('groups.update locked true', (draw) => draw.groups.update('g1', { locked: true }));
  writes('groups.update of a missing group', (draw) => draw.groups.update('none', { name: 'x' }));
  writes('groups.updateMany', (draw) =>
    draw.groups.updateMany([{ id: 'g1', patch: { name: 'G3' } }]),
  );
  writes('groups.delete', (draw) => draw.groups.delete('g1'));
  writes(
    'groups.delete a selected group',
    (draw) => draw.groups.delete('g1'),
    (draw) => draw.selection.set('group', ['g1']),
  );
  writes(
    'groups.delete a locked group',
    (draw) => draw.groups.delete('g1'),
    (draw) => draw.groups.update('g1', { locked: true }),
  );
  writes('groups.delete a missing group', (draw) => draw.groups.delete('none'));
  writes(
    'groups.deleteMany',
    (draw) => draw.groups.deleteMany(['g1', 'g2']),
    (draw) => draw.groups.create({ id: 'g2', featureIds: ['pt', 'ln'] }),
  );
  writes('groups.move to another layer', (draw) => draw.groups.move('g1', { layerId: 'lb' }));
  writes('groups.move in its layer to index 0', (draw) =>
    draw.groups.move('g1', { layerId: 'la', index: 0 }),
  );
  writes('groups.move to a locked layer', (draw) => draw.groups.move('g1', { layerId: 'lc' }));
  writes(
    'groups.move into a group',
    (draw) => draw.groups.move('g1', { groupId: 'g2' }),
    (draw) => draw.groups.create({ id: 'g2', featureIds: ['pt'] }),
  );
  writes(
    'groups.moveMany to another layer',
    (draw) => draw.groups.moveMany(['g1', 'g2'], { layerId: 'lb', index: 0 }),
    (draw) => draw.groups.create({ id: 'g2', featureIds: ['pt'] }),
  );
  writes(
    'groups.move in read-only',
    (draw) => draw.groups.move('g1', { layerId: 'lb' }),
    (draw) => draw.setReadOnly(true),
  );
});

describe('metadata.update', () => {
  writes('metadata.update the title', (draw) => draw.metadata.update({ title: 'New' }));
  writes('metadata.update the description', (draw) =>
    draw.metadata.update({ description: 'About' }),
  );
  writes('metadata.update to the same value', (draw) =>
    draw.metadata.update({ title: 'The document' }),
  );
  writes('metadata.update the title to undefined', (draw) =>
    draw.metadata.update({ title: undefined }),
  );
  writes(
    'metadata.update in read-only',
    (draw) => draw.metadata.update({ title: 'x' }),
    (draw) => draw.setReadOnly(true),
  );
});

describe('draw.transact', () => {
  writes('transact of three writes', (draw) =>
    draw.transact(() => {
      draw.features.create(point(1, 1));
      draw.features.update('pt', { properties: { n: 9 } });
      draw.layers.update('lb', { name: 'B2' });
    }),
  );
  writes('transact with a source', (draw) =>
    draw.transact(() => draw.features.update('pt', { properties: { n: 9 } }), { source: 'import' }),
  );
  writes('transact with the source remote', (draw) =>
    draw.transact(() => draw.features.delete('pt'), { source: 'remote' }),
  );
  writes('transact with ignoreLocks on a locked feature', (draw) =>
    draw.transact(() => draw.features.update('lck', { properties: { n: 9 } }), {
      ignoreLocks: true,
    }),
  );
  writes('transact with ignoreLocks on a feature of a locked layer', (draw) =>
    draw.transact(() => draw.features.delete('pc'), { ignoreLocks: true }),
  );
  writes('transact that throws after a write', (draw) =>
    draw.transact(() => {
      draw.features.update('pt', { properties: { n: 9 } });
      throw new Error('stop');
    }),
  );
  writes('transact inside transact', (draw) =>
    draw.transact(
      () => {
        draw.features.update('pt', { properties: { n: 9 } });
        draw.transact(() => draw.features.update('ln', { properties: { n: 9 } }), {
          source: 'import',
        });
      },
      { source: 'batch' },
    ),
  );
  writes('transact returns the value of its function', (draw) => draw.transact(() => 42));
  writes(
    'transact in read-only',
    (draw) => draw.transact(() => draw.features.update('pt', { properties: { n: 9 } })),
    (draw) => draw.setReadOnly(true),
  );
  writes(
    'a write under the interaction lock',
    (draw) => draw.features.update('pt', { properties: { n: 9 } }),
    (draw) => draw.setInteractionLocked(true),
  );
});

table.end();
