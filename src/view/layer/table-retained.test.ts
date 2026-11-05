// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The drawing of a layer held as rows of columns
 *
 * The invariant of the order: the ranges drawn, in the order they are drawn, are the rows of the
 * layer in their order, each once. It holds with the kinds of the runs interleaved, with rows
 * drawn at once between retained ones, with the chunks out of view skipped, and with the ranges
 * cut at places (each cut is one more draw and nothing else). The renderers are mocks that
 * record what they are asked to build and draw.
 */

import type { ProjectionData } from 'maplibre-gl';
import { beforeEach, describe, expect, it } from 'vitest';
import { draggedRowsOf } from '../../feature-table/dragged-rows.js';
import {
  createFeatureTablesStore,
  type FeatureTablesInternals,
  featureTablesInternals,
} from '../../feature-table/feature-tables.js';
import type { LayerTable } from '../../feature-table/layer-table.js';
import type { EnuEdit } from '../../geometry/enu-transforms.js';
import type { Feature, Layer } from '../../shared/types/model.js';
import { createRowBlockDataBuilder } from '../../table/row-group-builder.js';
import {
  createTestDrawer,
  feature,
  orderKey,
  rowOfFeature,
  seededRandom,
  tablesOfFeatures,
} from '../../test-utils.js';
import { createFeatureCompanionRegistry } from '../feature-companion.js';
import type { RetainedRendererSet } from '../renderers/retained.js';
import { TerrainContext } from '../terrain/context.js';
import { setTerrainCameraMoving } from '../terrain/state.js';
import type { StoreRetainedDrawDeps } from './store-retained-immediate.js';
import { type TableDrawRecord, TableLayerRenderer } from './table-retained.js';

const LAYER: Layer = {
  id: 'layer',
  name: 'layer',
  visible: true,
  locked: false,
  opacity: 1,
  items: [],
  styleRule: undefined,
  metadata: undefined,
};

const PROJECTION = {} as ProjectionData;

/** A GL that accepts every call (the textures of the state of the rows) */
function createGL(): WebGL2RenderingContext & { uploads: number } {
  const target = { uploads: 0 } as Record<string, unknown>;
  return new Proxy(target, {
    get(t, prop: string) {
      if (prop in t) return t[prop];
      if (prop === 'texSubImage2D') return () => (t.uploads as number)++ && undefined;
      if (prop.startsWith('create')) return () => ({});
      if (prop === 'getParameter') return () => 4;
      if (/^[A-Z_0-9]+$/.test(prop)) return 1;
      return () => undefined;
    },
  }) as unknown as WebGL2RenderingContext & { uploads: number };
}

interface Draw {
  kind: string;
  batch: number;
  from: number;
  to: number;
}

/** Renderers that record their builds and draws, and a target that records the features drawn at once */
function createRenderers() {
  let next = 1;
  const draws: Draw[] = [];
  const builds: string[] = [];
  const disposed: number[] = [];
  const immediate: string[] = [];
  const batch = (kind: string, rowFirst: Int32Array) => {
    builds.push(kind);
    return { id: next++, kind, rowFirst } as unknown;
  };
  const drawRange = (b: unknown, from: number, to: number): void => {
    const { id, kind } = b as { id: number; kind: string };
    draws.push({ kind, batch: id, from, to });
  };
  const resolver = createTestDrawer();
  const renderers: RetainedRendererSet = {
    point: {
      buildRetained: () => null,
      drawRetained: () => {},
      disposeRetained: (b) => disposed.push((b as unknown as { id: number }).id),
      buildRetainedRows: (_i, _c, _o, rowFirst) => batch('point', rowFirst) as never,
      drawRetainedRange: (b, from, to) => drawRange(b, from, to),
    },
    line: {
      buildRetainedBatch: () => null,
      drawRetainedBatch: () => {},
      disposeRetainedBatch: (b) => disposed.push((b as unknown as { id: number }).id),
      buildRetainedRows: (_a, _o, rowFirst) => batch('line', rowFirst) as never,
      drawRetainedRange: (b, from, to) => drawRange(b, from, to),
    },
    polygon: {
      buildRetained: () => null,
      drawRetained: () => {},
      disposeRetained: (b) => disposed.push((b as unknown as { id: number }).id),
      createRetainedRows: (_v, _i, _o, rowFirst) => batch('polygon', rowFirst) as never,
      writeRetainedRows: () => {},
      drawRetainedRange: (b, from, to) => drawRange(b, from, to),
    },
    styles: resolver,
    viewport: () => [800, 600],
  };
  const deps: StoreRetainedDrawDeps = {
    renderers,
    batchManager: {
      beginFrame: () => {},
      processFeature: (f: Feature) => {
        immediate.push(f.id);
        return true;
      },
      endFrame: () => {},
    },
    customRenderers: new Map(),
    customRendererContext: {} as never,
    companions: createFeatureCompanionRegistry(),
  };
  return { renderers, deps, draws, builds, disposed, immediate };
}

