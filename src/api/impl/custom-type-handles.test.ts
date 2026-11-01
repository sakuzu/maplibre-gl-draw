// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The handles of a custom feature type
 *
 * - A type with a footprint laid on the map has the resize handles on the corners of its
 *   selection box and the rotate handle above it, drawn and hit as those of a built-in shape; a
 *   footprint of the screen has none
 * - Their drags are the resize and the rotation of the library (the edits `scale` and `rotate`),
 *   which write the fields the type declares (`transformFields`), from 0 and 1 for a feature
 *   without them, whether one feature is selected, several, or features selected in bulk; a
 *   rotation of a single feature of a `Point` turns it around its position. A type that declares
 *   none has none, whatever keys its features have
 * - The edits of a Store of the library (`applyEdits`) write the same fields, over features and
 *   over rows not made features
 * - The handles a type or a provider adds: a `resize` one is drawn as a resize handle and hit at
 *   its size, a `custom` one is drawn by the extension (`drawHandles`, with a render context of
 *   the frame) and is hit at the size it declares, and a handle of another kind, or a custom one
 *   of a size not above 0, is left out with a warning once a reason
 * - A definition that overrides a built-in type cannot declare fields
 * - Their `handles` receive the screen, the selection box the library draws
 *   (`draw.rendered.getSelectionBox`; none for the handles of no feature) and the look of the
 *   selection
 */

import type { ProjectionData } from 'maplibre-gl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DragNormalizedEvent, MouseNormalizedEvent } from '../../dispatcher/types.js';
import type { FrameDrawContext } from '../../extension/renderers.js';
import { transformBulkSelection } from '../../operations/bulk-transform.js';
import { DEFAULT_SELECTION_CONFIG } from '../../shared/config/selection.js';
import { DrawStore } from '../../store/draw-store.js';
import type { Store } from '../../store/store.js';
import { TableContractStore } from '../../store/table-memory.js';
import type { Feature as StoredFeature } from '../../store/types.js';
import { createMapStub, planeMetersPerPixel, STORE_KINDS } from '../../test-utils.js';
import type { TerrainContext } from '../../view/terrain/context.js';
import type { AuxiliaryHandleContext } from '../../view/ui/auxiliary-handles.js';
import { hitTestHandles } from '../../view/ui/handle-test.js';
import { computeRotateHandle } from '../../view/ui/handles.js';
import type { Draw } from '../draw.js';
import { DrawError } from '../errors.js';
import type { HandleContext } from '../extension/context.js';
import type { FeatureTypeDefinition, Footprint, Handle } from '../extension/feature-type.js';
import { createDrawOnEngine } from './create-draw.js';
import { createEngine, type Engine } from './engine.js';

type LngLat = [number, number];

/** The margin of the selection box in degrees (the map stub lays 100 px on a degree) */
const MARGIN = DEFAULT_SELECTION_CONFIG.box.margin / 100;

/** The keys a signboard keeps its rotation and its size under */
const ANGLE = 'boardAngle';
const SIZE = 'boardScale';

/**
 * A signboard: a box laid on the map east of its position (0.4 degrees wide, 0.2 tall), so that
 * the middle of its box is not its position
 */
function boardFootprint(feature: { geometry: unknown }): Footprint {
  const [x, y] = (feature.geometry as GeoJSON.Point).coordinates as LngLat;
  return {
    kind: 'ground',
    corners: {
      topLeft: [x, y + 0.1],
      topRight: [x + 0.4, y + 0.1],
      bottomRight: [x + 0.4, y - 0.1],
      bottomLeft: [x, y - 0.1],
    },
  };
}

const renderer = { onAdd: vi.fn(), draw: vi.fn(), onRemove: vi.fn() };

/** The type of the signboards, which declares the fields of its rotation and its size */
const CARD: FeatureTypeDefinition = {
  type: 'card',
  geometry: 'Point',
  renderer,
  footprint: boardFootprint,
  transformFields: { angleDegreesKey: ANGLE, scaleKey: SIZE, uniformScale: true },
};

/** A label box: the same footprint, no field declared */
const LABEL: FeatureTypeDefinition = {
  type: 'label',
  geometry: 'Point',
  renderer,
  footprint: boardFootprint,
};

/** A feature of a type at a position */
function featureOf(
  id: string,
  type: string,
  at: LngLat,
  properties: Record<string, unknown> = {},
): StoredFeature {
  return {
    id,
    type,
    geometry: { type: 'Point', coordinates: at },
    layerId: 'l',
    groupId: undefined,
    properties,
    style: {},
    visible: true,
    locked: false,
  } as StoredFeature;
}

