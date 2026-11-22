// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The work of the frames of a selection of every feature does not grow with the features
 * (1,000 against 10,000, `expectNotProportional`)
 *
 * Every feature of a layer of points, lines and areas is selected, with `{ layerIds }` or with a
 * box, and the frames after it are drawn: the frame the selection changes in, and a frame after it
 * that changes nothing. In both, no feature and no ID is made; in the frame after, no row is read
 * on the CPU, and the draws do not grow with the features. A frame after the selection is emptied
 * writes no row into the chunks. (1,000 features are a few: their frames are drawn one by one, from
 * the features the layer keeps; 10,000 are drawn from their rows.)
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { EngineModeContext } from '../../modes/handler.js';
import { selectFeaturesInBox } from '../../modes/select/box-selection.js';
import type { BoxSelection } from '../../store/types.js';
import {
  createCountedInstance,
  expectNotProportional,
  gridPoints,
  WORK_SCENES,
  WORK_SIZES,
  workDuring,
} from '../../test-utils.js';
import type { TableLayerRenderer } from '../layer/table-retained.js';

type Instance = ReturnType<typeof createCountedInstance>;

const instances: Instance[] = [];

afterEach(() => {
  for (const instance of instances.splice(0)) instance.draw.destroy();
});

/** Draws frames until the drawing has no work left */
function settle(instance: Instance): void {
  for (let frame = 0; frame < 30; frame++) {
    instance.map.render();
    if (!instance.draw.hasPendingWork()) return;
  }
  throw new Error('the drawing still has work after 30 frames');
}

/** `count` features of the grid: a point, a line and an area in turn */
function shapes(count: number) {
  const step = 2 / Math.ceil(Math.sqrt(count)) / 3;
  return gridPoints(count).map(({ geometry }, i) => {
    const [x, y] = geometry.coordinates;
    if (i % 3 === 0) return { type: 'Point', geometry };
    if (i % 3 === 1) {
      return {
        type: 'LineString',
        geometry: {
          type: 'LineString',
          coordinates: [
            [x, y],
            [x + step, y + step],
          ],
        },
      };
    }
    return {
      type: 'Polygon',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [x, y],
            [x + step, y],
            [x, y + step],
            [x, y],
          ],
        ],
      },
    };
  });
}

/** An instance over `size` points, lines and areas, drawn until its work is done */
function instanceOf(size: number): Instance {
  const instance = createCountedInstance();
  instances.push(instance);
  instance.draw.features.createMany(shapes(size) as never);
  settle(instance);
  return instance;
}

function rendererOf(instance: Instance): TableLayerRenderer {
  const renderer = instance.engine.customLayer.getTableRenderer();
  if (!renderer) throw new Error('the instance draws no rows');
  return renderer;
}

/** What one frame did */
interface FrameWork {
  /** The features and the other objects made by the Store */
  objectsCreated: number;
  /** The IDs of rows read from the Store */
  idsRead: number;
  /** The rows read on the CPU: by the Store, and the state of the rows by the drawing */
  rowsRead: number;
  /** The rows written into the chunks */
  rowsPacked: number;
  /** The GL draw calls */
  draws: number;
}

/** The work of one frame */
function frameWork(instance: Instance): FrameWork {
  const renderer = rendererOf(instance);
  const before = { ...renderer.stats };
  const ids = instance.storeWork.calls.get('getRowId') ?? 0;
  instance.gl.reset();
  const work = workDuring(instance.counts, () => instance.map.render());
  const after = renderer.stats;
  return {
    objectsCreated: work.objectsCreated,
    idsRead: (instance.storeWork.calls.get('getRowId') ?? 0) - ids,
    rowsRead: work.rowsTouched + after.stateRowsRead - before.stateRowsRead,
    rowsPacked: after.rowsPacked - before.rowsPacked,
    draws: instance.gl.draws(),
  };
}

/** Results built once per size */
function measured<T>(measure: (size: number) => T): (size: number) => T {
  const results = new Map<number, T>();
  return (size) => {
    let result = results.get(size);
    if (result === undefined) {
      result = measure(size);
      results.set(size, result);
    }
    return result;
  };
}

/** The frame a selection is made in, and a frame after it that changes nothing */
function framesAfter(instance: Instance, select: () => void) {
  select();
  const changed = frameWork(instance);
  const after = frameWork(instance);
  return { changed, after, selected: instance.draw.selection.get().ids.count() };
}

describe(WORK_SCENES.selectAll, () => {
  const layer = measured((size) => {
    const instance = instanceOf(size);
    const layerId = instance.draw.layers.list()[0].id;
    return framesAfter(instance, () => {
      instance.draw.selection.set('feature', { layerIds: [layerId] });
    });
  });

  const box = measured((size) => {
    const instance = instanceOf(size);
    const selection = {
      startPoint: [-1.5, -1.5],
      endPoint: [1.5, 1.5],
      previousSelection: [],
    } as unknown as BoxSelection;
    return framesAfter(instance, () => {
      const ids = selectFeaturesInBox(
        selection,
        instance.engine.context as unknown as EngineModeContext,
      );
      instance.draw.selection.set('feature', ids);
    });
  });

  const emptied = measured((size) => {
    const instance = instanceOf(size);
    const layerId = instance.draw.layers.list()[0].id;
    instance.draw.selection.set('feature', { layerIds: [layerId] });
    settle(instance);
    instance.draw.selection.clear();
    return frameWork(instance);
  });

  for (const [name, scene] of [
    ['every feature of a layer', layer],
    ['every feature in a box', box],
  ] as const) {
    it(`selects ${name}`, () => {
      expect(scene(WORK_SIZES.small).selected).toBe(WORK_SIZES.small);
      expect(scene(WORK_SIZES.large).selected).toBe(WORK_SIZES.large);
    });

    it(`makes no feature and reads no ID to draw the frames of ${name}`, () => {
      for (const frame of ['changed', 'after'] as const) {
        expectNotProportional((size) => scene(size)[frame].objectsCreated, 'the objects made', {
          zero: true,
        });
        expectNotProportional((size) => scene(size)[frame].idsRead, 'the IDs read', {
          zero: true,
        });
      }
    });

    it(`reads no row on the CPU in a frame after selecting ${name} that changes nothing`, () => {
      expectNotProportional((size) => scene(size).after.rowsRead, 'the rows read', {
        zero: true,
      });
    });

    it(`draws as many times in a frame after selecting ${name}`, () => {
      expectNotProportional((size) => scene(size).after.draws, 'the draw calls');
    });
  }

  it('writes no row into the chunks in the frame after the selection is emptied', () => {
    expectNotProportional((size) => emptied(size).rowsPacked, 'the rows written into the chunks', {
      zero: true,
    });
    expectNotProportional((size) => emptied(size).objectsCreated, 'the objects made', {
      zero: true,
    });
  });
});
