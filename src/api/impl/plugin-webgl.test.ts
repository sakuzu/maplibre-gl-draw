// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a plugin draws with WebGL of its own (`ctx.webgl`), through the engine: one definition is one
 * part, whatever uses it, and the ledger of the instance comes back to 0 however the plugin ends
 */

import type { Map as MapLibreMap, ProjectionData } from 'maplibre-gl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  EngineOverlayRenderer,
  FeatureTypeRenderer,
  FrameDrawContext,
} from '../../extension/renderers.js';
import { createMapStub } from '../../test-utils.js';
import type { PluginContext } from '../extension/context.js';
import type { FeatureRenderer, Gpu, GpuDefinition } from '../extension/webgl.js';
import type { StoredFeature } from '../model.js';
import { createDrawOnEngine } from './create-draw.js';
import type { Engine } from './engine.js';
import { createEngine } from './engine.js';

const PROJECTION = { mainMatrix: new Float32Array(16) } as unknown as ProjectionData;

/** The values of a frame, as far as a render context reads them */
const FRAME = {
  shaderData: { vertexShaderPrelude: '', define: '', variantName: 'mercator' },
  centerLngLat: [0, 0],
  mainMatrixArray: Array.from({ length: 16 }, () => 0),
  pixelRatio: 1,
  terrain: {},
  opacity: 1,
} as unknown as FrameDrawContext;

/** A context that counts what is alive */
function context() {
  const alive = new Set<object>();
  const lost = { value: false };
  const known: Record<string, unknown> = {
    ARRAY_BUFFER: 1,
    STATIC_DRAW: 2,
    DYNAMIC_DRAW: 3,
    createBuffer() {
      const buffer = {};
      alive.add(buffer);
      return buffer;
    },
    deleteBuffer: (buffer: object) => alive.delete(buffer),
    isContextLost: () => lost.value,
  };
  const gl = new Proxy(known, {
    get: (target, name: string) => target[name] ?? (() => {}),
  }) as unknown as WebGL2RenderingContext;
  return { gl, alive, lost };
}

/** An engine and what its plugins put in it */
function open() {
  const engine: Engine = createEngine(createMapStub().map, {}, { deferDefaultMode: true });
  const draw = createDrawOnEngine(engine);
  engine.enterDefaultMode();
  const renderers = new Map<string, FeatureTypeRenderer>();
  const register = engine.customLayer.registerFeatureRenderer.bind(engine.customLayer);
  vi.spyOn(engine.customLayer, 'registerFeatureRenderer').mockImplementation((type, renderer) => {
    renderers.set(type, renderer as FeatureTypeRenderer);
    return register(type, renderer);
  });
  const overlays: EngineOverlayRenderer[] = [];
  const addOverlay = engine.customLayer.addOverlay.bind(engine.customLayer);
  vi.spyOn(engine.customLayer, 'addOverlay').mockImplementation((renderer) => {
    overlays.push(renderer);
    return addOverlay(renderer);
  });
  const add = (setup: (ctx: PluginContext) => void, name = 'acme'): void => {
    draw.extensions.plugins.add({ name, onAdd: setup });
  };
  const ledger = engine.customLayer.getGpuLedger();
  return { engine, draw, renderers, overlays, add, ledger };
}

/** A definition of a renderer that holds 100 bytes */
function definition(render: FeatureRenderer['render'] = () => {}) {
  const seen: Gpu[] = [];
  const value: GpuDefinition<FeatureRenderer> = {
    gpuShare: 0.5,
    prepare: vi.fn((gpu: Gpu) => {
      seen.push(gpu);
      gpu.buffer(100);
      return { render, rows: () => ({}) as never };
    }),
  };
  return { value, seen };
}