interface Opened {
  engine: Engine;
  draw: Draw;
  store: Store;
}

const opened: Draw[] = [];

afterEach(() => {
  for (const draw of opened.splice(0)) draw.destroy();
  vi.useRealTimers();
});

/** An instance over a Store with the types registered and a layer `l` of the features given */
function open(store: Store, features: readonly StoredFeature[]): Opened {
  vi.useFakeTimers();
  store.createLayer({
    id: 'l',
    name: 'l',
    visible: true,
    locked: false,
    opacity: 1,
    ...(store.tables ? { kind: 'table' } : { items: [] }),
    styleRule: undefined,
    metadata: undefined,
  } as never);
  const engine = createEngine(
    createMapStub().map,
    { store, initDefaultLayer: false },
    { deferDefaultMode: true },
  );
  const draw = createDrawOnEngine(engine, { store, initDefaultLayer: false });
  engine.enterDefaultMode();
  opened.push(draw);
  draw.extensions.featureTypes.add(CARD);
  draw.extensions.featureTypes.add(LABEL);
  store.transact(() => {
    for (const feature of features) store.createFeature(feature);
  });
  return { engine, draw, store };
}

/** A mouse or drag event at a position, as the normalizer gives it to the input router */
function event<T extends MouseNormalizedEvent | DragNormalizedEvent>(
  engine: Engine,
  type: T['type'],
  at: LngLat,
  start: LngLat = at,
): T {
  const point = engine.map.project(at);
  const from = engine.map.project(start);
  const inert = {
    preventDefault: () => {},
    stopPropagation: () => {},
    button: 0,
    buttons: 1,
    clientX: point.x,
    clientY: point.y,
  };
  return {
    type,
    point: { x: point.x, y: point.y },
    lngLat: { lng: at[0], lat: at[1] },
    originalEvent: inert as unknown as MouseEvent,
    modifiers: { shift: false, ctrl: false, alt: false, meta: false },
    dragStartPoint: { x: from.x, y: from.y },
    dragStartLngLat: { lng: start[0], lat: start[1] },
  } as unknown as T;
}

/** A drag from a position to another, let go there */
function drag({ engine }: Opened, from: LngLat, to: LngLat): void {
  const router = engine.inputRouter;
  router.dispatch(event<MouseNormalizedEvent>(engine, 'mousemove', from));
  router.dispatch(event<MouseNormalizedEvent>(engine, 'mousedown', from));
  router.dispatch(event<DragNormalizedEvent>(engine, 'dragstart', from, from));
  const middle: LngLat = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
  router.dispatch(event<DragNormalizedEvent>(engine, 'dragmove', middle, from));
  router.dispatch(event<DragNormalizedEvent>(engine, 'dragmove', to, from));
  router.dispatch(event<DragNormalizedEvent>(engine, 'dragend', to, from));
  vi.runAllTimers();
}

/** The selection box of features as `[west, south, east, north]`, its margin included */
function boxOf(features: readonly StoredFeature[]): [number, number, number, number] {
  const corners = features.flatMap((feature) => {
    const { corners } = boardFootprint(feature) as Extract<Footprint, { kind: 'ground' }>;
    return [corners.topLeft, corners.bottomRight];
  });
  return [
    Math.min(...corners.map((c) => c[0] as number)) - MARGIN,
    Math.min(...corners.map((c) => c[1] as number)) - MARGIN,
    Math.max(...corners.map((c) => c[0] as number)) + MARGIN,
    Math.max(...corners.map((c) => c[1] as number)) + MARGIN,
  ];
}

/** The rotate handle above a selection box (its margin included) */
function rotateHandleOf([w, s, e, n]: readonly number[]): LngLat {
  const box = {
    topLeft: [w, n] as LngLat,
    topRight: [e, n] as LngLat,
    bottomRight: [e, s] as LngLat,
    bottomLeft: [w, s] as LngLat,
    center: [(w + e) / 2, (s + n) / 2] as LngLat,
  };
  const handle = computeRotateHandle(box, DEFAULT_SELECTION_CONFIG.rotateHandle.distance, {
    metersPerPixel: planeMetersPerPixel(100),
  });
  return handle.position as LngLat;
}

/** The position of a feature */
function positionOf(store: Store, id: string): LngLat {
  const feature = store.getFeature(id) as StoredFeature;
  return (feature.geometry as GeoJSON.Point).coordinates as LngLat;
}

