// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the extensions of the contract installed into the engine: a custom feature type
 * end to end (its drawing with a RenderContext, its hit test, its handles), the overlays, the
 * providers of snapping and companions, and the colors of the shared renderers
 */

import type { Map as MapLibreMap, ProjectionData } from 'maplibre-gl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DragNormalizedEvent, MouseNormalizedEvent } from '../../dispatcher/types.js';
import type {
  EngineOverlayRenderer,
  FeatureTypeRenderer,
  FrameDrawContext,
  LayeredOverlayRenderer,
} from '../../extension/index.js';
import { createMapStub, createSyntheticInput } from '../../test-utils.js';
import { createFeatureCompanionRegistry } from '../../view/feature-companion.js';
import { calculateOffsetUniforms } from '../../view/shaders/helpers.js';
import type { TerrainContext } from '../../view/terrain/context.js';
import type { Draw } from '../draw.js';
import type { ScreenContext } from '../extension/context.js';
import type { FeatureTypeDefinition, Handle } from '../extension/feature-type.js';
import type { Hit } from '../extension/provider.js';
import type { RenderContext } from '../extension/render.js';
import type { Feature, FeatureInput } from '../model.js';
import type { AdapterDeps } from './adapters.js';
import { adaptCompanionProvider } from './adapters.js';
import { createTerrainAnchors } from './contexts.js';
import { createDrawOnEngine } from './create-draw.js';
import type { Engine } from './engine.js';
import { createEngine } from './engine.js';
import { createOverlayStack } from './render-context.js';

/** An engine with its draw instance attached, as the entries build it */
function engineWithDraw(): Engine {
  const engine = createEngine(createMapStub().map, {}, { deferDefaultMode: true });
  createDrawOnEngine(engine);
  engine.enterDefaultMode();
  return engine;
}

const PROJECTION = { mainMatrix: new Float32Array(16) } as unknown as ProjectionData;
const GL = {} as WebGL2RenderingContext;

/** The context the engine gives its own renderers, with spies for the shared renderers */
function baseContext(): FrameDrawContext {
  return {
    shaderData: { vertexShaderPrelude: 'prelude', define: '#define X', variantName: 'mercator' },
    centerLngLat: [139.7, 35.6],
    mainMatrixArray: Array.from({ length: 16 }, (_, i) => (i % 5 === 0 ? 1 : 0)),
    pixelRatio: 2,
    terrain: {} as TerrainContext,
    opacity: 0.5,
    sdfLineRenderer: { draw: vi.fn(), drawClosed: vi.fn() },
    fillShaderManager: { drawPolygonRings: vi.fn() },
    pointShapeRenderer: { draw: vi.fn() },
  } as unknown as FrameDrawContext;
}

function drag(type: DragNormalizedEvent['type'], lng: number, lat: number): DragNormalizedEvent {
  return {
    type,
    point: { x: lng * 100 + 400, y: 300 - lat * 100 },
    lngLat: { lng, lat },
    originalEvent: {} as MouseEvent,
    modifiers: { shift: false, ctrl: false, alt: false, meta: false },
    dragStartPoint: { x: 500, y: 200 },
    dragStartLngLat: { lng: 1, lat: 1 },
  };
}

