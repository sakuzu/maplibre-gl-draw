// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The two variants of the program of the rows, on the GL that counts its calls: a chunk is marked
 * dashed just when a row of it is dashed or dotted (when it is packed, and when a row of it is
 * packed again with dashes; never unmarked until it is made again), it is drawn with the variant
 * that cuts the dashes just when it is marked, the two variants are made together once for a
 * projection, and a frame changes from one variant to the other at most about once a chunk
 */

import { LngLatBounds } from 'maplibre-gl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocumentLayer, DrawDocument, Feature, FeatureStyle } from '../../index.js';
import { createCountedInstance } from '../../test-utils.js';
import { type RowsChunk, RowsRenderer } from '../renderers/rows/rows-renderer.js';
import type { TableLayerRenderer } from './table-retained.js';

type Instance = ReturnType<typeof createCountedInstance>;

const instances: Instance[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const instance of instances.splice(0)) instance.draw.destroy();
});

// ============================================================================
// The documents
// ============================================================================

const CELL = 0.003;
const ORIGIN: [number, number] = [139.4, 35.6];

/** A generator of numbers from a seed (the same numbers on every run) */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

type Kind = 'point' | 'line' | 'polygon';

/** A feature of a kind in the cell `i` of a grid `columns` wide */
function featureAt(
  id: string,
  layerId: string,
  kind: Kind,
  i: number,
  columns: number,
  style: FeatureStyle,
): Feature {
  const x = ORIGIN[0] + (i % columns) * CELL;
  const y = ORIGIN[1] + Math.floor(i / columns) * CELL;
  const s = CELL * 0.8;
  const geometry: Feature['geometry'] =
    kind === 'point'
      ? { type: 'Point', coordinates: [x + s / 2, y + s / 2] }
      : kind === 'line'
        ? {
            type: 'LineString',
            coordinates: [
              [x, y],
              [x + s / 3, y + s],
              [x + (2 * s) / 3, y],
              [x + s, y + s],
            ],
          }
        : {
            type: 'Polygon',
            coordinates: [
              [
                [x, y],
                [x + s, y],
                [x + s, y + s],
                [x, y + s],
                [x, y],
              ],
            ],
          };
  const type = kind === 'point' ? 'Point' : kind === 'line' ? 'LineString' : 'Polygon';
  return {
    id,
    type,
    geometry,
    layerId,
    groupId: undefined,
    properties: {},
    style,
    visible: true,
    locked: false,
  };
}

function layerOf(id: string, items: readonly string[]): DocumentLayer {
  return {
    id,
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    items,
    styleRule: undefined,
    metadata: undefined,
  };
}

function documentOf(layers: ReadonlyArray<{ id: string; features: Feature[] }>): DrawDocument {
  return {
    version: '3.0.0',
    layers: layers.map((layer) =>
      layerOf(
        layer.id,
        layer.features.map((f) => f.id),
      ),
    ),
    layerOrder: layers.map((layer) => layer.id),
    groups: [],
    features: layers.flatMap((layer) => layer.features),
    files: {},
  };
}

/** The kinds of ten features in turn: 5 polygons, 3 lines and 2 points */
const MIXED: readonly Kind[] = [
  'polygon',
  'line',
  'point',
  'polygon',
  'line',
  'polygon',
  'line',
  'polygon',
  'point',
  'polygon',
];

/**
 * `n` features of mixed kinds in one layer, with `dashedEvery`, one in that many of the features
 * that are not points dashed
 */
function mixedLayer(id: string, n: number, dashedEvery = 0, from = 0): Feature[] {
  const columns = Math.max(1, Math.ceil(Math.sqrt(n)));
  let notPoints = 0;
  return Array.from({ length: n }, (_, i) => {
    const kind = MIXED[i % MIXED.length];
    const dashed = kind !== 'point' && dashedEvery > 0 && notPoints++ % dashedEvery === 0;
    return featureAt(
      `${id}-${i}`,
      id,
      kind,
      from + i,
      columns,
      dashed ? { lineStyle: 'dashed' } : {},
    );
  });
}