const TYPE = { geometry: 'Point' } as const;
const attachAll = (
  renderers: Map<string, FeatureTypeRenderer>,
  gl: WebGL2RenderingContext,
): void => {
  for (const renderer of renderers.values()) renderer.onAdd(gl, {} as MapLibreMap);
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ctx.webgl.addFeatureRenderer', () => {
  it('prepares a definition once for the types given it, with one source of rows', () => {
    const { add, renderers, ledger, engine } = open();
    const { gl } = context();
    const { value } = definition();
    add((ctx) => {
      ctx.extensions.featureTypes.add({ type: 'Marker', ...TYPE });
      ctx.extensions.featureTypes.add({ type: 'Sticker', ...TYPE });
      ctx.webgl.addFeatureRenderer('Marker', value);
      ctx.webgl.addFeatureRenderer('Sticker', value);
    });
    attachAll(renderers, gl);
    expect(value.prepare).toHaveBeenCalledOnce();
    expect(ledger.snapshot().byOwner).toEqual({ acme: 100 });
    const marker = renderers.get('Marker');
    expect(marker?.gpuRows).toBeDefined();
    expect(marker?.gpuRows).toBe(renderers.get('Sticker')?.gpuRows);
    engine.destroy();
  });

  it('refuses a type that was not added', () => {
    const { add, engine } = open();
    expect(() => add((ctx) => ctx.webgl.addFeatureRenderer('Marker', definition().value))).toThrow(
      expect.objectContaining({ code: 'not-found' }),
    );
    engine.destroy();
  });

  it('gives back everything with the plugin that added it', () => {
    const { add, draw, renderers, ledger, engine } = open();
    const { gl, alive } = context();
    const { value, seen } = definition();
    add((ctx) => {
      ctx.extensions.featureTypes.add({ type: 'Marker', ...TYPE });
      ctx.webgl.addFeatureRenderer('Marker', value);
    });
    attachAll(renderers, gl);
    draw.extensions.plugins.remove('acme');
    expect(seen[0].signal.aborted).toBe(true);
    expect(alive.size).toBe(0);
    expect(ledger.snapshot().objects).toBe(0);
    expect(ledger.audit()).toBe(true);
    engine.destroy();
  });

  it('gives back everything when the instance is destroyed', () => {
    const { add, renderers, ledger, engine } = open();
    const { gl, alive } = context();
    add((ctx) => {
      ctx.extensions.featureTypes.add({ type: 'Marker', ...TYPE });
      ctx.webgl.addFeatureRenderer('Marker', definition().value);
    });
    attachAll(renderers, gl);
    expect(alive.size).toBe(1);
    engine.destroy();
    expect(alive.size).toBe(0);
    expect(ledger.snapshot().objects).toBe(0);
  });

  it('stops only what threw, and gives back what it held', () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { add, renderers, ledger, engine } = open();
    const { gl, alive } = context();
    const render = vi.fn(() => {
      throw new Error('in a frame');
    });
    const { value } = definition(render);
    add((ctx) => {
      ctx.extensions.featureTypes.add({ type: 'Marker', ...TYPE });
      ctx.webgl.addFeatureRenderer('Marker', value);
    });
    attachAll(renderers, gl);
    const feature: StoredFeature = {
      id: 'a',
      type: 'Marker',
      geometry: { type: 'Point', coordinates: [0, 0] },
      layerId: 'l',
      groupId: undefined,
      properties: {},
      style: {},
      visible: true,
      locked: false,
    };
    const draw = (): void => renderers.get('Marker')?.draw(feature, PROJECTION, 10, FRAME);
    draw();
    draw();
    expect(render).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith('Error in plugin "acme":', expect.any(Error));
    expect(alive.size).toBe(0);
    expect(ledger.snapshot().objects).toBe(0);
    engine.destroy();
  });

  it('comes back with a new `gpu` after a lost context, and holds it once', () => {
    const { add, renderers, ledger, engine } = open();
    const { gl, alive, lost } = context();
    const { value, seen } = definition();
    add((ctx) => {
      ctx.extensions.featureTypes.add({ type: 'Marker', ...TYPE });
      ctx.webgl.addFeatureRenderer('Marker', value);
    });
    const marker = renderers.get('Marker') as FeatureTypeRenderer;
    marker.onAdd(gl, {} as MapLibreMap);
    lost.value = true;
    marker.onRemove();
    expect(seen[0].signal.aborted).toBe(true);
    expect(ledger.snapshot().objects).toBe(0);
    lost.value = false;
    alive.clear();
    marker.onAdd(gl, {} as MapLibreMap);
    expect(value.prepare).toHaveBeenCalledTimes(2);
    expect(ledger.snapshot().bytes).toBe(100);
    engine.destroy();
  });
});

describe('ctx.webgl.addOverlay', () => {
  it('draws what prepare returned, with the copies of the world, and goes with the plugin', () => {
    const { add, draw, overlays, ledger, engine } = open();
    const { gl, alive } = context();
    const drawn = vi.fn();
    const seen: Gpu[] = [];
    add((ctx) =>
      ctx.webgl.addOverlay({
        gpuShare: 0.1,
        prepare(gpu) {
          seen.push(gpu);
          gpu.buffer(10);
          return drawn;
        },
      }),
    );
    expect(overlays.length).toBeGreaterThan(0);
    const [above] = overlays;
    above.onAdd(gl, {} as MapLibreMap);
    expect(ledger.snapshot().byOwner).toEqual({ acme: 10 });
    above.draw(PROJECTION, 12, FRAME);
    expect(drawn).toHaveBeenCalledOnce();
    const [overlayContext] = drawn.mock.calls[0];
    expect(overlayContext.worldCopies).toEqual([overlayContext]);
    draw.extensions.plugins.remove('acme');
    expect(seen[0].signal.aborted).toBe(true);
    expect(alive.size).toBe(0);
    expect(ledger.snapshot().objects).toBe(0);
    engine.destroy();
  });

  it('holds rows under what the device has left, the rest of the page counted', () => {
    const { add, draw, overlays, engine } = open();
    const { gl } = context();
    vi.spyOn(draw.memory, 'get').mockReturnValue({
      limitBytes: 1_000,
      bytes: 700,
      jsBytes: 600,
      gpuBytes: 100,
      peakGpuBytes: 100,
      gpuAllocations: 1,
    });
    let rows: Gpu | null = null;
    add((ctx) =>
      ctx.webgl.addOverlay({
        gpuShare: 0.1,
        prepare(gpu) {
          rows = gpu.rows;
          return () => {};
        },
      }),
    );
    overlays[0].onAdd(gl, {} as MapLibreMap);
    expect((rows as unknown as Gpu).memory().limitBytes).toBe(300);
    engine.destroy();
  });

  it('holds the shares of the plugins of an instance', () => {
    const { add, engine } = open();
    const half = (): GpuDefinition<() => void> => ({ gpuShare: 0.5, prepare: () => () => {} });
    add((ctx) => ctx.webgl.addOverlay(half()), 'one');
    expect(() => add((ctx) => ctx.webgl.addOverlay(half()), 'two')).toThrow(
      expect.objectContaining({ code: 'too-large' }),
    );
    engine.destroy();
  });
});
