// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The table of what the instance does: the drags of the select mode
 *
 * Each scene builds the document of `fillParityDocument`, selects something (not observed),
 * then drags with the pointer of the map stub: a feature, a vertex or a handle. It reads the
 * dragged features in the middle of the drag (`during`), and after the release (or after
 * Escape in the middle of the drag) what `observeParity` reads.
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

const table = parityTable('drag');

function filled(): ParityInstance {
  const t = createParityInstance({ initDefaultLayer: false });
  fillParityDocument(t);
  return t;
}

/**
 * A scene of a drag: a press at `from`, moves to `to` in four steps, then the release (or
 * Escape and the release, with `cancel`). `during` is read after the moves.
 */
function drags(
  name: string,
  options: {
    select?: (draw: Draw) => void;
    from: [number, number];
    to: [number, number];
    watch: string[];
    cancel?: boolean;
    modifiers?: { shift?: boolean; alt?: boolean };
  },
): void {
  table.scene(name, async () => {
    const t = filled();
    if (options.select) parityQuiet(() => options.select?.(t.draw));
    let during: unknown;
    const seen = await observeParity(t, () => {
      const { from, to } = options;
      t.map.press(from, options.modifiers);
      for (let i = 1; i <= 4; i++) {
        const f = i / 4;
        t.map.pull(
          [from[0] + (to[0] - from[0]) * f, from[1] + (to[1] - from[1]) * f],
          options.modifiers,
        );
      }
      during = options.watch.map((id) => readParity(t.draw, 'features.get', id));
      if (options.cancel) t.map.key('Escape');
      t.map.release(to, options.modifiers);
    });
    return { during, ...seen };
  });
}

const select =
  (...ids: string[]) =>
  (draw: Draw) =>
    draw.selection.set('feature', ids);

describe('a drag of features', () => {
  drags('a selected point', {
    select: select('pt'),
    from: [-3, 2],
    to: [-2.5, 1.5],
    watch: ['pt'],
  });
  drags('a point not selected', { from: [-3, 2], to: [-2.5, 1.5], watch: ['pt'] });
  drags('a selected polygon by its fill', {
    select: select('pg'),
    from: [-2.5, 0.5],
    to: [-2, 0],
    watch: ['pg'],
  });
  drags('two selected features', {
    select: select('pt', 'ln'),
    from: [-1.5, 2],
    to: [-1, 1.5],
    watch: ['pt', 'ln'],
  });
  drags('a selected group', {
    select: (draw) => draw.selection.set('group', ['g1']),
    from: [3, -1],
    to: [3, -0.5],
    watch: ['ga', 'gb'],
  });
  drags('a selected layer', {
    select: (draw) => draw.selection.set('layer', ['lb']),
    from: [1, -2.5],
    to: [1, -2],
    watch: ['pb', 'pb2'],
  });
  drags('a selected circle', {
    select: select('cir'),
    from: [-3, -2.5],
    to: [-2.5, -2.5],
    watch: ['cir'],
  });
  drags('a selected image', {
    select: select('img'),
    from: [2.5, -2],
    to: [2, -1.5],
    watch: ['img'],
  });
  drags('a selected locked feature', {
    select: select('lck'),
    from: [2, 2.5],
    to: [1.5, 2],
    watch: ['lck'],
  });
  drags('a selected feature of a locked layer', {
    select: select('pc'),
    from: [-0.5, 1.5],
    to: [0, 1],
    watch: ['pc'],
  });
  drags('a selected feature with a locked one', {
    select: select('pt', 'lck'),
    from: [-3, 2],
    to: [-2.5, 1.5],
    watch: ['pt', 'lck'],
  });
  drags('a selected feature, cancelled with Escape', {
    select: select('pt', 'ln'),
    from: [-3, 2],
    to: [-2.5, 1.5],
    watch: ['pt', 'ln'],
    cancel: true,
  });
  drags('a selected feature in read-only', {
    select: (draw) => {
      draw.selection.set('feature', ['pt']);
      draw.setReadOnly(true);
    },
    from: [-3, 2],
    to: [-2.5, 1.5],
    watch: ['pt'],
  });
  drags('a selected feature under the interaction lock', {
    select: (draw) => {
      draw.selection.set('feature', ['pt']);
      draw.setInteractionLocked(true);
    },
    from: [-3, 2],
    to: [-2.5, 1.5],
    watch: ['pt'],
  });
  drags('nothing, from an empty place', { from: [0.5, -0.5], to: [1, -1], watch: ['pt'] });
});

describe('a drag of vertices and handles', () => {
  drags('a vertex of a selected line', {
    select: select('ln'),
    from: [-1, 2],
    to: [-0.5, 1.5],
    watch: ['ln'],
  });
  drags('a vertex of a selected line, cancelled with Escape', {
    select: select('ln'),
    from: [-1, 2],
    to: [-0.5, 1.5],
    watch: ['ln'],
    cancel: true,
  });
  drags('the midpoint of a selected line', {
    select: select('ln'),
    from: [-1.5, 2],
    to: [-1.5, 1.5],
    watch: ['ln'],
  });
  drags('a vertex of a selected polygon', {
    select: select('pg'),
    from: [-3, 0],
    to: [-3.3, -0.3],
    watch: ['pg'],
  });
  drags('a vertex of the hole of a selected polygon', {
    select: select('hole'),
    from: [0.5, 0.5],
    to: [0.7, 0.7],
    watch: ['hole'],
  });
  drags('a selected vertex with another selected vertex', {
    select: (draw) => {
      draw.selection.set('feature', ['ln']);
      draw.vertexSelection.set('ln', [
        { ring: 0, index: 0 },
        { ring: 0, index: 1 },
      ]);
    },
    from: [-1, 2],
    to: [-1, 1.5],
    watch: ['ln'],
  });
  drags('a corner of the frame of two selected features', {
    select: select('pt', 'pg'),
    from: [-1.9, 2.1],
    to: [-1.4, 2.6],
    watch: ['pt', 'pg'],
  });
  drags('a corner of the frame, cancelled with Escape', {
    select: select('pt', 'pg'),
    from: [-1.9, 2.1],
    to: [-1.4, 2.6],
    watch: ['pt', 'pg'],
    cancel: true,
  });
  drags('the rotate handle above the frame of two selected features', {
    select: select('pt', 'pg'),
    from: [-2.5, 2.114],
    to: [-2, 2.114],
    watch: ['pt', 'pg'],
  });
  drags('the radius of a selected circle', {
    select: select('cir'),
    from: [-2.873, -2.627],
    to: [-2.75, -2.75],
    watch: ['cir'],
  });
});

table.end();