/** Whether a feature is drawn dashed or dotted */
function isDashed(feature: Feature): boolean {
  const style = feature.style;
  if (!style.lineStyle || style.lineStyle === 'solid') return false;
  if (feature.type === 'LineString') return true;
  if (feature.type === 'Polygon') return style.strokeWidth !== 0;
  return false;
}

/**
 * Layers of random sizes, each of random features: solid, dashed and dotted lines, polygons with
 * a solid, a dashed or a dotted outline, polygons without an outline (dashed or not) and points
 */
function randomLayers(seed: number, count: number): Array<{ id: string; features: Feature[] }> {
  const random = seeded(seed);
  const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)];
  const styles: Array<[Kind, FeatureStyle]> = [
    ['line', {}],
    ['line', { lineStyle: 'dashed' }],
    ['line', { lineStyle: 'dotted' }],
    ['polygon', {}],
    ['polygon', { lineStyle: 'dashed' }],
    ['polygon', { lineStyle: 'dotted' }],
    ['polygon', { strokeWidth: 0 }],
    ['polygon', { strokeWidth: 0, lineStyle: 'dashed' }],
    ['point', {}],
  ];
  const layers: Array<{ id: string; features: Feature[] }> = [];
  let cell = 0;
  for (let l = 0; l < count; l++) {
    const id = `layer-${l}`;
    const size = 1 + Math.floor(random() * 30);
    // A layer in three is solid only
    const solid = l % 3 === 0;
    const features: Feature[] = [];
    for (let i = 0; i < size; i++) {
      const [kind, style] = solid
        ? pick([styles[0], styles[3], styles[6], styles[8]])
        : pick(styles);
      features.push(featureAt(`${id}-${i}`, id, kind, cell++, 40, style));
    }
    layers.push({ id, features });
  }
  return layers;
}

// ============================================================================
// The instance
// ============================================================================

function instanceOver(): Instance {
  const instance = createCountedInstance({ defaultMode: 'select' });
  instances.push(instance);
  const map = instance.map.map as unknown as Record<string, unknown>;
  map.getCenter = () => ({ lng: ORIGIN[0] + 0.3, lat: ORIGIN[1] + 0.3 });
  map.getBounds = () => new LngLatBounds(ORIGIN, [ORIGIN[0] + 0.6, ORIGIN[1] + 0.6]);
  return instance;
}

function rendererOf(instance: Instance): TableLayerRenderer {
  const renderer = instance.engine.customLayer.getTableRenderer();
  if (!renderer) throw new Error('the instance draws no rows');
  return renderer;
}

/** The renderer of the rows of an instance */
function rowsOf(instance: Instance): RowsRenderer {
  const rows = (rendererOf(instance) as unknown as { rows: RowsRenderer | null }).rows;
  if (!rows) throw new Error('the instance has no renderer of the rows yet');
  return rows;
}

function settle(instance: Instance): void {
  for (let frame = 1; frame <= 2_000; frame++) {
    instance.map.render();
    if (!instance.draw.hasPendingWork()) return;
  }
  throw new Error('the drawing still has work after 2,000 frames');
}

async function load(instance: Instance, document: DrawDocument): Promise<void> {
  if (!(await instance.draw.document.load(document))) throw new Error('not loaded');
  settle(instance);
}

/** The chunks of rows drawn, by the layer they are of */
function chunksByLayer(instance: Instance): Map<string, RowsChunk[]> {
  const renderer = rendererOf(instance) as unknown as {
    layers: Map<
      string,
      {
        groups: Map<number, { chunks: Array<{ batches: RowsChunk | null }> | null }>;
        extras: Map<unknown, { chunks: Array<{ batches: RowsChunk | null }> | null }>;
      }
    >;
  };
  const out = new Map<string, RowsChunk[]>();
  for (const [layerId, layer] of renderer.layers) {
    const chunks: RowsChunk[] = [];
    for (const group of [...layer.groups.values(), ...layer.extras.values()]) {
      for (const chunk of group.chunks ?? []) if (chunk.batches) chunks.push(chunk.batches);
    }
    out.set(layerId, chunks);
  }
  return out;
}

