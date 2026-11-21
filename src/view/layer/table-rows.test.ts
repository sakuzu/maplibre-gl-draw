// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The drawing of the layers of a flat map from the rows of the built-in Store
 * (`TableLayerRenderer`), on the GL that counts its calls: the order of the rows drawn, what a
 * write or a change of this client writes again, the builds over the frames, the rows written
 * before they are in row groups, the drawing by kind told once, and what the drawing reads
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { LngLatBounds } from 'maplibre-gl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDrawOnEngine } from '../../api/impl/create-draw.js';
import { createEngine } from '../../api/impl/engine.js';
import { checkDrawOptions, toEngineOptions } from '../../api/impl/options.js';
import { createStore } from '../../store/built-in/create-store.js';
import {
  createCountedInstance,
  createCountingGL,
  createDrawingMapStub,
  gridPoints,
} from '../../test-utils.js';
import type { TableDrawRecord, TableLayerRenderer, TableWorkStats } from './table-retained.js';

type Instance = ReturnType<typeof createCountedInstance>;

const instances: Instance[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const instance of instances.splice(0)) instance.draw.destroy();
});

/** An instance on the counting GL, destroyed at the end of the test */
function instanceOf(): Instance {
  const instance = createCountedInstance();
  instances.push(instance);
  return instance;
}

/** The renderer of the rows of an instance */
function rendererOf(instance: Instance): TableLayerRenderer {
  const renderer = instance.engine.customLayer.getTableRenderer();
  if (!renderer) throw new Error('the instance draws no rows');
  return renderer;
}

/** Draws frames until the drawing has no work left (throws past 30) */
function settle(instance: Instance): number {
  for (let frame = 1; frame <= 30; frame++) {
    instance.map.render();
    if (!instance.draw.hasPendingWork()) return frame;
  }
  throw new Error('the drawing still has work after 30 frames');
}

/** The work of the drawing during `fn` */
function statsDuring(renderer: TableLayerRenderer, fn: () => void): TableWorkStats {
  const before = { ...renderer.stats };
  fn();
  const after = renderer.stats;
  return Object.fromEntries(
    Object.entries(after).map(([key, value]) => [key, value - before[key as keyof TableWorkStats]]),
  ) as unknown as TableWorkStats;
}

/** The ranges one frame draws */
function recordFrame(instance: Instance): TableDrawRecord[] {
  const renderer = rendererOf(instance);
  const record: TableDrawRecord[] = [];
  renderer.recordDraws(record);
  instance.map.render();
  renderer.recordDraws(null);
  return record;
}