/** Features of every kind of run, interleaved at random (the order is the order given) */
function interleaved(count: number, seed: number): Feature[] {
  const random = seededRandom(seed);
  const out: Feature[] = [];
  for (let i = 0; i < count; i++) {
    const x = random() * 10;
    const y = random() * 10;
    const pick = random();
    if (pick < 0.3) out.push(feature(`p${i}`, 'Point', [x, y]));
    else if (pick < 0.55) {
      out.push(
        feature(`l${i}`, 'LineString', [
          [x, y],
          [x + 0.1, y + 0.1],
        ]),
      );
    } else if (pick < 0.85) {
      out.push(
        feature(`g${i}`, 'Polygon', [
          [
            [x, y],
            [x + 0.1, y],
            [x + 0.1, y + 0.1],
            [x, y],
          ],
        ]),
      );
    } else {
      // A dashed line is drawn at once
      out.push(
        feature(
          `d${i}`,
          'LineString',
          [
            [x, y],
            [x + 0.1, y],
          ],
          { style: { lineStyle: 'dashed' } },
        ),
      );
    }
  }
  return out;
}

let terrain: TerrainContext;

beforeEach(() => {
  terrain = new TerrainContext();
});

function setup(features: Feature[], targetRows?: number) {
  const { internals, table } = tablesOfFeatures('layer', features, targetRows);
  const mocks = createRenderers();
  const renderer = new TableLayerRenderer({
    gl: createGL(),
    terrain,
    requestRepaint: () => {},
    buildBudgetMs: Number.POSITIVE_INFINITY,
  });
  const frame = (bounds?: { minX: number; minY: number; maxX: number; maxY: number }) => {
    const record: TableDrawRecord[] = [];
    renderer.recordDraws(record);
    renderer.beginFrame();
    renderer.drawLayer(
      internals,
      table,
      LAYER,
      { projectionData: PROJECTION, zoom: 10, bounds },
      mocks.deps,
    );
    renderer.endFrame();
    renderer.recordDraws(null);
    return record;
  };
  return { internals, table, renderer, frame, ...mocks };
}

/** The rows the ranges cover, in order, as `group:row` */
function coverage(table: LayerTable, record: TableDrawRecord[]): string[] {
  const out: string[] = [];
  for (const entry of record) {
    for (let row = entry.from; row < entry.to; row++) out.push(`${entry.groupIndex}:${row}`);
  }
  void table;
  return out;
}

/** Every row of the layer in its order, as `group:row` */
function allRows(table: LayerTable): string[] {
  const out: string[] = [];
  for (let g = 0; g < table.groupCount; g++) {
    for (let row = 0; row < table.groupAt(g).data.length; row++) out.push(`${g}:${row}`);
  }
  return out;
}

/** Whether the ranges come in the order of the layer, each after the previous one */
function inOrder(record: TableDrawRecord[]): boolean {
  for (let i = 1; i < record.length; i++) {
    const a = record[i - 1];
    const b = record[i];
    if (b.groupIndex < a.groupIndex) return false;
    if (b.groupIndex === a.groupIndex && b.from < a.to) return false;
  }
  return true;
}

