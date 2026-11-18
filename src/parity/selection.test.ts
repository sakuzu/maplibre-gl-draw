// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The table of what the instance does: the selection and the selected vertices
 *
 * Each scene builds the document of `fillParityDocument`, sets up a selection (not observed),
 * then calls one method of `draw.selection` or `draw.vertexSelection`, or makes a change that
 * takes something out of the selection, and reads what it returned, the document, the state
 * of this client and the events (`observeParity`).
 */

import { describe } from 'vitest';
import type { Draw } from '../index.js';
import {
  createParityInstance,
  fillParityDocument,
  observeParity,
  type ParityInstance,
  parityQuiet,
  parityTable,
  readParity,
} from '../test-utils.js';

const table = parityTable('selection');

function filled(): ParityInstance {
  const t = createParityInstance({ initDefaultLayer: false });
  fillParityDocument(t);
  return t;
}

/** A scene: the document, then `setup` (not observed), then `act` (observed) */
function scene(
  name: string,
  act: (draw: Draw) => unknown,
  setup?: (draw: Draw) => void,
  more?: (draw: Draw) => Record<string, unknown>,
): void {
  table.scene(name, async () => {
    const t = filled();
    if (setup) parityQuiet(() => setup(t.draw));
    const seen = await observeParity(t, () => act(t.draw));
    return more ? { ...seen, ...more(t.draw) } : seen;
  });
}

describe('selection.set, add, remove and clear', () => {
  for (const [label, ids] of [
    ['two features', ['pt', 'ln']],
    ['a hidden feature', ['pt', 'hid']],
    ['a feature hidden by this client', ['pt', 'loc']],
    ['a feature of a hidden layer', ['pt', 'pd']],
    ['a locked feature', ['pt', 'lck']],
    ['a feature of a locked layer', ['pt', 'pc']],
    ['a grouped feature', ['ga']],
    ['a missing feature', ['pt', 'none']],
    ['a group ID', ['g1']],
    ['the same feature twice', ['pt', 'pt']],
    ['no features', []],
  ] as const) {
    scene(`selection.set feature of ${label}`, (draw) => draw.selection.set('feature', ids));
  }
  scene('selection.set group', (draw) => draw.selection.set('group', ['g1']));
  scene('selection.set group of a feature ID', (draw) => draw.selection.set('group', ['pt']));
  scene('selection.set layer', (draw) => draw.selection.set('layer', ['lb']));
  scene('selection.set layer of a hidden layer', (draw) => draw.selection.set('layer', ['ld']));
  scene('selection.set layer of a locked layer', (draw) => draw.selection.set('layer', ['lc']));
  scene('selection.set layer of a missing layer', (draw) => draw.selection.set('layer', ['none']));
  scene(
    'selection.set the same selection again',
    (draw) => draw.selection.set('feature', ['pt']),
    (draw) => draw.selection.set('feature', ['pt']),
  );
  scene(
    'selection.set in read-only',
    (draw) => draw.selection.set('feature', ['pt']),
    (draw) => draw.setReadOnly(true),
  );
  scene(
    'selection.set over a selection of a group',
    (draw) => draw.selection.set('feature', ['pt']),
    (draw) => draw.selection.set('group', ['g1']),
  );
  scene(
    'selection.add to features',
    (draw) => draw.selection.add(['ln', 'pg']),
    (draw) => draw.selection.set('feature', ['pt']),
  );
  scene('selection.add to nothing', (draw) => draw.selection.add(['ln']));
  scene(
    'selection.add a selected feature',
    (draw) => draw.selection.add(['pt']),
    (draw) => draw.selection.set('feature', ['pt']),
  );
  scene(
    'selection.add a hidden feature',
    (draw) => draw.selection.add(['hid']),
    (draw) => draw.selection.set('feature', ['pt']),
  );
  scene(
    'selection.add to a selection of a group',
    (draw) => draw.selection.add(['pt']),
    (draw) => draw.selection.set('group', ['g1']),
  );
  scene(
    'selection.add to a selection of a layer',
    (draw) => draw.selection.add(['la']),
    (draw) => draw.selection.set('layer', ['lb']),
  );
  scene(
    'selection.remove one of two',
    (draw) => draw.selection.remove(['pt']),
    (draw) => draw.selection.set('feature', ['pt', 'ln']),
  );
  scene(
    'selection.remove the last one',
    (draw) => draw.selection.remove(['pt']),
    (draw) => draw.selection.set('feature', ['pt']),
  );
  scene(
    'selection.remove one not selected',
    (draw) => draw.selection.remove(['ln']),
    (draw) => draw.selection.set('feature', ['pt']),
  );
  scene(
    'selection.clear',
    (draw) => draw.selection.clear(),
    (draw) => draw.selection.set('feature', ['pt', 'ln']),
  );
  scene('selection.clear of nothing', (draw) => draw.selection.clear());
});

