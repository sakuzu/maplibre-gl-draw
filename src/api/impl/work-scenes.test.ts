// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The work of the scenes that does not grow with the number of features
 *
 * Each scene runs on an instance over 1,000 and over 10,000 points, on a map stub that draws on
 * a counting GL, and what it counts must grow less than twice. Only the scenes and the numbers
 * that do not depend on the number of features today are here; a scene whose work grows with
 * them gets its test with the work that makes it not grow.
 */

import { afterEach, describe, it } from 'vitest';
import type { WorkCounts } from '../../shared/work-counts.js';
import {
  createCountedInstance,
  createSyntheticDrag,
  expectNotProportional,
  gridPoints,
  storeWorkDuring,
  WORK_SCENES,
  workDuring,
} from '../../test-utils.js';

const instances: ReturnType<typeof createCountedInstance>[] = [];

afterEach(() => {
  for (const instance of instances.splice(0)) instance.draw.destroy();
});

/** An instance over `size` points, drawn once (the first frame builds what it draws) */
function instanceOf(size: number) {
  const instance = createCountedInstance();
  instance.draw.features.createMany(gridPoints(size));
  instance.map.render();
  instances.push(instance);
  return instance;
}

/** The draw calls of one frame */
function frameDraws(instance: ReturnType<typeof instanceOf>): number {
  instance.gl.reset();
  instance.map.render();
  return instance.gl.draws();
}

/** The coordinates of a point of the instance, away from the edges of the grid */
function pointOf(instance: ReturnType<typeof instanceOf>): [number, number] {
  const feature = instance.draw.features.list()[5];
  return (feature.geometry as GeoJSON.Point).coordinates as [number, number];
}

/** What a scene measured, built once per size */
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

type SceneWork = WorkCounts & { addedDraws: number };

describe(WORK_SCENES.select, () => {
  const scene = measured((size): SceneWork => {
    const instance = instanceOf(size);
    const before = frameDraws(instance);
    const work = workDuring(instance.counts, () => instance.input.click(pointOf(instance)));
    if (instance.draw.selection.get().ids.length !== 1) throw new Error('nothing selected');
    return { ...work, addedDraws: frameDraws(instance) - before };
  });

  it('makes no more features for a click on one of 10,000 than of 1,000', () => {
    // A click makes no feature at all
    expectNotProportional((size) => scene(size).objectsCreated, 'the features made', {
      zero: true,
    });
  });

  it('notifies as often', () => {
    expectNotProportional((size) => scene(size).notifications, 'the notifications');
  });

  it('adds as many draw calls to the frame', () => {
    expectNotProportional((size) => scene(size).addedDraws, 'the added draw calls');
  });
});

describe(WORK_SCENES.dragFrame, () => {
  const scene = measured((size): WorkCounts => {
    const instance = instanceOf(size);
    const at = pointOf(instance);
    instance.input.click(at);
    const drag = createSyntheticDrag(instance.engine);
    drag.start(at);
    drag.move([at[0] + 0.05, at[1]]);
    const work = workDuring(instance.counts, () => drag.move([at[0] + 0.1, at[1]]));
    if (work.notifications === 0) throw new Error('the drag did not move the feature');
    drag.end([at[0] + 0.1, at[1]]);
    return work;
  });

  it('makes as many features for a move of one feature', () => {
    expectNotProportional((size) => scene(size).objectsCreated, 'the features made');
  });

  it('notifies as often', () => {
    expectNotProportional((size) => scene(size).notifications, 'the notifications');
  });
});

describe(WORK_SCENES.receiveChange, () => {
  const scene = measured((size): WorkCounts => {
    const instance = instanceOf(size);
    const id = instance.draw.features.list()[5].id;
    // Written to the Store directly, as a change made outside the instance
    return workDuring(instance.counts, () =>
      instance.store.updateFeature(id, { properties: { changed: true } }),
    );
  });

  it('makes as many features for a change of one feature', () => {
    expectNotProportional((size) => scene(size).objectsCreated, 'the features made');
  });

  it('notifies as often', () => {
    expectNotProportional((size) => scene(size).notifications, 'the notifications');
  });
});

describe(WORK_SCENES.deleteLayer, () => {
  it('notifies as often for a layer of 10,000 features as for one of 1,000', () => {
    expectNotProportional((size) => {
      const instance = instanceOf(size);
      const layer = instance.draw.layers.list()[0];
      return workDuring(instance.counts, () => instance.draw.layers.delete(layer.id)).notifications;
    }, 'the notifications');
  });
});

// The features the instance reads and writes through its Store, counted by the Store it is given
// (`createCountingStore`) whatever the marks of the library count. Only the amounts that do not
// grow with the number of features today are here.

describe(WORK_SCENES.dragFrame, () => {
  const scene = measured((size) => {
    const instance = instanceOf(size);
    const at = pointOf(instance);
    instance.input.click(at);
    const drag = createSyntheticDrag(instance.engine);
    drag.start(at);
    drag.move([at[0] + 0.05, at[1]]);
    const work = storeWorkDuring(instance.storeWork, () => drag.move([at[0] + 0.1, at[1]]));
    if (work.featuresWritten === 0) throw new Error('the drag did not write the feature');
    drag.end([at[0] + 0.1, at[1]]);
    return work;
  });

  it('writes as many features through the Store for a move of one feature', () => {
    expectNotProportional(
      (size) => scene(size).featuresWritten,
      'the features written through the Store',
    );
  });
});

describe(WORK_SCENES.receiveChange, () => {
  const scene = measured((size) => {
    const instance = instanceOf(size);
    const id = instance.draw.features.list()[5].id;
    // Written to the Store itself, not through the wrapper the instance was given
    return storeWorkDuring(instance.storeWork, () =>
      instance.store.updateFeature(id, { properties: { changed: true } }),
    );
  });

  it('reads as many features through the Store for a change of one feature', () => {
    expectNotProportional(
      (size) => scene(size).featuresRead,
      'the features read through the Store',
    );
  });
});
