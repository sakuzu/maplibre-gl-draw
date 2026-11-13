// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for `draw.extensions`: the standard methods of every collection, the plugins and what
 * they add, the input of the plugins and the modes, and the interaction of the plugins
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeatureTypeRenderer } from '../../extension/renderers.js';
import { pixelsToMeters } from '../../geometry/units.js';
import {
  setAnchorProjector,
  setScreenScaleFrame,
  setViewProjector,
} from '../../shared/math/index.js';
import { MemoryContractStore } from '../../store/memory.js';
import type { StoreChange } from '../../store/types.js';
import { writesOf } from '../../test-support/writes.js';
import { createMapStub, createSyntheticInput } from '../../test-utils.js';
import { customRendererOf } from '../../view/layer/store-retained-classify.js';
import { computeBoundingBox } from '../../view/ui/selection-ui/index.js';
import type { Draw } from '../draw.js';
import { createDraw } from '../draw.js';
import { DrawError } from '../errors.js';
import type { Change } from '../events.js';
import type { ModeContext, PluginContext } from '../extension/context.js';
import type { FeatureTypeDefinition } from '../extension/feature-type.js';
import type { ModeFactory } from '../extension/mode.js';
import type { Plugin } from '../extension/plugin.js';
import type { CompanionProvider, HandleProvider, SnapProvider } from '../extension/provider.js';
import type { OverlayRenderer } from '../extension/render.js';
import type { Store } from '../extension/store.js';
import type { ExtensionsCollections } from '../extensions.js';
import type { StoredFeature as Feature } from '../model.js';
import { createDrawOnEngine } from './create-draw.js';
import type { Engine } from './engine.js';
import { createEngine } from './engine.js';

/** An engine with its draw instance attached, as the entries build it */
function engineWithDraw(): Engine {
  const engine = createEngine(createMapStub().map, {}, { deferDefaultMode: true });
  createDrawOnEngine(engine);
  engine.enterDefaultMode();
  return engine;
}

const render = (): void => {};

function featureType(type: string): FeatureTypeDefinition {
  return { type, geometry: 'Point', render };
}
function overlay(name: string): OverlayRenderer {
  return { name, draw() {} };
}
function snapProvider(name: string): SnapProvider {
  return { name, candidates: () => [] };
}
function handleProvider(name: string): HandleProvider {
  return { name, handles: () => [], onHandleDrag: () => null };
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

  it('throws alreadyExists for a name that is taken', () => {
    add('a');
    expect(errorOf(() => add('a')).code).toBe('alreadyExists');
  });

  it('adds all or none with addMany', () => {
    const collection = collectionOf(draw.extensions);
    add('b');
    const error = errorOf(() => collection.addMany([make('a'), make('b')] as never[]));
    expect(error.code).toBe('alreadyExists');
    expect(collection.has('a')).toBe(false);
    const remove = collection.addMany([make('c'), make('d')] as never[]);
    expect(collection.count()).toBe(3);
    remove();
    expect(collection.count()).toBe(1);
  });

  it('removes by name, and throws notFound for a missing one', () => {
    const collection = collectionOf(draw.extensions);
    add('a');
    add('b');
    expect(errorOf(() => collection.remove('x')).code).toBe('notFound');
    expect(errorOf(() => collection.removeMany(['a', 'x'])).code).toBe('notFound');
    expect(collection.count()).toBe(2);
    expect(collection.removeMany(['a', 'b'])).toBe(true);
    expect(collection.count()).toBe(0);
  });
});

