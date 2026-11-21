// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for group / layer deletion in handleDeleteShortcut
 *
 * The Delete key deletes a feature / group / layer according to the selection type.
 * For a group, the contents are deleted and the emptied group is deleted automatically; for a
 * layer, everything under it is deleted and at least one layer is kept. The spatial index of
 * the Store finds what is left.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { type BulkEdits, createBulkEdits } from '../../api/impl/bulk-edits.js';
import { createDocumentAccess } from '../../api/impl/document-access.js';
import { startSelectionDeletion } from '../../operations/bulk-deletion.js';
import { groupSelection } from '../../operations/layer-operations.js';
import { deleteSelection } from '../../operations/selection-operations.js';
import { coordinatesOf } from '../../shared/utils/coordinates.js';
import { AutoNameGenerator } from '../../shared/utils/name-generator.js';
import { createStore } from '../../store/built-in/create-store.js';
import type { DocumentAccess, InstanceDocument } from '../../store/document-access.js';
import { StoreSpatialIndex } from '../../store/spatial/store-spatial-index.js';
import type { Feature } from '../../store/types.js';
import { createTestDocument } from '../../test-utils.js';
import type { EngineModeContext } from '../handler.js';
import { handleDeleteShortcut, handleGroupShortcut } from './shortcut-handler.js';

/** Records the ids the Store reported as deleted (the spatial index drops exactly those) */
class DeletionLog {
  removed: string[] = [];
  constructor(store: DocumentAccess) {
    store.subscribe((changes) => {
      for (const deleted of changes.features?.deleted ?? []) this.removed.push(deleted.id);
    });
  }
}

function feature(id: string, layerId: string): Feature {
  return {
    groupId: undefined,
    id,
    type: 'Point',
    geometry: { type: 'Point', coordinates: [0, 0] },
    layerId,
    properties: {},
    locked: false,
    visible: true,
    style: {},
  };
}

let store: InstanceDocument;
let edits: BulkEdits;
let spatial: DeletionLog;
let index: StoreSpatialIndex;
let context: EngineModeContext;

/** The layer an instance makes over a built-in Store, with the bulk edits of the instance */
function documentWithEdits(): { store: InstanceDocument; edits: BulkEdits } {
  const rows = createStore();
  const layer = createDocumentAccess(rows);
  return { store: layer, edits: createBulkEdits(layer, rows) };
}

beforeEach(() => {
  // The layer an instance makes over the built-in Store
  ({ store, edits } = documentWithEdits());
  spatial = new DeletionLog(store);
  index = new StoreSpatialIndex(store);
  context = { store, spatialIndex: index, bulkEdits: edits } as unknown as EngineModeContext;
});

/** Presses the Delete key, and waits for the deletion it starts (written in parts) */
async function pressDelete(): Promise<void> {
  handleDeleteShortcut(context);
  await edits.waitForWrites();
}

describe('handleDeleteShortcut with a group selection', () => {
  it('Delete on a group selection deletes its contents and the emptied group', async () => {
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
    store.createFeature(feature('f1', 'l1'));
    store.createFeature(feature('f2', 'l1'));
    store.createGroup({
      id: 'g1',
      layerId: 'l1',
      name: 'g',
      featureIds: ['f1', 'f2'],
      locked: false,
      visible: true,
    });

    store.setSelection('group', ['g1']);
    await pressDelete();

    expect(store.getFeature('f1')).toBeUndefined();
    expect(store.getFeature('f2')).toBeUndefined();
    expect(store.getGroup('g1')).toBeUndefined();
    expect(spatial.removed).toEqual(expect.arrayContaining(['f1', 'f2']));
    expect(index.findNear([0, 0], 0)).toEqual([]);
  });
});

describe('handleDeleteShortcut with a layer selection', () => {
  it('Delete on a layer selection deletes everything under it and cleans the index', async () => {
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
    store.createLayer({
      id: 'l2',
      name: 'l2',
      visible: true,
      locked: false,
      opacity: 1,
      items: [],
      styleRule: undefined,
      metadata: undefined,
    });
    store.createFeature(feature('f1', 'l1'));
    store.createFeature(feature('f2', 'l1'));

    store.setSelection('layer', ['l1']);
    await pressDelete();

    expect(store.getLayer('l1')).toBeUndefined();
    expect(store.getFeature('f1')).toBeUndefined();
    expect(store.getFeature('f2')).toBeUndefined();
    expect(spatial.removed).toEqual(expect.arrayContaining(['f1', 'f2']));
    expect(index.findNear([0, 0], 0)).toEqual([]);
  });

  it('the last remaining layer is not deleted', async () => {
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

    store.setSelection('layer', ['l1']);
    await pressDelete();

    expect(store.getLayer('l1')).toBeDefined();
  });
});

