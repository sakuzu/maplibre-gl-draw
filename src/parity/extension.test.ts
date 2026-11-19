// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The table of what the instance does: what extensions use
 *
 * - A plugin reads the Store of its context (`ctx.store`) and subscribes to it
 * - An application that keeps the document elsewhere gives the instance its own Store (the
 *   `store` option) and writes the changes made outside the instance into it; the instance
 *   follows them. The Store also gives the instance the largest number of the automatic names
 *   it knows of, and is told when a drag that wrote in the middle is given up
 *
 * Everything is written with the public API: `createDraw` (through `createParityInstance`),
 * the `store` option, plugins and the events.
 */

import { describe } from 'vitest';
import type { Draw, Feature } from '../index.js';
import type { Store } from '../store/index.js';
import {
  type ApplicationStore,
  createApplicationStore,
  createParityInstance,
  fillParityDocument,
  observeParity,
  type ParityInstance,
  type ParityView,
  parityQuiet,
  parityStoreView,
  parityTable,
  readParity,
  readStoreChange,
  settleParity,
} from '../test-utils.js';

const table = parityTable('extension');

/** An instance with the document filled in, and the Store of the context of a plugin */
function withPlugin(app?: ApplicationStore): { t: ParityInstance; store: Store } {
  const t = createParityInstance({ initDefaultLayer: false, app });
  fillParityDocument(t);
  let store: Store | null = null;
  parityQuiet(() =>
    t.draw.extensions.plugins.add({
      name: 'store-probe',
      onAdd(ctx) {
        store = ctx.store;
      },
    }),
  );
  if (!store) throw new Error('the plugin was not added');
  return { t, store: parityStoreView(store) };
}

describe('what a plugin reads from the Store of its context', () => {
  const reads: [string, ParityView, ...unknown[]][] = [
    ['getFeature', 'store.getFeature', 'pt'],
    ['getFeature of a missing feature', 'store.getFeature', 'none'],
    ['listFeatures', 'store.listFeatures'],
    ['listFeaturesInOrder', 'store.listFeaturesInOrder'],
    ['getLayer', 'store.getLayer', 'lb'],
    ['listLayers', 'store.listLayers'],
    ['getLayerOrder', 'store.getLayerOrder'],
    ['getGroup', 'store.getGroup', 'g1'],
    ['listGroups', 'store.listGroups'],
    ['getFile', 'store.getFile', 'file-1'],
    ['listFiles', 'store.listFiles'],
    ['getMetadata', 'store.getMetadata'],
    ['getSelection', 'store.getSelection'],
    ['getEditingIds', 'store.getEditingIds'],
    ['getVertexSelection', 'store.getVertexSelection'],
    ['getMode', 'store.getMode'],
    ['isReadOnly', 'store.isReadOnly'],
    ['isInteractionLocked', 'store.isInteractionLocked'],
    ['isHidden', 'store.isHidden', 'loc'],
    ['isHidden of one not hidden', 'store.isHidden', 'pt'],
    ['listHidden', 'store.listHidden'],
  ];
  for (const [label, view, ...args] of reads) {
    table.scene(`ctx.store.${label}`, () => {
      const { t, store } = withPlugin();
      parityQuiet(() => {
        t.draw.selection.set('feature', ['ln']);
        t.draw.vertexSelection.set('ln', [{ ring: 0, index: 2 }]);
      });
      return { value: readParity(store, view, ...args) };
    });
  }
  table.scene('ctx.store.subscribe to a write and a selection', async () => {
    const { t, store } = withPlugin();
    const notified: unknown[] = [];
    settleParity();
    store.subscribe((change) => notified.push(readStoreChange(store, change)));
    const seen = await observeParity(t, () => {
      t.draw.features.update('pt', { properties: { n: 5 } });
      t.draw.selection.set('feature', ['pt']);
    });
    return { ...seen, storeChanges: readParity(notified, 'storeChanges') };
  });
  table.scene('ctx.store.subscribe, then unsubscribed', async () => {
    const { t, store } = withPlugin();
    const notified: unknown[] = [];
    settleParity();
    const stop = store.subscribe((change) => notified.push(readStoreChange(store, change)));
    stop();
    await observeParity(t, () => t.draw.features.delete('pt'));
    return { storeChanges: readParity(notified, 'storeChanges') };
  });
  table.scene('ctx.store.transact of two writes of the instance', async () => {
    const { t, store } = withPlugin();
    return observeParity(t, () =>
      store.transact(() => {
        t.draw.features.update('pt', { properties: { n: 5 } });
        t.draw.features.delete('ln');
      }, 'import'),
    );
  });
  table.scene('the Store of a plugin follows a change of the instance', async () => {
    const { t, store } = withPlugin();
    await observeParity(t, () => t.draw.features.move('pt', { layerId: 'lb', index: 0 }));
    return {
      feature: readParity(store, 'store.getFeature', 'pt'),
      inOrder: readParity(store, 'store.listFeaturesInOrder'),
    };
  });
});