describe('a custom feature type', () => {
  let engine: Engine;
  let registered: FeatureTypeRenderer | null;
  const handle: Handle = { id: 'corner', position: [1.5, 1], kind: 'resize', cursor: 'ew-resize' };
  const definition = {
    type: 'pin',
    geometry: 'Point',
    // The hit test reaches 30 px, beyond the click tolerance
    hitPaddingPx: 30,
    renderer: { onAdd: vi.fn(), draw: vi.fn(), onRemove: vi.fn() },
    hitTest: vi.fn((feature: Feature, ctx) => {
      const [x, y] = ctx.screen.project((feature.geometry as GeoJSON.Point).coordinates);
      const distancePx = Math.hypot(x - ctx.point[0], y - ctx.point[1]);
      return distancePx <= 30 ? { kind: 'feature' as const, id: feature.id, distancePx } : null;
    }),
    handles: vi.fn(() => [handle]),
    onHandleDrag: vi.fn((_feature: Feature, _handle: Handle, event) => ({
      properties: { size: event.lngLat[0] },
    })),
    snapCandidates: vi.fn(() => [{ position: [1.001, 1.001], kind: 'anchor', source: 'pin' }]),
  } satisfies FeatureTypeDefinition;

  beforeEach(() => {
    engine = engineWithDraw();
    registered = null;
    const register = engine.customLayer.registerFeatureRenderer.bind(engine.customLayer);
    vi.spyOn(engine.customLayer, 'registerFeatureRenderer').mockImplementation((type, r) => {
      registered = r;
      return register(type, r);
    });
    engine.extensions.collections.featureTypes.add(definition);
    const { store } = engine.context;
    store.createFeature({
      id: 'p1',
      type: 'pin',
      geometry: { type: 'Point', coordinates: [1, 1] },
      layerId: store.listLayers()[0].id,
      groupId: undefined,
      properties: {},
      style: {},
      locked: false,
      visible: true,
    });
  });
  afterEach(() => {
    engine.destroy();
    vi.clearAllMocks();
  });

  it('is drawn by its renderer with a RenderContext', () => {
    expect(registered).not.toBeNull();
    const adapter = registered as unknown as FeatureTypeRenderer;
    const map = {} as MapLibreMap;
    adapter.onAdd(GL, map);
    expect(definition.renderer.onAdd).toHaveBeenCalledWith(map, GL);

    const base = baseContext();
    const feature = engine.context.store.getFeature('p1');
    adapter.draw(feature as never, PROJECTION, 12, base);
    const [drawn, ctx] = definition.renderer.draw.mock.calls[0] as unknown as [
      Feature,
      RenderContext,
    ];
    expect(drawn.id).toBe('p1');
    expect(ctx.gl).toBe(GL);
    expect(ctx.projection).toBe(PROJECTION);
    expect(ctx.zoom).toBe(12);
    expect(ctx.pixelRatio).toBe(2);
    expect(ctx.opacity).toBe(0.5);
    expect(ctx.shader.variantName).toBe('mercator');
    expect(ctx.offset).toEqual(calculateOffsetUniforms(base.centerLngLat, base.mainMatrixArray));

    ctx.line.draw(
      [
        [0, 0],
        [1, 1],
      ],
      { width: 2, color: '#ff0000', opacity: 1, lineStyle: 'solid' },
    );
    expect(base.sdfLineRenderer.draw).toHaveBeenCalledWith(
      [
        [0, 0],
        [1, 1],
      ],
      { width: 2, color: [1, 0, 0, 1], opacity: 1, lineStyle: 'solid' },
      { widthUnit: 'pixels', closed: false },
      12,
      PROJECTION,
    );
    ctx.fill.draw(
      [
        [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
      ],
      { color: 'rgba(0, 0, 255, 0.5)', opacity: 0.5 },
    );
    expect(base.fillShaderManager.drawPolygonRings).toHaveBeenCalledWith(
      [
        [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
      ],
      [0, 0, 1, 0.25],
      PROJECTION,
      12,
    );

    adapter.onRemove();
    expect(definition.renderer.onRemove).toHaveBeenCalledWith(map, GL);
  });

  it('is hit by its hit test, which selects it in select mode', () => {
    createSyntheticInput(engine).click([1.1, 1]);
    expect(definition.hitTest).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p1' }),
      expect.objectContaining({ point: [510, 200], tolerancePx: expect.any(Number) }),
    );
    expect(engine.context.store.getSelection().ids).toEqual(['p1']);

    createSyntheticInput(engine).click([3, 3]);
    expect(engine.context.store.getSelection().ids).toEqual([]);
  });

  it('shows its handles, and a drag of one applies the patch of onHandleDrag', () => {
    const { store, selectionScope } = engine.context;
    const provider = selectionScope.auxiliaryHandles.list()[0];
    const feature = store.getFeature('p1');
    expect(feature).toBeDefined();
    const shown = provider.getHandles(feature as never, {} as never);
    expect(shown).toEqual([{ id: 'corner', position: [1.5, 1], cursor: 'ew-resize' }]);

    const updates: Array<boolean | undefined> = [];
    store.subscribe((changes) => {
      for (const update of changes.features?.updated ?? []) updates.push(update.isIntermediate);
    });
    expect(
      provider.onHandleDragStart(
        { providerId: provider.id, handleId: 'corner', featureId: 'p1' },
        drag('dragstart', 1.5, 1),
      ),
    ).toBe(true);
    provider.onHandleDragMove(drag('dragmove', 1.7, 1));
    provider.onHandleDragEnd(drag('dragend', 2, 1));

    expect(definition.onHandleDrag).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'p1' }),
      handle,
      expect.objectContaining({ lngLat: [2, 1] }),
    );
    expect(store.getFeature('p1')?.properties.size).toBe(2);
    expect(updates[0]).toBe(true);
    expect(updates[updates.length - 1]).not.toBe(true);
  });

  it('offers its snapping candidates, keeping a kind of its own', () => {
    const result = engine.context.snapService.resolve(
      { lng: 1, lat: 1 },
      { x: 500, y: 200 },
      { zoom: 10, modifiers: { shift: false, ctrl: false, alt: false, meta: false } },
    );
    expect(result.lngLat).toEqual({ lng: 1.001, lat: 1.001 });
    expect(result.target).toEqual(
      expect.objectContaining({ kind: 'anchor', featureId: 'p1', description: 'pin' }),
    );
  });

  it('takes nothing back from the engine once it is removed', () => {
    engine.extensions.collections.featureTypes.remove('pin');
    expect(engine.context.selectionScope.auxiliaryHandles.list()).toEqual([]);
    createSyntheticInput(engine).click([1.1, 1]);
    expect(engine.context.store.getSelection().ids).toEqual([]);
  });
});

