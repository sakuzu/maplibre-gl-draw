// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The table of what the instance does: the reads
 *
 * Each scene builds the document of `fillParityDocument` and reads one public member with one
 * set of arguments. See `parityTable` in src/test-utils.ts for how the rows are recorded and
 * compared.
 */

import { describe } from 'vitest';
import {
  createParityInstance,
  fillParityDocument,
  type ParityInstance,
  type ParityView,
  parityTable,
  readParity,
} from '../test-utils.js';

const table = parityTable('reads');

/** The instance of a scene with the document filled in */
function filled(): ParityInstance {
  const t = createParityInstance({ initDefaultLayer: false });
  fillParityDocument(t);
  return t;
}

/** A scene that reads one view with its arguments */
function reads(name: string, view: ParityView, ...args: unknown[]): void {
  table.scene(name, () => ({ value: readParity(filled().draw, view, ...args) }));
}

const IDS = ['pt', 'ln', 'pg', 'hole', 'mpt', 'mln', 'mpg', 'cir', 'fh', 'img', 'hid', 'lck'];

describe('the reads of the features', () => {
  for (const id of [...IDS, 'ga', 'pb', 'pc', 'pd', 'loc', 'none']) {
    reads(`features.get ${id}`, 'features.get', id);
  }
  reads('features.getMany with a missing ID', 'features.getMany', ['pt', 'none', 'ga']);
  reads('features.getMany of none', 'features.getMany', []);
  reads('features.list of everything', 'features.list');
  for (const [label, filter] of [
    ['layerId la', { layerId: 'la' }],
    ['layerId lb', { layerId: 'lb' }],
    ['layerId of a hidden layer', { layerId: 'ld' }],
    ['layerId missing', { layerId: 'none' }],
    ['groupId g1', { groupId: 'g1' }],
    ['groupId missing', { groupId: 'none' }],
    ['type Point', { type: 'Point' }],
    ['type Polygon', { type: 'Polygon' }],
    ['type Circle', { type: 'Circle' }],
    ['visible true', { visible: true }],
    ['visible false', { visible: false }],
    ['shown true', { shown: true }],
    ['shown false', { shown: false }],
    ['locked true', { locked: true }],
    ['locked false', { locked: false }],
    ['bbox', { bbox: [-3.5, -0.5, 0.5, 2.2] }],
    ['bbox empty', { bbox: [10, 10, 11, 11] }],
    ['layerId and type', { layerId: 'la', type: 'Point' }],
    ['layerId and locked', { layerId: 'lc', locked: true }],
  ] as const) {
    reads(`features.list by ${label}`, 'features.list', filter);
    reads(`features.count by ${label}`, 'features.count', filter);
  }
  reads('features.count of everything', 'features.count');
  for (const id of ['pt', 'hid', 'none']) reads(`features.has ${id}`, 'features.has', id);
  for (const id of ['pt', 'lck', 'pc', 'pd', 'hid', 'loc', 'ga', 'none']) {
    reads(`features.isEditable ${id}`, 'features.isEditable', id);
  }
  for (const id of ['pt', 'ln', 'pg', 'img', 'pb', 'pb2', 'cir', 'none']) {
    reads(`features.getAppliedStyle ${id}`, 'features.getAppliedStyle', id);
  }
});