/** A scene with a Store of the application: the document, then `setup`, then the write `act` */
function outside(
  name: string,
  act: (store: ApplicationStore['scene'], draw: Draw, t: ParityInstance) => unknown,
  setup?: (draw: Draw, t: ParityInstance, store: ApplicationStore['scene']) => void,
  options: { nameNumbers?: Record<string, number>; abort?: boolean } = {},
): void {
  table.scene(name, async () => {
    const app = createApplicationStore(options);
    const t = createParityInstance({ initDefaultLayer: false, app });
    fillParityDocument(t);
    if (setup) parityQuiet(() => setup(t.draw, t, app.scene));
    const notified: unknown[] = [];
    settleParity();
    app.scene.subscribe((change) => notified.push(readStoreChange(app.store, change)));
    app.calls.length = 0;
    const seen = await observeParity(t, () => act(app.scene, t.draw, t));
    return { ...seen, storeChanges: readParity(notified, 'storeChanges'), calls: [...app.calls] };
  });
}

const feature = (id: string, x: number, y: number, extra: Partial<Feature> = {}): Feature => ({
  id,
  type: 'Point',
  geometry: { type: 'Point', coordinates: [x, y] },
  layerId: 'la',
  groupId: undefined,
  properties: {},
  style: {},
  visible: true,
  locked: false,
  ...extra,
});