describe('the outline of a custom feature type', () => {
  const baseFeature = {
    layerId: 'l',
    groupId: undefined,
    properties: {},
    style: {},
    locked: false,
    visible: true,
  };
  /** A diamond around the screen point of a coordinate, 20 px from its middle */
  const diamond = (feature: Feature, ctx: { project(p: GeoJSON.Position): [number, number] }) => {
    const geometry = feature.geometry as GeoJSON.Point | GeoJSON.Polygon;
    const anchor = geometry.type === 'Point' ? geometry.coordinates : geometry.coordinates[0][0];
    const [x, y] = ctx.project(anchor);
    return [
      [x, y - 20],
      [x + 20, y],
      [x, y + 20],
      [x - 20, y],
    ] as Array<[number, number]>;
  };
  const renderer = { onAdd: vi.fn(), draw: vi.fn(), onRemove: vi.fn() };

  it('gives the frame and its handles of a type that is not a point, before bounds', () => {
    const engine = engineWithDraw();
    let turned = true;
    engine.extensions.collections.featureTypes.add({
      type: 'turned',
      geometry: 'Polygon',
      renderer,
      bounds: () => ({ min: [0, 0], max: [10, 10] }),
      outline: (feature, ctx) => (turned ? diamond(feature, ctx) : []),
    });
    const calculator = engine.context.selectionScope.extensions.getBoundingBoxCalculator('turned');
    const feature = {
      ...baseFeature,
      id: 't',
      type: 'turned',
      geometry: {
        type: 'Polygon' as const,
        coordinates: [
          [
            [1, 1],
            [2, 1],
            [2, 2],
            [1, 1],
          ],
        ],
      },
    };
    // (1, 1) is (500, 200) on the screen of the stub, where 1 degree is 100 px
    expect(calculator?.(feature, 512)).toEqual({
      topLeft: [1, 1.2],
      topRight: [1.2, 1],
      bottomRight: [1, 0.8],
      bottomLeft: [0.8, 1],
      center: [1, 1],
    });
    // Anything but four corners gives the box of bounds
    turned = false;
    expect(calculator?.(feature, 512)).toEqual({
      topLeft: [-4, 3],
      topRight: [-3.9, 3],
      bottomRight: [-3.9, 2.9],
      bottomLeft: [-4, 2.9],
      center: [-3.95, 2.95],
    });
    engine.destroy();
  });

  it('gives the frame of a point type, which keeps no area and no resize handles', () => {
    const engine = engineWithDraw();
    engine.extensions.collections.featureTypes.add({
      type: 'turned-pin',
      geometry: 'Point',
      renderer,
      outline: (feature, ctx) => diamond(feature, ctx),
    });
    const { extensions } = engine.context.selectionScope;
    const feature = {
      ...baseFeature,
      id: 'p',
      type: 'turned-pin',
      geometry: { type: 'Point' as const, coordinates: [1, 1] },
    };
    expect(extensions.getBoundingBoxCalculator('turned-pin')).toBeUndefined();
    expect(extensions.resolvePointFrameCorners(feature, { x: 500, y: 200 }, 0)).toEqual([
      { x: 500, y: 180 },
      { x: 520, y: 200 },
      { x: 500, y: 220 },
      { x: 480, y: 200 },
    ]);
    // The margin moves every edge of the diamond out, so its top goes up by 4 * sqrt(2)
    const [top] = extensions.resolvePointFrameCorners(feature, { x: 500, y: 200 }, 4);
    expect(top.x).toBeCloseTo(500);
    expect(top.y).toBeCloseTo(180 - 4 * Math.SQRT2);

    engine.extensions.collections.featureTypes.remove('turned-pin');
    expect(extensions.resolvePointFrameCorners(feature, { x: 500, y: 200 }, 0)).toEqual([
      { x: 494, y: 194 },
      { x: 506, y: 194 },
      { x: 506, y: 206 },
      { x: 494, y: 206 },
    ]);
    engine.destroy();
  });

  it('refuses an outline that is not a function', () => {
    const engine = engineWithDraw();
    expect(() =>
      engine.extensions.collections.featureTypes.add({
        type: 'wrong',
        geometry: 'Point',
        renderer,
        outline: [] as never,
      }),
    ).toThrow(/outline/);
    engine.destroy();
  });
});