/** `count` features of the grid, a point, a line and a polygon in turn */
function interleaved(count: number) {
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

/** The ids of the features made */
function idsOf(made: unknown): string[] {
  return (made as Array<{ id: string }>).map((feature) => feature.id);
}

/** The ids of the rows of the layer of a feature, in the order of the layer */
function rowIdsOf(instance: Instance, layerId: string): string[] {
  const view = instance.store.tables.get(layerId);
  if (!view) return [];
  return [...view.listRowRefs(0, view.rowCount)].map(
    (ref) => instance.store.tables.getRowId(ref) as string,
  );
}

describe('the drawing of the rows of a layer', () => {
  it('draws points, lines and polygons interleaved in the order of the rows of the layer', () => {
    const instance = instanceOf();
    const ids = idsOf(instance.draw.features.createMany(interleaved(6_000) as never));
    settle(instance);
    const layerId = instance.draw.features.get(ids[0])?.layerId as string;
    expect(rowIdsOf(instance, layerId)).toEqual(ids);
    const record = recordFrame(instance).filter((r) => r.layerId === layerId);
    expect(record.length).toBeGreaterThan(1);
    // One run after the other, each group from its first row to its last, the groups in order
    let groupIndex = 0;
    let next = 0;
    for (const range of record) {
      expect(range.kind).toBe('rows');
      if (range.groupIndex !== groupIndex) {
        expect(range.groupIndex).toBe(groupIndex + 1);
        groupIndex = range.groupIndex;
        next = 0;
      }
      expect(range.from).toBe(next);
      next = range.to;
    }
    const view = instance.store.tables.get(layerId);
    const drawn = record.reduce((sum, range) => sum + range.to - range.from, 0);
    expect(drawn).toBe(view?.rowCount);
  });

  it('writes the row of a feature whose value changed into its chunk, and no other row', () => {
    const instance = instanceOf();
    const ids = idsOf(instance.draw.features.createMany(gridPoints(3_000) as never));
    settle(instance);
    const renderer = rendererOf(instance);
    const bytes = { sub: 0 };
    const work = statsDuring(renderer, () => {
      instance.gl.reset();
      instance.draw.features.update(ids[1_234], {
        geometry: { type: 'Point', coordinates: [0.123, 0.456] },
      });
      settle(instance);
      bytes.sub =
        (instance.gl.calls.get('bufferSubData') ?? 0) +
        (instance.gl.calls.get('texSubImage2D') ?? 0);
    });
    expect(work).toMatchObject({ rowsWrittenInPlace: 1, rowsPacked: 1, chunksBuilt: 0 });
    expect(instance.gl.calls.get('bufferData') ?? 0).toBe(0);
    expect(bytes.sub).toBeGreaterThan(0);
  });

  it('writes the state of the rows only when this client hides or selects, not the chunks', () => {
    const instance = instanceOf();
    const ids = idsOf(instance.draw.features.createMany(interleaved(3_000) as never));
    settle(instance);
    const renderer = rendererOf(instance);
    const selected = statsDuring(renderer, () => {
      instance.draw.selection.set('feature', [ids[10]]);
      settle(instance);
    });
    expect(selected).toMatchObject({ chunksBuilt: 0, rowsPacked: 0, stateRowsWritten: 1 });
    expect(selected.statesUploaded).toBeGreaterThan(0);
    const hidden = statsDuring(renderer, () => {
      instance.draw.hidden.add(ids[20]);
      settle(instance);
    });
    expect(hidden).toMatchObject({ chunksBuilt: 0, rowsPacked: 0, stateRowsWritten: 1 });
    expect(hidden.statesUploaded).toBeGreaterThan(0);
  });

  it('builds the chunks again over the frames within the budget, drawing the old ones meanwhile', () => {
    const instance = instanceOf();
    instance.draw.features.createMany(interleaved(10_000) as never);
    settle(instance);
    const renderer = rendererOf(instance);
    const before = recordFrame(instance);
    // Every step of a build takes longer than the budget of a frame
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      now += 1_000;
      return now;
    });
    renderer.reclassify();
    const frames: Array<{ built: number; drawn: number }> = [];
    for (
      let frame = 0;
      frame < 30 && (frames.length === 0 || instance.draw.hasPendingWork());
      frame++
    ) {
      const record: TableDrawRecord[] = [];
      renderer.recordDraws(record);
      const work = statsDuring(renderer, () => instance.map.render());
      renderer.recordDraws(null);
      frames.push({ built: work.chunksBuilt, drawn: record.length });
    }
    vi.restoreAllMocks();
    expect(frames.length).toBeGreaterThan(2);
    // At most one build a frame, every chunk built once, and every frame draws every row
    for (const frame of frames) {
      expect(frame.built).toBeLessThanOrEqual(1);
      expect(frame.drawn).toBe(before.length);
    }
    expect(frames.reduce((sum, f) => sum + f.built, 0)).toBe(before.length);
    expect(instance.draw.hasPendingWork()).toBe(false);
  });

  it('draws fewer than 64 rows written in the frame, more by the frame the work is done, and then asks for no frame', () => {
    const instance = instanceOf();
    instance.draw.features.createMany(gridPoints(1_000) as never);
    settle(instance);
    const layerId = instance.draw.layers.list()[0].id;
    const rowsDrawn = (record: TableDrawRecord[]): number =>
      record.filter((r) => r.layerId === layerId).reduce((sum, r) => sum + r.to - r.from, 0);
    // 10 rows go to the delta of the layer: drawn in the frame they are written
    instance.draw.features.createMany(
      Array.from({ length: 10 }, (_, i) => ({
        type: 'Point',
        geometry: { type: 'Point', coordinates: [0.5 + i * 0.001, 0.5] },
      })) as never,
    );
    expect(rowsDrawn(recordFrame(instance))).toBe(1_010);
    settle(instance);
    // 500 rows go into row groups of their own: drawn from the frame they are taken in
    instance.draw.features.createMany(
      Array.from({ length: 500 }, (_, i) => ({
        type: 'Point',
        geometry: { type: 'Point', coordinates: [-0.5 + i * 0.001, -0.5] },
      })) as never,
    );
    const frames = settle(instance);
    expect(frames).toBeLessThanOrEqual(4);
    expect(rowsDrawn(recordFrame(instance))).toBe(1_510);
    const repaint = instance.map.map.triggerRepaint as unknown as ReturnType<typeof vi.fn>;
    repaint.mockClear();
    instance.map.render();
    instance.map.render();
    expect(repaint).not.toHaveBeenCalled();
  });
});