describe('the order of the drawing of a layer held as rows', () => {
  it('draws every row once, in the order of the layer, whatever kinds are interleaved', () => {
    for (const seed of [1, 2, 3]) {
      const { table, frame, draws, immediate } = setup(interleaved(400, seed), 64);
      expect(table.groupCount).toBeGreaterThan(3);
      // The state of the groups is written before the main pass of the frame after the one
      // they are first seen in, and their chunks are drawn from that frame on
      frame();
      draws.length = 0;
      immediate.length = 0;
      const record = frame();
      expect(inOrder(record)).toBe(true);
      expect(coverage(table, record)).toEqual(allRows(table));
      // Every retained range is one draw of its batch, and every dashed line was drawn at once
      expect(draws.length).toBe(record.filter((entry) => entry.kind !== 'immediate').length);
      expect(immediate.every((id) => id.startsWith('d'))).toBe(true);
      expect(immediate.length).toBe(
        interleaved(400, seed).filter((f) => f.id.startsWith('d')).length,
      );
    }
  });

  it('skips the chunks out of view and keeps the order of the others', () => {
    const { table, frame } = setup(interleaved(300, 4), 50);
    frame({ minX: 0, minY: 0, maxX: 3, maxY: 3 });
    const record = frame({ minX: 0, minY: 0, maxX: 3, maxY: 3 });
    const retained = record.filter((entry) => entry.kind !== 'immediate');
    expect(retained.length).toBeGreaterThan(0);
    expect(coverage(table, retained).length).toBeLessThan(allRows(table).length);
    expect(inOrder(record)).toBe(true);
  });

  it('cuts the ranges in view at the places asked for, one more draw per cut, the rows unchanged', () => {
    const features = interleaved(500, 5);
    const plain = setup(features, 100);
    plain.frame();
    const before = plain.frame();
    for (const cuts of [1, 10, 100]) {
      const { renderer, frame, draws } = setup(features, 100);
      renderer.setArtificialCuts(cuts);
      frame(); // builds
      frame(); // writes the state of the groups
      draws.length = 0;
      const record = frame();
      expect(inOrder(record)).toBe(true);
      expect(coverage(plain.table, record)).toEqual(coverage(plain.table, before));
      const retainedBefore = before.filter((entry) => entry.kind !== 'immediate').length;
      expect(draws.length).toBe(retainedBefore + cuts);
    }
  });

  it('draws nothing of a chunk that is not built while the camera moves, and builds it once it stops', () => {
    const { frame, builds } = setup(interleaved(50, 6));
    setTerrainCameraMoving(terrain, true);
    const moving = frame();
    expect(moving.filter((entry) => entry.kind !== 'immediate')).toEqual([]);
    expect(builds).toEqual([]);
    setTerrainCameraMoving(terrain, false);
    const still = frame();
    expect(still.filter((entry) => entry.kind !== 'immediate').length).toBeGreaterThan(0);
  });

  it('keeps drawing the batches of a chunk made again until the new ones are built', () => {
    const { renderer, frame, builds, disposed } = setup(interleaved(80, 7));
    frame();
    const first = builds.length;
    renderer.invalidateAll(true);
    setTerrainCameraMoving(terrain, true);
    // While the camera moves nothing is built, and the old batches keep being drawn
    const record = frame();
    expect(record.filter((entry) => entry.kind !== 'immediate').length).toBeGreaterThan(0);
    expect(disposed).toEqual([]);
    setTerrainCameraMoving(terrain, false);
    frame();
    expect(builds.length).toBe(first * 2);
    expect(disposed.length).toBe(first);
  });

  it('builds the chunks over the frames within the budget', () => {
    const { internals, table } = tablesOfFeatures('layer', interleaved(200, 8), 20);
    const mocks = createRenderers();
    const renderer = new TableLayerRenderer({
      gl: createGL(),
      terrain,
      requestRepaint: () => {},
      buildBudgetMs: 0,
    });
    let frames = 0;
    do {
      renderer.beginFrame();
      renderer.drawLayer(
        internals,
        table,
        LAYER,
        { projectionData: PROJECTION, zoom: 10, bounds: undefined },
        mocks.deps,
      );
      renderer.endFrame();
      frames++;
    } while (renderer.hasPendingWork && frames < 1000);
    expect(renderer.hasPendingWork).toBe(false);
    expect(frames).toBeGreaterThan(2);
  });

  it('draws the row groups added, in order, from the first frame', () => {
    const { tables, writer } = createFeatureTablesStore();
    const internals = featureTablesInternals(tables) as FeatureTablesInternals;
    const builder = createRowBlockDataBuilder({ targetRows: 20 });
    interleaved(100, 9).forEach((f, i) => {
      builder.addRow(rowOfFeature(f, orderKey(i)));
    });
    writer.addRowBlocks('layer', builder.finish());
    const mocks = createRenderers();
    const renderer = new TableLayerRenderer({
      gl: createGL(),
      terrain,
      requestRepaint: () => {},
      buildBudgetMs: 0,
    });
    const taken: number[] = [];
    let frames = 0;
    do {
      const record: TableDrawRecord[] = [];
      renderer.recordDraws(record);
      renderer.beginFrame();
      renderer.advanceTables(internals);
      const table = internals.layerTable('layer') as LayerTable;
      taken.push(table.groupCount);
      renderer.drawLayer(
        internals,
        table,
        LAYER,
        { projectionData: PROJECTION, zoom: 10, bounds: undefined },
        mocks.deps,
      );
      renderer.endFrame();
      renderer.recordDraws(null);
      expect(inOrder(record)).toBe(true);
      frames++;
    } while ((renderer.hasPendingWork || internals.hasQueuedBlocks) && frames < 1000);
    // Taken in when they were added: every group is in the first frame
    expect(taken[0]).toBe(5);
    expect(internals.hasQueuedBlocks).toBe(false);
  });
});