/** A property of a feature */
function propertyOf(store: Store, id: string, key: string): unknown {
  return store.getFeature(id)?.properties[key];
}

/** An angle within [0, 360) as a number of a half turn or less away from it */
function turned(angle: unknown): number {
  return Number(angle);
}

describe.each(STORE_KINDS)('the handles of a footprint laid on the map over %s', (_, makeStore) => {
  it('are the resize handles on the corners of the selection box and the rotate handle above it', () => {
    const view = open(makeStore(), [featureOf('c', 'card', [0, 0])]);
    const { selectionScope } = view.engine.context;
    const feature = view.store.getFeature('c') as StoredFeature;
    const box = boxOf([feature]);
    const transform = {
      project: (lngLat: readonly number[]) => view.engine.map.project([lngLat[0], lngLat[1]]),
      unproject: (point: { x: number; y: number }) => view.engine.map.unproject([point.x, point.y]),
      metersPerPixel: planeMetersPerPixel(100),
    };
    const at = (lngLat: LngLat) => {
      const point = view.engine.map.project(lngLat);
      return hitTestHandles(
        { x: point.x, y: point.y },
        [feature],
        transform as never,
        DEFAULT_SELECTION_CONFIG,
        10,
        selectionScope,
      );
    };
    expect(at([box[2], box[1]])).toEqual({ type: 'resize', handle: 'resize-se' });
    expect(at([box[0], box[3]])).toEqual({ type: 'resize', handle: 'resize-nw' });
    expect(at(rotateHandleOf(box))?.type).toBe('rotate');
  });

  it('are none for a footprint of the screen', () => {
    const view = open(makeStore(), [featureOf('m', 'mark', [0, 0])]);
    view.draw.extensions.featureTypes.add({
      type: 'mark',
      geometry: 'Point',
      renderer,
      footprint: (feature) => ({
        kind: 'screen',
        position: (feature.geometry as GeoJSON.Point).coordinates,
        halfWidthPx: 20,
        halfHeightPx: 10,
      }),
      transformFields: { angleDegreesKey: ANGLE },
    });
    const feature = view.store.getFeature('m') as StoredFeature;
    const transform = {
      project: (lngLat: readonly number[]) => view.engine.map.project([lngLat[0], lngLat[1]]),
      unproject: (point: { x: number; y: number }) => view.engine.map.unproject([point.x, point.y]),
      metersPerPixel: planeMetersPerPixel(100),
    };
    const { x, y } = view.engine.map.project([0, 0]);
    const margin = DEFAULT_SELECTION_CONFIG.box.margin;
    // The corner of the box on the screen, and above it where a rotate handle would be
    for (const point of [
      { x: x + 20 + margin, y: y + 10 + margin },
      { x, y: y - 10 - margin - DEFAULT_SELECTION_CONFIG.rotateHandle.distance },
    ]) {
      const hit = hitTestHandles(
        point,
        [feature],
        transform as never,
        DEFAULT_SELECTION_CONFIG,
        10,
        view.engine.context.selectionScope,
      );
      expect(hit?.type === 'resize' || hit?.type === 'rotate').toBe(false);
    }
  });

  it('turn a single feature around its position and write the rotation it declares, from 0', () => {
    const view = open(makeStore(), [featureOf('c', 'card', [0, 0])]);
    view.draw.selection.set('feature', ['c']);
    const box = boxOf([view.store.getFeature('c') as StoredFeature]);
    // A quarter turn clockwise around the position [0, 0]: the handle above it taken to its east
    const handle = rotateHandleOf(box);
    drag(view, handle, [Math.hypot(handle[0], handle[1]), 0]);
    expect(turned(propertyOf(view.store, 'c', ANGLE))).toBeCloseTo(
      270 + (Math.atan2(handle[0], handle[1]) * 180) / Math.PI,
      0,
    );
    expect(positionOf(view.store, 'c')).toEqual([0, 0]);
    expect(propertyOf(view.store, 'c', SIZE)).toBeUndefined();
  });

  it('add the turn to the rotation a feature has', () => {
    const view = open(makeStore(), [featureOf('c', 'card', [0, 0], { [ANGLE]: 30 })]);
    view.draw.selection.set('feature', ['c']);
    const handle = rotateHandleOf(boxOf([view.store.getFeature('c') as StoredFeature]));
    drag(view, handle, [Math.hypot(handle[0], handle[1]), 0]);
    expect(turned(propertyOf(view.store, 'c', ANGLE))).toBeCloseTo(
      (300 + (Math.atan2(handle[0], handle[1]) * 180) / Math.PI) % 360,
      0,
    );
  });

  it('scale a feature from the corner across and write the size it declares, from 1', () => {
    const view = open(makeStore(), [featureOf('c', 'card', [0, 0])]);
    view.draw.selection.set('feature', ['c']);
    const [, s, e] = boxOf([view.store.getFeature('c') as StoredFeature]);
    // The south-east handle taken twice as far from the corner across, the north-west corner of
    // the footprint, which stays
    const anchor: LngLat = [0, 0.1];
    drag(view, [e, s], [anchor[0] + 2 * (e - anchor[0]), anchor[1] + 2 * (s - anchor[1])]);
    expect(Number(propertyOf(view.store, 'c', SIZE))).toBeCloseTo(2, 2);
    // Its position moved as a uniform scaling around that corner moves it
    const [x, y] = positionOf(view.store, 'c');
    expect(x).toBeCloseTo(0, 3);
    expect(y).toBeCloseTo(anchor[1] - 2 * anchor[1], 2);
    expect(propertyOf(view.store, 'c', ANGLE)).toBeUndefined();
  });

  it('write the fields of several features selected, by the same drag', () => {
    const view = open(makeStore(), [
      featureOf('a', 'card', [0, 0]),
      featureOf('b', 'card', [0, -0.5], { [ANGLE]: 10 }),
    ]);
    view.draw.selection.set('feature', ['a', 'b']);
    const box = boxOf(['a', 'b'].map((id) => view.store.getFeature(id) as StoredFeature));
    const handle = rotateHandleOf(box);
    const center: LngLat = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
    drag(view, handle, [center[0] + 1, center[1]]);
    const a = turned(propertyOf(view.store, 'a', ANGLE));
    const b = turned(propertyOf(view.store, 'b', ANGLE));
    expect(a).toBeGreaterThan(180);
    expect((b - a + 360) % 360).toBeCloseTo(10, 6);
    // The features turned around the middle of their box, not around their positions
    expect(positionOf(view.store, 'a')).not.toEqual([0, 0]);
  });

  it('change only the geometry of a type that declares no field, whatever keys it has', () => {
    const view = open(makeStore(), [
      featureOf('l1', 'label', [0, 0], { 'maplibre-gl-draw:rotation': 20 }),
    ]);
    view.draw.selection.set('feature', ['l1']);
    const box = boxOf([view.store.getFeature('l1') as StoredFeature]);
    const handle = rotateHandleOf(box);
    drag(view, handle, [box[2] + 1, (box[1] + box[3]) / 2]);
    expect(propertyOf(view.store, 'l1', 'maplibre-gl-draw:rotation')).toBe(20);
    // Turned around the middle of its box, as a feature without a rotation is
    expect(positionOf(view.store, 'l1')).not.toEqual([0, 0]);
  });

  it('are written by the edits of the Store as by the drags', () => {
    const view = open(makeStore(), [featureOf('c', 'card', [0, 0])]);
    view.store.applyEdits([
      { kind: 'rotate', target: { featureIds: ['c'] }, center: [0, 0], angleDegrees: 45 },
      {
        kind: 'scale',
        target: { featureIds: ['c'] },
        center: [0, 0],
        eastFactor: 3,
        northFactor: 3,
        sizeFactor: 3,
      },
    ]);
    expect(propertyOf(view.store, 'c', ANGLE)).toBeCloseTo(45, 9);
    expect(propertyOf(view.store, 'c', SIZE)).toBeCloseTo(3, 9);
  });
});

