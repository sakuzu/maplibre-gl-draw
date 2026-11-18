// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The table of what the instance does: what a click and a box hit
 *
 * Each scene builds the document of `fillParityDocument` in the select mode, then clicks one
 * place with the pointer of the map stub (or drags a box with Shift held), and reads the
 * selection and the events (`map.clicked` carries the hit). The map stub shows (-4, -3) to
 * (4, 3), 100 px to the degree.
 */

import { describe } from 'vitest';
import type { Draw } from '../index.js';
import {
  createParityInstance,
  fillParityDocument,
  observeParity,
  type ParityInstance,
  type ParityMap,
  parityQuiet,
  parityTable,
} from '../test-utils.js';

const table = parityTable('hits');

function filled(options: { center?: [number, number] } = {}): ParityInstance {
  const t = createParityInstance({ initDefaultLayer: false, ...options });
  fillParityDocument(t);
  return t;
}

/** A scene: the document, then `setup` (not observed), then the input `act` (observed) */
function hits(
  name: string,
  act: (map: ParityMap, draw: Draw) => void,
  setup?: (draw: Draw) => void,
): void {
  table.scene(name, async () => {
    const t = filled();
    if (setup) parityQuiet(() => setup(t.draw));
    return observeParity(t, () => act(t.map, t.draw));
  });
}

describe('a click in the select mode', () => {
  for (const [label, at] of [
    ['on a point', [-3, 2]],
    ['near a point', [-2.96, 2.04]],
    ['on a line', [-1.5, 2]],
    ['near a line', [-1.5, 2.03]],
    ['on the fill of a polygon', [-2.5, 0.5]],
    ['on the edge of a polygon', [-3, 0.5]],
    ['on the ring of a polygon with a hole', [0.25, 1]],
    ['in the hole of a polygon', [1, 1]],
    ['on a multi point', [3.5, 2.5]],
    ['on a multi line', [-3, -1.5]],
    ['on the second part of a multi polygon', [-0.5, -0.75]],
    ['on the center of a circle', [-3, -2.5]],
    ['inside a circle', [-2.9, -2.45]],
    ['on a freehand line', [-1.2, -2.2]],
    ['on an image', [2.5, -2]],
    ['on a corner of an image', [2.05, -1.8]],
    ['on a hidden feature', [1, 2.5]],
    ['on a locked feature', [2, 2.5]],
    ['on a feature hidden by this client', [0, 2.5]],
    ['on a feature of a locked layer', [-0.5, 1.5]],
    ['on a feature of a hidden layer', [-1.5, 1.5]],
    ['on a grouped feature', [3, -1]],
    ['on a feature of a layer with a style rule', [1, -2.5]],
    ['on nothing', [0.5, -0.5]],
  ] as const) {
    hits(`click ${label}`, (map) => map.click([at[0], at[1]]));
  }
  hits(
    'click on nothing with a selection',
    (map) => map.click([0.5, -0.5]),
    (draw) => draw.selection.set('feature', ['pt']),
  );
  hits(
    'click on a selected feature',
    (map) => map.click([-3, 2]),
    (draw) => draw.selection.set('feature', ['pt', 'ln']),
  );
  hits(
    'click with Shift adds to the selection',
    (map) => map.click([-1.5, 2], { shift: true }),
    (draw) => draw.selection.set('feature', ['pt']),
  );
  hits(
    'click with Shift on a selected feature',
    (map) => map.click([-3, 2], { shift: true }),
    (draw) => draw.selection.set('feature', ['pt', 'ln']),
  );
  hits(
    'click on a member of a selected group',
    (map) => map.click([3, -1]),
    (draw) => draw.selection.set('group', ['g1']),
  );
  hits(
    'click on a feature in read-only',
    (map) => map.click([-3, 2]),
    (draw) => draw.setReadOnly(true),
  );
  hits(
    'click on a feature under the interaction lock',
    (map) => map.click([-3, 2]),
    (draw) => draw.setInteractionLocked(true),
  );
  hits(
    'click where two features are, the one above wins',
    (map) => map.click([-2.5, 0.5]),
    (draw) =>
      draw.features.create({
        id: 'over',
        layerId: 'la',
        type: 'Polygon',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-2.8, 0.2],
              [-2.2, 0.2],
              [-2.2, 0.8],
              [-2.8, 0.8],
              [-2.8, 0.2],
            ],
          ],
        },
      }),
  );
  hits(
    'click where a layer below and a layer above overlap',
    (map) => map.click([1, -2.5]),
    (draw) => {
      draw.features.create({
        id: 'under',
        layerId: 'la',
        type: 'Point',
        geometry: { type: 'Point', coordinates: [1, -2.5] },
      });
    },
  );
  hits('double click on a line', (map) => map.dblclick([-1.5, 2]));
  hits(
    'double click on a selected polygon',
    (map) => map.dblclick([-2.5, 0.5]),
    (draw) => draw.selection.set('feature', ['pg']),
  );
});

