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
import type { FeatureTypeDefinition, Handle } from '../extension/feature-type.js';
import type { Hit } from '../extension/provider.js';
import type { RenderContext } from '../extension/render.js';
import type { Feature } from '../model.js';
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