describe('the run of the retained draws of a layer', () => {
  it('is opened around the layer, ended around every chunk drawn at once, and ended', () => {
    const { frame, renderers, deps, draws, immediate } = setup(interleaved(300, 9), 50);
    frame(); // builds
    const events: string[] = [];
    const run = {
      begin: () => events.push('begin'),
      forget: () => events.push('forget'),
      end: () => events.push('end'),
    };
    const drawn = draws.length;
    const drawnAtOnce = immediate.length;
    (renderers as { run?: unknown }).run = run;
    const recordDraw = (kind: 'point' | 'line' | 'polygon') => {
      const original = renderers[kind].drawRetainedRange as (...args: unknown[]) => void;
      renderers[kind].drawRetainedRange = ((...args: unknown[]) => {
        events.push('draw');
        original(...args);
      }) as never;
    };
    recordDraw('point');
    recordDraw('line');
    recordDraw('polygon');
    const processFeature = deps.batchManager.processFeature;
    deps.batchManager.processFeature = (f: Feature, selected: boolean) => {
      events.push('immediate');
      return processFeature(f, selected);
    };
    frame();
    expect(draws.length - drawn).toBeGreaterThan(0);
    expect(immediate.length - drawnAtOnce).toBeGreaterThan(0);
    expect(events[0]).toBe('begin');
    expect(events[events.length - 1]).toBe('end');
    expect(events).not.toContain('forget');
    // The retained draws are made in the run, the features drawn at once outside it, and the
    // run is opened again after them
    let open = false;
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      if (event === 'begin') open = true;
      else if (event === 'end') open = false;
      else if (event === 'draw') expect(open).toBe(true);
      else if (event === 'immediate') {
        expect(open).toBe(false);
        expect(['end', 'immediate']).toContain(events[i - 1]);
      }
    }
    for (let i = 1; i < events.length; i++) {
      if (events[i] === 'draw' && events[i - 1] !== 'draw') {
        expect(events[i - 1]).toBe('begin');
      }
    }
  });

  it('reads the size of the render target once per layer, however many chunks it draws', () => {
    const { frame, renderers, draws } = setup(interleaved(300, 12), 50);
    frame();
    let reads = 0;
    const viewport = renderers.viewport;
    renderers.viewport = () => {
      reads++;
      return viewport();
    };
    draws.length = 0;
    frame();
    expect(draws.length).toBeGreaterThan(10);
    expect(reads).toBe(1);
  });

  it('is ended when a draw throws', () => {
    const { frame, renderers } = setup(interleaved(50, 10));
    frame();
    const events: string[] = [];
    (renderers as { run?: unknown }).run = {
      begin: () => events.push('begin'),
      forget: () => events.push('forget'),
      end: () => events.push('end'),
    };
    const fail = () => {
      throw new Error('draw');
    };
    renderers.point.drawRetainedRange = fail;
    renderers.line.drawRetainedRange = fail;
    renderers.polygon.drawRetainedRange = fail;
    expect(() => frame()).toThrow('draw');
    expect(events[events.length - 1]).toBe('end');
  });
});