describe('the extent of a custom feature type', () => {
  it('measures its features in the spatial index by bbox, and by the geometry without it', () => {
    const engine = createEngine(createMapStub().map, {}, { deferDefaultMode: true });
    const draw = createDrawOnEngine(engine);
    engine.enterDefaultMode();
    let reach = 2;
    const renderer = { onAdd: vi.fn(), draw: vi.fn(), onRemove: vi.fn() };
    const remove = draw.extensions.featureTypes.add({
      type: 'wide',
      geometry: 'Point',
      renderer,
      // A disc of `reach` degrees drawn around the point
      bbox(feature) {
        const [x, y] = (feature.geometry as GeoJSON.Point).coordinates;
        return [x - reach, y - reach, x + reach, y + reach];
      },
    });
    const feature = draw.features.create({
      type: 'wide',
      geometry: { type: 'Point', coordinates: [10, 10] },
    });
    if (!feature) throw new Error('not created');
    const near = [11, 11, 11.5, 11.5] as [number, number, number, number];
    expect(draw.features.list({ bbox: near }).map((f) => f.id)).toEqual([feature.id]);
    expect(engine.context.spatialIndex.findNear([11.5, 10], 0)).toEqual([feature.id]);

    // A change outside the document is measured again with invalidate
    reach = 1;
    expect(draw.features.list({ bbox: [11.5, 11.5, 12, 12] })).toHaveLength(1);
    engine.context.spatialIndex.invalidateType('wide');
    expect(draw.features.list({ bbox: [11.5, 11.5, 12, 12] })).toHaveLength(0);
    expect(draw.features.list({ bbox: near })).toHaveLength(1);

    // An extent that is not four finite numbers gives the one of the geometry
    reach = Number.NaN;
    engine.context.spatialIndex.invalidateType('wide');
    expect(draw.features.list({ bbox: near })).toHaveLength(0);
    expect(draw.features.list({ bbox: [9, 9, 10, 10] })).toHaveLength(1);

    reach = 2;
    engine.context.spatialIndex.invalidateType('wide');
    expect(draw.features.list({ bbox: near })).toHaveLength(1);
    remove();
    expect(draw.features.list({ bbox: near })).toHaveLength(0);
    draw.destroy();
  });

  it('refuses a bbox that is not a function', () => {
    const engine = engineWithDraw();
    expect(() =>
      engine.extensions.collections.featureTypes.add({
        type: 'wrong',
        geometry: 'Point',
        renderer: { onAdd: vi.fn(), draw: vi.fn(), onRemove: vi.fn() },
        bbox: [0, 0, 1, 1] as never,
      }),
    ).toThrow(/bbox/);
    engine.destroy();
  });
});