describe('the handles of a footprint laid on the map, of features selected in bulk', () => {
  it('write the fields the type declares on the rows, as one by one', () => {
    const store = new DrawStore(new TableContractStore(), { holdLimit: 3 });
    const ids = ['a', 'b', 'c', 'd'];
    const view = open(
      store,
      ids.map((id, i) => featureOf(id, 'card', [i, 0], i === 1 ? { [ANGLE]: 15 } : {})),
    );
    store.setSelection('feature', ids);
    expect(store.getSelectedRows()?.count).toBe(4);
    expect(
      transformBulkSelection(store, { kind: 'rotate', center: [0, 0], angleDegrees: 30 }),
    ).toBe(true);
    const angles = ids.map((id) => {
      const handle = store.tables?.findRow(id) as number;
      const read = store.tables?.readValues({
        handles: Int32Array.of(handle),
        fields: new Map([[`property:${ANGLE}`, []]]),
      });
      return read?.fields.get(`property:${ANGLE}`)?.[0];
    });
    expect(angles[0]).toBeCloseTo(30, 9);
    expect(angles[1]).toBeCloseTo(45, 9);
    expect(angles[3]).toBeCloseTo(30, 9);
    expect(view.draw.features.get('a')).toBeDefined();
  });
});

describe('the handles a custom type adds', () => {
  const handles: Handle[] = [
    { kind: 'resize', id: 'edge', position: [0.4, 0], cursor: 'ew-resize' },
    { kind: 'custom', id: 'tip', position: [0, 0.5], sizePx: 20 },
    { kind: 'other', id: 'odd', position: [0, 1] } as unknown as Handle,
    { kind: 'custom', id: 'bad', position: [0, 1], sizePx: -1 },
    { kind: 'custom', id: 'flat', position: [0, 1], sizePx: 0 },
    { id: 'none', position: [0, 1] } as unknown as Handle,
    { kind: 'scale', id: 'old', position: [0, 1] } as unknown as Handle,
  ];

  function withHandles(
    seen: HandleContext[] = [],
    drawHandles?: FeatureTypeDefinition['drawHandles'],
  ): Opened {
    const view = open(new DrawStore(new TableContractStore()), [featureOf('c', 'card', [0, 0])]);
    view.draw.extensions.featureTypes.remove('card');
    view.draw.extensions.featureTypes.add({
      ...CARD,
      handles(_feature, ctx) {
        seen.push(ctx);
        return handles;
      },
      onHandleDrag: () => null,
      ...(drawHandles && { drawHandles }),
    });
    return view;
  }

  it('are the resize and custom ones, the others left out with a warning once a reason', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const view = withHandles();
      const provider = view.engine.context.selectionScope.auxiliaryHandles.list()[0];
      const feature = view.store.getFeature('c') as StoredFeature;
      for (let i = 0; i < 3; i++) {
        expect(provider?.getHandles(feature, {} as AuxiliaryHandleContext)).toEqual([
          { kind: 'resize', id: 'edge', position: [0.4, 0], cursor: 'ew-resize' },
          { kind: 'custom', id: 'tip', position: [0, 0.5], sizePx: 20 },
        ]);
      }
      // The kind "other", a size not above 0 (-1 and 0), no kind, and the kind "scale"
      expect(warn).toHaveBeenCalledTimes(4);
      expect(String(warn.mock.calls[0]?.[0])).toContain('feature type "card"');
    } finally {
      warn.mockRestore();
    }
  });

  it('have the type draw its custom handles, with a render context of the frame', () => {
    const drawHandles = vi.fn();
    const view = withHandles([], drawHandles);
    vi.spyOn(view.engine.customLayer, 'getGL').mockReturnValue({} as WebGL2RenderingContext);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = view.engine.context.selectionScope.auxiliaryHandles.list()[0];
    const feature = view.store.getFeature('c') as StoredFeature;
    const given = provider?.getHandles(feature, {} as AuxiliaryHandleContext) ?? [];
    warn.mockRestore();
    provider?.drawHandles?.(feature, given, PROJECTION, 10, frameContext());
    expect(drawHandles).toHaveBeenCalledTimes(1);
    expect(drawHandles).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c' }),
      [{ kind: 'custom', id: 'tip', position: [0, 0.5], sizePx: 20 }],
      expect.objectContaining({ point: expect.anything(), screen: expect.anything() }),
    );
    // Nothing to draw: not called
    provider?.drawHandles?.(feature, [], PROJECTION, 10, frameContext());
    expect(drawHandles).toHaveBeenCalledTimes(1);
  });

  it('receive the selection box the library draws and the look of the selection', () => {
    const seen: HandleContext[] = [];
    const view = withHandles(seen);
    view.draw.options.update({ selectionStyle: { box: { ...boxStyle(), margin: 4 } } });
    const provider = view.engine.context.selectionScope.auxiliaryHandles.list()[0];
    provider?.getHandles(view.store.getFeature('c') as StoredFeature, {} as AuxiliaryHandleContext);
    const ctx = seen[0] as HandleContext;
    expect(ctx.selectionBox).toEqual(view.draw.rendered.getSelectionBox('c'));
    expect(ctx.selectionBox?.kind).toBe('ground');
    expect(ctx.selectionStyle.box.margin).toBe(4);
    expect(ctx.selectionStyle.resizeHandle.point.size).toBe(
      DEFAULT_SELECTION_CONFIG.resizeHandle.point.size,
    );
    expect(ctx.screen.project([0, 0])).toEqual([400, 300]);
  });

  it('give a handle provider the same context', () => {
    const view = open(new DrawStore(new TableContractStore()), [featureOf('c', 'card', [0, 0])]);
    const seen: HandleContext[] = [];
    view.draw.extensions.handleProviders.add({
      name: 'grips',
      handles(_feature, ctx) {
        seen.push(ctx);
        return [];
      },
      onHandleDrag: () => null,
    });
    const provider = view.engine.context.selectionScope.auxiliaryHandles.get('grips');
    provider?.getHandles(view.store.getFeature('c') as StoredFeature, {} as AuxiliaryHandleContext);
    expect(seen[0]?.selectionBox).toEqual(view.draw.rendered.getSelectionBox('c'));
  });

  it('give the handles of no feature a context without a selection box', () => {
    const view = open(new DrawStore(new TableContractStore()), []);
    const seen: HandleContext[] = [];
    view.draw.extensions.handleProviders.add({
      name: 'free',
      handles: () => [],
      globalHandles(ctx) {
        seen.push(ctx);
        return [{ kind: 'custom', id: 'g', position: [0, 0], sizePx: 6 }];
      },
      onHandleDrag: () => null,
    });
    const provider = view.engine.context.selectionScope.auxiliaryHandles.get('free');
    expect(provider?.getGlobalHandles?.({} as AuxiliaryHandleContext)).toEqual([
      { kind: 'custom', id: 'g', position: [0, 0], sizePx: 6 },
    ]);
    expect(seen[0]?.selectionBox).toBeNull();
    expect(seen[0]?.selectionStyle.box.margin).toBe(DEFAULT_SELECTION_CONFIG.box.margin);
  });
});