/** The chunks drawn in one frame, each with whether the variant that cuts the dashes drew it */
function drawnInFrame(instance: Instance): Array<{ chunk: RowsChunk; dashed: boolean }> {
  const drawn: Array<{ chunk: RowsChunk; dashed: boolean }> = [];
  const drawRange = RowsRenderer.prototype.drawRange;
  const spy = vi.spyOn(RowsRenderer.prototype, 'drawRange').mockImplementation(function (
    this: RowsRenderer,
    ...args: Parameters<RowsRenderer['drawRange']>
  ) {
    const before = this.dashedDraws;
    const draws = this.draws;
    const result = drawRange.apply(this, args);
    if (this.draws > draws) drawn.push({ chunk: args[0], dashed: this.dashedDraws > before });
    return result;
  });
  instance.map.render();
  spy.mockRestore();
  return drawn;
}

/** The changes of the variant of the program in one frame, and the chunks drawn */
function switchesInFrame(instance: Instance): { switches: number; chunks: number } {
  const rows = rowsOf(instance);
  const before = rows.programSwitches;
  const drawn = drawnInFrame(instance);
  return {
    switches: rows.programSwitches - before,
    chunks: new Set(drawn.map((d) => d.chunk)).size,
  };
}

// ============================================================================
// The tests
// ============================================================================

describe('the mark of a chunk with dashes', () => {
  it('is set just when a row of the chunk is dashed or dotted', async () => {
    const instance = instanceOver();
    settle(instance);
    const layers = randomLayers(3, 40);
    await load(instance, documentOf(layers));
    const chunks = chunksByLayer(instance);
    let marked = 0;
    for (const layer of layers) {
      const ofLayer = chunks.get(layer.id) ?? [];
      expect(ofLayer.length, layer.id).toBe(1);
      const expected = layer.features.some(isDashed);
      expect(ofLayer[0].dashed, layer.id).toBe(expected);
      if (expected) marked++;
    }
    // Both kinds of chunk are there
    expect(marked).toBeGreaterThan(0);
    expect(marked).toBeLessThan(layers.length);
  });

  it('is set when a solid row of a chunk without dashes is written dashed in place, and kept when it is written solid again', async () => {
    const instance = instanceOver();
    settle(instance);
    await load(instance, documentOf([{ id: 'lines', features: mixedLayer('lines', 200) }]));
    const [chunk] = chunksByLayer(instance).get('lines') ?? [];
    expect(chunk.dashed).toBe(false);
    const renderer = rendererOf(instance);
    const built = renderer.stats.chunksBuilt;
    const inPlace = renderer.stats.rowsWrittenInPlace;
    instance.draw.features.update('lines-1', { style: { lineStyle: 'dashed' } });
    settle(instance);
    expect(chunksByLayer(instance).get('lines')).toEqual([chunk]);
    expect(renderer.stats.chunksBuilt).toBe(built);
    expect(renderer.stats.rowsWrittenInPlace).toBeGreaterThan(inPlace);
    expect(chunk.dashed).toBe(true);
    instance.draw.features.update('lines-1', { style: { lineStyle: 'solid' } });
    settle(instance);
    expect(chunksByLayer(instance).get('lines')).toEqual([chunk]);
    expect(renderer.stats.chunksBuilt).toBe(built);
    expect(chunk.dashed).toBe(true);
  });

  it('does not change with a style written in place with the same layout', async () => {
    const instance = instanceOver();
    settle(instance);
    await load(
      instance,
      documentOf([
        { id: 'solid', features: mixedLayer('solid', 100) },
        { id: 'dashed', features: mixedLayer('dashed', 100, 10, 100) },
      ]),
    );
    const before = chunksByLayer(instance);
    const [solid] = before.get('solid') ?? [];
    const [dashed] = before.get('dashed') ?? [];
    expect([solid.dashed, dashed.dashed]).toEqual([false, true]);
    const patchStyle = vi.spyOn(RowsRenderer.prototype, 'patchRowStyle');
    // A solid line of another color, and a polygon with a dashed outline of another fill
    instance.draw.features.update('solid-1', { style: { strokeColor: '#ff0000' } });
    instance.draw.features.update('dashed-0', {
      style: { fillColor: '#00ff00', lineStyle: 'dashed' },
    });
    settle(instance);
    expect(patchStyle).toHaveBeenCalledTimes(2);
    const after = chunksByLayer(instance);
    expect(after.get('solid')).toEqual([solid]);
    expect(after.get('dashed')).toEqual([dashed]);
    expect([solid.dashed, dashed.dashed]).toEqual([false, true]);
  });
});