describe('a click across the antimeridian', () => {
  /** The map stub around (180, 0), with features stored on both sides of the line */
  function across(): ParityInstance {
    const t = createParityInstance({ center: [180, 0] });
    parityQuiet(() => {
      t.draw.features.create({
        id: 'east',
        type: 'Point',
        geometry: { type: 'Point', coordinates: [-179.8, 0] },
      });
      t.draw.features.create({
        id: 'west',
        type: 'Point',
        geometry: { type: 'Point', coordinates: [179.8, 1] },
      });
      t.draw.features.create({
        id: 'crossing',
        type: 'LineString',
        geometry: {
          type: 'LineString',
          coordinates: [
            [179.5, 0.5],
            [-179.5, 0.5],
          ],
        },
      });
      t.draw.features.create({
        id: 'spanning',
        type: 'Polygon',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [179.5, -1.5],
              [180.5, -1.5],
              [180.5, -0.5],
              [179.5, -0.5],
              [179.5, -1.5],
            ],
          ],
        },
      });
    });
    return t;
  }
  for (const [label, at] of [
    ['on a point stored east of the line', [180.2, 0]],
    ['on a point stored west of the line', [179.8, 1]],
    ['on a line across the line', [180, 0.5]],
    ['on a polygon across the line, east of it', [180.3, -1]],
    ['on a polygon across the line, west of it', [179.7, -1]],
  ] as const) {
    table.scene(`click ${label}`, async () => {
      const t = across();
      return observeParity(t, () => t.map.click([at[0], at[1]]));
    });
  }
});

describe('a box selection', () => {
  for (const [label, from, to] of [
    ['around a point, a line and a polygon', [-3.6, -0.2], [-0.8, 2.6]],
    ['around a hidden and a locked feature', [0.8, 2.3], [2.2, 2.7]],
    ['around a feature hidden by this client', [-0.2, 2.3], [0.2, 2.7]],
    ['around the features of a locked layer and a hidden layer', [-1.7, 1.3], [-0.3, 1.7]],
    ['around a group', [2.8, -1.2], [3.7, -0.8]],
    ['around one member of a group', [2.8, -1.2], [3.2, -0.8]],
    ['across part of a polygon', [-2.5, 0.5], [-1.5, 1.5]],
    ['around an image and a circle', [-3.5, -2.8], [3.5, -1.6]],
    ['around nothing', [0.3, -0.9], [0.7, -0.6]],
    ['drawn from the bottom right', [-0.8, 2.6], [-3.6, -0.2]],
  ] as const) {
    hits(`box ${label}`, (map) =>
      map.drag([from[0], from[1]], [to[0], to[1]], { modifiers: { shift: true } }),
    );
  }
  hits(
    'box with a selection',
    (map) => map.drag([-3.6, 1.8], [-2.8, 2.2], { modifiers: { shift: true } }),
    (draw) => draw.selection.set('feature', ['pb']),
  );
  hits(
    'box cancelled with Escape',
    (map) => {
      map.press([-3.6, -0.2], { shift: true });
      map.pull([-2, 1], { shift: true });
      map.pull([-0.8, 2.6], { shift: true });
      map.key('Escape');
      map.release([-0.8, 2.6], { shift: true });
    },
    (draw) => draw.selection.set('feature', ['pb']),
  );
});

table.end();