describe('extensions.modes', () => {
  const probe: ModeFactory = () => ({});

  it('has the built-in modes written to the contract', () => {
    expect(draw.extensions.modes.list()).toEqual(
      expect.arrayContaining(['drawPoint', 'drawCircle', 'drawFreehand']),
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
    expect(errorOf(() => draw.extensions.modes.add('select', probe)).code).toBe('alreadyExists');
    expect(errorOf(() => draw.extensions.modes.remove('nothing')).code).toBe('notFound');
    expect(errorOf(() => draw.extensions.modes.add('', probe)).code).toBe('invalidInput');
  });

  it('adds several modes at once, all or none', () => {
    expect(() =>
      draw.extensions.modes.addMany([
        { name: 'one', factory: probe },
        { name: 'drawLine', factory: probe },
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
      'alreadyExists',
    );
  });
});

describe('extensions.featureTypes.override', () => {
  const square = {
    type: 'Polygon' as const,
    geometry: {
      type: 'Polygon' as const,
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
          [0, 0],
        ],
      ],
    },
  };

  /** A draw instance on an engine, with the renderers the engine registers */
  function setUp() {
    const engine = createEngine(createMapStub().map, {}, { deferDefaultMode: true });
    const instance = createDrawOnEngine(engine);
    engine.enterDefaultMode();
    const removed: string[] = [];
    const registered: string[] = [];
    const register = engine.customLayer.registerFeatureRenderer.bind(engine.customLayer);
    vi.spyOn(engine.customLayer, 'registerFeatureRenderer').mockImplementation((type, r) => {
      registered.push(type);
      const unregister = register(type, r);
      return () => {
        removed.push(type);
        unregister();
      };
    });
    const feature = writesOf(instance).features.create(square);
    if (!feature) throw new Error('not created');
    const selected = () => engine.context.store.getSelection().ids;
    return { engine, instance, registered, removed, selected, input: createSyntheticInput(engine) };
  }

  it('draws and hit tests a built-in type by the definition, and puts the type back', () => {
    const { instance, registered, removed, selected, input } = setUp();
    const hitTest = vi.fn(() => null);
    const restore = instance.extensions.featureTypes.override({
      type: 'Polygon',
      geometry: 'Polygon',
      render,
      hitTest,
    });
    expect(registered).toEqual(['Polygon']);
    expect(instance.extensions.featureTypes.has('Polygon')).toBe(true);
    expect(instance.extensions.featureTypes.list()).toEqual(['Polygon']);
    input.click([0.5, 0.5]);
    expect(hitTest).toHaveBeenCalled();
    expect(selected()).toEqual([]);

    restore();
    expect(removed).toEqual(['Polygon']);
    expect(instance.extensions.featureTypes.has('Polygon')).toBe(false);
    input.click([0.5, 0.5]);
    expect(selected()).toHaveLength(1);
    // add keeps refusing the name
    expect(errorOf(() => instance.extensions.featureTypes.add(featureType('Polygon'))).code).toBe(
      'alreadyExists',
    );
    instance.destroy();
  });

  it('keeps the built-in hit test for a definition without one, and is removed by name', () => {
    const { instance, removed, selected, input } = setUp();
    instance.extensions.featureTypes.override({ type: 'Polygon', geometry: 'Polygon', render });
    input.click([0.5, 0.5]);
    expect(selected()).toHaveLength(1);
    expect(instance.extensions.featureTypes.remove('Polygon')).toBe(true);
    expect(removed).toEqual(['Polygon']);
    instance.destroy();
  });

  it('is put back when the plugin that overrode the type is removed', () => {
    const { instance, removed } = setUp();
    instance.extensions.plugins.add(
      plugin('overrider', {
        onAdd(ctx: PluginContext) {
          ctx.extensions.featureTypes.override({ type: 'Circle', geometry: 'Point', render });
        },
      }),
    );
    expect(instance.extensions.featureTypes.get('Circle')?.geometry).toBe('Point');
    instance.extensions.plugins.remove('overrider');
    expect(removed).toEqual(['Circle']);
    expect(instance.extensions.featureTypes.has('Circle')).toBe(false);
    instance.destroy();
  });

  it('frames an override by the kind of its footprint, whatever its geometry', () => {
    const { engine, instance } = setUp();
    const { extensions } = engine.context.selectionScope;
    // A point laid on the map as a square of 0.2 degrees, and an image as a mark of the screen
    instance.extensions.featureTypes.override({
      type: 'Point',
      geometry: 'Point',
      render,
      footprint: (feature) => {
        const [x, y] = (feature.geometry as GeoJSON.Point).coordinates;
        return {
          kind: 'ground',
          corners: {
            topLeft: [x - 0.1, y + 0.1],
            topRight: [x + 0.1, y + 0.1],
            bottomRight: [x + 0.1, y - 0.1],
            bottomLeft: [x - 0.1, y - 0.1],
          },
        };
      },
    });
    instance.extensions.featureTypes.override({
      type: 'Image',
      geometry: 'Point',
      render,
      footprint: (feature) => ({
        kind: 'screen',
        position: (feature.geometry as GeoJSON.Point).coordinates,
        halfWidthPx: 15,
        halfHeightPx: 5,
      }),
    });
    const point = writesOf(instance).features.create({
      type: 'Point',
      geometry: { type: 'Point', coordinates: [1, 1] },
    }) as Feature;
    const image = writesOf(instance).features.create({
      type: 'Image',
      geometry: { type: 'Point', coordinates: [2, 2] },
    }) as Feature;
    const box = computeBoundingBox(point as never, extensions);
    expect(box?.topLeft[0]).toBeCloseTo(0.9, 12);
    expect(box?.bottomRight[1]).toBeCloseTo(0.9, 12);
    expect(box?.center).toEqual([1, 1]);
    // An image of the screen keeps no area on the map and is the size it gives on the screen
    expect(computeBoundingBox(image as never, extensions)).toEqual({
      topLeft: [2, 2],
      topRight: [2, 2],
      bottomRight: [2, 2],
      bottomLeft: [2, 2],
      center: [2, 2],
    });
    expect(extensions.resolvePointFrameExtent(image as never)).toEqual({
      halfWidth: 15,
      halfHeight: 5,
    });
    instance.destroy();
  });

  it('takes only the features appliesTo accepts, and leaves the others to the built-in type', () => {
    const { engine, instance, selected, input } = setUp();
    let captured: FeatureTypeRenderer | null = null;
    const register = engine.customLayer.registerFeatureRenderer;
    vi.mocked(register).mockImplementation((_type, r) => {
      captured = r;
      return () => {};
    });
    const hitTest = vi.fn(() => null);
    const snapCandidates = vi.fn(() => []);
    const handles = vi.fn(() => []);
    instance.extensions.featureTypes.override({
      type: 'Polygon',
      geometry: 'Polygon',
      render,
      appliesTo: (feature) => feature.properties.kind === 'special',
      hitTest,
      footprint: (feature) => ({
        kind: 'screen',
        position: (feature.geometry as GeoJSON.Polygon).coordinates[0][0],
        halfWidthPx: 10,
        halfHeightPx: 10,
      }),
      bbox: () => [-50, -50, 50, 50],
      handles,
      snapCandidates,
    });
    const plain = engine.context.store.listFeatures()[0];
    const special = writesOf(instance).features.create({
      ...square,
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [2, 2],
            [3, 2],
            [3, 3],
            [2, 3],
            [2, 2],
          ],
        ],
      },
      properties: { kind: 'special' },
    });
    if (!special) throw new Error('not created');
    const stored = engine.context.store.getFeature(special.id);
    if (!stored) throw new Error('not stored');

    // Drawing: the plain feature stays on the batches of the built-in type
    const engineRenderer = captured as unknown as FeatureTypeRenderer;
    expect(engineRenderer.appliesTo?.(plain)).toBe(false);
    expect(engineRenderer.appliesTo?.(stored)).toBe(true);
    const customTypes = new Map([['Polygon', engineRenderer]]);
    expect(customRendererOf(customTypes, plain)).toBeUndefined();
    expect(customRendererOf(customTypes, stored)).toBe(engineRenderer);

    // Hit testing: the plain feature is hit by the built-in test, the other by the definition
    input.click([0.5, 0.5]);
    expect(selected()).toEqual([plain.id]);
    expect(hitTest).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: plain.id }),
      expect.anything(),
    );
    input.click([2.5, 2.5]);
    expect(hitTest).toHaveBeenCalledWith(
      expect.objectContaining({ id: special.id }),
      expect.anything(),
    );
    expect(selected()).toEqual([]);

    // The selection frame: the built-in extent, and the one of bounds
    const { extensions } = engine.context.selectionScope;
    expect(computeBoundingBox(plain, extensions)?.topLeft).toEqual([0, 1]);
    expect(computeBoundingBox(stored, extensions)?.topLeft).not.toEqual([2, 3]);

    // The extent on the map, the snapping candidates and the handles
    expect(
      writesOf(instance)
        .features.list({ bbox: [40, 40, 41, 41] })
        .map((f) => f.id),
    ).toEqual([special.id]);
    expect(engine.context.snapTargets.forFeature(plain)).toBeUndefined();
    expect(engine.context.snapTargets.forFeature(stored)).toBeDefined();
    const provider = engine.context.selectionScope.auxiliaryHandles.list()[0];
    provider.getHandles(plain, {} as never);
    expect(handles).not.toHaveBeenCalled();
    provider.getHandles(stored, {} as never);
    expect(handles).toHaveBeenCalledTimes(1);
    instance.destroy();
  });

  it('ignores appliesTo in a type that is added', () => {
    const { instance, input } = setUp();
    const hitTest = vi.fn(() => null);
    instance.extensions.featureTypes.add({
      type: 'pin',
      geometry: 'Point',
      render,
      appliesTo: () => false,
      hitTest,
    });
    writesOf(instance).features.create({
      type: 'pin',
      geometry: { type: 'Point', coordinates: [5, 5] },
    });
    input.click([5, 5]);
    expect(hitTest).toHaveBeenCalled();
    instance.destroy();
  });

  it('refuses a type that is not built in, another geometry, and a second override', () => {
    const types = draw.extensions.featureTypes;
    expect(errorOf(() => types.override(featureType('pin'))).code).toBe('invalidInput');
    expect(errorOf(() => types.override(featureType('MultiPoint'))).code).toBe('invalidInput');
    expect(
      errorOf(() => types.override({ type: 'Circle', geometry: 'Polygon', render })).code,
    ).toBe('invalidInput');
    expect(
      errorOf(() => types.override({ type: 'Image', geometry: 'Point', render: 1 } as never)).code,
    ).toBe('invalidInput');
    types.override(featureType('Image'));
    expect(errorOf(() => types.override(featureType('Image'))).code).toBe('alreadyExists');
    expect(types.has('Image')).toBe(true);
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
          ctx.on('readOnly.changed', heard);
        },
        onRemove,
      }),
    );
    expect(draw.extensions.modes.has('plugin_mode')).toBe(true);
    expect(draw.extensions.overlays.has('plugin_overlay')).toBe(true);
    draw.setReadOnly(true);
    expect(heard).toHaveBeenCalledWith({ readOnly: true });

    draw.extensions.plugins.remove('p');
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(draw.extensions.modes.has('plugin_mode')).toBe(false);
    expect(draw.extensions.overlays.has('plugin_overlay')).toBe(false);
    expect(draw.extensions.featureTypes.has('pin')).toBe(false);
    heard.mockClear();
    draw.setReadOnly(false);
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
    context.on('readOnly.changed', every);
    context.once('readOnly.changed', first);
    draw.setReadOnly(true);
    context.off('readOnly.changed', every);
    draw.setReadOnly(false);
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
    // The shape being drawn is draw.drawing, reached through ctx.draw, with no second way to it
    expect('drawing' in context).toBe(false);
    expect(context.store.listLayers()).toHaveLength(1);
    expect(context.draw.drawing.isDrawing()).toBe(false);
    expect(context.draw.drawing.undoVertex()).toBe(false);
    expect(context.screen.project([1, 1])).toEqual([500, 200]);
    expect(context.screen.unproject([500, 200])).toEqual([1, 1]);
    expect(context.names.next('Layer')).toEqual(expect.any(String));
  });

  it('has no way to send an event: the events are those of the library only', () => {
    let ctx: PluginContext | null = null;
    draw.extensions.plugins.add(
      plugin('counter', {
        onAdd(context) {
          ctx = context;
        },
      }),
    );
    expect('emit' in (ctx as unknown as PluginContext)).toBe(false);
    // A name that is not an event of the library is refused
    expect(() =>
      (ctx as unknown as PluginContext).on('counter.changed' as never, () => {}),
    ).toThrow(expect.objectContaining({ code: 'invalidInput' }));
  });

  it('answers for the screen in the frame drawn last', () => {
    let ctx: PluginContext | null = null;
    draw.extensions.plugins.add(
      plugin('p', {
        onAdd(context) {
          ctx = context;
        },
      }),
    );
    const { screen } = ctx as unknown as PluginContext;
    const map = draw.getMap();
    // A frame drawn at another view than the camera of the map now
    setScreenScaleFrame(map, { zoom: 3.5, centerLatitude: 0, transition: 0 });
    setViewProjector(map, {
      project: () => ({ x: 7, y: 9 }),
      unproject: (_x, _y, near) => ({ lng: near.lng + 1, lat: near.lat }),
    });
    try {
      expect(screen.zoom).toBe(3.5);
      expect(screen.project([1, 1])).toEqual([7, 9]);
      expect(screen.unproject([500, 200])).toEqual([2, 1]);
      expect(screen.metersPerPixel([0, 0])).toBeCloseTo(pixelsToMeters(1, 3.5, 0), 6);
    } finally {
      setViewProjector(map, null);
      setScreenScaleFrame(map, null);
    }
  });

  it('gives the heights of the terrain, and projects onto it through the screen', () => {
    let ctx: PluginContext | null = null;
    draw.extensions.plugins.add(
      plugin('p', {
        onAdd(context) {
          ctx = context;
        },
      }),
    );
    const context = ctx as unknown as PluginContext;
    // Without terrain: the ground is at 0 and nothing hides a position
    expect(context.terrain.elevation([1, 1])).toBe(0);
    expect(context.terrain.occlusionOpacity([1, 1])).toBe(1);
    expect(context.terrain.generation()).toEqual(expect.any(Number));
    // One projection: the screen answers where a position is drawn, on the terrain when it is on
    expect(Object.keys(context.terrain).sort()).toEqual([
      'elevation',
      'generation',
      'occlusionOpacity',
    ]);
    const map = draw.getMap();
    setAnchorProjector(map, { project: () => ({ x: 7, y: 9 }) });
    try {
      expect(context.screen.project([1, 1])).toEqual([7, 9]);
    } finally {
      setAnchorProjector(map, null);
    }
    expect(context.screen.project([1, 1])).toEqual([500, 200]);
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
    engine.modeManager.setMode('drawPoint');

    createSyntheticInput(engine).click([1, 1]);

    expect(onClick).toHaveBeenCalledWith(
      expect.objectContaining({ lngLat: [1, 1], point: [500, 200], pointerType: 'mouse' }),
    );
    expect(engine.context.store.listFeatures()).toHaveLength(0);
    expect(engine.modeManager.getMode()).toBe('drawPoint');
  });

  it('lets the mode receive a click the plugin does not consume', () => {
    engine.extensions.collections.plugins.add(plugin('p', { input: { onClick: () => false } }));
    engine.modeManager.setMode('drawPoint');
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

  it('leaves the mode running on an Escape a plugin or the mode consumes', () => {
    const onCancel = vi.fn();
    let modeConsumes = true;
    engine.extensions.collections.modes.add('probe', () => ({
      onCancel,
      onKeyDown: () => modeConsumes,
    }));
    engine.modeManager.setMode('probe');
    createSyntheticInput(engine).key('Escape');
    expect(onCancel).not.toHaveBeenCalled();

    modeConsumes = false;
    engine.extensions.collections.plugins.add(
      plugin('escape', { input: { onKeyDown: (event) => event.key === 'Escape' } }),
    );
    createSyntheticInput(engine).key('Escape');
    expect(onCancel).not.toHaveBeenCalled();
    expect(engine.modeManager.getMode()).toBe('probe');
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
    const onSelectedFeatureClick = vi.fn(() => true);
    engine.extensions.collections.plugins.add(
      plugin('p', { selectMode: { onSelectedFeatureClick } }),
    );
    createSyntheticInput(engine).click([1, 1]);
    createSyntheticInput(engine).click([1, 1]);
    expect(onSelectedFeatureClick).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'f' }),
      expect.objectContaining({ lngLat: [1, 1] }),
    );
  });

  it('keeps the select mode still during an exclusive interaction, which Escape cancels', () => {
    let active = true;
    const cancel = vi.fn(() => {
      active = false;
    });
    const finish = vi.fn();
    engine.extensions.collections.plugins.add(
      plugin('p', { exclusive: { isActive: () => active, cancel, finish } }),
    );
    const input = createSyntheticInput(engine);
    input.key('Escape');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(finish).not.toHaveBeenCalled();
    // Not active any more: Escape is the select mode's again
    input.key('Escape');
    expect(cancel).toHaveBeenCalledTimes(1);
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
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [1, 1] },
      properties: {},
    });
    expect(feature?.properties['maplibre-gl-draw:layerId']).toBe(
      engine.context.getWritableLayerId(),
    );
    expect(feature?.id).toEqual(expect.any(String));
    expect(feature?.properties.name).toEqual(expect.any(String));
    expect(feature?.properties['maplibre-gl-draw:createdZoom']).toBe(10);
  });

  it('keeps the name and the ID given, and the ID of the preview', () => {
    ctx.preview.set({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [1, 1] },
      properties: {},
    });
    const pending = engine.context.shapes.drawing()?.pendingFeatureId;
    expect(pending).toEqual(expect.any(String));
    const feature = ctx.commitFeature({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [1, 1] },
      properties: { name: 'mine' },
    });
    expect(feature?.id).toBe(pending);
    expect(feature?.properties.name).toBe('mine');
    // The sketch that showed it ended with the write
    expect(engine.context.shapes.drawing()).toBeNull();
    expect(engine.sketches.count()).toBe(0);
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
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [0, 0] },
      properties: {},
    });
    expect(feature?.properties['maplibre-gl-draw:layerId']).toBe('other');
  });

  it('refuses when no layer can be written, drops the drawing and returns to select', () => {
    const { store } = engine.context;
    store.updateLayer(store.listLayers()[0].id, { locked: true });
    ctx.preview.set({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [1, 1] },
      properties: {},
    });
    expect(
      ctx.commitFeature({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [1, 1] },
        properties: {},
      }),
    ).toBeNull();
    expect(engine.context.shapes.drawing()).toBeNull();
    expect(engine.modeManager.getMode()).toBe('select');
  });

  it('gives the look of the selection with CSS colors, the options over the defaults', () => {
    expect(ctx.selectionStyle.box.stroke.color).toMatch(/^#|^rgba\(/);
    expect(ctx.selectionStyle.selectionRectangle.strokeWidth).toEqual(expect.any(Number));
    ctx.draw.options.update({
      selectionStyle: { selectionRectangle: { strokeColor: 'red' } },
    } as never);
    expect(ctx.selectionStyle.selectionRectangle.strokeColor).toBe('red');
  });

  it('refuses while the document is read-only', () => {
    engine.context.store.setReadOnly(true);
    expect(
      ctx.commitFeature({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [1, 1] },
        properties: {},
      }),
    ).toBeNull();
    expect(engine.context.store.listFeatures()).toHaveLength(0);
  });

  it('tells the plugins of each feature it commits, and not of a refused one', () => {
    const committed: string[] = [];
    engine.extensions.collections.plugins.add(
      plugin('commits', { onFeatureCommit: (feature) => committed.push(feature.id) }),
    );
    const feature = ctx.commitFeature({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [1, 1] },
      properties: {},
    });
    expect(committed).toEqual([feature?.id]);
    engine.context.store.setReadOnly(true);
    ctx.commitFeature({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [2, 2] },
      properties: {},
    });
    expect(committed).toHaveLength(1);
  });
});