describe('the variant of the program a chunk is drawn with', () => {
  it('cuts the dashes just for the chunks marked dashed', async () => {
    const instance = instanceOver();
    settle(instance);
    await load(instance, documentOf(randomLayers(5, 40)));
    const drawn = drawnInFrame(instance);
    expect(drawn.length).toBeGreaterThanOrEqual(40);
    expect(drawn.some((d) => d.dashed)).toBe(true);
    expect(drawn.some((d) => !d.dashed)).toBe(true);
    for (const { chunk, dashed } of drawn) expect(dashed).toBe(chunk.dashed);
  });

  for (const n of [2_000, 20_000]) {
    it(`never cuts the dashes for a document of ${n} features without dashes`, async () => {
      const instance = instanceOver();
      settle(instance);
      await load(instance, documentOf([{ id: 'mixed', features: mixedLayer('mixed', n) }]));
      const rows = rowsOf(instance);
      const draws = rows.draws;
      const drawn = drawnInFrame(instance);
      expect(drawn.length).toBeGreaterThan(0);
      expect(rows.draws).toBeGreaterThan(draws);
      expect(rows.dashedDraws).toBe(0);
    });
  }
});

describe('the variants of the program of the rows', () => {
  it('are made together, two for a projection, and not again when the first dashed row comes', async () => {
    const instance = instanceOver();
    instance.map.render();
    const rows = rowsOf(instance);
    expect(rows.programsMade).toBe(2);
    await load(instance, documentOf([{ id: 'solid', features: mixedLayer('solid', 300) }]));
    expect(rows.programsMade).toBe(2);
    expect(rows.dashedDraws).toBe(0);
    instance.draw.features.create({
      type: 'LineString',
      geometry: {
        type: 'LineString',
        coordinates: [
          [ORIGIN[0], ORIGIN[1]],
          [ORIGIN[0] + 0.01, ORIGIN[1] + 0.01],
        ],
      },
      style: { lineStyle: 'dashed' },
    } as never);
    settle(instance);
    expect(rows.dashedDraws).toBeGreaterThan(0);
    expect(rows.programsMade).toBe(2);
    // Another projection makes the two of it
    expect(rows.ensureShader({ variantName: 'globe', vertexShaderPrelude: '', define: '' })).toBe(
      true,
    );
    expect(rows.programsMade).toBe(4);
  });
});

describe('the changes of the variant of the program in a frame', () => {
  for (const n of [2_000, 20_000]) {
    it(`are at most the chunks and a few, for ${n} features one in ten of them dashed`, async () => {
      const instance = instanceOver();
      settle(instance);
      await load(instance, documentOf([{ id: 'mixed', features: mixedLayer('mixed', n, 10) }]));
      const { switches, chunks } = switchesInFrame(instance);
      expect(chunks).toBeGreaterThan(0);
      expect(switches).toBeLessThanOrEqual(chunks + 2);
    });
  }

  it('are at most the chunks and a few, for layers with dashes and layers without them in turn', async () => {
    const instance = instanceOver();
    settle(instance);
    const layers = Array.from({ length: 30 }, (_, l) => ({
      id: `layer-${l}`,
      features: mixedLayer(`layer-${l}`, 50, l % 2 === 0 ? 0 : 10, l * 50),
    }));
    await load(instance, documentOf(layers));
    const { switches, chunks } = switchesInFrame(instance);
    expect(chunks).toBe(30);
    // The variant changes from a layer to the next
    expect(switches).toBeGreaterThanOrEqual(chunks - 1);
    expect(switches).toBeLessThanOrEqual(chunks + 2);
  });
});
