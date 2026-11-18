// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The table of what the instance does: the state of this client
 *
 * The mode, read-only, the interaction lock, what this client hides, and the features being
 * edited (marked by a Store of the application with `startEditing`, and announced to the
 * plugins with `interaction.onDrawCommit` when the select mode is entered). Each scene builds
 * the document of `fillParityDocument`, changes the state, and reads what `observeParity` reads.
 */

import { describe } from 'vitest';
import type { Draw, Feature } from '../index.js';
import {
  createApplicationStore,
  createParityInstance,
  fillParityDocument,
  observeParity,
  type ParityInstance,
  parityQuiet,
  parityTable,
} from '../test-utils.js';

const table = parityTable('client');

function filled(): ParityInstance {
  const t = createParityInstance({ initDefaultLayer: false });
  fillParityDocument(t);
  return t;
}

function scene(
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

describe('the mode', () => {
  for (const mode of [
    'drawPoint',
    'drawLine',
    'drawPolygon',
    'drawImage',
    'drawCircle',
    'drawFreehand',
    'select',
  ]) {
    scene(
      `setMode ${mode} from the select mode with a selection`,
      (draw) => draw.setMode(mode),
      (draw) => draw.selection.set('feature', ['pt']),
    );
  }
  scene('setMode of an unknown mode', (draw) => draw.setMode('nothing'));
  scene(
    'setMode select from a drawing in progress',
    (draw) => draw.setMode('select'),
    (draw, t) => {
      draw.setMode('drawLine');
      t.map.click([0.5, -0.5]);
      t.map.click([1, -1]);
    },
  );
  scene(
    'setMode of a drawing mode in read-only',
    (draw) => draw.setMode('drawLine'),
    (draw) => draw.setReadOnly(true),
  );
  scene(
    'setMode of a drawing mode under the interaction lock',
    (draw) => draw.setMode('drawLine'),
    (draw) => draw.setInteractionLocked(true),
  );
  scene(
    'a point drawn in the point mode',
    (_draw, t) => t.map.click([0.5, -0.5]),
    (draw) => draw.setMode('drawPoint'),
  );
  scene(
    'a line drawn and finished with Enter',
    (_draw, t) => {
      t.map.click([0.5, -0.5]);
      t.map.click([1, -1]);
      t.map.key('Enter');
    },
    (draw) => draw.setMode('drawLine'),
  );
  scene(
    'a line finished by a click on its last vertex',
    (_draw, t) => {
      t.map.click([0.5, -0.5]);
      t.map.click([1, -1]);
      t.map.click([1, -1]);
    },
    (draw) => draw.setMode('drawLine'),
  );
  scene(
    'a polygon drawn and finished on its first vertex',
    (_draw, t) => {
      t.map.click([0.5, -0.5]);
      t.map.click([1, -0.5]);
      t.map.click([1, -1]);
      t.map.click([0.5, -0.5]);
    },
    (draw) => draw.setMode('drawPolygon'),
  );
  scene(
    'a line drawing given up with Escape',
    (_draw, t) => {
      t.map.click([0.5, -0.5]);
      t.map.click([1, -1]);
      t.map.key('Escape');
    },
    (draw) => draw.setMode('drawLine'),
  );
  scene(
    'a vertex taken back with Backspace',
    (_draw, t) => {
      t.map.click([0.5, -0.5]);
      t.map.click([1, -1]);
      t.map.click([1.5, -1]);
      t.map.key('Backspace');
      t.map.key('Enter');
    },
    (draw) => draw.setMode('drawLine'),
  );
  scene(
    'a circle drawn with a drag',
    (_draw, t) => t.map.drag([0.5, -0.5], [0.8, -0.5]),
    (draw) => draw.setMode('drawCircle'),
  );
  scene(
    'a circle drawn with two clicks',
    (_draw, t) => {
      t.map.click([0.5, -0.5]);
      t.map.move([0.8, -0.5]);
      t.map.click([0.8, -0.5]);
    },
    (draw) => draw.setMode('drawCircle'),
  );
  scene(
    'a freehand line drawn with a drag',
    (_draw, t) => t.map.drag([0.5, -0.5], [1.5, -1], { steps: 6 }),
    (draw) => draw.setMode('drawFreehand'),
  );
  scene(
    'a drawing into a locked active layer',
    (_draw, t) => t.map.click([0.5, -0.5]),
    (draw) => {
      draw.layers.setActive('la');
      draw.layers.update('la', { locked: true });
      draw.setMode('drawPoint');
    },
  );
  scene(
    'Delete in the select mode with a selection',
    (_draw, t) => t.map.key('Delete'),
    (draw) => draw.selection.set('feature', ['pt', 'ln']),
  );
  scene(
    'Escape in the select mode with a selection',
    (_draw, t) => t.map.key('Escape'),
    (draw) => draw.selection.set('feature', ['pt', 'ln']),
  );
  scene(
    'Ctrl+G in the select mode with a selection',
    (_draw, t) => t.map.key('g', { ctrl: true }),
    (draw) => draw.selection.set('feature', ['pt', 'ln']),
  );
  scene(
    'Ctrl+Shift+G in the select mode with a group selected',
    (_draw, t) => t.map.key('g', { ctrl: true, shift: true }),
    (draw) => draw.selection.set('group', ['g1']),
  );
  scene('Ctrl+A in the select mode', (_draw, t) => t.map.key('a', { ctrl: true }));
  scene(
    'an arrow key in the select mode with a selection',
    (_draw, t) => t.map.key('ArrowRight'),
    (draw) => draw.selection.set('feature', ['pt']),
  );
});

describe('read-only and the interaction lock', () => {
  scene('setReadOnly true', (draw) => draw.setReadOnly(true));
  scene(
    'setReadOnly true with a selection',
    (draw) => draw.setReadOnly(true),
    (draw) => draw.selection.set('feature', ['pt']),
  );
  scene(
    'setReadOnly true in a drawing mode',
    (draw) => draw.setReadOnly(true),
    (draw) => draw.setMode('drawPolygon'),
  );
  scene(
    'setReadOnly true with selected vertices',
    (draw) => draw.setReadOnly(true),
    (draw) => {
      draw.selection.set('feature', ['ln']);
      draw.vertexSelection.set('ln', [{ ring: 0, index: 1 }]);
    },
  );
  scene(
    'setReadOnly true twice',
    (draw) => draw.setReadOnly(true),
    (draw) => draw.setReadOnly(true),
  );
  scene(
    'setReadOnly false',
    (draw) => draw.setReadOnly(false),
    (draw) => draw.setReadOnly(true),
  );
  scene('setInteractionLocked true', (draw) => draw.setInteractionLocked(true));
  scene(
    'setInteractionLocked true in a drawing mode',
    (draw) => draw.setInteractionLocked(true),
    (draw) => draw.setMode('drawLine'),
  );
  scene(
    'setInteractionLocked true with a selection',
    (draw) => draw.setInteractionLocked(true),
    (draw) => draw.selection.set('feature', ['pt']),
  );
  scene(
    'setInteractionLocked false',
    (draw) => draw.setInteractionLocked(false),
    (draw) => draw.setInteractionLocked(true),
  );
  scene(
    'Delete under the interaction lock',
    (_draw, t) => t.map.key('Delete'),
    (draw) => {
      draw.selection.set('feature', ['pt']);
      draw.setInteractionLocked(true);
    },
  );
  scene(
    'Delete in read-only',
    (_draw, t) => t.map.key('Delete'),
    (draw) => {
      draw.selection.set('feature', ['pt']);
      draw.setReadOnly(true);
    },
  );
});

describe('what this client hides', () => {
  scene('hidden.add', (draw) => draw.hidden.add('pt'));
  scene('hidden.add of a hidden one', (draw) => draw.hidden.add('loc'));
  scene('hidden.add of a group', (draw) => draw.hidden.add('g1'));
  scene('hidden.add of a layer', (draw) => draw.hidden.add('lb'));
  scene('hidden.add of a missing ID', (draw) => draw.hidden.add('none'));
  scene('hidden.addMany', (draw) => draw.hidden.addMany(['pt', 'ln', 'loc']));
  scene('hidden.remove', (draw) => draw.hidden.remove('loc'));
  scene('hidden.remove of one not hidden', (draw) => draw.hidden.remove('pt'));
  scene(
    'hidden.removeMany',
    (draw) => draw.hidden.removeMany(['loc', 'pt']),
    (draw) => draw.hidden.add('pt'),
  );
  scene(
    'hidden.clear',
    (draw) => draw.hidden.clear(),
    (draw) => draw.hidden.add('pt'),
  );
  scene(
    'hidden.clear of nothing',
    (draw) => draw.hidden.clear(),
    (draw) => draw.hidden.clear(),
  );
  scene(
    'hidden.add in read-only',
    (draw) => draw.hidden.add('pt'),
    (draw) => draw.setReadOnly(true),
  );
  scene('features.delete of a hidden one', (draw) => draw.features.delete('loc'));
});

describe('the features being edited', () => {
  /** A scene with a Store of the application and a plugin that records `onDrawCommit` */
  function edits(
    name: string,
    act: (draw: Draw, t: ParityInstance) => unknown,
    setup: (
      draw: Draw,
      t: ParityInstance,
      store: ReturnType<typeof createApplicationStore>,
    ) => void,
  ): void {
    table.scene(name, async () => {
      const app = createApplicationStore();
      const t = createParityInstance({ initDefaultLayer: false, app });
      fillParityDocument(t);
      const committed: string[] = [];
      parityQuiet(() => {
        t.draw.extensions.plugins.add({
          name: 'commit-probe',
          onAdd() {},
          interaction: {
            onDrawCommit(feature: Feature) {
              committed.push(feature.id);
            },
          },
        });
        setup(t.draw, t, app);
      });
      const seen = await observeParity(t, () => act(t.draw, t));
      return { ...seen, committed, editing: [...app.scene.getEditingIds()] };
    });
  }
  edits(
    'the select mode entered with features being edited',
    (draw) => draw.setMode('select'),
    (draw, _t, app) => {
      draw.setMode('drawLine');
      app.scene.startEditing(['pt', 'none']);
    },
  );
  edits(
    'the select mode entered with none being edited',
    (draw) => draw.setMode('select'),
    (draw) => draw.setMode('drawLine'),
  );
  edits(
    'a point drawn while another is being edited',
    (_draw, t) => t.map.click([0.5, -0.5]),
    (draw, _t, app) => {
      draw.setMode('drawPoint');
      app.scene.startEditing(['pt']);
    },
  );
  edits(
    'a feature being edited deleted',
    (draw) => draw.features.delete('pt'),
    (_draw, _t, app) => app.scene.startEditing(['pt', 'ln']),
  );
  edits(
    'endEditing of a Store',
    (_draw, _t) => undefined,
    (_draw, _t, app) => {
      app.scene.startEditing(['pt', 'ln']);
      app.scene.endEditing(['pt']);
    },
  );
});

table.end();