describe('suppression of handleDeleteShortcut (interaction lock / readOnly)', () => {
  function setupTwoLayersWithFeatures(): void {
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
    store.createLayer({
      id: 'l2',
      name: 'l2',
      visible: true,
      locked: false,
      opacity: 1,
      items: [],
      styleRule: undefined,
      metadata: undefined,
    });
    store.createFeature(feature('f1', 'l1'));
    store.createFeature(feature('f2', 'l1'));
  }

  it('nothing is deleted while the interaction lock is on (the index keeps them)', async () => {
    setupTwoLayersWithFeatures();
    store.setSelection('feature', ['f1', 'f2']);
    store.setInteractionLock(true);

    await pressDelete();

    expect(store.getFeature('f1')).toBeDefined();
    expect(store.getFeature('f2')).toBeDefined();
    expect(spatial.removed).toEqual([]);
  });

  it('nothing is deleted while readOnly (the index keeps them)', async () => {
    setupTwoLayersWithFeatures();
    store.setSelection('feature', ['f1', 'f2']);
    store.setReadOnly(true);

    await pressDelete();

    expect(store.getFeature('f1')).toBeDefined();
    expect(store.getFeature('f2')).toBeDefined();
    // The index follows the Store, which kept both features
    expect(spatial.removed).toEqual([]);
    expect(index.findNear([0, 0], 0).sort()).toEqual(['f1', 'f2']);
  });

  it('deleting a layer selection is suppressed while the interaction lock is on too', async () => {
    setupTwoLayersWithFeatures();
    store.setSelection('layer', ['l1']);
    store.setInteractionLock(true);

    await pressDelete();

    expect(store.getLayer('l1')).toBeDefined();
    expect(spatial.removed).toEqual([]);
  });
});

describe('handleDeleteShortcut never removes a locked feature', () => {
  beforeEach(() => {
    for (const id of ['l1', 'l2']) {
      store.createLayer({
        id,
        name: id,
        visible: true,
        locked: false,
        opacity: 1,
        items: [],
        styleRule: undefined,
        metadata: undefined,
      });
    }
  });

  it('a group loses only its unlocked members and stays with the locked one', async () => {
    store.createFeature(feature('f1', 'l1'));
    store.createFeature({ ...feature('f2', 'l1'), locked: true });
    store.createGroup({
      id: 'g1',
      layerId: 'l1',
      name: 'g',
      featureIds: ['f1', 'f2'],
      locked: false,
      visible: true,
    });

    store.setSelection('group', ['g1']);
    await pressDelete();

    expect(store.getFeature('f1')).toBeUndefined();
    expect(store.getFeature('f2')).toBeDefined();
    expect(store.getGroup('g1')?.featureIds).toEqual(['f2']);
  });

  it('a layer holding a locked feature or a locked group is not deleted', async () => {
    store.createFeature({ ...feature('f1', 'l1'), locked: true });
    store.createFeature(feature('f2', 'l2'));
    store.createGroup({
      id: 'g2',
      layerId: 'l1',
      name: 'g',
      featureIds: ['f2'],
      locked: true,
      visible: true,
    });

    store.setSelection('layer', ['l1']);
    await pressDelete();
    store.setSelection('layer', ['l2']);
    await pressDelete();

    expect(store.getLayer('l1')).toBeDefined();
    expect(store.getFeature('f1')).toBeDefined();
    expect(store.getLayer('l2')).toBeDefined();
    expect(store.getFeature('f2')).toBeDefined();
  });
});

