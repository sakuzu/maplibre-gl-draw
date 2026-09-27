// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for `draw.extensions`: the standard methods of every collection, the plugins and what
 * they add, the input of the plugins and the modes, and the interaction of the plugins
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMapStub, createSyntheticInput } from '../../../test-utils.js';
import type { Engine } from '../../engine.js';
import { createEngine } from '../../engine.js';
import type { Draw } from '../draw.js';
import { createDraw } from '../draw.js';
import { DrawError } from '../errors.js';
import type { ModeContext, PluginContext } from '../extension/context.js';
import type { FeatureTypeDefinition } from '../extension/feature-type.js';
import type { ModeFactory } from '../extension/mode.js';
import type { Plugin } from '../extension/plugin.js';
import type { CompanionProvider, HandleProvider, SnapProvider } from '../extension/provider.js';
import type { OverlayRenderer } from '../extension/render.js';
import type { ExtensionsCollections } from '../extensions.js';
import { createDrawOnEngine } from './create-draw.js';

/** An engine with its draw instance attached, as the entries build it */
function engineWithDraw(): Engine {
  const engine = createEngine(createMapStub().map, {}, { deferDefaultMode: true });
  createDrawOnEngine(engine);
  engine.enterDefaultMode();
  return engine;
}

const renderer = { onAdd() {}, draw() {}, onRemove() {} };

function featureType(type: string): FeatureTypeDefinition {
  return { type, geometry: 'Point', renderer };
}
function overlay(name: string): OverlayRenderer {
  return { name, onAdd() {}, draw() {}, onRemove() {} };
}
function snapProvider(name: string): SnapProvider {
  return { name, candidates: () => [] };
}
function handleProvider(name: string): HandleProvider {
  return { name, handles: () => [], onDrag: () => null };
}
function companionProvider(name: string): CompanionProvider {
  return { name, has: () => false, draw() {}, hitTest: () => null };
}
function plugin(name: string, extra: Partial<Plugin> = {}): Plugin {
  return { name, onAdd() {}, ...extra };
}

/** The error a call throws */
function errorOf(fn: () => unknown): DrawError {
  try {
    fn();
  } catch (error) {
    return error as DrawError;
  }
  throw new Error('it did not throw');
}

let stub: ReturnType<typeof createMapStub>;
let draw: Draw;

beforeEach(() => {
  vi.useFakeTimers();
  stub = createMapStub();
  draw = createDraw(stub.map);
});

afterEach(() => {
  draw.destroy();
  vi.useRealTimers();
});

/** One collection whose members are named, with how to make a member of it */
type NamedCase = [
  string,
  (extensions: ExtensionsCollections) => {
    get(name: string): unknown;
    list(): unknown[];
    count(): number;
    has(name: string): boolean;
    add(value: never): () => void;
    addMany(values: readonly never[]): () => void;
    remove(name: string): boolean;
    removeMany(names: readonly string[]): boolean;
  },
  (name: string) => unknown,
];

const NAMED: NamedCase[] = [
  ['plugins', (e) => e.plugins, plugin],
  ['featureTypes', (e) => e.featureTypes, featureType],
  ['overlays', (e) => e.overlays, overlay],
  ['snapProviders', (e) => e.snapProviders, snapProvider],
  ['handleProviders', (e) => e.handleProviders, handleProvider],
  ['companionProviders', (e) => e.companionProviders, companionProvider],
];

describe.each(NAMED)('extensions.%s', (_kind, collectionOf, make) => {
  const add = (name: string) => collectionOf(draw.extensions).add(make(name) as never);

  it('adds, reads and counts, and the returned function removes', () => {
    const collection = collectionOf(draw.extensions);
    const remove = add('a');
    expect(collection.has('a')).toBe(true);
    expect(collection.count()).toBe(1);
    expect(collection.get('a')).toBeDefined();
    expect(collection.list()).toHaveLength(1);
    remove();
    remove();
    expect(collection.has('a')).toBe(false);
    expect(collection.get('a')).toBeUndefined();
    expect(collection.count()).toBe(0);
  });

  it('throws already-exists for a name that is taken', () => {
    add('a');
    expect(errorOf(() => add('a')).code).toBe('already-exists');
  });

  it('adds all or none with addMany', () => {
    const collection = collectionOf(draw.extensions);
    add('b');
    const error = errorOf(() => collection.addMany([make('a'), make('b')] as never[]));
    expect(error.code).toBe('already-exists');
    expect(collection.has('a')).toBe(false);
    const remove = collection.addMany([make('c'), make('d')] as never[]);
    expect(collection.count()).toBe(3);
    remove();
    expect(collection.count()).toBe(1);
  });

  it('removes by name, and throws not-found for a missing one', () => {
    const collection = collectionOf(draw.extensions);
    add('a');
    add('b');
    expect(errorOf(() => collection.remove('x')).code).toBe('not-found');
    expect(errorOf(() => collection.removeMany(['a', 'x'])).code).toBe('not-found');
    expect(collection.count()).toBe(2);
    expect(collection.removeMany(['a', 'b'])).toBe(true);
    expect(collection.count()).toBe(0);
  });
});

