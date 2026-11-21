// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The work of the drawing of the layers from their rows does not grow with the number of features
 * (1,000 against 10,000, `expectNotProportional`): a frame after a write, after a change of the
 * selection, of rows just written; and what is counted as no work at all (features made in a
 * frame that changes nothing). The draws of a layer of points, lines and polygons interleaved
 * follow its chunks, not the changes of kind.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  createCountedInstance,
  expectNotProportional,
  gridPoints,
  WORK_SCENES,
  workDuring,
} from '../../test-utils.js';
import type { TableLayerRenderer, TableWorkStats } from './table-retained.js';

type Instance = ReturnType<typeof createCountedInstance>;

const instances: Instance[] = [];

afterEach(() => {
  for (const instance of instances.splice(0)) instance.draw.destroy();
});

function instanceOf(): Instance {
  const instance = createCountedInstance();
  instances.push(instance);
  return instance;
}

function rendererOf(instance: Instance): TableLayerRenderer {
  const renderer = instance.engine.customLayer.getTableRenderer();
  if (!renderer) throw new Error('the instance draws no rows');
  return renderer;
}

/** Draws frames until the drawing has no work left */
function settle(instance: Instance): void {
  for (let frame = 0; frame < 30; frame++) {
    instance.map.render();
    if (!instance.draw.hasPendingWork()) return;
  }
  throw new Error('the drawing still has work after 30 frames');
}

/** The ids of the features made */
function idsOf(made: unknown): string[] {
  return (made as Array<{ id: string }>).map((feature) => feature.id);
}

/** What the drawing and the Store did in one frame */
interface FrameWork {
  /** The rows the Store read, and the objects it made */
  rowsTouched: number;
  objectsCreated: number;
  /** The rows the drawing read the state of, packed or wrote in place, and the chunks built */
  stateRowsRead: number;
  rowsPacked: number;
  chunksBuilt: number;
  /** The GL draw calls */
  draws: number;
}