describe('the reads of the layers and the groups', () => {
  for (const id of ['la', 'lb', 'lc', 'ld', 'none']) reads(`layers.get ${id}`, 'layers.get', id);
  reads('layers.getMany with a missing ID', 'layers.getMany', ['lb', 'none', 'la']);
  reads('layers.list of everything', 'layers.list');
  for (const [label, filter] of [
    ['visible true', { visible: true }],
    ['visible false', { visible: false }],
    ['locked true', { locked: true }],
    ['locked false', { locked: false }],
  ] as const) {
    reads(`layers.list by ${label}`, 'layers.list', filter);
    reads(`layers.count by ${label}`, 'layers.count', filter);
  }
  reads('layers.count of everything', 'layers.count');
  for (const id of ['la', 'none']) reads(`layers.has ${id}`, 'layers.has', id);
  reads('layers.getOrder', 'layers.getOrder');
  reads('layers.getActive', 'layers.getActive');
  for (const id of ['g1', 'none']) reads(`groups.get ${id}`, 'groups.get', id);
  reads('groups.getMany with a missing ID', 'groups.getMany', ['none', 'g1']);
  reads('groups.list of everything', 'groups.list');
  for (const [label, filter] of [
    ['layerId la', { layerId: 'la' }],
    ['layerId lb', { layerId: 'lb' }],
    ['visible true', { visible: true }],
    ['locked true', { locked: true }],
  ] as const) {
    reads(`groups.list by ${label}`, 'groups.list', filter);
    reads(`groups.count by ${label}`, 'groups.count', filter);
  }
  reads('groups.count of everything', 'groups.count');
  for (const id of ['g1', 'none']) reads(`groups.has ${id}`, 'groups.has', id);
});

describe('the reads of the state of this client and of the document', () => {
  for (const id of ['loc', 'pt', 'none']) {
    reads(`hidden.get ${id}`, 'hidden.get', id);
    reads(`hidden.has ${id}`, 'hidden.has', id);
  }
  reads('hidden.list', 'hidden.list');
  reads('hidden.count', 'hidden.count');
  reads('metadata.get', 'metadata.get');
  reads('document.toJSON', 'document.toJSON');
  reads('document.toGeoJSON', 'document.toGeoJSON');
  reads('getMode', 'mode');
  reads('isReadOnly', 'readOnly');
  reads('isInteractionLocked', 'interactionLocked');
  reads('the document as the table reads it', 'document');
  reads('the state of this client as the table reads it', 'client');
  table.scene('the state of a new instance with a default layer', () => {
    const t = createParityInstance();
    return { document: readParity(t.draw, 'document'), client: readParity(t.draw, 'client') };
  });
});

describe('the lists over 10,000 items', () => {
  /** An instance with 10,001 points, the first 10,000 in groups of one */
  function many(): ParityInstance {
    const t = createParityInstance();
    const ids = Array.from({ length: 10_001 }, (_, i) => `m${i}`);
    t.draw.features.createMany(
      ids.map((id, i) => ({
        id,
        type: 'Point' as const,
        geometry: { type: 'Point' as const, coordinates: [(i % 100) / 50 - 1, i / 5_000 - 1] },
      })),
    );
    return t;
  }
  table.scene('features.list of 10,001 features', () => ({
    value: readParity(many().draw, 'features.listSize'),
  }));
  table.scene('selection.features of 10,001 features', () => {
    const t = many();
    t.draw.selection.set(
      'feature',
      Array.from({ length: 10_001 }, (_, i) => `m${i}`),
    );
    return { value: readParity(t.draw, 'selection.featuresSize') };
  });
  table.scene('groups.list of 10,001 groups', async () => {
    const t = createParityInstance({ initDefaultLayer: false });
    const ids = Array.from({ length: 10_001 }, (_, i) => i);
    await t.draw.document.load({
      version: '3.0.0',
      layerOrder: ['l'],
      layers: [
        {
          id: 'l',
          name: 'L',
          visible: true,
          locked: false,
          opacity: 1,
          items: ids.map((i) => `g${i}`),
          styleRule: undefined,
          metadata: undefined,
        },
      ],
      groups: ids.map((i) => ({
        id: `g${i}`,
        layerId: 'l',
        name: `G ${i}`,
        featureIds: [`m${i}`],
        visible: true,
        locked: false,
      })),
      features: ids.map((i) => ({
        id: `m${i}`,
        type: 'Point',
        geometry: { type: 'Point', coordinates: [(i % 100) / 50 - 1, i / 5_000 - 1] },
        layerId: 'l',
        groupId: `g${i}`,
        properties: {},
        style: {},
        visible: true,
        locked: false,
      })),
    });
    return { value: readParity(t.draw, 'groups.listSize') };
  });
});

table.end();
