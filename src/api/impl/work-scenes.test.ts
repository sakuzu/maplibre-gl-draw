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

import { afterEach, describe, expect, it } from 'vitest';
import type { EngineModeContext } from '../../modes/handler.js';
import { selectFeaturesInBox } from '../../modes/select/box-selection.js';
import type { WorkCounts } from '../../shared/work-counts.js';
import type { FeatureRowField, Store } from '../../store/built-in/types.js';
import type { BoxSelection } from '../../store/types.js';
import {
  createCountedInstance,
  createSyntheticDrag,
  expectNotProportional,
  gridPoints,
  storeWorkDuring,
  WORK_SCENES,
  WORK_SIZES,
  workDuring,
} from '../../test-utils.js';
import type { IdSet } from '../model.js';

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

/**
 * Writes the attribute `changed` of a feature as a row, as a change made outside the instance:
 * the points of the grid have no other attribute
 */
function writeChanged(store: Store, id: string): void {
  store.writeRows({
    rows: Int32Array.of(store.tables.getRowRef(id) as number),
    fields: new Map<FeatureRowField, unknown[]>([['properties:changed', [true]]]),
  });
}

/** Draws frames until the drawing has no work left */
function settle(instance: ReturnType<typeof instanceOf>): void {
  for (let frame = 0; frame < 20; frame++) {
    if (!instance.draw.hasPendingWork()) return;
    instance.map.render();
  }
  throw new Error('the drawing still has work after 20 frames');
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
    // The rows written are drawn from the frame they are taken into row groups; the pointer comes
    // to the place before it clicks there, as it does on a page (the first event after a change
    // of the document tests what is under the pointer from every feature: its own scene)
    settle(instance);
    const at = pointOf(instance);
    instance.input.move(at);
    const before = frameDraws(instance);
    const work = workDuring(instance.counts, () => instance.input.click(at));
    if (instance.draw.selection.get().ids.count() !== 1) throw new Error('nothing selected');
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

describe(WORK_SCENES.selectAll, () => {
  /** The calls of a method of the tables of the Store the instance was given, while `fn` runs */
  const callsDuring = (instance: ReturnType<typeof instanceOf>, name: string, fn: () => void) => {
    const before = instance.storeWork.calls.get(name) ?? 0;
    fn();
    return (instance.storeWork.calls.get(name) ?? 0) - before;
  };

  /**
   * Every feature of the layer selected with `{ layerIds }`, with a listener of
   * `selection.changed`, then the set counted, asked and read one at a time
   */
  const scene = measured((size) => {
    const instance = instanceOf(size);
    const layerId = instance.draw.layers.list()[0].id;
    let told: IdSet | null = null;
    instance.draw.on('selection.changed', ({ selection }) => {
      told = selection.ids;
    });
    let idsRead = 0;
    const work = workDuring(instance.counts, () => {
      idsRead = callsDuring(instance, 'getRowId', () => {
        instance.draw.selection.set('feature', { layerIds: [layerId] });
      });
    });
    const { ids } = instance.draw.selection.get();
    if (ids.count() !== size) throw new Error(`${ids.count()} selected of ${size}`);
    const asked = workDuring(instance.counts, () => {
      idsRead += callsDuring(instance, 'getRowId', () => {
        ids.count();
        ids.has('nothing');
      });
    });
    let iterated = 0;
    const read = workDuring(instance.counts, () => {
      for (const _ of ids.iterate()) iterated += 1;
    });
    return { work, idsRead, asked, read, iterated, told: told === ids };
  });

  it('makes as many arrays and features to select every feature of a layer of 10,000 as of 1,000', () => {
    expectNotProportional((size) => scene(size).work.objectsCreated, 'the objects made');
  });

  it('reads no ID of a row to select them, to count them or to ask for one', () => {
    expectNotProportional((size) => scene(size).idsRead, 'the IDs read from the rows', {
      zero: true,
    });
    expectNotProportional((size) => scene(size).asked.objectsCreated, 'the objects made', {
      zero: true,
    });
  });

  it('reads the IDs one at a time without making an array or a feature', () => {
    expect(scene(WORK_SIZES.large).iterated).toBe(WORK_SIZES.large);
    expectNotProportional((size) => scene(size).read.objectsCreated, 'the objects made', {
      zero: true,
    });
  });

  it('tells selection.changed with the set of the selection itself, not a copy of it', () => {
    expect(scene(WORK_SIZES.small).told).toBe(true);
    expect(scene(WORK_SIZES.large).told).toBe(true);
  });

  /** A box over the whole grid: every point lies wholly inside it */
  const box = measured((size) => {
    const instance = instanceOf(size);
    const selection = {
      startPoint: [-1.5, -1.5],
      endPoint: [1.5, 1.5],
      previousSelection: [],
    } as unknown as BoxSelection;
    let selected = 0;
    const work = workDuring(instance.counts, () => {
      selected = selectFeaturesInBox(
        selection,
        instance.engine.context as unknown as EngineModeContext,
      ).count();
    });
    return { work, selected };
  });

  it('makes as many arrays and features to select every feature with a box', () => {
    expect(box(WORK_SIZES.small).selected).toBe(WORK_SIZES.small);
    expect(box(WORK_SIZES.large).selected).toBe(WORK_SIZES.large);
    expectNotProportional((size) => box(size).work.objectsCreated, 'the objects made');
  });

  /** Every feature selected, then the layer renamed, then the layer hidden */
  const followed = measured((size) => {
    const instance = instanceOf(size);
    const layerId = instance.draw.layers.list()[0].id;
    instance.draw.selection.set('feature', { layerIds: [layerId] });
    const before = instance.draw.selection.get().ids;
    const renamed = workDuring(instance.counts, () => {
      instance.draw.layers.update(layerId, { name: 'renamed' });
    });
    const kept = instance.draw.selection.get().ids === before;
    const hidden = workDuring(instance.counts, () => {
      instance.draw.layers.update(layerId, { visible: false });
    });
    return { renamed, kept, hidden, left: instance.draw.selection.get().ids.count() };
  });

  it('keeps the selection when the layer is renamed, and makes no feature for it', () => {
    expect(followed(WORK_SIZES.large).kept).toBe(true);
    expectNotProportional((size) => followed(size).renamed.objectsCreated, 'the objects made', {
      zero: true,
    });
  });

  it('empties the selection when the layer is hidden, without a feature for each', () => {
    expect(followed(WORK_SIZES.large).left).toBe(0);
    expectNotProportional((size) => followed(size).hidden.objectsCreated, 'the objects made');
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
    return workDuring(instance.counts, () => writeChanged(instance.store, id));
  });

  it('makes as many features for a change of one feature', () => {
    expectNotProportional((size) => scene(size).objectsCreated, 'the features made');
  });

  it('notifies as often', () => {
    expectNotProportional((size) => scene(size).notifications, 'the notifications');
  });
});

describe(WORK_SCENES.deleteLayer, () => {
  it('notifies as often in a part for a layer of 10,000 features as for one of 1,000', async () => {
    // The deletion is written in parts, whose number grows with the features: what does not grow
    // is the number of notifications a part gives
    const perPart = new Map<number, number>();
    for (const size of [WORK_SIZES.small, WORK_SIZES.large]) {
      const instance = instanceOf(size);
      const layer = instance.draw.layers.list()[0];
      let parts = 0;
      const stop = instance.draw.document.subscribe(() => {
        parts += 1;
      });
      const before = instance.counts.notifications;
      await instance.draw.layers.delete(layer.id);
      stop();
      perPart.set(size, (instance.counts.notifications - before) / Math.max(parts, 1));
    }
    expectNotProportional((size) => perPart.get(size) ?? 0, 'the notifications of a part');
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
    return storeWorkDuring(instance.storeWork, () => writeChanged(instance.store, id));
  });

  it('reads as many features through the Store for a change of one feature', () => {
    expectNotProportional(
      (size) => scene(size).featuresRead,
      'the features read through the Store',
    );
  });
});