describe('the state of the rows', () => {
  function stateSetup() {
    const features = Array.from({ length: 6 }, (_, i) => feature(`p${i}`, 'Point', [i, i]));
    const { internals, table } = tablesOfFeatures('layer', features);
    const gl = createGL();
    const mocks = createRenderers();
    const renderer = new TableLayerRenderer({ gl, terrain, requestRepaint: () => {} });
    const draw = (): void => {
      renderer.beginFrame();
      renderer.drawLayer(
        internals,
        table,
        LAYER,
        { projectionData: PROJECTION, zoom: 10, bounds: undefined },
        mocks.deps,
      );
    };
    return { internals, table, gl, draw, mocks };
  }

  it('uploads the texture of a group before a main pass, only when its state changed', () => {
    const { internals, gl, draw } = stateSetup();
    // A group seen for the first time gets its texture before the next main pass
    draw();
    expect(gl.uploads).toBe(0);
    draw();
    expect(gl.uploads).toBe(1);
    draw();
    expect(gl.uploads).toBe(1);
    const handle = (internals as FeatureTablesInternals).ids.handleOf('p2');
    internals.states.setHidden(Int32Array.of(handle), true);
    draw();
    expect(gl.uploads).toBe(2);
  });

  it('skips the hidden rows drawn at once and moves the moving ones', () => {
    const features = [
      feature(
        'a',
        'LineString',
        [
          [0, 0],
          [1, 0],
        ],
        { style: { lineStyle: 'dashed' } },
      ),
      feature(
        'b',
        'LineString',
        [
          [0, 1],
          [1, 1],
        ],
        { style: { lineStyle: 'dashed' } },
      ),
    ];
    const { internals, table } = tablesOfFeatures('layer', features);
    const mocks = createRenderers();
    const drawn: Feature[] = [];
    mocks.deps.batchManager.processFeature = (f: Feature) => {
      drawn.push(f);
      return true;
    };
    const renderer = new TableLayerRenderer({ gl: createGL(), terrain, requestRepaint: () => {} });
    const ids = internals.ids;
    internals.states.setHidden(Int32Array.of(ids.handleOf('a')), true);
    internals.states.setMoving(Int32Array.of(ids.handleOf('b')), 1);
    internals.states.setTranslation(1, 2, 3);
    renderer.beginFrame();
    renderer.drawLayer(
      internals,
      table,
      LAYER,
      { projectionData: PROJECTION, zoom: 10, bounds: undefined },
      mocks.deps,
    );
    expect(drawn.map((f) => f.id)).toEqual(['b']);
    expect((drawn[0].geometry as { coordinates: unknown }).coordinates).toEqual([
      [2, 4],
      [3, 4],
    ]);
  });
});