const PROJECTION = { mainMatrix: new Float32Array(16) } as unknown as ProjectionData;

/** The values of a frame, with spies for the shared renderers */
function frameContext(): FrameDrawContext {
  return {
    shaderData: { vertexShaderPrelude: 'prelude', define: '#define X', variantName: 'mercator' },
    centerLngLat: [0, 0],
    mainMatrixArray: Array.from({ length: 16 }, (_, i) => (i % 5 === 0 ? 1 : 0)),
    pixelRatio: 1,
    terrain: {} as TerrainContext,
    opacity: 1,
    sdfLineRenderer: { draw: vi.fn(), drawClosed: vi.fn() },
    fillShaderManager: { drawPolygonRings: vi.fn() },
    pointShapeRenderer: { draw: vi.fn() },
  } as unknown as FrameDrawContext;
}

/** The stroke of the box of the selection, as the default has it */
function boxStyle() {
  return {
    stroke: { width: 2, color: '#ff2d55', opacity: 1, lineStyle: 'solid' as const },
  };
}

describe('the fields a custom type declares', () => {
  it('refuse a declaration of the wrong shape', () => {
    const view = open(new DrawStore(new TableContractStore()), []);
    for (const transformFields of [
      'boardAngle',
      { angleDegreesKey: '' },
      { scaleKey: 3 },
      { angleDegreesKey: 'same', scaleKey: 'same' },
      { uniformScale: 'yes' },
    ]) {
      expect(() =>
        view.draw.extensions.featureTypes.add({
          type: 'odd',
          geometry: 'Point',
          renderer,
          transformFields: transformFields as never,
        }),
      ).toThrow(DrawError);
    }
  });

  it('cannot be given to a definition that overrides a built-in type', () => {
    const view = open(new DrawStore(new TableContractStore()), []);
    expect(() =>
      view.draw.extensions.featureTypes.override({
        type: 'Point',
        geometry: 'Point',
        renderer,
        transformFields: { angleDegreesKey: ANGLE },
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid-input' }));
    expect(view.draw.extensions.featureTypes.has('Point')).toBe(false);
  });

  it('are let go of with the type, and with the instance', () => {
    const store = new DrawStore(new TableContractStore());
    const view = open(store, []);
    expect(store.transformFields?.of('card')).toEqual(CARD.transformFields);
    view.draw.extensions.featureTypes.remove('card');
    expect(store.transformFields?.of('card')).toBeUndefined();
    view.draw.destroy();
    expect(store.transformFields).toBeNull();
  });
});