/** The work of one frame */
function frameWork(instance: Instance): FrameWork {
  const renderer = rendererOf(instance);
  const before: TableWorkStats = { ...renderer.stats };
  instance.gl.reset();
  const work = workDuring(instance.counts, () => instance.map.render());
  const after = renderer.stats;
  return {
    rowsTouched: work.rowsTouched,
    objectsCreated: work.objectsCreated,
    stateRowsRead: after.stateRowsRead - before.stateRowsRead,
    rowsPacked: after.rowsPacked - before.rowsPacked,
    chunksBuilt: after.chunksBuilt - before.chunksBuilt,
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

/** `count` features of the grid, a point, a line and a polygon in turn (or each kind together) */
function shapes(count: number, grouped = false) {
  const step = 2 / Math.ceil(Math.sqrt(count)) / 3;
  const made = gridPoints(count).map(({ geometry }, i) => {
    const [x, y] = geometry.coordinates;
    if (i % 3 === 0) return { kind: 0, feature: { type: 'Point', geometry } };
    if (i % 3 === 1) {
      return {
        kind: 1,
        feature: {
          type: 'LineString',
          geometry: {
            type: 'LineString',
            coordinates: [
              [x, y],
              [x + step, y + step],
            ],
          },
        },
      };
    }
    return {
      kind: 2,
      feature: {
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
      },
    };
  });
  if (grouped) made.sort((a, b) => a.kind - b.kind);
  return made.map((each) => each.feature);
}

/** The chunks of the layers drawn: their number, and the vertices they hold */
function chunksOf(renderer: TableLayerRenderer): { chunks: number; vertices: number } {
  const layers = (
    renderer as unknown as {
      layers: Map<
        string,
        { groups: Map<number, { chunks: Array<{ range: { vertices: number } }> | null }> }
      >;
    }
  ).layers;
  let chunks = 0;
  let vertices = 0;
  for (const layer of layers.values()) {
    for (const group of layer.groups.values()) {
      for (const chunk of group.chunks ?? []) {
        chunks++;
        vertices += chunk.range.vertices;
      }
    }
  }
  return { chunks, vertices };
}

describe(WORK_SCENES.interleavedLayers, () => {
  const scene = measured((size) => {
    const draws: number[] = [];
    let interleaved = { chunks: 0, vertices: 0, groups: 0 };
    for (const grouped of [false, true]) {
      const instance = instanceOf();
      const ids = idsOf(instance.draw.features.createMany(shapes(size, grouped) as never));
      settle(instance);
      draws.push(frameWork(instance).draws);
      if (!grouped) {
        const layerId = instance.draw.features.get(ids[0])?.layerId as string;
        const table = (
          rendererOf(instance) as unknown as {
            reader: { table(id: string): { groupCount: number } | undefined };
          }
        ).reader.table(layerId);
        interleaved = { ...chunksOf(rendererOf(instance)), groups: table?.groupCount ?? 0 };
      }
    }
    return { interleaved: draws[0], grouped: draws[1], ...interleaved };
  });

  for (const size of [1_000, 10_000]) {
    it(`draws as many times as the same layer with each kind together, ${size.toLocaleString('en')} features`, () => {
      const { interleaved, grouped } = scene(size);
      expect(interleaved).toBeGreaterThan(0);
      expect(interleaved).toBe(grouped);
    });

    it(`draws no more times than its chunks, and has no more chunks than its row groups and its vertices by 40,000, ${size.toLocaleString('en')} features`, () => {
      const { interleaved, chunks, vertices, groups } = scene(size);
      // Every chunk is in view
      expect(interleaved).toBeLessThanOrEqual(chunks);
      expect(chunks).toBeLessThanOrEqual(groups + Math.ceil(vertices / 40_000));
    });
  }
});

describe('the frame after rows are written', () => {
  it('draws no row one at a time and makes as much for 10,000 rows written in one write as for 1,000', () => {
    const scene = measured((size) => {
      const instance = instanceOf();
      settle(instance);
      const ids = idsOf(instance.draw.features.createMany(shapes(size) as never));
      const work = frameWork(instance);
      const layerId = instance.draw.features.get(ids[0])?.layerId as string;
      const table = (
        rendererOf(instance) as unknown as {
          reader: { table(id: string): { groupCount: number } | undefined };
        }
      ).reader.table(layerId);
      return { ...work, groups: table?.groupCount ?? 0 };
    });
    // The rows taken in are drawn a chunk at a time (the whole groups of 4,096 rows are taken in
    // at once); the others wait
    for (const size of [1_000, 10_000]) {
      expect(scene(size).draws).toBeLessThanOrEqual(scene(size).groups);
    }
    expectNotProportional((size) => scene(size).objectsCreated, 'the objects made', {
      zero: true,
    });
  });
});

describe('a frame that changes nothing', () => {
  it('makes no object with 100,000 features selected', { timeout: 120_000 }, () => {
    const instance = instanceOf();
    const ids = idsOf(instance.draw.features.createMany(gridPoints(100_000) as never));
    settle(instance);
    instance.draw.selection.set('feature', ids);
    settle(instance);
    instance.map.render();
    expect(frameWork(instance).objectsCreated).toBe(0);
  });

  it('makes no object with 2,000 rows drawn at once in view', () => {
    const instance = instanceOf();
    instance.draw.extensions.featureTypes.add({
      type: 'pin',
      geometry: 'Point',
      renderer: { onAdd() {}, draw() {}, onRemove() {} },
    } as never);
    instance.draw.features.createMany(
      gridPoints(2_000).map((each) => ({ ...each, type: 'pin' })) as never,
    );
    settle(instance);
    instance.map.render();
    const work = frameWork(instance);
    expect(work.objectsCreated).toBe(0);
    // They are drawn
    expect(
      (rendererOf(instance).stats as TableWorkStats & { featuresMade: number }).featuresMade,
    ).toBeGreaterThan(0);
  });

  it('makes no feature of the rows drawn in one draw', () => {
    const instance = instanceOf();
    instance.draw.features.createMany(shapes(10_000) as never);
    settle(instance);
    const renderer = rendererOf(instance);
    const made = renderer.stats.featuresMade;
    const work = frameWork(instance);
    expect(renderer.stats.featuresMade - made).toBe(0);
    expect(work.objectsCreated).toBe(0);
    expect(work.draws).toBeGreaterThan(0);
  });
});

describe('the frame after a change', () => {
  /** An instance over `size` points of the grid, drawn until its work is done */
  function settled(size: number): { instance: Instance; ids: string[] } {
    const instance = instanceOf();
    const ids = idsOf(instance.draw.features.createMany(gridPoints(size) as never));
    settle(instance);
    return { instance, ids };
  }

  /** Moves features by a little, in one change */
  function move(instance: Instance, ids: readonly string[]): void {
    instance.draw.transact(() => {
      for (const id of ids) {
        const feature = instance.draw.features.get(id) as { geometry: GeoJSON.Point };
        const [x, y] = feature.geometry.coordinates;
        instance.draw.features.update(id, {
          geometry: { type: 'Point', coordinates: [x + 1e-5, y] },
        });
      }
    });
  }

  const oneWrite = measured((size) => {
    const { instance, ids } = settled(size);
    move(instance, [ids[5]]);
    return frameWork(instance);
  });

  const manyWrites = measured((size) => {
    const { instance, ids } = settled(size);
    move(instance, ids.slice(0, 1_024));
    return frameWork(instance);
  });

  it('reads and writes as many rows after one feature is written', () => {
    expectNotProportional((size) => oneWrite(size).rowsTouched, 'the rows read', { zero: true });
    expectNotProportional(
      (size) => oneWrite(size).stateRowsRead + oneWrite(size).rowsPacked,
      'the rows the drawing read and wrote again',
      { zero: true },
    );
    expectNotProportional((size) => oneWrite(size).objectsCreated, 'the objects made', {
      zero: true,
    });
  });

  it('reads and writes as many rows after 1,024 features are moved', () => {
    expectNotProportional((size) => manyWrites(size).rowsTouched, 'the rows read', {
      zero: true,
    });
    expectNotProportional(
      (size) => manyWrites(size).stateRowsRead + manyWrites(size).rowsPacked,
      'the rows the drawing read and wrote again',
      { zero: true },
    );
    expectNotProportional((size) => manyWrites(size).objectsCreated, 'the objects made', {
      zero: true,
    });
  });

  it('writes as many rows and builds as many chunks after the selection changes by one', () => {
    const scene = measured((size) => {
      const { instance, ids } = settled(size);
      instance.draw.selection.set('feature', [ids[5]]);
      return frameWork(instance);
    });
    expectNotProportional(
      (size) => scene(size).stateRowsRead + scene(size).rowsPacked,
      'the rows the drawing read and wrote again',
      { zero: true },
    );
    expectNotProportional((size) => scene(size).chunksBuilt, 'the chunks built', { zero: true });
  });
});