describe('the start and the end of a handle drag', () => {
  const handle: Handle = { id: 'h', position: [1, 1], kind: 'grip' };
  const renderer = { onAdd: vi.fn(), draw: vi.fn(), onRemove: vi.fn() };

  function setUp() {
    const engine = engineWithDraw();
    const { store } = engine.context;
    store.createFeature({
      id: 'f',
      type: 'Point',
      geometry: { type: 'Point', coordinates: [1, 1] },
      layerId: store.listLayers()[0].id,
      groupId: undefined,
      properties: {},
      style: {},
      locked: false,
      visible: true,
    });
    return engine;
  }
  const hit = (providerId: string, featureId = 'f') => ({ providerId, handleId: 'h', featureId });

  it('asks onDragStart, which can refuse, and calls onDragEnd once after the last onDrag', () => {
    const engine = setUp();
    const calls: string[] = [];
    let accept = false;
    engine.extensions.collections.handleProviders.add({
      name: 'grips',
      handles: () => [handle],
      onDrag: (feature, _handle, event) => {
        calls.push(`drag ${feature?.id} ${event.lngLat[0]}`);
        return { properties: { at: event.lngLat[0] } };
      },
      onDragStart: (feature, grabbed, event) => {
        calls.push(`start ${feature?.id} ${grabbed.id} ${event.lngLat[0]}`);
        return accept;
      },
      onDragEnd: (feature, grabbed, event) => {
        calls.push(`end ${feature?.properties.at} ${grabbed.id} ${event.lngLat[0]}`);
      },
    });
    const provider = engine.context.selectionScope.auxiliaryHandles.get('grips');
    if (!provider) throw new Error('not installed');

    expect(provider.onHandleDragStart(hit('grips'), drag('dragstart', 1, 1))).toBe(false);
    expect(calls).toEqual(['start f h 1']);

    calls.length = 0;
    accept = true;
    expect(provider.onHandleDragStart(hit('grips'), drag('dragstart', 1, 1))).toBe(true);
    provider.onHandleDragMove(drag('dragmove', 2, 1));
    provider.onHandleDragEnd(drag('dragend', 3, 1));
    // A second end, with no drag going on, is not announced
    provider.onHandleDragEnd(drag('dragend', 4, 1));
    expect(calls).toEqual(['start f h 1', 'drag f 2', 'drag f 3', 'end 3 h 3']);
    engine.destroy();
  });

  it('gives a handle of globalHandles a null feature', () => {
    const engine = setUp();
    const onDragStart = vi.fn(() => true);
    const onDragEnd = vi.fn();
    engine.extensions.collections.handleProviders.add({
      name: 'free',
      handles: () => [],
      globalHandles: () => [handle],
      onDrag: () => null,
      onDragStart,
      onDragEnd,
    });
    const provider = engine.context.selectionScope.auxiliaryHandles.get('free');
    if (!provider) throw new Error('not installed');
    const global = { ...hit('free', ''), global: true };
    expect(provider.onHandleDragStart(global, drag('dragstart', 1, 1))).toBe(true);
    provider.onHandleDragEnd(drag('dragend', 2, 1));
    expect(onDragStart).toHaveBeenCalledWith(null, handle, expect.anything());
    expect(onDragEnd).toHaveBeenCalledWith(null, handle, expect.anything());
    engine.destroy();
  });

  it('calls onHandleDragStart and onHandleDragEnd of a custom type', () => {
    const engine = engineWithDraw();
    let accept = true;
    const onHandleDragStart = vi.fn(() => accept);
    const onHandleDragEnd = vi.fn();
    engine.extensions.collections.featureTypes.add({
      type: 'grip',
      geometry: 'Point',
      renderer,
      handles: () => [handle],
      onHandleDrag: () => ({ properties: { moved: true } }),
      onHandleDragStart,
      onHandleDragEnd,
    });
    const { store, selectionScope } = engine.context;
    store.createFeature({
      id: 'g',
      type: 'grip',
      geometry: { type: 'Point', coordinates: [1, 1] },
      layerId: store.listLayers()[0].id,
      groupId: undefined,
      properties: {},
      style: {},
      locked: false,
      visible: true,
    });
    const provider = selectionScope.auxiliaryHandles.list()[0];
    const grabbed = { providerId: provider.id, handleId: 'h', featureId: 'g' };
    expect(provider.onHandleDragStart(grabbed, drag('dragstart', 1, 1))).toBe(true);
    provider.onHandleDragEnd(drag('dragend', 2, 1));
    expect(onHandleDragStart).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'g' }),
      handle,
      expect.objectContaining({ lngLat: [1, 1] }),
    );
    expect(onHandleDragEnd).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'g', properties: { moved: true } }),
      handle,
      expect.objectContaining({ lngLat: [2, 1] }),
    );
    accept = false;
    expect(provider.onHandleDragStart(grabbed, drag('dragstart', 1, 1))).toBe(false);
    expect(onHandleDragEnd).toHaveBeenCalledTimes(1);
    engine.destroy();
  });
});