describe('the changes a Store of the application writes from outside the instance', () => {
  outside('createFeature outside a transaction', (store) =>
    store.createFeature(feature('x', 1, 1)),
  );
  outside('createFeature in a transaction from elsewhere', (store) =>
    store.transact(() => store.createFeature(feature('x', 1, 1)), 'remote'),
  );
  outside('createFeature of an ID in use', (store) =>
    store.transact(() => store.createFeature(feature('pt', 1, 1)), 'remote'),
  );
  outside(
    'updateFeature of a selected feature',
    (store) =>
      store.transact(
        () => store.updateFeature('pt', { geometry: { type: 'Point', coordinates: [-2.5, 2.5] } }),
        'remote',
      ),
    (draw) => draw.selection.set('feature', ['pt']),
  );
  outside(
    'updateFeature of a feature with selected vertices',
    (store) =>
      store.transact(
        () =>
          store.updateFeature('ln', {
            geometry: {
              type: 'LineString',
              coordinates: [
                [-2, 1.5],
                [-1, 1.5],
              ],
            },
          }),
        'remote',
      ),
    (draw) => {
      draw.selection.set('feature', ['ln']);
      draw.vertexSelection.set('ln', [{ ring: 0, index: 1 }]);
    },
  );
  outside(
    'updateFeature visible false of a selected feature',
    (store) => store.transact(() => store.updateFeature('pt', { visible: false }), 'remote'),
    (draw) => draw.selection.set('feature', ['pt', 'ln']),
  );
  outside('updateFeature in the middle of an edit', (store) =>
    store.transact(
      () => store.updateFeature('pt', { geometry: { type: 'Point', coordinates: [-2.9, 2] } }),
      'remote',
    ),
  );
  outside('updateFeature of a locked feature', (store) =>
    store.transact(() => store.updateFeature('lck', { properties: { a: 1 } }), 'remote'),
  );
  outside(
    'updateFeature in read-only',
    (store) => store.transact(() => store.updateFeature('pt', { properties: { a: 1 } }), 'remote'),
    (draw) => draw.setReadOnly(true),
  );
  outside(
    'updateFeature that takes the last feature out of its group',
    (store) => store.transact(() => store.updateFeature('gb', { groupId: undefined }), 'remote'),
    (draw) => draw.features.move('ga', { groupId: null }),
  );
  outside(
    'deleteFeature of a selected feature',
    (store) => store.transact(() => store.deleteFeature('pt'), 'remote'),
    (draw) => draw.selection.set('feature', ['pt', 'ln']),
  );
  outside('deleteFeature of a feature hidden by this client', (store) =>
    store.transact(() => store.deleteFeature('loc'), 'remote'),
  );
  outside(
    'deleteFeature of a feature being edited',
    (store) => store.transact(() => store.deleteFeature('pt'), 'remote'),
    (_draw, _t, store) => store.startEditing(['pt']),
  );
  outside(
    'deleteFeature of the last feature of a group',
    (store) =>
      store.transact(() => {
        store.deleteFeature('ga');
        store.deleteFeature('gb');
      }, 'remote'),
    (draw) => draw.selection.set('group', ['g1']),
  );
  outside('deleteFeature of a missing feature', (store) =>
    store.transact(() => store.deleteFeature('none'), 'remote'),
  );
  outside('createLayer', (store) =>
    store.transact(
      () =>
        store.createLayer({
          id: 'lx',
          name: 'X',
          visible: true,
          locked: false,
          opacity: 1,
          styleRule: undefined,
          metadata: undefined,
        }),
      'remote',
    ),
  );
  outside(
    'updateLayer visible false of a layer with a selection',
    (store) => store.transact(() => store.updateLayer('lb', { visible: false }), 'remote'),
    (draw) => draw.selection.set('feature', ['pb']),
  );
  outside(
    'deleteLayer of a selected layer',
    (store) => store.transact(() => store.deleteLayer('lb'), 'remote'),
    (draw) => draw.selection.set('layer', ['lb']),
  );
  outside('deleteLayer of the active layer', (store) =>
    store.transact(() => store.deleteLayer('la'), 'remote'),
  );
  outside('setLayerOrder', (store) =>
    store.transact(() => store.setLayerOrder(['ld', 'lc', 'lb', 'la']), 'remote'),
  );
  outside('reorderInLayer', (store) =>
    store.transact(() => store.reorderInLayer('pg', 'la', 0), 'remote'),
  );
  outside('reorderInGroup', (store) =>
    store.transact(() => store.reorderInGroup('gb', 'g1', 0), 'remote'),
  );
  outside('createGroup', (store) =>
    store.transact(() => {
      store.createGroup({
        id: 'gx',
        layerId: 'la',
        name: 'GX',
        featureIds: ['pt', 'ln'],
        visible: true,
        locked: false,
      });
    }, 'remote'),
  );
  outside(
    'updateGroup visible false of a selected group',
    (store) => store.transact(() => store.updateGroup('g1', { visible: false }), 'remote'),
    (draw) => draw.selection.set('group', ['g1']),
  );
  outside(
    'deleteGroup of a selected group',
    (store) => store.transact(() => store.deleteGroup('g1'), 'remote'),
    (draw) => draw.selection.set('group', ['g1']),
  );
  outside('createFile and deleteFile', (store) =>
    store.transact(() => {
      store.createFile({ id: 'fx', mimeType: 'image/png', dataURL: 'data:image/png;base64,AAAA' });
      store.createFile({ id: 'fy', mimeType: 'image/png', dataURL: 'data:image/png;base64,AAAA' });
      store.deleteFile('fy');
    }, 'remote'),
  );
  outside('setMetadata', (store) =>
    store.transact(() => store.setMetadata({ description: 'From elsewhere' }), 'remote'),
  );
  outside(
    'a transaction of several changes from elsewhere',
    (store) =>
      store.transact(() => {
        store.createFeature(feature('x', 1, 1));
        store.updateFeature('pt', { properties: { n: 7 } });
        store.deleteFeature('pb');
        store.setMetadata({ title: 'Elsewhere' });
      }, 'remote'),
    (draw) => draw.selection.set('feature', ['pb']),
  );
  outside(
    'a write of the instance after a change from elsewhere',
    (_store, draw) => draw.features.update('x', { properties: { n: 1 } }),
    (_draw, _t, store) => store.transact(() => store.createFeature(feature('x', 1, 1)), 'remote'),
  );
});