describe('extensions.modes', () => {
  const probe: ModeFactory = () => ({});

  it('has the built-in modes written to the contract', () => {
    expect(draw.extensions.modes.list()).toEqual(
      expect.arrayContaining(['draw_point', 'draw_circle', 'draw_freehand']),
    );
  });

  it('adds a mode that setMode enters, and removes it', () => {
    const remove = draw.extensions.modes.add('probe', probe);
    expect(draw.extensions.modes.get('probe')).toBe(probe);
    expect(draw.setMode('probe')).toBe(true);
    remove();
    expect(draw.getMode()).toBe('select');
    expect(draw.extensions.modes.has('probe')).toBe(false);
  });

  it('refuses a name a mode of the engine has, and a missing name', () => {
    expect(errorOf(() => draw.extensions.modes.add('select', probe)).code).toBe('already-exists');
    expect(errorOf(() => draw.extensions.modes.remove('nothing')).code).toBe('not-found');
    expect(errorOf(() => draw.extensions.modes.add('', probe)).code).toBe('invalid-input');
  });

  it('adds several modes at once, all or none', () => {
    expect(() =>
      draw.extensions.modes.addMany([
        { name: 'one', factory: probe },
        { name: 'draw_line', factory: probe },
      ]),
    ).toThrow(DrawError);
    expect(draw.extensions.modes.has('one')).toBe(false);
    draw.extensions.modes.addMany([
      { name: 'one', factory: probe },
      { name: 'two', factory: probe },
    ]);
    expect(draw.extensions.modes.removeMany(['one', 'two'])).toBe(true);
  });
});

describe('extensions.featureTypes', () => {
  it('refuses the name of a built-in type', () => {
    expect(errorOf(() => draw.extensions.featureTypes.add(featureType('Point'))).code).toBe(
      'already-exists',
    );
  });
});

describe('extensions.plugins', () => {
  it('gives the API of a plugin', () => {
    draw.extensions.plugins.add(plugin('p', { api: { answer: 42 } }));
    expect(draw.extensions.plugins.getApi<{ answer: number }>('p')?.answer).toBe(42);
    expect(draw.extensions.plugins.getApi('nothing')).toBeUndefined();
  });

  it('removes what a plugin added, and ends its subscriptions, when it is removed', () => {
    const heard = vi.fn();
    const onRemove = vi.fn();
    draw.extensions.plugins.add(
      plugin('p', {
        onAdd(ctx: PluginContext) {
          ctx.extensions.modes.add('plugin_mode', () => ({}));
          ctx.extensions.overlays.add(overlay('plugin_overlay'));
          ctx.extensions.featureTypes.add(featureType('pin'));
          ctx.on('mode.changed', heard);
        },
        onRemove,
      }),
    );
    expect(draw.extensions.modes.has('plugin_mode')).toBe(true);
    expect(draw.extensions.overlays.has('plugin_overlay')).toBe(true);
    draw.setMode('plugin_mode');
    expect(heard).toHaveBeenCalledWith({ mode: 'plugin_mode', previous: 'select' });

    draw.extensions.plugins.remove('p');
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(draw.extensions.modes.has('plugin_mode')).toBe(false);
    expect(draw.extensions.overlays.has('plugin_overlay')).toBe(false);
    expect(draw.extensions.featureTypes.has('pin')).toBe(false);
    heard.mockClear();
    draw.setMode('draw_point');
    expect(heard).not.toHaveBeenCalled();
  });

  it('ends a subscription with off and runs a once subscription one time', () => {
    let ctx: PluginContext | null = null;
    draw.extensions.plugins.add(
      plugin('p', {
        onAdd(context) {
          ctx = context;
        },
      }),
    );
    const context = ctx as unknown as PluginContext;
    const every = vi.fn();
    const first = vi.fn();
    context.on('mode.changed', every);
    context.once('mode.changed', first);
    draw.setMode('draw_point');
    context.off('mode.changed', every);
    draw.setMode('select');
    expect(every).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1);
  });

  it('removes what it added when onAdd throws, and is not added', () => {
    const add = () =>
      draw.extensions.plugins.add(
        plugin('broken', {
          onAdd(ctx) {
            ctx.extensions.modes.add('half', () => ({}));
            throw new Error('broken');
          },
        }),
      );
    expect(add).toThrow('broken');
    expect(draw.extensions.plugins.has('broken')).toBe(false);
    expect(draw.extensions.modes.has('half')).toBe(false);
  });

  it('gives the context of a plugin the instance and the drawing control', () => {
    let ctx: PluginContext | null = null;
    draw.extensions.plugins.add(
      plugin('p', {
        onAdd(context) {
          ctx = context;
        },
      }),
    );
    const context = ctx as unknown as PluginContext;
    expect(context.draw).toBe(draw);
    expect(context.store.listLayers()).toHaveLength(1);
    expect(context.drawing.isDrawing()).toBe(false);
    expect(context.drawing.undoVertex()).toBe(false);
    expect(context.screen.project([1, 1])).toEqual([500, 200]);
    expect(context.screen.unproject([500, 200])).toEqual([1, 1]);
    expect(context.names.next('Layer')).toEqual(expect.any(String));
  });
});