describe('the providers of snapping candidates', () => {
  it('snaps to the candidate of the highest priority at the same distance', () => {
    const engine = engineWithDraw();
    engine.extensions.collections.snapProviders.addMany([
      {
        name: 'low',
        candidates: () => [{ position: [1.001, 1], kind: 'guide', priority: 1, source: 'low' }],
      },
      {
        name: 'high',
        candidates: () => [{ position: [1.001, 1], kind: 'guide', priority: 5, source: 'high' }],
      },
    ]);
    const result = engine.context.snapService.resolve(
      { lng: 1, lat: 1 },
      { x: 500, y: 200 },
      { zoom: 10, modifiers: { shift: false, ctrl: false, alt: false, meta: false } },
    );
    expect(result.target?.description).toBe('high');
    engine.destroy();
  });
});

describe('the overlays', () => {
  it('draw by order, then by the order they were added, and leave with the last one', () => {
    const added: EngineOverlayRenderer[] = [];
    const removed: EngineOverlayRenderer[] = [];
    const stack = createOverlayStack(
      {
        addOverlay(renderer) {
          added.push(renderer);
          return () => removed.push(renderer);
        },
      },
      { anchors: createTerrainAnchors },
    );
    const calls: string[] = [];
    const overlay = (name: string, order?: number) => ({
      name,
      ...(order !== undefined && { order }),
      onAdd: () => calls.push(`add ${name}`),
      draw: (ctx: RenderContext) => calls.push(`draw ${name} ${ctx.zoom}`),
      drawForLayer: (layerId: string) => calls.push(`layer ${name} ${layerId}`),
      onRemove: () => calls.push(`remove ${name}`),
    });
    const removeA = stack.add(overlay('a', 1));
    const removeB = stack.add(overlay('b'));
    const removeC = stack.add(overlay('c', -1));
    expect(added).toHaveLength(2);
    const [above, perLayer] = added as [EngineOverlayRenderer, LayeredOverlayRenderer];

    const gl = new Proxy({}, { get: () => () => {} }) as WebGL2RenderingContext;
    above.onAdd(gl, {} as MapLibreMap);
    calls.length = 0;
    const base = baseContext();
    above.draw(PROJECTION, 7, base);
    perLayer.drawForLayer('l1', PROJECTION, 7, base);
    expect(calls).toEqual([
      'draw c 7',
      'draw b 7',
      'draw a 7',
      'layer c l1',
      'layer b l1',
      'layer a l1',
    ]);

    calls.length = 0;
    removeB();
    removeC();
    expect(calls).toEqual(['remove b', 'remove c']);
    expect(removed).toEqual([]);
    removeA();
    expect(removed).toHaveLength(2);
  });
});

describe('a companion provider', () => {
  it('keeps the hit it returned and gives it back to onClick with the click', () => {
    const own: Hit = { kind: 'companion', id: 'label', featureId: 'f', distancePx: 3 };
    const onClick = vi.fn(() => true);
    const feature = { id: 'f', type: 'Point', geometry: { type: 'Point', coordinates: [1, 1] } };
    const deps = {
      store: { getFeature: () => feature },
      screen: {},
      customLayer: { getGL: () => null },
      anchors: createTerrainAnchors,
    } as unknown as AdapterDeps;
    const provider = adaptCompanionProvider(
      { name: 'labels', has: () => true, draw() {}, hitTest: () => own, onClick },
      deps,
    );
    const registry = createFeatureCompanionRegistry();
    registry.register(provider);
    const hit = provider.hitTest(
      feature as never,
      { x: 5, y: 5 },
      {
        point: { x: 5, y: 5 },
        project: () => ({ x: 0, y: 0 }),
        unproject: () => ({ lng: 1, lat: 1 }),
        zoom: 10,
        tolerancePx: 4,
      },
    );
    expect(hit?.id).toBe('label');
    const click = {
      type: 'click',
      point: { x: 5, y: 5 },
      lngLat: { lng: 1, lat: 1 },
      originalEvent: {} as MouseEvent,
      modifiers: { shift: false, ctrl: false, alt: false, meta: false },
    } as MouseNormalizedEvent;
    provider.onCompanionClick('f', hit as never, click);
    expect(onClick).toHaveBeenCalledWith(feature, own, expect.objectContaining({ lngLat: [1, 1] }));
  });
});

