// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The work of the drawing of the layers from their rows on the terrain and on the globe does not
 * grow with the number of features (1,000 against 10,000, `expectNotProportional`): the draws of
 * a layer of points, lines and polygons interleaved follow its chunks, not the changes of kind;
 * the rows packed in a frame after the surface changes are bounded by the budget; and a frame
 * after one feature is written writes as many rows.
 */

import type { CustomRenderMethodInput } from 'maplibre-gl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCountedInstance,
  expectNotProportional,
  gridPoints,
  renderInput,
} from '../../test-utils.js';
import type { TableLayerRenderer } from './table-retained.js';

type Instance = ReturnType<typeof createCountedInstance>;

const instances: Instance[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const instance of instances.splice(0)) instance.draw.destroy();
});

function rendererOf(instance: Instance): TableLayerRenderer {
  const renderer = instance.engine.customLayer.getTableRenderer();
  if (!renderer) throw new Error('the instance draws no rows');
  return renderer;
}

/** The surfaces the scenes are drawn on */
type Surface = 'terrain' | 'globe';

/** A terrain of four DEM tiles over the area the map stub shows */
function demTerrain() {
  const tiles = new Map<string, object>([
    ['7/63/63', { id: 'a' }],
    ['7/64/63', { id: 'b' }],
    ['7/63/64', { id: 'c' }],
    ['7/64/64', { id: 'd' }],
  ]);
  return {
    exaggeration: 1,
    meshSize: 32,
    tileManager: {
      getRenderableTiles: () =>
        [...tiles.keys()].map((key) => {
          const [z, x, y] = key.split('/').map(Number);
          return { tileID: { canonical: { x, y, z }, key, wrap: 0 } };
        }),
    },
    getTerrainData: (tileID: { key: string }) => ({
      texture: tiles.get(tileID.key),
      u_terrain_matrix: new Float64Array(16).fill(1),
      u_terrain_unpack: [6553.6, 25.6, 0.1, 10000],
      u_terrain_dim: 512,
    }),
  };
}

/** A render input of the globe */
function globeInput(): CustomRenderMethodInput {
  const input = renderInput();
  const data = { ...input.defaultProjectionData, projectionTransition: 1 };
  return {
    ...input,
    shaderData: { variantName: 'globe', vertexShaderPrelude: '', define: '' },
    defaultProjectionData: data,
    getProjectionData: () => data,
  } as unknown as CustomRenderMethodInput;
}

/** An instance on a surface, with the render input of its frames */
function instanceOn(surface: Surface): {
  instance: Instance;
  input: () => CustomRenderMethodInput;
} {
  const instance = createCountedInstance();
  instances.push(instance);
  if (surface === 'terrain') {
    Object.assign(instance.map.map as object, {
      terrain: demTerrain(),
      queryTerrainElevation: ([lng, lat]: [number, number]) => 100 + 40 * lng + 25 * lat,
    });
    return { instance, input: renderInput };
  }
  return { instance, input: globeInput };
}

/** Draws frames until the drawing has no work left */
function settle(instance: Instance, input: () => CustomRenderMethodInput, most = 60): void {
  for (let frame = 0; frame < most; frame++) {
    instance.map.render(input());
    if (!instance.draw.hasPendingWork()) return;
  }
  throw new Error(`the drawing still has work after ${most} frames`);
}

/** A clock that moves on by `step` ms whenever it is read */
function stepClock(step: number): void {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => {
    now += step;
    return now;
  });
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

/** The chunks of the layers drawn */
function chunkCount(renderer: TableLayerRenderer): number {
  const layers = (
    renderer as unknown as {
      layers: Map<string, { groups: Map<number, { chunks: unknown[] | null }> }>;
    }
  ).layers;
  let chunks = 0;
  for (const layer of layers.values()) {
    for (const group of layer.groups.values()) chunks += group.chunks?.length ?? 0;
  }
  return chunks;
}