describe('the input of the plugins and the modes', () => {
  let engine: Engine;

  beforeEach(() => {
    engine = engineWithDraw();
  });
  afterEach(() => {
    engine.destroy();
  });

  it('gives a click to the input of a plugin first; true consumes it before the mode', () => {
    const onClick = vi.fn(() => true);
    engine.extensions.collections.plugins.add(plugin('p', { input: { onClick } }));
    engine.modeManager.setMode('draw_point');

    createSyntheticInput(engine).click([1, 1]);

    expect(onClick).toHaveBeenCalledWith(
      expect.objectContaining({ lngLat: [1, 1], point: [500, 200], pointerType: 'mouse' }),
    );
    expect(engine.context.store.listFeatures()).toHaveLength(0);
    expect(engine.modeManager.getMode()).toBe('draw_point');
  });

  it('lets the mode receive a click the plugin does not consume', () => {
    engine.extensions.collections.plugins.add(plugin('p', { input: { onClick: () => false } }));
    engine.modeManager.setMode('draw_point');
    createSyntheticInput(engine).click([1, 1]);
    expect(engine.context.store.listFeatures()).toHaveLength(1);
  });

  it('gives a mode of the contract its input and a key it consumes', () => {
    const received: string[] = [];
    engine.extensions.collections.modes.add('probe', () => ({
      onPointerMove: () => {
        received.push('move');
      },
      onClick: (event) => {
        received.push(`click ${event.snapped.lngLat.join(',')}`);
        return true;
      },
      onKeyDown: (event) => {
        received.push(`key ${event.key}`);
        return true;
      },
    }));
    engine.modeManager.setMode('probe');
    createSyntheticInput(engine).click([1, 1]);
    createSyntheticInput(engine).key('a');
    expect(received).toEqual(['move', 'click 1,1', 'key a']);
  });

  it('interrupts a mode with an Escape it does not consume', () => {
    const onCancel = vi.fn();
    engine.extensions.collections.modes.add('probe', () => ({ onCancel }));
    engine.modeManager.setMode('probe');
    createSyntheticInput(engine).key('Escape');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('narrows a selection with interaction.filterSelection', () => {
    const { store } = engine.context;
    const layerId = store.listLayers()[0].id;
    const base = {
      layerId,
      groupId: undefined,
      properties: {},
      style: {},
      locked: false,
      visible: true,
    };
    store.createFeature({
      ...base,
      id: 'kept',
      type: 'Point',
      geometry: { type: 'Point', coordinates: [1, 1] },
    });
    store.createFeature({
      ...base,
      id: 'refused',
      type: 'Point',
      geometry: { type: 'Point', coordinates: [-1, -1] },
    });
    const filterSelection = vi.fn((ids: readonly string[]) => ids.filter((id) => id !== 'refused'));
    engine.extensions.collections.plugins.add(plugin('p', { interaction: { filterSelection } }));

    createSyntheticInput(engine).click([1, 1]);
    expect(store.getSelection().ids).toEqual(['kept']);

    createSyntheticInput(engine).click([-1, -1]);
    expect(filterSelection).toHaveBeenLastCalledWith(['refused']);
    expect(store.getSelection().ids).toEqual([]);
  });

  it('tells the plugins about a feature clicked again, with the feature and the click', () => {
    const { store } = engine.context;
    const layerId = store.listLayers()[0].id;
    store.createFeature({
      id: 'f',
      type: 'Point',
      geometry: { type: 'Point', coordinates: [1, 1] },
      layerId,
      groupId: undefined,
      properties: {},
      style: {},
      locked: false,
      visible: true,
    });
    const onFeatureClick = vi.fn(() => true);
    engine.extensions.collections.plugins.add(plugin('p', { interaction: { onFeatureClick } }));
    createSyntheticInput(engine).click([1, 1]);
    createSyntheticInput(engine).click([1, 1]);
    expect(onFeatureClick).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'f' }),
      expect.objectContaining({ lngLat: [1, 1] }),
    );
  });
});

