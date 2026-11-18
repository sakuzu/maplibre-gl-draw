// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The table of what the instance does: snapping
 *
 * Each scene builds a small document of snapping candidates, draws with the pointer of the map
 * stub (or drags a vertex in the select mode) near them, and reads the events (`snap.changed`
 * carries the candidate snapped to) and the document the drawing left.
 *
 * The snapping reach is 10 px at zoom 10 of a real map (about 0.007 degrees), so the pointer
 * comes within a few thousandths of a degree of a candidate. The candidates: the square `sq` from (0, 0) to (1, 1), the lines `h` and `v` that cross at
 * (2.5, 0.5), the hidden square `hsq` at (-2, 0), the square `lsq` at (-2, -2) hidden by this
 * client, the locked square `ksq` at (0, -2), and `dsq` at (2, -2) in a hidden layer.
 */

import { describe } from 'vitest';
import type { DrawOptions } from '../index.js';
import {
  createParityInstance,
  observeParity,
  type ParityInstance,
  type ParityMap,
  parityQuiet,
  parityRing,
  parityTable,
} from '../test-utils.js';

const table = parityTable('snapping');

function candidates(options: DrawOptions = {}): ParityInstance {
  const t = createParityInstance(options);
  parityQuiet(() => {
    const { draw } = t;
    const poly = (id: string, x: number, y: number, extra: object = {}) =>
      draw.features.create({
        id,
        type: 'Polygon',
        geometry: { type: 'Polygon', coordinates: [parityRing(x, y, 1)] },
        ...extra,
      });
    poly('sq', 0, 0);
    draw.features.create({
      id: 'h',
      type: 'LineString',
      geometry: {
        type: 'LineString',
        coordinates: [
          [2, 0],
          [3, 1],
        ],
      },
    });
    draw.features.create({
      id: 'v',
      type: 'LineString',
      geometry: {
        type: 'LineString',
        coordinates: [
          [2, 1],
          [3, 0],
        ],
      },
    });
    poly('hsq', -2, 0, { visible: false });
    poly('lsq', -2, -2);
    draw.hidden.add('lsq');
    poly('ksq', 0, -2, { locked: true });
    draw.layers.create({ id: 'hidden-layer', visible: false });
    poly('dsq', 2, -2, { layerId: 'hidden-layer' });
  });
  return t;
}

/** A scene: the candidates, the mode, then the input `act` (observed) */
function snaps(
  name: string,
  act: (map: ParityMap) => void,
  options: { mode?: string; draw?: DrawOptions } = {},
): void {
  table.scene(name, async () => {
    const t = candidates(options.draw);
    parityQuiet(() => t.draw.setMode(options.mode ?? 'drawLine'));
    return observeParity(t, () => act(t.map));
  });
}

/** Starts a line at a free place, moves near `at`, clicks there and finishes the line */
const lineTo =
  (at: [number, number], modifiers?: { alt?: boolean }) =>
  (map: ParityMap): void => {
    map.click([-3.5, 2.5]);
    map.move(at, modifiers);
    map.click(at, modifiers);
    map.key('Enter');
  };

describe('the candidates of a line being drawn', () => {
  snaps('a vertex of a polygon', lineTo([1.003, 1.002]));
  snaps('a point on an edge of a polygon', lineTo([0.5, 1.003]));
  snaps('the intersection of two lines', lineTo([2.502, 0.503]));
  snaps('a vertex of a line', lineTo([3.004, 0.997]));
  snaps('nothing in reach', lineTo([1.03, 1.03]));
  snaps('a vertex of a hidden polygon', lineTo([-0.997, 1.003]));
  snaps('a vertex of a polygon hidden by this client', lineTo([-0.997, -0.997]));
  snaps('a vertex of a locked polygon', lineTo([1.003, -0.997]));
  snaps('a vertex of a polygon in a hidden layer', lineTo([3.003, -0.997]));
  snaps('a vertex with the key that turns snapping off', lineTo([1.003, 1.002], { alt: true }));
  snaps('a guide from the last vertex', (map) => {
    map.click([-3, 2]);
    map.move([-2.001, 1.003]);
    map.click([-2.001, 1.003]);
    map.key('Enter');
  });
  snaps('the vertices of the line itself', (map) => {
    map.click([-3, 2]);
    map.click([-2, 2.5]);
    map.move([-2.997, 2.003]);
    map.click([-2.997, 2.003]);
  });
  snaps('only the moves, without a click', (map) => {
    map.move([1.003, 1.002]);
    map.move([0.5, 1.003]);
    map.move([1.03, 1.03]);
  });
});

describe('the options of snapping', () => {
  snaps('the vertices turned off', lineTo([1.003, 1.002]), {
    draw: { snapping: { kinds: { vertex: false } } },
  });
  snaps('the edges turned off', lineTo([0.5, 1.003]), {
    draw: { snapping: { kinds: { edge: false } } },
  });
  snaps('the intersections turned off', lineTo([2.502, 0.503]), {
    draw: { snapping: { kinds: { intersection: false } } },
  });
  snaps(
    'the guides turned off',
    (map) => {
      map.click([-3, 2]);
      map.move([-2.001, 1.003]);
      map.click([-2.001, 1.003]);
      map.key('Enter');
    },
    { draw: { snapping: { kinds: { guide: false } } } },
  );
  snaps('snapping turned off', lineTo([1.003, 1.002]), { draw: { snapping: { enabled: false } } });
  snaps('a smaller reach', lineTo([1.006, 1.002]), { draw: { snapping: { tolerancePx: 3 } } });
});

describe('snapping in the other modes', () => {
  snaps('a point drawn on a vertex', (map) => map.click([1.003, 1.002]), { mode: 'drawPoint' });
  snaps(
    'a polygon drawn from vertices',
    (map) => {
      map.click([0.997, 0.003]);
      map.click([1.6, 0.4]);
      map.click([1.003, 0.998]);
      map.key('Enter');
    },
    { mode: 'drawPolygon' },
  );
  table.scene('a vertex dragged onto a vertex in the select mode', async () => {
    const t = candidates();
    parityQuiet(() => t.draw.selection.set('feature', ['h']));
    return observeParity(t, () => t.map.drag([3, 1], [1.003, 1.002]));
  });
  table.scene('a feature dragged near a vertex in the select mode', async () => {
    const t = candidates();
    parityQuiet(() => t.draw.selection.set('feature', ['h']));
    return observeParity(t, () => t.map.drag([2.25, 0.25], [1.253, 0.252]));
  });
});

table.end();