for (const surface of ['terrain', 'globe'] as const) {
  describe(`the work of the rows on the ${surface}`, () => {
    const interleaved = measured((size) => {
      const draws: number[] = [];
      let chunks = 0;
      let rowDraws = 0;
      for (const grouped of [false, true]) {
        const { instance, input } = instanceOn(surface);
        instance.draw.features.createMany(shapes(size, grouped) as never);
        settle(instance, input);
        const rows = (rendererOf(instance) as unknown as { rows: { draws: number } }).rows;
        const before = rows.draws;
        instance.gl.reset();
        instance.map.render(input());
        draws.push(instance.gl.draws());
        if (!grouped) {
          chunks = chunkCount(rendererOf(instance));
          rowDraws = rows.draws - before;
        }
      }
      return { interleaved: draws[0], grouped: draws[1], chunks, rowDraws };
    });

    for (const size of [1_000, 10_000]) {
      it(`draws an interleaved layer as many times as the same layer with each kind together, its rows no more times than its chunks, ${size.toLocaleString('en')} features`, () => {
        const scene = interleaved(size);
        expect(scene.interleaved).toBeGreaterThan(0);
        // Every GL draw of the frame (the terrain draws its own as well)
        expect(scene.interleaved).toBe(scene.grouped);
        // The draws of the rows
        expect(scene.rowDraws).toBeGreaterThan(0);
        expect(scene.rowDraws).toBeLessThanOrEqual(scene.chunks);
      });
    }

    it('packs as many rows in a frame after the surface changes', { timeout: 120_000 }, () => {
      const scene = measured((size) => {
        const { instance, input } = instanceOn(surface);
        instance.draw.features.createMany(shapes(size) as never);
        settle(instance, input);
        const renderer = rendererOf(instance);
        // A finer mesh of the terrain, the globe seen nearer: a new step of the surface
        const map = instance.map.map as unknown as {
          terrain?: { meshSize: number };
          getZoom: () => number;
        };
        if (map.terrain) map.terrain.meshSize = 64;
        else map.getZoom = () => 4;
        // Next to no budget in a frame: the work goes on over the frames
        stepClock(50);
        let most = 0;
        let total = 0;
        for (let frame = 0; frame < 400; frame++) {
          const before = renderer.stats.rowsPacked;
          instance.map.render(input());
          const packed = renderer.stats.rowsPacked - before;
          most = Math.max(most, packed);
          total += packed;
          if (!instance.draw.hasPendingWork()) break;
        }
        expect(instance.draw.hasPendingWork()).toBe(false);
        return { most, total };
      });
      // The surface changed the rows (they were packed again)
      expect(scene(1_000).total).toBeGreaterThan(0);
      expectNotProportional((size) => scene(size).most, 'the rows packed in a frame');
    });

    it('writes as many rows after one feature is written', () => {
      const scene = measured((size) => {
        const { instance, input } = instanceOn(surface);
        const ids = instance.draw.features.createMany(gridPoints(size) as never) as unknown as {
          id: string;
        }[];
        settle(instance, input);
        const renderer = rendererOf(instance);
        const id = typeof ids[5] === 'string' ? (ids[5] as unknown as string) : ids[5].id;
        const feature = instance.draw.features.get(id) as { geometry: GeoJSON.Point };
        const [x, y] = feature.geometry.coordinates;
        instance.draw.features.update(id, {
          geometry: { type: 'Point', coordinates: [x + 1e-5, y] },
        } as never);
        const before = { ...renderer.stats };
        instance.map.render(input());
        const after = renderer.stats;
        return {
          rows: after.rowsPacked - before.rowsPacked + (after.stateRowsRead - before.stateRowsRead),
          chunks: after.chunksBuilt - before.chunksBuilt,
          inPlace: after.rowsWrittenInPlace - before.rowsWrittenInPlace,
        };
      });
      expect(scene(1_000).inPlace).toBeGreaterThan(0);
      expectNotProportional((size) => scene(size).rows, 'the rows the drawing wrote again', {
        zero: true,
      });
      expectNotProportional((size) => scene(size).chunks, 'the chunks built', { zero: true });
    });
  });
}