describe('deleteSelection runs the same deletion as the Delete key', () => {
  /** Builds a store, selects, runs the deletion and returns the state and the notifications */
  async function run(
    deleteWith: (s: InstanceDocument, e: BulkEdits) => Promise<boolean | undefined>,
  ) {
    const { store: s, edits: e } = documentWithEdits();
    for (const id of ['l1', 'l2']) {
      s.createLayer({
        id,
        name: id,
        visible: true,
        locked: false,
        opacity: 1,
        items: [],
        styleRule: undefined,
        metadata: undefined,
      });
    }
    s.createFeature(feature('f1', 'l1'));
    s.createFeature({ ...feature('f2', 'l1'), locked: true });
    s.createFeature(feature('f3', 'l2'));
    s.setSelection('feature', ['f1', 'f2', 'f3']);
    let notifications = 0;
    s.subscribe((changes) => {
      if (changes.features) notifications++;
    });
    const result = await deleteWith(s, e);
    return {
      result,
      notifications,
      features: s
        .listFeatures()
        .map((f) => f.id)
        .sort(),
      selection: s.getSelection().ids,
    };
  }

  it('deletes the unlocked features in one change and returns true', async () => {
    const viaApi = await run(async (_s, e) => (await startSelectionDeletion(e)) !== null);
    const viaKey = await run(async (s, e) => {
      handleDeleteShortcut({ store: s, bulkEdits: e } as unknown as EngineModeContext);
      await e.waitForWrites();
      return undefined;
    });

    expect(viaApi.result).toBe(true);
    expect(viaApi.features).toEqual(['f2']);
    // One transaction: one notification, so one step for a subscriber that records changes
    expect(viaApi.notifications).toBe(1);
    expect(viaApi.selection).toEqual([]);
    expect({ ...viaKey, result: true }).toEqual(viaApi);
  });

  it('deletes the selected vertices first, as one change', () => {
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
    store.createFeature({
      ...feature('line', 'l1'),
      type: 'LineString',
      geometry: {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 0],
          [2, 0],
        ],
      },
    });
    store.setSelection('feature', ['line']);
    store.setSelectedVertices({ featureId: 'line', vertices: [{ ring: 0, index: 1 }] });

    deleteSelection(edits);
    expect(coordinatesOf(store.getFeature('line'))).toEqual([
      [0, 0],
      [2, 0],
    ]);
    expect(store.getVertexSelection()).toBeNull();
  });

  it('returns false and deletes nothing while read-only, locked or with nothing to delete', async () => {
    const deleted = async (): Promise<boolean> => (await startSelectionDeletion(edits)) !== null;
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
    store.createFeature(feature('f1', 'l1'));
    store.createFeature({ ...feature('f2', 'l1'), locked: true });

    expect(await deleted()).toBe(false);

    store.setSelection('feature', ['f2']);
    expect(await deleted()).toBe(false);

    store.setSelection('feature', ['f1']);
    store.setReadOnly(true);
    expect(await deleted()).toBe(false);
    store.setReadOnly(false);
    store.setInteractionLock(true);
    expect(await deleted()).toBe(false);
    expect(store.getFeature('f1')).toBeDefined();

    // The last layer is kept, so deleting it deletes nothing
    store.setInteractionLock(false);
    store.setSelection('layer', ['l1']);
    expect(await deleted()).toBe(false);
    expect(store.getLayer('l1')).toBeDefined();
  });
});

describe('the group shortcut places the group where groupSelection does', () => {
  function build(): InstanceDocument {
    const s = createTestDocument();
    s.createLayer({
      id: 'l1',
      name: 'l1',
      visible: true,
      locked: false,
      opacity: 1,
      items: [],
      styleRule: undefined,
      metadata: undefined,
    });
    for (const id of ['a', 'b', 'c', 'd']) s.createFeature(feature(id, 'l1'));
    s.setSelection('feature', ['a', 'c']);
    return s;
  }

  it('leaves the same layer order for the key and the API', () => {
    const viaKey = build();
    handleGroupShortcut({
      store: viaKey,
      autoNameGenerator: new AutoNameGenerator(viaKey),
      generateFeatureId: () => 'g',
    } as unknown as EngineModeContext);

    const viaApi = build();
    groupSelection(viaApi, () => 'g', new AutoNameGenerator(viaApi));

    expect(viaKey.getLayer('l1')?.items).toEqual(viaApi.getLayer('l1')?.items);
    expect(viaKey.getGroup('g')?.featureIds).toEqual(viaApi.getGroup('g')?.featureIds);
  });
});
