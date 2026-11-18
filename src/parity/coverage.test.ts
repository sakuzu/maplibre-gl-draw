// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The table has no missing rows: every method of the public resources of the published version,
 * every event of `DrawEvents` and every member of the public `Store` of its main entry is used
 * by at least one row
 *
 * What a row uses was noted while it was recorded (the `uses` of its scene in the records): the
 * methods the scene called on the resources of the instance and on a Store, and the optional
 * members of a Store of the application the instance called. An event is used by a row that
 * read it (the `order` of the events of a scene). The lists below are those of the published
 * version, written out by hand, so that a later change of the declarations does not shorten
 * them.
 */

import { describe, expect, it } from 'vitest';
import { PARITY_AXES, readParityRecords } from '../test-utils.js';

/** The methods of the public resources of the published version, by interface */
const METHODS: Readonly<Record<string, readonly string[]>> = {
  FeaturesCollection: [
    'get',
    'getMany',
    'list',
    'count',
    'has',
    'isEditable',
    'create',
    'createMany',
    'update',
    'updateMany',
    'delete',
    'deleteMany',
    'move',
    'moveMany',
    'getAppliedStyle',
    'union',
    'difference',
    'intersection',
    'split',
    'buffer',
  ],
  LayersCollection: [
    'get',
    'getMany',
    'list',
    'count',
    'has',
    'create',
    'createMany',
    'update',
    'updateMany',
    'delete',
    'deleteMany',
    'reorder',
    'getOrder',
    'getActive',
    'setActive',
  ],
  GroupsCollection: [
    'get',
    'getMany',
    'list',
    'count',
    'has',
    'create',
    'createMany',
    'update',
    'updateMany',
    'delete',
    'deleteMany',
    'move',
    'moveMany',
  ],
  SelectionResource: [
    'get',
    'set',
    'add',
    'remove',
    'clear',
    'features',
    'delete',
    'group',
    'ungroup',
    'move',
  ],
  VertexSelectionResource: ['get', 'set', 'clear', 'delete'],
  HiddenCollection: [
    'get',
    'list',
    'count',
    'has',
    'add',
    'addMany',
    'remove',
    'removeMany',
    'clear',
  ],
  MetadataResource: ['get', 'update'],
  DocumentResource: ['load', 'loadMany', 'toJSON', 'toGeoJSON'],
  Store: [
    'getFeature',
    'listFeatures',
    'listFeaturesInOrder',
    'getLayer',
    'listLayers',
    'getLayerOrder',
    'getGroup',
    'listGroups',
    'getFile',
    'listFiles',
    'getMetadata',
    'getSelection',
    'getEditingIds',
    'getVertexSelection',
    'getMode',
    'isReadOnly',
    'isInteractionLocked',
    'isHidden',
    'listHidden',
    'subscribe',
    'transact',
    'createFeature',
    'updateFeature',
    'abortIntermediateUpdates',
    'deleteFeature',
    'createLayer',
    'updateLayer',
    'deleteLayer',
    'setLayerOrder',
    'reorderInLayer',
    'reorderInGroup',
    'createGroup',
    'updateGroup',
    'deleteGroup',
    'createFile',
    'deleteFile',
    'setMetadata',
    'setSelection',
    'startEditing',
    'endEditing',
    'setSelectedVertices',
    'setMode',
    'setReadOnly',
    'setInteractionLock',
    'setLocallyHidden',
    'getMaxNameNumber',
    'recordNameNumber',
  ],
};

/** The events of `DrawEvents` of the published version */
const EVENTS: readonly string[] = [
  'feature.created',
  'feature.updated',
  'feature.deleted',
  'feature.moved',
  'layer.created',
  'layer.updated',
  'layer.deleted',
  'layer.reordered',
  'group.created',
  'group.updated',
  'group.deleted',
  'metadata.updated',
  'document.changed',
  'document.loaded',
  'selection.changed',
  'vertexSelection.changed',
  'drag.started',
  'drag.ended',
  'mode.changed',
  'hidden.changed',
  'readOnly.changed',
  'interactionLock.changed',
  'options.changed',
  'snap.changed',
  'preview.changed',
  'map.clicked',
  'dataset.clicked',
  'dataset.added',
  'dataset.removed',
  'dataset.reordered',
  'image.requested',
  'layerStack.changed',
  'image.failed',
];

/** Every record of every axis */
const records = await Promise.all(
  PARITY_AXES.map(async (axis) => ({ axis, ...(await readParityRecords(axis)) })),
);

describe('the table has no missing rows', () => {
  it('every axis has its records', () => {
    for (const { axis, rows, scenes } of records) {
      expect(rows.size, `the rows of ${axis}`).toBeGreaterThan(0);
      expect(scenes.size, `the scenes of ${axis}`).toBeGreaterThan(0);
    }
  });

  const used = new Set<string>();
  for (const { scenes } of records)
    for (const uses of scenes.values()) for (const u of uses) used.add(u);
  for (const [resource, methods] of Object.entries(METHODS)) {
    it(`every method of ${resource} is used by a row`, () => {
      expect(methods.filter((m) => !used.has(`${resource}.${m}`))).toEqual([]);
    });
  }

  it('every event of DrawEvents is read by a row', () => {
    const read = new Set<string>();
    for (const { rows } of records) {
      for (const [row, value] of rows) {
        if (row.endsWith(' | order')) for (const name of value as string[]) read.add(name);
      }
    }
    expect(EVENTS.filter((name) => !read.has(name))).toEqual([]);
  });

  it('every row belongs to a scene of its axis', () => {
    for (const { axis, rows, scenes } of records) {
      const strays = [...rows.keys()].filter((row) => !scenes.has(row.split(' | ')[0]));
      expect(strays, `the rows of ${axis} without a scene`).toEqual([]);
    }
  });
});