describe('selection.get and features', () => {
  for (const [label, type, ids] of [
    ['features', 'feature', ['ln', 'pt']],
    ['a group', 'group', ['g1']],
    ['a layer', 'layer', ['lb']],
    ['nothing', 'feature', []],
  ] as const) {
    table.scene(`selection.get of ${label}`, () => {
      const t = filled();
      parityQuiet(() => t.draw.selection.set(type, ids));
      return {
        get: readParity(t.draw, 'selection.get'),
        features: readParity(t.draw, 'selection.features'),
      };
    });
  }
});

describe('selection.delete, group, ungroup and move', () => {
  scene(
    'selection.delete of features',
    (draw) => draw.selection.delete(),
    (draw) => draw.selection.set('feature', ['pt', 'ln']),
  );
  scene(
    'selection.delete with a locked feature',
    (draw) => draw.selection.delete(),
    (draw) => draw.selection.set('feature', ['pt', 'lck']),
  );
  scene(
    'selection.delete of a group',
    (draw) => draw.selection.delete(),
    (draw) => draw.selection.set('group', ['g1']),
  );
  scene(
    'selection.delete of a layer',
    (draw) => draw.selection.delete(),
    (draw) => draw.selection.set('layer', ['lb']),
  );
  scene('selection.delete of nothing', (draw) => draw.selection.delete());
  scene(
    'selection.delete in read-only',
    (draw) => draw.selection.delete(),
    (draw) => {
      draw.selection.set('feature', ['pt']);
      draw.setReadOnly(true);
    },
  );
  scene(
    'selection.group of two features',
    (draw) => draw.selection.group(),
    (draw) => draw.selection.set('feature', ['pt', 'ln']),
  );
  scene(
    'selection.group of features of two layers',
    (draw) => draw.selection.group(),
    (draw) => draw.selection.set('feature', ['pt', 'pb']),
  );
  scene(
    'selection.group with a grouped feature',
    (draw) => draw.selection.group(),
    (draw) => draw.selection.set('feature', ['pt', 'ga']),
  );
  scene(
    'selection.group of one feature',
    (draw) => draw.selection.group(),
    (draw) => draw.selection.set('feature', ['pt']),
  );
  scene('selection.group of nothing', (draw) => draw.selection.group());
  scene(
    'selection.ungroup of a group',
    (draw) => draw.selection.ungroup(),
    (draw) => draw.selection.set('group', ['g1']),
  );
  scene(
    'selection.ungroup of a grouped feature',
    (draw) => draw.selection.ungroup(),
    (draw) => draw.selection.set('feature', ['ga']),
  );
  scene(
    'selection.ungroup of a feature not grouped',
    (draw) => draw.selection.ungroup(),
    (draw) => draw.selection.set('feature', ['pt']),
  );
  scene(
    'selection.move of features to another layer',
    (draw) => draw.selection.move({ layerId: 'lb' }),
    (draw) => draw.selection.set('feature', ['pt', 'ln']),
  );
  scene(
    'selection.move of features into a group',
    (draw) => draw.selection.move({ groupId: 'g1', index: 0 }),
    (draw) => draw.selection.set('feature', ['pt', 'ln']),
  );
  scene(
    'selection.move of a group to another layer',
    (draw) => draw.selection.move({ layerId: 'lb', index: 0 }),
    (draw) => draw.selection.set('group', ['g1']),
  );
  scene('selection.move of nothing', (draw) => draw.selection.move({ layerId: 'lb' }));
  scene(
    'selection.move with a locked feature',
    (draw) => draw.selection.move({ layerId: 'lb' }),
    (draw) => draw.selection.set('feature', ['pt', 'lck']),
  );
});