describe('the outline of any feature on the screen', () => {
  /** A draw instance on an engine, with the screen of its extensions */
  function withScreen() {
    const engine = createEngine(createMapStub().map, {}, { deferDefaultMode: true });
    const draw = createDrawOnEngine(engine);
    engine.enterDefaultMode();
    let screen: ScreenContext | null = null;
    draw.extensions.plugins.add({
      name: 'reader',
      onAdd(ctx) {
        screen = ctx.screen;
      },
    });
    return { engine, draw, screen: screen as unknown as ScreenContext };
  }
  const renderer = { onAdd: vi.fn(), draw: vi.fn(), onRemove: vi.fn() };
  /** Creates a feature that must be created */
  const create = (draw: Draw, input: FeatureInput): Feature => {
    const feature = draw.features.create(input);
    if (!feature) throw new Error('not created');
    return feature;
  };

  it('gives the corners of the extent of a line or an area, and the frame of a point', () => {
    const { engine, draw, screen } = withScreen();
    const area = create(draw, {
      type: 'Polygon',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      },
    });
    // (0, 0) is (400, 300) on the screen of the stub, where 1 degree is 100 px
    expect(screen.outline(area)).toEqual([
      [400, 200],
      [500, 200],
      [500, 300],
      [400, 300],
    ]);
    const point = create(draw, {
      type: 'Point',
      geometry: { type: 'Point', coordinates: [1, 1] },
    });
    // The frame of a point spans its marker: a radius of 6 px and an outline of 2 px
    expect(screen.outline(point)).toEqual([
      [492, 192],
      [508, 192],
      [508, 208],
      [492, 208],
    ]);
    engine.destroy();
  });

  it('gives the turned corners of an image', () => {
    const { engine, draw, screen } = withScreen();
    const image = (rotation: number) =>
      create(draw, {
        type: 'Image',
        geometry: { type: 'Point', coordinates: [1, 1] },
        properties: {
          'maplibre-gl-draw:imageWidth': 200,
          'maplibre-gl-draw:imageHeight': 100,
          'maplibre-gl-draw:rotation': rotation,
        },
      });
    const [topLeft, topRight, bottomRight] = screen.outline(image(0));
    expect(topLeft[1]).toBeCloseTo(topRight[1]);
    expect(topRight[0]).toBeCloseTo(bottomRight[0]);
    expect(topRight[0] - topLeft[0]).toBeGreaterThan(bottomRight[1] - topRight[1]);
    const turned = screen.outline(image(90));
    expect(turned).toHaveLength(4);
    // Turned a quarter, the top edge stands upright
    expect(turned[0][0]).toBeCloseTo(turned[1][0]);
    expect(turned[1][1]).toBeCloseTo(turned[2][1]);
    engine.destroy();
  });

  it('gives the outline of a custom type, or the corners of its bounds', () => {
    const { engine, draw, screen } = withScreen();
    draw.extensions.featureTypes.add({
      type: 'diamond',
      geometry: 'Polygon',
      renderer,
      outline: (feature, ctx) => {
        const [x, y] = ctx.project((feature.geometry as GeoJSON.Polygon).coordinates[0][0]);
        return [
          [x, y - 20],
          [x + 20, y],
          [x, y + 20],
          [x - 20, y],
        ];
      },
    });
    draw.extensions.featureTypes.add({
      type: 'badge',
      geometry: 'Point',
      renderer,
      bounds: (feature, ctx) => {
        const [x, y] = ctx.project((feature.geometry as GeoJSON.Point).coordinates);
        return { min: [x - 10, y - 5], max: [x + 10, y + 5] };
      },
    });
    const ring = [
      [1, 1],
      [2, 1],
      [2, 2],
      [1, 1],
    ];
    const diamond = create(draw, {
      type: 'diamond',
      geometry: { type: 'Polygon', coordinates: [ring] },
    });
    const corners = screen.outline(diamond);
    const expected = [
      [500, 180],
      [520, 200],
      [500, 220],
      [480, 200],
    ];
    corners.forEach((corner, i) => {
      expect(corner[0]).toBeCloseTo(expected[i][0]);
      expect(corner[1]).toBeCloseTo(expected[i][1]);
    });
    const badge = create(draw, {
      type: 'badge',
      geometry: { type: 'Point', coordinates: [1, 1] },
    });
    expect(screen.outline(badge)).toEqual([
      [490, 195],
      [510, 195],
      [510, 205],
      [490, 205],
    ]);
    engine.destroy();
  });
});
