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
import { writesOf } from '../../test-support/writes.js';
import { createMapStub, createSyntheticInput } from '../../test-utils.js';
import { createFeatureCompanionRegistry } from '../../view/feature-companion.js';
import { calculateOffsetUniforms } from '../../view/shaders/helpers.js';
import type { TerrainContext } from '../../view/terrain/context.js';
import { computeBoundingBox, hasZeroArea } from '../../view/ui/selection-ui/index.js';
import { offsetUniformsAt, viewUniforms } from '../../webgl/index.js';
import { DrawError } from '../errors.js';
import type { FootprintContext, PointContext, ScreenContext } from '../extension/context.js';
import type { FeatureTypeDefinition, Footprint, Handle } from '../extension/feature-type.js';
import type { Hit } from '../extension/provider.js';
import type { RenderContext } from '../extension/render.js';
import type { Feature, StoredFeature } from '../model.js';
import type { LayerTableView } from '../tables.js';
import type { AdapterDeps } from './adapters.js';
import { adaptCompanionProvider } from './adapters.js';
import { createTerrainSurface } from './contexts.js';
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
    render: vi.fn(),
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

    const base = baseContext();
    const feature = engine.context.store.getFeature('p1');
    adapter.draw(feature as never, PROJECTION, 12, base);
    const [drawn, ctx] = definition.render.mock.calls[0] as unknown as [Feature, RenderContext];
    expect(drawn.id).toBe('p1');
    // The screen of the frame is the screen of the extensions, read while the frame is drawn
    let screen: ScreenContext | null = null;
    engine.extensions.collections.plugins.add({
      name: 'screen',
      onAdd(context) {
        screen = context.screen;
      },
    });
    expect(ctx.screen).toBe(screen);
    expect(ctx).not.toHaveProperty('zoom');
    expect(ctx).not.toHaveProperty('pixelRatio');
    expect(ctx.opacity).toBe(0.5);
    // The details of the GPU are read through /webgl, not from the context
    expect(ctx).not.toHaveProperty('shader');
    expect(ctx).not.toHaveProperty('offset');
    expect(ctx).not.toHaveProperty('projection');
    const view = viewUniforms(ctx);
    expect(view.shader.variantName).toBe('mercator');
    expect(view.projection).toBe(PROJECTION);
    const frame = { ...PROJECTION, mainMatrix: base.mainMatrixArray as never };
    expect(view.offset).toEqual(calculateOffsetUniforms(base.centerLngLat, frame));
    expect(offsetUniformsAt(ctx, [1, 2])).toEqual(calculateOffsetUniforms([1, 2], frame));
    expect(() => viewUniforms({} as RenderContext)).toThrow(DrawError);

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
    // A width given at a reference zoom follows the zoom from it
    ctx.line.draw(
      [
        [0, 0],
        [1, 1],
      ],
      { width: 2, color: '#ff0000', opacity: 1, lineStyle: 'solid' },
      { referenceZoom: 10 },
    );
    expect(base.sdfLineRenderer.draw).toHaveBeenLastCalledWith(
      [
        [0, 0],
        [1, 1],
      ],
      { width: 2, color: [1, 0, 0, 1], opacity: 1, lineStyle: 'solid' },
      { widthUnit: 'pixels', createdZoom: 10, closed: false },
      12,
      PROJECTION,
    );
    // So do the size and the outline of a point marker: four times as large two zooms in
    const marker = {
      shape: 'circle' as const,
      size: 6,
      fillColor: '#00ff00',
      fillOpacity: 1,
      strokeColor: '#000000',
      strokeWidth: 1,
      strokeOpacity: 1,
    };
    ctx.point.draw([0, 0], marker);
    expect(base.pointShapeRenderer.draw).toHaveBeenLastCalledWith(
      [0, 0],
      expect.objectContaining({ size: 6, strokeWidth: 1 }),
      undefined,
      undefined,
    );
    ctx.point.draw([0, 0], marker, { referenceZoom: 10 });
    expect(base.pointShapeRenderer.draw).toHaveBeenLastCalledWith(
      [0, 0],
      expect.objectContaining({ size: 24, strokeWidth: 4 }),
      undefined,
      undefined,
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
    );

    adapter.onRemove();
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

  it('shows its handles, and a drag of one gives the patch of onHandleDrag', () => {
    const { store, selectionScope } = engine.context;
    const provider = selectionScope.auxiliaryHandles.list()[0];
    const feature = store.getFeature('p1');
    expect(feature).toBeDefined();
    const shown = provider.getHandles(feature as never, {} as never);
    expect(shown).toEqual([
      { kind: 'resize', id: 'corner', position: [1.5, 1], cursor: 'ew-resize' },
    ]);

    expect(
      provider.onHandleDragStart(
        { providerId: provider.id, handleId: 'corner', featureId: 'p1' },
        drag('dragstart', 1.5, 1),
      ),
    ).toBe(true);
    provider.onHandleDragMove(drag('dragmove', 1.7, 1));
    const patch = provider.onHandleDragRelease?.(drag('dragend', 2, 1));
    provider.onHandleDragEnd(drag('dragend', 2, 1));

    expect(definition.onHandleDrag).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'p1' }),
      handle,
      expect.objectContaining({ lngLat: [2, 1] }),
    );
    expect(patch).toEqual({ properties: { size: 2 } });
  });

  it('gives the Store the patch of a drag as its fields: the style under its key becomes the style', () => {
    const engine = engineWithDraw();
    engine.extensions.collections.featureTypes.add({
      type: 'wide',
      geometry: 'Point',
      render: vi.fn(),
      handles: () => [handle],
      onHandleDrag: (_feature, _handle, event) => ({
        properties: { 'maplibre-gl-draw:style': { strokeWidth: event.lngLat[0] }, note: 'x' },
      }),
    });
    const { store, selectionScope } = engine.context;
    store.createFeature({
      id: 'w',
      type: 'wide',
      geometry: { type: 'Point', coordinates: [1, 1] },
      layerId: store.listLayers()[0].id,
      groupId: undefined,
      properties: {},
      style: {},
      locked: false,
      visible: true,
    });
    const [provider] = selectionScope.auxiliaryHandles
      .list()
      .filter((p) => p.id.endsWith('type:wide'));
    const grabbed = { providerId: provider.id, handleId: handle.id, featureId: 'w' };
    expect(provider.onHandleDragStart(grabbed, drag('dragstart', 1, 1))).toBe(true);
    const patch = provider.onHandleDragMove(drag('dragmove', 3, 1));
    expect(patch).toEqual({ style: { strokeWidth: 3 }, properties: { note: 'x' } });
    engine.destroy();
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

describe('the pictures of the points of a custom feature type', () => {
  it('reach the drawing of the rows as its renderer gives them', () => {
    const engine = engineWithDraw();
    let registered: FeatureTypeRenderer | null = null;
    const register = engine.customLayer.registerFeatureRenderer.bind(engine.customLayer);
    vi.spyOn(engine.customLayer, 'registerFeatureRenderer').mockImplementation((type, r) => {
      registered = r;
      return register(type, r);
    });
    const rowSprites = { texture: null, revision: 0, sprite: () => null };
    engine.extensions.collections.featureTypes.override({
      type: 'Point',
      geometry: 'Point',
      appliesTo: () => true,
      rows: { appliesTo: () => true, sprites: rowSprites },
    });
    expect((registered as unknown as FeatureTypeRenderer).rowSprites).toBe(rowSprites);
    engine.destroy();
  });
});

describe('the answers of a custom feature type and a companion provider from the rows', () => {
  it('reach the classification of the rows with the answer of appliesTo, and only with it', () => {
    const engine = engineWithDraw();
    const registered: FeatureTypeRenderer[] = [];
    const register = engine.customLayer.registerFeatureRenderer.bind(engine.customLayer);
    vi.spyOn(engine.customLayer, 'registerFeatureRenderer').mockImplementation((type, r) => {
      registered.push(r);
      return register(type, r);
    });
    const appliesToRow = vi.fn(() => true);
    engine.extensions.collections.featureTypes.override({
      type: 'Point',
      geometry: 'Point',
      appliesTo: () => true,
      rows: { appliesTo: appliesToRow },
      render: vi.fn(),
    });
    engine.extensions.collections.featureTypes.add({
      type: 'pin',
      geometry: 'Point',
      rows: { appliesTo: appliesToRow },
      render: vi.fn(),
    });
    const [point, pin] = registered;
    const view = {} as LayerTableView;
    expect(point.appliesToRow?.(view, 3)).toBe(true);
    expect(appliesToRow).toHaveBeenCalledWith(view, 3);
    // A type added takes every feature of its type: it is not asked
    expect(pin.appliesToRow).toBeUndefined();
    engine.destroy();
  });

  it('refuses the rows of a type, of a renderer or of a companion provider of the wrong shape', () => {
    const engine = engineWithDraw();
    const render = vi.fn();
    expect(() =>
      engine.extensions.collections.featureTypes.add({
        type: 'pin',
        geometry: 'Point',
        rows: { appliesTo: true as never },
        render,
      }),
    ).toThrow(/rows\.appliesTo/);
    expect(() =>
      engine.extensions.collections.featureTypes.add({
        type: 'pin',
        geometry: 'Point',
        rows: true as never,
        render,
      }),
    ).toThrow(/rows/);
    expect(() =>
      engine.extensions.collections.companionProviders.add({
        name: 'rings',
        has: () => false,
        rows: { has: 'yes' as never },
        draw: () => {},
        hitTest: () => null,
      }),
    ).toThrow(/rows\.has/);
    engine.destroy();
  });
});

describe('the footprint of a custom feature type', () => {
  const baseFeature = {
    layerId: 'l',
    groupId: undefined,
    properties: {},
    style: {},
    locked: false,
    visible: true,
  };
  const render = vi.fn();
  /** A diamond 0.2 degrees around the first position of a feature, laid on the map */
  const diamond = (feature: Feature): Footprint => {
    const geometry = feature.geometry as GeoJSON.Point | GeoJSON.Polygon;
    const [x, y] = geometry.type === 'Point' ? geometry.coordinates : geometry.coordinates[0][0];
    return {
      kind: 'ground',
      corners: {
        topLeft: [x, y + 0.2],
        topRight: [x + 0.2, y],
        bottomRight: [x, y - 0.2],
        bottomLeft: [x - 0.2, y],
      },
    };
  };
  const polygon = {
    ...baseFeature,
    id: 't',
    type: 'shape',
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
  const point = {
    ...baseFeature,
    id: 'p',
    type: 'shape',
    geometry: { type: 'Point' as const, coordinates: [1, 1] },
  };

  it('frames a footprint laid on the map on the map, whatever the geometry', () => {
    const engine = engineWithDraw();
    engine.extensions.collections.featureTypes.add({
      type: 'shape',
      geometry: 'Point',
      render,
      footprint: (feature) => diamond(feature),
    });
    const { extensions } = engine.context.selectionScope;
    const box = computeBoundingBox(point, extensions);
    expect(box).toEqual({
      topLeft: [1, 1.2],
      topRight: [1.2, 1],
      bottomRight: [1, 0.8],
      bottomLeft: [0.8, 1],
      center: [1, 1],
    });
    // A box with area: the resize and rotate handles stand on its corners
    expect(box && hasZeroArea(box)).toBe(false);
    engine.destroy();
  });

  it('frames a footprint of the screen on the screen around its position, whatever the geometry', () => {
    const engine = engineWithDraw();
    engine.extensions.collections.featureTypes.add({
      type: 'shape',
      geometry: 'Polygon',
      render,
      footprint: () => ({ kind: 'screen', position: [1.5, 1.5], halfWidthPx: 20, halfHeightPx: 8 }),
    });
    const { extensions } = engine.context.selectionScope;
    const box = computeBoundingBox(polygon, extensions);
    expect(box?.center).toEqual([1.5, 1.5]);
    expect(box && hasZeroArea(box)).toBe(true);
    expect(extensions.resolvePointFrameCorners(polygon, { x: 550, y: 150 }, 4)).toEqual([
      { x: 526, y: 138 },
      { x: 574, y: 138 },
      { x: 574, y: 162 },
      { x: 526, y: 162 },
    ]);
    engine.extensions.collections.featureTypes.remove('shape');
    expect(computeBoundingBox(polygon, extensions)?.center).toEqual([1.5, 1.5]);
    engine.destroy();
  });

  it('gives the footprint a context of the screen alone, which it cannot change', () => {
    const engine = engineWithDraw();
    const contexts: FootprintContext[] = [];
    engine.extensions.collections.featureTypes.add({
      type: 'shape',
      geometry: 'Polygon',
      render,
      footprint: (_feature, ctx) => {
        contexts.push(ctx);
        return null;
      },
    });
    computeBoundingBox(polygon, engine.context.selectionScope.extensions);
    expect(contexts.length).toBeGreaterThan(0);
    const [ctx] = contexts;
    expect(Object.keys(ctx)).toEqual(['screen']);
    expect(typeof ctx.screen.project).toBe('function');
    expect(Object.isFrozen(ctx)).toBe(true);
    engine.destroy();
  });

  it('gives the footprint of the geometry for one that is not one, and none for null', () => {
    const engine = engineWithDraw();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let given: unknown = null;
    engine.extensions.collections.featureTypes.add({
      type: 'shape',
      geometry: 'Polygon',
      render,
      footprint: () => given as Footprint | null,
    });
    const { extensions } = engine.context.selectionScope;
    expect(computeBoundingBox(polygon, extensions)).toBeNull();
    const ofGeometry = {
      topLeft: [1, 2],
      topRight: [2, 2],
      bottomRight: [2, 1],
      bottomLeft: [1, 1],
      center: [1.5, 1.5],
    };
    for (const wrong of [
      { kind: 'ground', corners: { topLeft: [0, 0], topRight: [1, 0], bottomRight: [1, 1] } },
      { kind: 'screen', position: [1, 1], halfWidthPx: -1, halfHeightPx: 2 },
      { kind: 'screen', position: [Number.NaN, 1], halfWidthPx: 1, halfHeightPx: 2 },
      { kind: 'other' },
      [],
    ]) {
      given = wrong;
      expect(computeBoundingBox(polygon, extensions)).toEqual(ofGeometry);
    }
    // Told once, in the console, as a handle left out is
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/"shape" gave a footprint that is not one/);
    warn.mockRestore();
    engine.destroy();
  });

  it('refuses a footprint that is not a function', () => {
    const engine = engineWithDraw();
    expect(() =>
      engine.extensions.collections.featureTypes.add({
        type: 'wrong',
        geometry: 'Point',
        render,
        footprint: [] as never,
      }),
    ).toThrow(/footprint/);
    engine.destroy();
  });
});

describe('the extent of a custom feature type', () => {
  it('measures its features in the spatial index by bbox, and by the geometry without it', () => {
    const engine = createEngine(createMapStub().map, {}, { deferDefaultMode: true });
    const draw = createDrawOnEngine(engine);
    engine.enterDefaultMode();
    let reach = 2;
    const render = vi.fn();
    const remove = draw.extensions.featureTypes.add({
      type: 'wide',
      geometry: 'Point',
      render,
      // A disc of `reach` degrees drawn around the point
      bbox(feature) {
        const [x, y] = (feature.geometry as GeoJSON.Point).coordinates;
        return [x - reach, y - reach, x + reach, y + reach];
      },
    });
    const feature = writesOf(draw).features.create({
      type: 'wide',
      geometry: { type: 'Point', coordinates: [10, 10] },
    });
    if (!feature) throw new Error('not created');
    const near = [11, 11, 11.5, 11.5] as [number, number, number, number];
    expect(
      writesOf(draw)
        .features.list({ bbox: near })
        .map((f) => f.id),
    ).toEqual([feature.id]);
    expect(engine.context.spatialIndex.findNear([11.5, 10], 0)).toEqual([feature.id]);

    // A change outside the document is measured again with invalidate
    reach = 1;
    expect(writesOf(draw).features.list({ bbox: [11.5, 11.5, 12, 12] })).toHaveLength(1);
    engine.context.spatialIndex.invalidateType('wide');
    expect(writesOf(draw).features.list({ bbox: [11.5, 11.5, 12, 12] })).toHaveLength(0);
    expect(writesOf(draw).features.list({ bbox: near })).toHaveLength(1);

    // An extent that is not four finite numbers gives the one of the geometry, told once
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    reach = Number.NaN;
    engine.context.spatialIndex.invalidateType('wide');
    expect(writesOf(draw).features.list({ bbox: near })).toHaveLength(0);
    expect(writesOf(draw).features.list({ bbox: [9, 9, 10, 10] })).toHaveLength(1);
    engine.context.spatialIndex.invalidateType('wide');
    expect(writesOf(draw).features.list({ bbox: [9, 9, 10, 10] })).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/"wide" gave a bbox that is not one/);
    warn.mockRestore();

    reach = 2;
    engine.context.spatialIndex.invalidateType('wide');
    expect(writesOf(draw).features.list({ bbox: near })).toHaveLength(1);
    remove();
    expect(writesOf(draw).features.list({ bbox: near })).toHaveLength(0);
    draw.destroy();
  });

  it('refuses a bbox that is not a function', () => {
    const engine = engineWithDraw();
    expect(() =>
      engine.extensions.collections.featureTypes.add({
        type: 'wrong',
        geometry: 'Point',
        render: vi.fn(),
        bbox: [0, 0, 1, 1] as never,
      }),
    ).toThrow(/bbox/);
    engine.destroy();
  });
});

describe('the start and the end of a handle drag', () => {
  const handle: Handle = { id: 'h', position: [1, 1], kind: 'resize' };
  const render = vi.fn();

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

  it('asks onHandleDragStart, which can refuse, and calls onHandleDragEnd once after the last onHandleDrag', () => {
    const engine = setUp();
    const calls: string[] = [];
    let accept = false;
    engine.extensions.collections.handleProviders.add({
      name: 'grips',
      handles: () => [handle],
      onHandleDrag: (feature, _handle, event) => {
        calls.push(`drag ${feature?.id} ${event.lngLat[0]}`);
        return { properties: { at: event.lngLat[0] } };
      },
      onHandleDragStart: (feature, grabbed, event) => {
        calls.push(`start ${feature?.id} ${grabbed.id} ${event.lngLat[0]}`);
        return accept;
      },
      onHandleDragEnd: (feature, grabbed, event) => {
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
    provider.onHandleDragRelease?.(drag('dragend', 3, 1));
    provider.onHandleDragEnd(drag('dragend', 3, 1));
    // A second end, with no drag going on, is not announced
    provider.onHandleDragEnd(drag('dragend', 4, 1));
    expect(calls).toEqual(['start f h 1', 'drag f 2', 'drag f 3', 'end undefined h 3']);
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
      onHandleDrag: () => null,
      onHandleDragStart: onDragStart,
      onHandleDragEnd: onDragEnd,
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
      render,
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
      expect.objectContaining({ id: 'g' }),
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
      {
        surface: createTerrainSurface,
        screen: { zoom: 7 } as ScreenContext,
        appliedStyle: () => {
          throw new Error('no look is read');
        },
      },
    );
    const calls: string[] = [];
    const overlay = (name: string, order?: number) => ({
      name,
      ...(order !== undefined && { order }),
      draw: (ctx: RenderContext) => calls.push(`draw ${name} ${ctx.screen.zoom}`),
      drawForLayer: (layerId: string) => calls.push(`layer ${name} ${layerId}`),
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

    removeB();
    removeC();
    expect(removed).toEqual([]);
    removeA();
    expect(removed).toHaveLength(2);
  });
});

describe('a companion provider', () => {
  it('keeps the hit it returned and gives it back to onClick with the click', () => {
    const own = { id: 'ring', distancePx: 3 };
    const filled: Hit = { kind: 'companion', id: 'ring', featureId: 'f', distancePx: 3 };
    const onClick = vi.fn(() => true);
    const feature: StoredFeature = {
      id: 'f',
      type: 'Point',
      geometry: { type: 'Point', coordinates: [1, 1] },
      layerId: 'l',
      groupId: undefined,
      properties: { name: 'F' },
      style: {},
      visible: true,
      locked: false,
    };
    const deps = {
      store: { getFeature: () => feature },
      shapes: { draggedIds: () => [] },
      screen: {},
      customLayer: { getGL: () => null },
      surface: createTerrainSurface,
    } as unknown as AdapterDeps;
    const provider = adaptCompanionProvider(
      { name: 'rings', has: () => true, draw() {}, hitTest: () => own, onClick },
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
    expect(hit?.id).toBe('ring');
    const click = {
      type: 'click',
      point: { x: 5, y: 5 },
      lngLat: { lng: 1, lat: 1 },
      originalEvent: {} as MouseEvent,
      modifiers: { shift: false, ctrl: false, alt: false, meta: false },
    } as MouseNormalizedEvent;
    provider.onCompanionClick('f', hit as never, click);
    // The provider is given the feature in the public shape
    expect(onClick).toHaveBeenCalledWith(
      {
        type: 'Feature',
        id: 'f',
        geometry: { type: 'Point', coordinates: [1, 1] },
        properties: { name: 'F', 'maplibre-gl-draw:layerId': 'l' },
      },
      filled,
      expect.objectContaining({ lngLat: [1, 1] }),
    );
  });

  it('tells its hit test what the reading leaves out: the features this client drags', () => {
    const contexts: PointContext[] = [];
    let dragged: string[] | null = null;
    const deps = {
      store: { getFeature: () => undefined },
      shapes: { draggedIds: () => dragged ?? [] },
      screen: {},
      customLayer: { getGL: () => null },
      surface: createTerrainSurface,
    } as unknown as AdapterDeps;
    const provider = adaptCompanionProvider(
      {
        name: 'probe',
        has: () => true,
        draw() {},
        hitTest: (_feature, ctx) => {
          contexts.push(ctx);
          return null;
        },
      },
      deps,
    );
    const at = {
      point: { x: 5, y: 5 },
      project: () => ({ x: 0, y: 0 }),
      unproject: () => ({ lng: 1, lat: 1 }),
      zoom: 10,
      tolerancePx: 4,
    };
    const feature: StoredFeature = {
      id: 'f',
      type: 'Point',
      geometry: { type: 'Point', coordinates: [1, 1] },
      layerId: 'l',
      groupId: undefined,
      properties: {},
      style: {},
      visible: true,
      locked: false,
    };
    provider.hitTest(feature as never, { x: 5, y: 5 }, at);
    dragged = ['f', 'g'];
    provider.hitTest(feature as never, { x: 5, y: 5 }, at);
    expect(contexts[0]).not.toHaveProperty('excludeIds');
    expect([...(contexts[1].excludeIds ?? [])]).toEqual(['f', 'g']);
  });

  it('answers from the rows with its rows.has, and has none without it', () => {
    const deps = {
      store: { getFeature: () => undefined },
      shapes: { draggedIds: () => [] },
      screen: {},
      customLayer: { getGL: () => null },
      surface: createTerrainSurface,
    } as unknown as AdapterDeps;
    const hasRow = vi.fn((_view: LayerTableView, handle: number) => handle === 2);
    const fromRows = adaptCompanionProvider(
      { name: 'rows', has: () => false, rows: { has: hasRow }, draw() {}, hitTest: () => null },
      deps,
    );
    const view = {} as LayerTableView;
    expect(fromRows.hasRow?.(view, 2)).toBe(true);
    expect(fromRows.hasRow?.(view, 1)).toBe(false);
    expect(hasRow).toHaveBeenCalledWith(view, 2);
    const fromFeatures = adaptCompanionProvider(
      { name: 'features', has: () => true, draw() {}, hitTest: () => null },
      deps,
    );
    expect(fromFeatures.hasRow).toBeUndefined();
    expect(fromRows.classifyKeys).toBeUndefined();
  });

  it('takes the keys its answers read from rows.classifyKeys, as they are when it is added', () => {
    const deps = {
      store: { getFeature: () => undefined },
      shapes: { draggedIds: () => [] },
      screen: {},
      customLayer: { getGL: () => null },
      surface: createTerrainSurface,
    } as unknown as AdapterDeps;
    const classifyKeys = ['ring'];
    const provider = adaptCompanionProvider(
      {
        name: 'rows',
        has: () => false,
        rows: { has: () => false, classifyKeys },
        draw() {},
        hitTest: () => null,
      },
      deps,
    );
    classifyKeys.push('name');
    expect(provider.classifyKeys).toEqual(['ring']);
  });
});