describe('the drawing by kind after the program of the rows failed', () => {
  it('is told once per instance', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const instance = instanceOf();
    const renderer = rendererOf(instance);
    // The program of the rows cannot be made
    const rows = (renderer as unknown as { rows: { ensureShader(data: unknown): boolean } | null })
      .rows;
    expect(rows).toBeNull();
    instance.map.render();
    const made = (renderer as unknown as { rows: { failed: boolean } }).rows;
    Object.defineProperty(made, 'failed', { get: () => true });
    Object.defineProperty(made, 'ready', { get: () => false });
    instance.draw.features.createMany(interleaved(300) as never);
    settle(instance);
    instance.map.render();
    const told = warn.mock.calls.filter((call) => String(call[0]).includes('drawn by kind'));
    expect(told).toHaveLength(1);
    // Another instance tells it again
    const other = instanceOf();
    other.map.render();
    const otherRows = (rendererOf(other) as unknown as { rows: object }).rows;
    Object.defineProperty(otherRows, 'failed', { get: () => true });
    Object.defineProperty(otherRows, 'ready', { get: () => false });
    other.draw.features.createMany(interleaved(30) as never);
    settle(other);
    expect(
      warn.mock.calls.filter((call) => String(call[0]).includes('drawn by kind')),
    ).toHaveLength(2);
  });
});

describe('the rows across the antimeridian', () => {
  /** Has the map of an instance look at `center` with a view `halfWidth` degrees to each side */
  function lookAt(instance: Instance, center: number, halfWidth: number): void {
    const map = instance.map.map as unknown as Record<string, unknown>;
    map.getCenter = () => ({ lng: center, lat: 0 });
    map.getBounds = () => new LngLatBounds([center - halfWidth, -0.1], [center + halfWidth, 0.1]);
  }

  /** The x translations of the matrices of the chunks drawn in one draw in a frame */
  function copiesDrawn(instance: Instance): number[] {
    const rows = (rendererOf(instance) as unknown as { rows: Record<string, unknown> }).rows;
    const drawRange = rows.drawRange as (...args: unknown[]) => unknown;
    const out: number[] = [];
    rows.drawRange = (...args: unknown[]) => {
      out.push(
        ((args[4] as { mainMatrix: ArrayLike<number> }).mainMatrix as ArrayLike<number>)[12],
      );
      return drawRange.apply(rows, args);
    };
    instance.map.render();
    rows.drawRange = drawRange;
    return out;
  }

  /** Points from 179.8 to 180 and from -180 to -179.8, one write a side */
  function pointsAtTheLine(instance: Instance): void {
    for (const side of [1, -1]) {
      instance.draw.features.createMany(
        Array.from({ length: 100 }, (_, i) => ({
          type: 'Point',
          geometry: { type: 'Point', coordinates: [side * (179.8 + i * 0.002), (i % 10) * 0.01] },
        })) as never,
      );
    }
  }

  it('draws the rows on either side of the line on the copy the view shows them on', () => {
    const instance = instanceOf();
    lookAt(instance, 179.95, 0.1);
    pointsAtTheLine(instance);
    settle(instance);
    const copies = copiesDrawn(instance);
    // The rows stored east of -180 are drawn on the copy east of the line (one turn on)
    expect(copies.some((x) => x === 0)).toBe(true);
    expect(copies.some((x) => Math.abs(x - 1) < 1e-6)).toBe(true);
  });

  it('draws one copy away from the line', () => {
    const instance = instanceOf();
    lookAt(instance, 179.95, 0.1);
    pointsAtTheLine(instance);
    settle(instance);
    lookAt(instance, 139.7, 0.1);
    const copies = copiesDrawn(instance);
    expect(copies.every((x) => x === 0)).toBe(true);
  });
});