describe('the selected vertices', () => {
  scene(
    'vertexSelection.set of a selected line',
    (draw) => draw.vertexSelection.set('ln', [{ ring: 0, index: 1 }]),
    (draw) => draw.selection.set('feature', ['ln']),
  );
  scene('vertexSelection.set of a feature not selected', (draw) =>
    draw.vertexSelection.set('ln', [{ ring: 0, index: 1 }]),
  );
  scene(
    'vertexSelection.set of a polygon with a hole',
    (draw) =>
      draw.vertexSelection.set('hole', [
        { ring: 1, index: 0 },
        { ring: 0, index: 2 },
      ]),
    (draw) => draw.selection.set('feature', ['hole']),
  );
  scene(
    'vertexSelection.set of a multi polygon',
    (draw) => draw.vertexSelection.set('mpg', [{ part: 1, ring: 0, index: 2 }]),
    (draw) => draw.selection.set('feature', ['mpg']),
  );
  scene(
    'vertexSelection.set of a vertex that is not there',
    (draw) => draw.vertexSelection.set('ln', [{ ring: 0, index: 9 }]),
    (draw) => draw.selection.set('feature', ['ln']),
  );
  scene(
    'vertexSelection.set of a point',
    (draw) => draw.vertexSelection.set('pt', [{ ring: 0, index: 0 }]),
    (draw) => draw.selection.set('feature', ['pt']),
  );
  scene(
    'vertexSelection.set of no vertices',
    (draw) => draw.vertexSelection.set('ln', []),
    (draw) => {
      draw.selection.set('feature', ['ln']);
      draw.vertexSelection.set('ln', [{ ring: 0, index: 1 }]);
    },
  );
  scene(
    'vertexSelection.clear',
    (draw) => draw.vertexSelection.clear(),
    (draw) => {
      draw.selection.set('feature', ['ln']);
      draw.vertexSelection.set('ln', [{ ring: 0, index: 1 }]);
    },
  );
  scene(
    'vertexSelection.delete of a vertex of a line',
    (draw) => draw.vertexSelection.delete(),
    (draw) => {
      draw.selection.set('feature', ['ln']);
      draw.vertexSelection.set('ln', [{ ring: 0, index: 1 }]);
    },
  );
  scene(
    'vertexSelection.delete that would leave a line of one vertex',
    (draw) => draw.vertexSelection.delete(),
    (draw) => {
      draw.selection.set('feature', ['ln']);
      draw.vertexSelection.set('ln', [
        { ring: 0, index: 0 },
        { ring: 0, index: 1 },
      ]);
    },
  );
  scene(
    'vertexSelection.delete of a vertex of a polygon',
    (draw) => draw.vertexSelection.delete(),
    (draw) => {
      draw.selection.set('feature', ['hole']);
      draw.vertexSelection.set('hole', [{ ring: 0, index: 1 }]);
    },
  );
  scene('vertexSelection.delete of nothing', (draw) => draw.vertexSelection.delete());
  scene(
    'vertexSelection.delete in read-only',
    (draw) => draw.vertexSelection.delete(),
    (draw) => {
      draw.selection.set('feature', ['ln']);
      draw.vertexSelection.set('ln', [{ ring: 0, index: 1 }]);
      draw.setReadOnly(true);
    },
  );
  scene(
    'vertexSelection.get after selection.clear',
    (draw) => draw.selection.clear(),
    (draw) => {
      draw.selection.set('feature', ['ln']);
      draw.vertexSelection.set('ln', [{ ring: 0, index: 1 }]);
    },
    (draw) => ({ vertices: readParity(draw, 'vertexSelection.get') }),
  );
});

describe('what leaves the selection', () => {
  scene(
    'hidden.add of a selected feature',
    (draw) => draw.hidden.add('pt'),
    (draw) => draw.selection.set('feature', ['pt', 'ln']),
  );
  scene(
    'hidden.addMany of a selected group member',
    (draw) => draw.hidden.addMany(['ga']),
    (draw) => draw.selection.set('group', ['g1']),
  );
  scene(
    'groups.update visible false of a selected group',
    (draw) => draw.groups.update('g1', { visible: false }),
    (draw) => draw.selection.set('group', ['g1']),
  );
  scene(
    'layers.update visible false of a selected layer',
    (draw) => draw.layers.update('lb', { visible: false }),
    (draw) => draw.selection.set('layer', ['lb']),
  );
  scene(
    'layers.delete of a selected layer',
    (draw) => draw.layers.delete('lb'),
    (draw) => draw.selection.set('layer', ['lb', 'la']),
  );
  scene(
    'features.delete of a selected feature with selected vertices',
    (draw) => draw.features.delete('ln'),
    (draw) => {
      draw.selection.set('feature', ['ln', 'pt']);
      draw.vertexSelection.set('ln', [{ ring: 0, index: 1 }]);
    },
  );
  scene(
    'features.update locked true of a selected feature',
    (draw) => draw.features.update('pt', { locked: true }),
    (draw) => draw.selection.set('feature', ['pt']),
  );
  scene(
    'document.load replace with a selection',
    (draw) => draw.document.load({ type: 'Point', coordinates: [0, 0] }, { mode: 'replace' }),
    (draw) => draw.selection.set('feature', ['pt']),
  );
});

table.end();