describe('the providers and the cursor of a mode', () => {
  let engine: Engine;
  let ctx: ModeContext;

  beforeEach(() => {
    engine = engineWithDraw();
    engine.extensions.collections.modes.add('probe', (context) => {
      ctx = context;
      return { onEnter: () => ctx.cursor.set('crosshair') };
    });
    engine.extensions.collections.modes.add('plain', () => ({}));
  });
  afterEach(() => {
    engine.destroy();
  });

  it('keeps the kind of its own that a snap provider gives its candidate', () => {
    engine.extensions.collections.snapProviders.add({
      name: 'grid',
      candidates: () => [{ position: [1, 1], kind: 'grid-node', source: 'grid' }],
    });
    const changes: Array<string | undefined> = [];
    engine.events.on('snap.changed', ({ result }) => changes.push(result?.target?.kind));
    engine.modeManager.setMode('probe');
    const { x, y } = engine.map.project([1, 1]);
    const result = ctx.snap([x, y]);
    expect(result.lngLat).toEqual([1, 1]);
    expect(result.target).toMatchObject({ kind: 'grid-node', description: 'grid' });
    expect(changes).toContain('grid-node');
  });

  it('goes back to the cursor the mode set when it was entered, and takes it back on leaving', () => {
    const canvas = engine.map.getCanvas();
    engine.modeManager.setMode('probe');
    expect(canvas.style.cursor).toBe('crosshair');
    ctx.cursor.set('pointer');
    ctx.cursor.reset();
    expect(canvas.style.cursor).toBe('crosshair');
    engine.modeManager.setMode('plain');
    expect(canvas.style.cursor).toBe('');
  });

  it('lets onClick of a companion consume the click or leave it to the select mode', () => {
    const { store } = engine.context;
    const layerId = store.listLayers()[0].id;
    store.createFeature({
      id: 'far',
      type: 'Point',
      geometry: { type: 'Point', coordinates: [3, 3] },
      layerId,
      groupId: undefined,
      properties: {},
      style: {},
      visible: true,
      locked: false,
    });
    let consume = true;
    const clicked: string[] = [];
    engine.extensions.collections.companionProviders.add({
      name: 'halo',
      has: (feature) => feature.id === 'far',
      draw() {},
      hitTest: (feature) => ({
        kind: 'companion',
        id: 'halo',
        featureId: feature.id,
        distancePx: 0,
      }),
      onClick(feature) {
        clicked.push(feature.id);
        return consume;
      },
    });
    engine.modeManager.setMode('select');
    createSyntheticInput(engine).click([0, 0]);
    expect(clicked).toEqual(['far']);
    expect(store.getSelection().ids).toEqual([]);
    consume = false;
    createSyntheticInput(engine).click([0, 0]);
    expect(clicked).toEqual(['far', 'far']);
    expect(store.getSelection().ids).toEqual(['far']);
  });
});