describe('the rows drawn at once while they are dragged in bulk', () => {
  it('are given to the renderer of their type moved, turned and resized as the drag draws them, with their rotation and scale when they turn and scale by them', () => {
    // A type of an extension at a point, with a rotation and a scale (a sign, a stamp), and a
    // point drawn at once (a picture)
    const features = [
      feature('n', 'Sign', [139.7, 35.6], {
        properties: { 'maplibre-gl-draw:rotation': 10, 'maplibre-gl-draw:scale': 2 },
      }),
      feature('p', 'Marker', [139.8, 35.7]),
    ];
    const edits: EnuEdit[] = [
      { kind: 'rotate', center: [139.75, 35.65], angleDegrees: 30 },
      { kind: 'scale', center: [139.6, 35.5], eastFactor: 1.5, northFactor: 0.75, sizeFactor: 1.5 },
    ];
    for (const transform of edits) {
      const { internals, table, tables } = tablesOfFeatures('layer', features);
      const mocks = createRenderers();
      const drawn: Feature[] = [];
      const extension = {
        name: 'extension',
        onAdd: () => {},
        onRemove: () => {},
        draw: (f: Feature) => drawn.push(f),
      };
      mocks.deps.customRenderers.set('Sign', extension as never);
      mocks.deps.customRenderers.set('Marker', extension as never);
      const handles = ['n', 'p'].map((id) => internals.ids.handleOf(id));
      internals.states.setMoving(Int32Array.from(handles), 2);
      // The sign turns and scales by its values, as the write of the drag decides
      internals.states.setByValues(Int32Array.of(handles[0]), true);
      internals.states.setTransform(2, transform);
      internals.states.setTranslation(2, 0.5, -0.25);
      const renderer = new TableLayerRenderer({
        gl: createGL(),
        terrain,
        requestRepaint: () => {},
      });
      renderer.beginFrame();
      renderer.drawLayer(
        internals,
        table,
        LAYER,
        { projectionData: PROJECTION, zoom: 10, bounds: undefined },
        mocks.deps,
      );
      const dragged = draggedRowsOf(tables);
      expect(drawn.map((f) => f.id)).toEqual(['n', 'p']);
      features.forEach((f, i) => {
        const at = (f.geometry as { coordinates: number[] }).coordinates;
        const expected = dragged?.position(handles[i], at) as number[];
        const coordinates = (drawn[i].geometry as { coordinates: number[] }).coordinates;
        expect(coordinates[0]).toBeCloseTo(expected[0], 6);
        expect(coordinates[1]).toBeCloseTo(expected[1], 6);
      });
      const properties = drawn[0].properties;
      // The rotation takes the angle (within [0, 360)), the scale the factor of the size
      expect(properties['maplibre-gl-draw:rotation']).toBe(transform.kind === 'rotate' ? 40 : 10);
      expect(properties['maplibre-gl-draw:scale']).toBe(transform.kind === 'scale' ? 3 : 2);
    }
  });
});

describe('the rows of a layer of xyz with an extension that answers from features', () => {
  it('are classified and drawn from features read with their z, without a throw', () => {
    const features = [
      feature('p', 'Point', [1, 2, 30], { properties: { kind: 'a' } }),
      feature('q', 'Point', [2, 2, 40]),
      feature(
        'l',
        'LineString',
        [
          [0, 0, 5],
          [1, 1, 6],
        ],
        { properties: { kind: 'b' } },
      ),
    ];
    const { internals, table } = tablesOfFeatures('layer', features, undefined, {
      dimensionsOf: () => 'xyz',
    });
    const mocks = createRenderers();
    const drawn: Feature[] = [];
    // A renderer that takes some points, and a provider of companions, both from features
    mocks.deps.customRenderers.set('Point', {
      name: 'some points',
      onAdd: () => {},
      onRemove: () => {},
      draw: (f: Feature) => drawn.push(f),
      appliesTo: (f: Feature) => f.properties.kind === 'a',
    } as never);
    mocks.deps.companions.register({
      id: 'c',
      has: (f: Feature) => f.properties.kind === 'b',
      draw: () => {},
      hitTest: () => null,
      onCompanionClick: () => true,
    });
    mocks.deps.batchManager.processFeature = (f: Feature) => {
      drawn.push(f);
      return true;
    };
    const renderer = new TableLayerRenderer({
      gl: createGL(),
      terrain,
      requestRepaint: () => {},
      buildBudgetMs: Number.POSITIVE_INFINITY,
    });
    const frame = (): void => {
      renderer.beginFrame();
      renderer.drawLayer(
        internals,
        table,
        LAYER,
        { projectionData: PROJECTION, zoom: 10, bounds: undefined },
        mocks.deps,
      );
      renderer.endFrame();
    };
    expect(frame).not.toThrow();
    expect(frame).not.toThrow();
    const byId = new Map(drawn.map((f) => [f.id, f]));
    const coordinatesOf = (id: string): unknown =>
      (byId.get(id)?.geometry as { coordinates?: unknown } | undefined)?.coordinates;
    expect(coordinatesOf('p')).toEqual([1, 2, 30]);
    expect(coordinatesOf('l')).toEqual([
      [0, 0, 5],
      [1, 1, 6],
    ]);
  });
});