describe('ModeContext.commitFeature', () => {
  let engine: Engine;
  let ctx: ModeContext;

  beforeEach(() => {
    engine = engineWithDraw();
    engine.extensions.collections.modes.add('probe', (context) => {
      ctx = context;
      return { writes: true };
    });
    engine.modeManager.setMode('probe');
  });
  afterEach(() => {
    engine.destroy();
  });

  it('gives a new feature the writable layer, an ID, the automatic name and the zoom', () => {
    const feature = ctx.commitFeature({
      type: 'Point',
      geometry: { type: 'Point', coordinates: [1, 1] },
    });
    expect(feature?.layerId).toBe(engine.context.getWritableLayerId());
    expect(feature?.id).toEqual(expect.any(String));
    expect(feature?.properties.name).toEqual(expect.any(String));
    expect(feature?.properties['maplibre-gl-draw:createdZoom']).toBe(10);
  });

  it('keeps the name and the ID given, and the ID of the preview', () => {
    ctx.preview.set({ type: 'Point', geometry: { type: 'Point', coordinates: [1, 1] } });
    const pending = engine.context.store.getTentative()?.pendingFeatureId;
    expect(pending).toEqual(expect.any(String));
    const feature = ctx.commitFeature({
      type: 'Point',
      geometry: { type: 'Point', coordinates: [1, 1] },
      properties: { name: 'mine' },
    });
    expect(feature?.id).toBe(pending);
    expect(feature?.properties.name).toBe('mine');
    expect(engine.context.store.getTentative()).toBeNull();
  });

  it('falls back to another writable layer when the active one is locked', () => {
    const { store } = engine.context;
    const active = store.listLayers()[0].id;
    store.createLayer({
      id: 'other',
      name: 'other',
      visible: true,
      locked: false,
      opacity: 1,
      items: [],
      styleRule: undefined,
      metadata: undefined,
    });
    store.updateLayer(active, { locked: true });
    const feature = ctx.commitFeature({
      type: 'Point',
      geometry: { type: 'Point', coordinates: [0, 0] },
    });
    expect(feature?.layerId).toBe('other');
  });

  it('refuses when no layer can be written, drops the drawing and returns to select', () => {
    const { store } = engine.context;
    store.updateLayer(store.listLayers()[0].id, { locked: true });
    ctx.preview.set({ type: 'Point', geometry: { type: 'Point', coordinates: [1, 1] } });
    expect(
      ctx.commitFeature({ type: 'Point', geometry: { type: 'Point', coordinates: [1, 1] } }),
    ).toBeNull();
    expect(store.getTentative()).toBeNull();
    expect(engine.modeManager.getMode()).toBe('select');
  });

  it('gives the look of the selection with CSS colors, the options over the defaults', () => {
    expect(ctx.selectionStyle.boundingBox.stroke.color).toMatch(/^#|^rgba\(/);
    expect(ctx.selectionStyle.boxSelection.strokeWidth).toEqual(expect.any(Number));
    ctx.draw.options.update({ selectionStyle: { boxSelection: { strokeColor: 'red' } } } as never);
    expect(ctx.selectionStyle.boxSelection.strokeColor).toBe('red');
  });

  it('refuses while the document is read-only', () => {
    engine.context.store.setReadOnly(true);
    expect(
      ctx.commitFeature({ type: 'Point', geometry: { type: 'Point', coordinates: [1, 1] } }),
    ).toBeNull();
    expect(engine.context.store.listFeatures()).toHaveLength(0);
  });
});

describe('the built-in modes written to the contract', () => {
  let engine: Engine;

  beforeEach(() => {
    engine = engineWithDraw();
  });
  afterEach(() => {
    engine.destroy();
  });

  it('draws a point, selects it and returns to select', () => {
    engine.modeManager.setMode('draw_point');
    createSyntheticInput(engine).click([1, 1]);
    const [feature] = engine.context.store.listFeatures();
    expect(feature.geometry).toEqual({ type: 'Point', coordinates: [1, 1] });
    expect(engine.context.store.getSelection().ids).toEqual([feature.id]);
    expect(engine.modeManager.getMode()).toBe('select');
  });

  it('draws a circle with two clicks', () => {
    engine.modeManager.setMode('draw_circle');
    createSyntheticInput(engine).click([1, 1]);
    expect(engine.context.store.getTentative()?.type).toBe('Circle');
    createSyntheticInput(engine).click([1, 1.5]);
    const [feature] = engine.context.store.listFeatures();
    expect(feature.type).toBe('Circle');
    expect(feature.properties['maplibre-gl-draw:radiusMeters']).toBeGreaterThan(1000);
    expect(engine.modeManager.getMode()).toBe('select');
  });

  it('drops the circle being drawn on Escape, and leaves on a second Escape', () => {
    engine.modeManager.setMode('draw_circle');
    createSyntheticInput(engine).click([1, 1]);
    createSyntheticInput(engine).key('Escape');
    expect(engine.context.store.getTentative()).toBeNull();
    expect(engine.modeManager.getMode()).toBe('draw_circle');
    createSyntheticInput(engine).key('Escape');
    expect(engine.modeManager.getMode()).toBe('select');
  });
});

describe('what a drawing mode reads and shows', () => {
  let ctx: ModeContext;

  beforeEach(() => {
    draw.extensions.modes.add('probe', (context) => {
      ctx = context;
      return {};
    });
    draw.setMode('probe');
  });

  it('shows the placed vertices and a highlighted one in the preview', () => {
    ctx.preview.set(
      {
        type: 'LineString',
        geometry: {
          type: 'LineString',
          coordinates: [
            [0, 0],
            [1, 1],
            [2, 2],
          ],
        },
      },
      { confirmedVertices: 2, highlightVertex: 0 },
    );
    const tentative = draw.getStore() as unknown as {
      getTentative(): { confirmedCount?: number; highlightedVertexIndex?: number } | null;
    };
    expect(tentative.getTentative()).toEqual(
      expect.objectContaining({ confirmedCount: 2, highlightedVertexIndex: 0 }),
    );
    expect(ctx.drawing.isDrawing()).toBe(true);
    ctx.preview.clear();
    expect(ctx.drawing.isDrawing()).toBe(false);
  });

  it('gives the writable layer, or null when none can be written', () => {
    const layer = draw.layers.list()[0];
    expect(ctx.writableLayer()?.id).toBe(layer.id);
    draw.layers.update(layer.id, { locked: true });
    expect(ctx.writableLayer()).toBeNull();
  });

  it('gives the rows of the datasets to trace along, with their dataset and index', () => {
    draw.datasets.add({
      id: 'roads',
      rows: [
        {
          type: 'Feature',
          id: 'r1',
          geometry: {
            type: 'LineString',
            coordinates: [
              [0, 0],
              [1, 1],
            ],
          },
          properties: {},
        },
        {
          type: 'Feature',
          id: 'r2',
          geometry: {
            type: 'LineString',
            coordinates: [
              [50, 50],
              [51, 51],
            ],
          },
          properties: {},
        },
      ],
    });
    const rows = ctx.listTraceRows([-0.5, -0.5, 0.5, 0.5]);
    expect(rows).toEqual([
      { datasetId: 'roads', rowIndex: 0, row: expect.objectContaining({ id: 'r1' }) },
    ]);
    expect(draw.datasets.get('roads')?.findRow('r1')).toBe(0);
  });
});

describe('features.list and count by extent', () => {
  it('keep the features whose extent meets the extent', () => {
    draw.features.createMany([
      { type: 'Point', geometry: { type: 'Point', coordinates: [1, 1] }, id: 'in' },
      { type: 'Point', geometry: { type: 'Point', coordinates: [9, 9] }, id: 'out' },
      {
        type: 'LineString',
        geometry: {
          type: 'LineString',
          coordinates: [
            [-5, 0],
            [5, 0],
          ],
        },
        id: 'across',
      },
    ]);
    expect(draw.features.list({ bbox: [0, -1, 2, 2] }).map((f) => f.id)).toEqual(['in', 'across']);
    expect(draw.features.count({ bbox: [0, -1, 2, 2], type: 'Point' })).toBe(1);
    expect(errorOf(() => draw.features.list({ bbox: [0, 0] as never })).code).toBe('invalid-input');
  });
});