describe('a Store that replaces its whole document', () => {
  /**
   * A Store of an application, which the instance wraps, that can announce a replacement of
   * its whole document
   */
  class ReplacingStore extends MemoryContractStore {
    readonly #listeners = new Set<(changes: StoreChange) => void>();
    override subscribe(listener: (changes: StoreChange) => void): () => void {
      const stop = super.subscribe(listener);
      this.#listeners.add(listener);
      return () => {
        stop();
        this.#listeners.delete(listener);
      };
    }
    announce(changes: StoreChange & { reset?: boolean }): void {
      for (const listener of this.#listeners) listener(changes);
    }
  }

  it('interrupts the current mode, and only for a reset', () => {
    const store = new ReplacingStore();
    const other = createDraw(createMapStub().map, { store: store as unknown as Store });
    const onCancel = vi.fn();
    other.extensions.modes.add('probe', () => ({ onCancel }));
    other.setMode('probe');
    store.announce({ source: 'remote' });
    expect(onCancel).not.toHaveBeenCalled();
    store.announce({ source: 'remote', reset: true });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(other.getMode()).toBe('probe');
    other.destroy();
    store.announce({ source: 'remote', reset: true });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('tells a replacement of the whole document as a change of the document itself', () => {
    const store = new ReplacingStore();
    const other = createDraw(createMapStub().map, { store: store as unknown as Store });
    const changes: Change[] = [];
    other.on('change', (change) => changes.push(change));
    const layer = other.layers.list()[0];
    store.announce({
      source: 'remote',
      reset: true,
      layers: { updated: [{ id: layer.id, layer, previous: layer }] },
    });
    store.announce({ source: 'remote', reset: true });
    expect(changes).toHaveLength(2);
    expect(changes.every((change) => change.document && change.source === 'remote')).toBe(true);
    writesOf(other).layers.update(layer.id, { name: 'renamed' });
    expect(changes[2].document).toBe(false);
    other.destroy();
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
    engine.modeManager.setMode('drawPoint');
    createSyntheticInput(engine).click([1, 1]);
    const [feature] = engine.context.store.listFeatures();
    expect(feature.geometry).toEqual({ type: 'Point', coordinates: [1, 1] });
    expect(engine.context.store.getSelection().ids).toEqual([feature.id]);
    expect(engine.modeManager.getMode()).toBe('select');
  });

  it('tells the plugins of a point it draws, and of the image placed after a request', () => {
    const committed: string[] = [];
    engine.extensions.collections.plugins.add(
      plugin('commits', { onFeatureCommit: (feature) => committed.push(feature.id) }),
    );
    engine.modeManager.setMode('drawPoint');
    createSyntheticInput(engine).click([1, 1]);
    const [point] = engine.context.store.listFeatures();
    expect(committed).toEqual([point.id]);

    // An image loaded otherwise is not a commit of the image mode; the one the image mode
    // placed (after `requestImage`) is
    const result = { format: 'image' as const, featureIds: [point.id], replaced: false };
    engine.extensions.loaded(result);
    expect(committed).toHaveLength(1);
    engine.extensions.loaded(result, true);
    expect(committed).toEqual([point.id, point.id]);
  });

  it('draws a circle with two clicks', () => {
    engine.modeManager.setMode('drawCircle');
    createSyntheticInput(engine).click([1, 1]);
    expect(engine.context.shapes.drawing()?.type).toBe('Circle');
    createSyntheticInput(engine).click([1, 1.5]);
    const [feature] = engine.context.store.listFeatures();
    expect(feature.type).toBe('Circle');
    expect(feature.properties['maplibre-gl-draw:radiusMeters']).toBeGreaterThan(1000);
    expect(engine.modeManager.getMode()).toBe('select');
  });

  it('drops the circle being drawn on Escape, and leaves on a second Escape', () => {
    engine.modeManager.setMode('drawCircle');
    createSyntheticInput(engine).click([1, 1]);
    createSyntheticInput(engine).key('Escape');
    expect(engine.context.shapes.drawing()).toBeNull();
    expect(engine.modeManager.getMode()).toBe('drawCircle');
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
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [
            [0, 0],
            [1, 1],
            [2, 2],
          ],
        },
        properties: {},
      },
      { confirmedVertices: 2, highlightVertex: 0 },
    );
    // A sketch of this client shows it, with the vertices placed and the one to close on
    const [sketch] = draw.sketches.list();
    expect(sketch?.owner).toBeNull();
    expect(sketch?.edits[0]).toMatchObject({
      kind: 'create',
      placedVertexCount: 2,
      highlightedVertexIndex: 0,
    });

    expect(ctx.draw.drawing.isDrawing()).toBe(true);
    ctx.preview.clear();
    expect(ctx.draw.drawing.isDrawing()).toBe(false);
  });

  it('gives the writable layer, or null when none can be written', () => {
    const layer = draw.layers.list()[0];
    expect(ctx.writableLayer()?.id).toBe(layer.id);
    writesOf(draw).layers.update(layer.id, { locked: true });
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
    writesOf(draw).features.createMany([
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
    expect(
      writesOf(draw)
        .features.list({ bbox: [0, -1, 2, 2] })
        .map((f) => f.id),
    ).toEqual(['in', 'across']);
    expect(draw.features.count({ bbox: [0, -1, 2, 2], type: 'Point' })).toBe(1);
    expect(errorOf(() => writesOf(draw).features.list({ bbox: [0, 0] as never })).code).toBe(
      'invalidInput',
    );
  });
});

describe('the extensions of two draw instances', () => {
  const board: FeatureTypeDefinition = {
    type: 'Board',
    geometry: 'Polygon',
    render: vi.fn(),
    footprint: (feature) => ({
      kind: 'screen',
      position: (feature.geometry as GeoJSON.Polygon).coordinates[0][0],
      halfWidthPx: 10,
      halfHeightPx: 10,
    }),
  };
  const handles = (name: string): HandleProvider => ({
    name,
    handles: () => [],
    onHandleDrag: () => null,
  });

  it('keep what is added to one instance out of the other', () => {
    const editor = engineWithDraw();
    const preview = engineWithDraw();

    preview.extensions.collections.featureTypes.add(board);
    const editorHandles = handles('aux');
    editor.extensions.collections.handleProviders.add(editorHandles);
    // The same name on the other instance is a registration of its own
    preview.extensions.collections.handleProviders.add(handles('aux'));

    expect(preview.extensions.collections.featureTypes.has('Board')).toBe(true);
    expect(editor.extensions.collections.featureTypes.has('Board')).toBe(false);
    const extensionsOf = (engine: Engine) => engine.context.selectionScope.extensions;
    expect(extensionsOf(preview).getBoundingBoxCalculator('Board')).toBeDefined();
    expect(extensionsOf(editor).getBoundingBoxCalculator('Board')).toBeUndefined();
    expect(editor.extensions.collections.handleProviders.get('aux')).toBe(editorHandles);
    expect(editor.context.selectionScope.auxiliaryHandles.list()).toHaveLength(1);
    expect(preview.context.selectionScope.auxiliaryHandles.list()).toHaveLength(1);

    editor.destroy();
    preview.destroy();
  });

  it('leave the other instance alone when one is destroyed', () => {
    const editor = engineWithDraw();
    const preview = engineWithDraw();
    editor.extensions.collections.featureTypes.add(board);
    preview.extensions.collections.featureTypes.add(board);
    editor.extensions.collections.handleProviders.add(handles('aux'));
    preview.extensions.collections.handleProviders.add(handles('aux'));

    preview.destroy();

    expect(preview.context.selectionScope.auxiliaryHandles.list()).toEqual([]);
    expect(
      preview.context.selectionScope.extensions.getBoundingBoxCalculator('Board'),
    ).toBeUndefined();
    expect(editor.context.selectionScope.auxiliaryHandles.list()).toHaveLength(1);
    expect(
      editor.context.selectionScope.extensions.getBoundingBoxCalculator('Board'),
    ).toBeDefined();
    editor.destroy();
  });
});

describe('drawing.cancel', () => {
  it('cancels the shape being drawn with drawing.cancel, and stays in the mode', () => {
    const engine = createEngine(createMapStub().map, {}, { deferDefaultMode: true });
    const draw = createDrawOnEngine(engine);
    engine.enterDefaultMode();
    let ctx: PluginContext | null = null;
    draw.extensions.plugins.add(
      plugin('canceller', {
        onAdd(context) {
          ctx = context;
        },
      }),
    );
    const context = ctx as unknown as PluginContext;
    expect(context.draw.drawing.cancel()).toBe(false);

    engine.modeManager.setMode('drawLine');
    const input = createSyntheticInput(engine);
    input.click([0, 0]);
    input.move([1, 1]);
    expect(context.draw.drawing.isDrawing()).toBe(true);
    const ended: string[] = [];
    engine.events.on('sketch.removed', ({ reason }) => ended.push(reason));
    expect(context.draw.drawing.cancel()).toBe(true);
    expect(context.draw.drawing.isDrawing()).toBe(false);
    // The sketch that showed the shape is removed
    expect(ended).toEqual(['cancelled']);
    expect(engine.modeManager.getMode()).toBe('drawLine');
    expect(context.draw.drawing.cancel()).toBe(false);
    expect(engine.modeManager.getMode()).toBe('drawLine');

    // The mode dropped its vertices: the next click starts a new shape
    input.click([2, 2]);
    input.move([3, 3]);
    const coordinates = engine.context.shapes.drawing()?.coordinates as number[][];
    expect(coordinates).toHaveLength(2);
    expect(coordinates[0]).toEqual([2, 2]);

    // A mode of the contract hears onCancel
    const onCancel = vi.fn();
    draw.extensions.modes.add('custom', (modeCtx) => ({
      onClick(event) {
        modeCtx.preview.set({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: event.lngLat },
          properties: {},
        });
        return true;
      },
      onCancel,
    }));
    engine.modeManager.setMode('custom');
    input.click([0, 0]);
    expect(context.draw.drawing.cancel()).toBe(true);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(context.draw.drawing.isDrawing()).toBe(false);
    expect(engine.modeManager.getMode()).toBe('custom');
    draw.destroy();
  });
});