describe('the state of this client a Store of the application writes', () => {
  outside('setSelection', (store) => store.setSelection('feature', ['pt', 'ln']));
  outside(
    'setSelection of nothing',
    (store) => store.setSelection(null, []),
    (draw) => draw.selection.set('feature', ['pt']),
  );
  outside('startEditing and endEditing', (store) => {
    store.startEditing(['pt', 'ln']);
    store.endEditing(['ln']);
  });
  outside(
    'setSelectedVertices',
    (store) => store.setSelectedVertices({ featureId: 'ln', vertices: [{ ring: 0, index: 0 }] }),
    (draw) => draw.selection.set('feature', ['ln']),
  );
  outside('setMode', (store) => store.setMode('drawLine'));
  outside('setReadOnly', (store) => store.setReadOnly(true));
  outside('setInteractionLock', (store) => store.setInteractionLock(true));
  outside('setLocallyHidden', (store) => {
    store.setLocallyHidden('pt', true);
    store.setLocallyHidden('loc', false);
  });
});

describe('what the instance asks a Store of the application', () => {
  outside(
    'the automatic name of a point drawn, after the largest number the Store knows',
    (_store, _draw, t) => t.map.click([0.5, -0.5]),
    (draw) => draw.setMode('drawPoint'),
    { nameNumbers: { Point: 41 } },
  );
  outside(
    'the automatic name of a layer and a group',
    (_store, draw) => {
      draw.layers.create({});
      draw.groups.create({ featureIds: ['pt'] });
    },
    undefined,
    { nameNumbers: { Layer: 3, Group: 7 } },
  );
  outside(
    'a drag that wrote in the middle, given up with Escape',
    (_store, _draw, t) => {
      t.map.press([-3, 2]);
      t.map.pull([-2.8, 1.8]);
      t.map.pull([-2.5, 1.5]);
      t.map.key('Escape');
      t.map.release([-2.5, 1.5]);
    },
    (draw) => draw.selection.set('feature', ['pt']),
    { abort: true },
  );
  outside(
    'a drag that wrote in the middle, given up, with a Store without the call',
    (_store, _draw, t) => {
      t.map.press([-3, 2]);
      t.map.pull([-2.8, 1.8]);
      t.map.pull([-2.5, 1.5]);
      t.map.key('Escape');
      t.map.release([-2.5, 1.5]);
    },
    (draw) => draw.selection.set('feature', ['pt']),
  );
  outside(
    'a drag whose feature is deleted from elsewhere in the middle',
    (store, _draw, t) => {
      t.map.press([-3, 2]);
      t.map.pull([-2.8, 1.8]);
      store.transact(() => store.deleteFeature('pt'), 'remote');
      t.map.pull([-2.5, 1.5]);
      t.map.release([-2.5, 1.5]);
    },
    (draw) => draw.selection.set('feature', ['pt']),
    { abort: true },
  );
  outside('draw.transact with ignoreLocks over a Store of the application', (_store, draw) =>
    draw.transact(() => draw.features.update('lck', { properties: { n: 1 } }), {
      ignoreLocks: true,
      source: 'import',
    }),
  );
});

table.end();