describe('the programs of the drawing by kind', () => {
  /**
   * The SHA-256 of the sources of the programs of the renderers of the points, the lines and the
   * polygons compiled for a frame (each source hashed, the hashes sorted and joined by commas),
   * as they were before the layers were drawn from their rows
   */
  const SOURCES_BEFORE = 'c9b999d0d642e7595ca27122074ae93749a70c940add6e9dba7d5cec2966b81c';

  it('are compiled from the same sources as before, to the letter', () => {
    const counting = createCountingGL().gl as unknown as Record<string, unknown>;
    const sources: string[] = [];
    const gl = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'shaderSource') {
            return (_shader: unknown, source: string) => {
              sources.push(source);
            };
          }
          return counting[prop as string];
        },
      },
    ) as unknown as WebGL2RenderingContext;
    const map = createDrawingMapStub(gl);
    const options = { store: createStore() };
    checkDrawOptions(options);
    const engine = createEngine(
      map.map as MapLibreMap,
      toEngineOptions(options, () => false),
      {
        deferDefaultMode: true,
      },
    );
    const draw = createDrawOnEngine(engine, options);
    engine.enterDefaultMode();
    draw.features.createMany(gridPoints(10) as never);
    for (let frame = 0; frame < 5; frame++) map.render();
    draw.destroy();
    // The program of the rows is the one that is new
    const hashes = [...new Set(sources)]
      .filter((source) => !source.includes('u_row_base') && !source.includes('v_dash_range'))
      .map((source) => createHash('sha256').update(source).digest('hex'))
      .sort();
    expect(hashes.length).toBeGreaterThan(0);
    expect(createHash('sha256').update(hashes.join(',')).digest('hex')).toBe(SOURCES_BEFORE);
  });
});

describe('what the drawing reads of the rows', () => {
  const SRC = fileURLToPath(new URL('../..', import.meta.url));

  /** The source files of a folder of src/, tests left out */
  async function sourcesOf(folder: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const name of await readdir(dir)) {
        const path = join(dir, name);
        if ((await stat(path)).isDirectory()) await walk(path);
        else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(path);
      }
    };
    await walk(join(SRC, folder));
    return out;
  }

  /** The modules a file imports */
  async function importsOf(path: string): Promise<string[]> {
    const text = await readFile(path, 'utf8');
    return [...text.matchAll(/(?:import|export)[^'"]*?from\s+'([^']+)'/g)].map((m) => m[1]);
  }

  it('imports nothing of the tables of the rows, and reads the built-in Store through its reader only', async () => {
    const broken: string[] = [];
    for (const path of await sourcesOf('view')) {
      for (const module of await importsOf(path)) {
        if (module.startsWith('@sakuzu/kasane')) broken.push(`${relative(SRC, path)}: ${module}`);
        if (module.includes('/store/built-in/') && !module.endsWith('/built-in/drawn-rows.js')) {
          broken.push(`${relative(SRC, path)}: ${module}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});
