// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Plugins (`draw.use`, the `plugins` option)
 *
 * - `setup` runs once, at once, with the instance and the map; what it returns is what `use`
 *   returns. The plugins of the options are added in their order
 * - A name taken, a name of the library and what is not a plugin are refused, and so is what a
 *   plugin adds under a name taken
 * - The signal of `use` removes the plugin with what it added: a mode it is in is left first,
 *   then its own signal is aborted; adding after fails with `invalidState`. A `setup` that throws
 *   leaves nothing added
 * - What the library calls of a plugin and throws is told in `status.problems`, the same failure
 *   once, its count added to
 * - The examples of the contract of the plugins work: a type drawn and hit by its footprint, a
 *   mode with an overlay, a type drawn from the features it joins, a companion of every type, the
 *   rows read without features, a type turned and resized by the library, a DOM element that
 *   follows a feature
 */

import type { Position } from 'geojson';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { DragNormalizedEvent, MouseNormalizedEvent } from '../../dispatcher/types.js';
import type { OverlayShape, Plugin, PluginContext } from '../../extend/index.js';
import type { FeatureTypeRenderer, FrameDrawContext } from '../../extension/renderers.js';
import { MemoryStore } from '../../store/memory.js';
import type { Store } from '../../store/store.js';
import { createTableStore } from '../../store/table-memory.js';
import type { Feature as StoredFeature } from '../../store/types.js';
import { writesOf } from '../../test-support/writes.js';
import { createMapStub, createSyntheticInput } from '../../test-utils.js';
import type { TerrainContext } from '../../view/terrain/context.js';
import type { Draw } from '../draw.js';
import { DrawError } from '../errors.js';
import type { Observable } from '../events.js';
import type { RenderContext as EngineRenderContext } from '../extension/render.js';
import type { Feature, FeatureGeometry } from '../model.js';
import type { SelectionStyleOptions } from '../options.js';
import { toSelectionStyle } from './contexts.js';
import { createDrawOnEngine } from './create-draw.js';
import { createEngine, type Engine } from './engine.js';

type LngLat = [number, number];

// ============================================================================
// The instance
// ============================================================================

interface Opened {
  readonly engine: Engine;
  readonly draw: Draw;
  readonly store: Store;
  /** The renderers of the engine the types were put in as, by type */
  readonly renderers: Map<string, FeatureTypeRenderer>;
  /** Draws a frame: what follows the frames drawn hears of it */
  drawFrame(): void;
}

const opened: Draw[] = [];

afterEach(() => {
  for (const draw of opened.splice(0)) draw.destroy();
  vi.useRealTimers();
});

/** An instance with a layer `l`, the map laying 100 px on a degree around [0, 0] */
function open(options: { plugins?: readonly Plugin<unknown>[]; rows?: boolean } = {}): Opened {
  const store = options.rows ? createTableStore().store : new MemoryStore();
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
  const frames = new Set<() => void>();
  engine.customLayer.onFrameDrawn = (listener) => {
    frames.add(listener);
    return () => frames.delete(listener);
  };
  const renderers = new Map<string, FeatureTypeRenderer>();
  const register = engine.customLayer.registerFeatureRenderer.bind(engine.customLayer);
  vi.spyOn(engine.customLayer, 'registerFeatureRenderer').mockImplementation((type, renderer) => {
    renderers.set(type, renderer);
    return register(type, renderer);
  });
  const draw = createDrawOnEngine(engine, {
    store,
    initDefaultLayer: false,
    ...(options.plugins && { plugins: options.plugins }),
  });
  engine.enterDefaultMode();
  opened.push(draw);
  return {
    engine,
    draw,
    store,
    renderers,
    drawFrame: () => {
      for (const listener of [...frames]) listener();
    },
  };
}

/** A feature written to the layer `l` */
function create(
  view: Opened,
  geometry: FeatureGeometry,
  properties: Record<string, unknown> = {},
  type?: string,
): StoredFeature {
  const feature = writesOf(view.draw).features.create({
    type: type ?? geometry.type,
    geometry,
    layerId: 'l',
    properties,
  });
  if (!feature) throw new Error('no feature');
  return feature;
}

const PROJECTION = { mainMatrix: new Float32Array(16) } as never;

/** The context the engine gives its own renderers in a frame */
function frame(): FrameDrawContext {
  return {
    shaderData: { vertexShaderPrelude: '', define: '', variantName: 'mercator' },
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

/** Draws a feature with the renderer of its type, in a frame of its own */
function drawn(view: Opened, id: string): FrameDrawContext {
  const feature = view.store.getFeature(id) as StoredFeature;
  const renderer = view.renderers.get(feature.type);
  if (!renderer) throw new Error(`no renderer of ${feature.type}`);
  const context = frame();
  renderer.draw(feature, PROJECTION, 10, context);
  return context;
}

/** A render context of the engine whose renderers record what they draw */
function recordingContext(draw: Draw): {
  context: EngineRenderContext;
  line: Mock<EngineRenderContext['line']['draw']>;
  fill: Mock<EngineRenderContext['fill']['draw']>;
  point: Mock<EngineRenderContext['point']['draw']>;
} {
  const line = vi.fn<EngineRenderContext['line']['draw']>();
  const fill = vi.fn<EngineRenderContext['fill']['draw']>();
  const point = vi.fn<EngineRenderContext['point']['draw']>();
  const context: EngineRenderContext = {
    screen: {
      project: (p) => [(p[0] as number) * 100 + 400, 300 - (p[1] as number) * 100],
      unproject: ([x, y]) => [(x - 400) / 100, (300 - y) / 100],
      metersPerPixel: () => 1113,
      zoom: 10,
      pixelRatio: 1,
    },
    opacity: 1,
    terrain: { elevation: () => 0, occlusionOpacity: () => 1, generation: () => 0 },
    line: { draw: line },
    fill: { draw: fill },
    point: { draw: point },
    appliedStyle: (feature) => {
      const look = draw.features.getAppliedStyle(feature.id);
      if (!look) throw new Error(`no look of ${feature.id}`);
      return look;
    },
  };
  return { context, line, fill, point };
}

/** The look of the selection of an instance, as the handles of a feature are placed with it */
function selectionStyleOf(view: Opened): Required<SelectionStyleOptions> {
  const { context } = view.engine;
  return toSelectionStyle(
    context.selectionStyle,
    context.renderingConfig.boxSelectionStyle,
    undefined,
  );
}

const MODIFIERS = { shift: false, ctrl: false, alt: false, meta: false };

function inert(type: string, point: { x: number; y: number }): MouseEvent {
  return {
    type,
    button: 0,
    buttons: type === 'mouseup' ? 0 : 1,
    clientX: point.x,
    clientY: point.y,
    target: null,
    preventDefault() {},
    stopPropagation() {},
  } as unknown as MouseEvent;
}

/** A press at a position dragged to another and let go there, through the input router */
function pointerDrag(engine: Engine, from: LngLat, to: LngLat): void {
  const screenOf = (at: LngLat) => engine.map.project(at);
  const start = screenOf(from);
  const mouse = (type: MouseNormalizedEvent['type'], at: LngLat): MouseNormalizedEvent => ({
    type,
    point: screenOf(at),
    lngLat: { lng: at[0], lat: at[1] },
    originalEvent: inert(type, screenOf(at)),
    modifiers: MODIFIERS,
    snap: false,
  });
  const drag = (type: DragNormalizedEvent['type'], at: LngLat): DragNormalizedEvent => ({
    type,
    point: screenOf(at),
    lngLat: { lng: at[0], lat: at[1] },
    originalEvent: inert(type, screenOf(at)),
    modifiers: MODIFIERS,
    dragStartPoint: start,
    dragStartLngLat: { lng: from[0], lat: from[1] },
    snap: false,
  });
  const router = engine.inputRouter;
  router.dispatch(mouse('mousemove', from));
  router.dispatch(mouse('mousedown', from));
  router.dispatch(drag('dragstart', from));
  router.dispatch(drag('dragmove', [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2]));
  router.dispatch(drag('dragmove', to));
  router.dispatch(drag('dragend', to));
  router.dispatch(mouse('mouseup', to));
}

/** What is hit first at a position */
function hitAt(view: Opened, at: LngLat): string | null {
  const point = view.engine.map.project(at);
  return view.engine.extensions.hitAt({ x: point.x, y: point.y })?.id ?? null;
}

/** The distance between two positions on the sphere, in meters */
function metersBetween([x1, y1]: Position, [x2, y2]: Position): number {
  const radians = Math.PI / 180;
  const a =
    Math.sin((((y2 as number) - (y1 as number)) * radians) / 2) ** 2 +
    Math.cos((y1 as number) * radians) *
      Math.cos((y2 as number) * radians) *
      Math.sin((((x2 as number) - (x1 as number)) * radians) / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.sqrt(a));
}

// ============================================================================
// The examples of the contract (`/extend` only)
// ============================================================================

const TYPE = 'maplibre-gl-draw:featureType';

// --- A range: a point and a radius, drawn and hit by the circle of its footprint ---

const RADIUS = 'acme:radiusMeters';
const centerOf = (f: Feature) => f.geometry.coordinates as Position;
const ring = ([lng, lat]: Position, meters: number): Position[] => {
  const y = meters / 111320;
  const x = y / Math.cos(((lat as number) * Math.PI) / 180);
  const turn = (i: number) => ((i % 64) * Math.PI) / 32; // The first position is due east
  return Array.from(
    { length: 65 },
    (_, i): Position => [
      (lng as number) + x * Math.cos(turn(i)),
      (lat as number) + y * Math.sin(turn(i)),
    ],
  );
};
const edge = (f: Feature) => ring(centerOf(f), f.properties[RADIUS]);

const range = (): Plugin => ({
  name: 'acme-range',
  setup(ctx) {
    ctx.addFeatureType({
      name: 'acme:range',
      footprint: (f) => ({ type: 'Polygon', coordinates: [edge(f)] }),
      // A resize scales the radius, and the position by the same ratio
      transformFields: { scaleKey: RADIUS, uniformScale: true },
      handles: (f) => [{ kind: 'resize', id: 'edge', position: edge(f)[0] as Position }],
      onHandleDrag: (f, _handle, input) => ({
        properties: { [RADIUS]: metersBetween(centerOf(f), input.snapped) },
      }),
    });
    ctx.addMode({
      name: 'acme:range',
      input(input) {
        if (input.type !== 'click') return;
        const name = ctx.names.next('acme:range');
        const properties = {
          [TYPE]: 'acme:range',
          [RADIUS]: 100,
          ...(name === undefined ? {} : { name }),
        };
        const geometry = { type: 'Point', coordinates: input.snapped } as const;
        return ctx.draw.write((tx) =>
          tx.features.create({ type: 'Feature', geometry, properties }),
        );
      },
    });
  },
});

// --- A measure of the distance between two points, with no feature ---

type Meters = number | null; // null while nothing is measured

const distance = (): Plugin<Observable<Meters>> => ({
  name: 'acme-distance',
  setup(ctx) {
    const listeners = new Set<(value: Meters) => void>();
    let value: Meters = null;
    let first: Position | null = null;
    const show = (to: Position | null) => {
      const coordinates = first && to ? [first, to] : [];
      const geometry = { type: 'LineString', coordinates } as const;
      ctx.setOverlay(first && to ? [{ geometry }] : []);
      value = first && to ? metersBetween(first, to) : null;
      for (const run of listeners) run(value);
    };
    ctx.addMode({
      name: 'acme:distance',
      exit() {
        first = null;
        show(null);
      },
      input(input) {
        if (input.type === 'pointermove' && first) show(input.snapped);
        if (input.type !== 'click') return;
        if (first) {
          show(input.snapped);
          first = null;
        } else first = input.snapped;
      },
    });
    return {
      get value() {
        return value;
      },
      subscribe(run) {
        run(value);
        listeners.add(run);
        return () => listeners.delete(run);
      },
    };
  },
});

// --- A line drawn between two features where they are drawn ---

const FROM = 'acme:from';
const TO = 'acme:to';
const here = (f: Feature) => f.geometry.coordinates as Position;
const head = ([x, y]: Position): Position[] => [
  [(x as number) - 0.0001, (y as number) - 0.0001],
  [(x as number) + 0.0001, (y as number) - 0.0001],
  [x as number, (y as number) + 0.0001],
];

/**
 * `pick` stands in for `ctx.draw.features.pick` of the contract, which the main entry does not
 * have yet: what is hit first at a point of the screen
 */
const link = (pick: (point: readonly [number, number]) => string | null): Plugin => ({
  name: 'acme-link',
  setup(ctx) {
    // Follows the features it joins, also while they are moved
    const ends = (f: Feature): readonly Position[] => {
      const [a, b] = ctx.rendered.getMany([f.properties[FROM], f.properties[TO]]);
      return a && b ? [here(a), here(b)] : [];
    };
    ctx.addFeatureType({
      name: 'acme:link',
      footprint: (f) => f.geometry,
      styleRuleChannel: 'stroke',
      render(feature, context) {
        const line = ends(feature);
        const end = line[1];
        if (!end) return;
        const color = context.appliedStyle(feature).strokeColor;
        const { opacity } = context;
        context.line.draw(line, { width: 2, color, opacity, lineStyle: 'solid' });
        context.fill.draw([head(end)], { color, opacity });
      },
      hitTest(feature, pointer) {
        const [x, y] = pointer.screenPoint;
        const away = ends(feature).map((end) => {
          const [px, py] = ctx.screen.project(end);
          return Math.hypot(px - x, py - y);
        });
        const near = Math.min(...away);
        return near <= pointer.tolerancePixels ? near : null;
      },
      snapCandidates: (f) => ends(f).map((position) => ({ position, kind: 'vertex' })),
      handles: (f) =>
        ends(f)
          .slice(1)
          .map((position) => ({
            kind: 'custom',
            id: 'tip',
            position,
            sizePixels: 10,
            cursor: 'grab',
          })),
      // While it can be grabbed, a mark and a line from where it starts
      drawHandles(feature, handles, context) {
        for (const { position, sizePixels } of handles) {
          const [start] = ends(feature);
          if (start) {
            context.line.draw([start, position], {
              width: 1,
              color: '#cc3333',
              opacity: 1,
              lineStyle: 'dashed',
            });
          }
          context.point.draw(position, {
            shape: 'circle',
            sizePixels,
            fillColor: '#cc3333',
            fillOpacity: 1,
            strokeColor: '#ffffff',
            strokeWidth: 2,
            strokeOpacity: 1,
          });
        }
      },
      // Joins the feature where it is let go: the sketch and the one write are the library's
      onHandleDrag(feature, _handle, input) {
        const hit = pick(input.screenPoint);
        return hit !== null && hit !== feature.id ? { properties: { [TO]: hit } } : null;
      },
    });
  },
});

// --- A ring under the features marked, of every type ---

const IMPORTANT = 'acme:important';
const WIDTH = 'acme:ringPixels';

const halo = (): Plugin => ({
  name: 'acme-halo',
  setup(ctx) {
    const ringOf = (feature: Feature): readonly Position[] => {
      const box = ctx.rendered.getFootprint(feature.id);
      if (box?.kind !== 'ground') return [];
      const { topLeft, topRight, bottomRight, bottomLeft } = box.corners;
      return [topLeft, topRight, bottomRight, bottomLeft];
    };
    ctx.addCompanion({
      name: 'acme-halo',
      has: (row) => row.property(IMPORTANT) === true,
      dependsOnProperties: [IMPORTANT],
      render(feature, context) {
        const width = feature.properties[WIDTH] ?? 6;
        const style = { width, color: '#ffcc00', opacity: 0.5, lineStyle: 'solid' } as const;
        context.line.draw(ringOf(feature), style, { closed: true });
      },
      hitTest(feature, pointer) {
        const [x, y] = pointer.screenPoint;
        const away = ringOf(feature).map((p) => {
          const [px, py] = ctx.screen.project(p);
          return Math.hypot(px - x, py - y);
        });
        const distancePixels = Math.min(...away);
        return distancePixels <= pointer.tolerancePixels ? { id: 'ring', distancePixels } : null;
      },
      // A press on the ring takes the mark off; the selection stays
      onClick(feature) {
        void ctx.draw.write((tx) =>
          tx.features.update(feature.id, { properties: { [IMPORTANT]: false } }),
        );
        return true;
      },
      // On a feature of any type, the top right corner sets the width of the ring
      handles(f) {
        const position = ringOf(f)[1];
        const shown = f.properties[IMPORTANT] === true && position;
        return shown ? [{ kind: 'resize', id: 'width', position }] : [];
      },
      onHandleDrag(feature, _handle, input) {
        if (!feature) return null;
        const corner = ringOf(feature)[1] ?? input.position;
        const [cx, cy] = ctx.screen.project(corner);
        const [ax, ay] = input.screenPoint;
        return { properties: { [WIDTH]: Math.hypot(ax - cx, ay - cy) } };
      },
    });
  },
});

// --- The vertices drawn, counted from the rows without features ---

const flat = (value: unknown): number =>
  !Array.isArray(value)
    ? 0
    : typeof value[0] === 'number'
      ? 1
      : value.reduce((sum: number, part) => sum + flat(part), 0);

/**
 * `getDrawnRowsRevision` and `getRow` stand in for `getDrawnRowsVersion` and `getRowGeometry` of
 * the contract, which `/webgl` names so later
 */
const density = (layerId: string): Plugin<Observable<number>> => ({
  name: 'acme-density',
  setup(ctx) {
    const listeners = new Set<(value: number) => void>();
    let value = 0;
    let seen = -1;
    const count = () => {
      const view = ctx.webgl.rows(layerId);
      if (!view) return;
      const b = ctx.map.getBounds();
      const box = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()] as const;
      let total = 0;
      for (const row of view.listDrawnRows([box[0], box[1], box[2], box[3]])) {
        const geometry = view.getRow(row)?.geometry;
        const coordinates = geometry && 'coordinates' in geometry ? geometry.coordinates : null;
        total += view.getRowPoint(row) ? 1 : flat(coordinates);
      }
      seen = view.getDrawnRowsRevision();
      value = total;
      for (const run of listeners) run(value);
    };
    const changed = () => {
      if (ctx.webgl.rows(layerId)?.getDrawnRowsRevision() !== seen) count();
    };
    ctx.map.on('moveend', count);
    ctx.map.on('render', changed);
    ctx.signal.addEventListener('abort', () => {
      ctx.map.off('moveend', count);
      ctx.map.off('render', changed);
    });
    return {
      get value() {
        return value;
      },
      subscribe(run) {
        run(value);
        listeners.add(run);
        return () => listeners.delete(run);
      },
    };
  },
});

// --- A plot of a plan, turned and resized by the library ---

const SIDE = 'acme:sideMeters';
const ROTATION = 'maplibre-gl-draw:rotation';
const box = ([x, y]: Position, half: number, turn: number) => {
  const at = (a: number, b: number): Position => [
    (x as number) + a * Math.cos(turn) - b * Math.sin(turn),
    (y as number) + a * Math.sin(turn) + b * Math.cos(turn),
  ];
  return {
    topLeft: at(-half, half),
    topRight: at(half, half),
    bottomRight: at(half, -half),
    bottomLeft: at(-half, -half),
  };
};
const middle = (a: Position, b: Position): Position => [
  ((a[0] as number) + (b[0] as number)) / 2,
  ((a[1] as number) + (b[1] as number)) / 2,
];

const plan = (metersPerUnit: Observable<number>): Plugin => ({
  name: 'acme-plan',
  setup(ctx) {
    ctx.addFeatureType({
      name: 'acme:plan',
      footprint: (f: Feature) => ({
        kind: 'ground',
        snap: 'center', // A plan is put on its center alone
        corners: box(
          f.geometry.coordinates as Position,
          (f.properties[SIDE] * metersPerUnit.value) / 222640,
          ((f.properties[ROTATION] ?? 0) * Math.PI) / 180,
        ),
      }),
      transformFields: { angleDegreesKey: ROTATION, scaleKey: SIDE, uniformScale: true },
      // In the middle of the east edge of the box drawn
      handles(_f, { selectionBox }) {
        if (selectionBox?.kind !== 'ground') return [];
        const { topRight, bottomRight } = selectionBox.corners;
        const position = middle(topRight, bottomRight);
        return [{ kind: 'resize', id: 'east', position, cursor: 'ew-resize' }];
      },
      onHandleDrag(f, _handle, input) {
        const [x] = f.geometry.coordinates as Position;
        const [east] = input.snapped;
        const side = (Math.abs((east as number) - (x as number)) * 222640) / metersPerUnit.value;
        return { properties: { [SIDE]: side } };
      },
    });
    const stop = metersPerUnit.subscribe(() => ctx.invalidate({ featureType: 'acme:plan' }));
    ctx.signal.addEventListener('abort', stop);
  },
});

// --- A DOM element that follows a point ---

interface Element {
  hidden: boolean;
  readonly style: { transform: string };
}

const popup = (element: Element): Plugin<(id: string | null) => void> => ({
  name: 'acme-popup',
  setup(ctx) {
    let followed: string | null = null;
    const place = () => {
      const feature = followed === null ? undefined : ctx.rendered.get(followed);
      element.hidden = feature === undefined;
      if (!feature) return;
      const at = feature.geometry.coordinates as Position;
      const [x, y] = ctx.screen.project(at);
      element.style.transform = `translate(${x}px, ${y}px)`;
    };
    const stop = ctx.rendered.changed.subscribe((ids) => {
      if (followed !== null && ids.includes(followed)) place();
    });
    ctx.map.on('move', place);
    ctx.signal.addEventListener('abort', () => {
      stop();
      ctx.map.off('move', place);
    });
    return (id) => {
      followed = id;
      place();
    };
  },
});

/** A value that changes over time, to give to a plugin */
function observable<T>(initial: T): Observable<T> & { set(value: T): void } {
  let value = initial;
  const listeners = new Set<(value: T) => void>();
  return {
    get value() {
      return value;
    },
    subscribe(run) {
      run(value);
      listeners.add(run);
      return () => listeners.delete(run);
    },
    set(next) {
      value = next;
      for (const run of listeners) run(value);
    },
  };
}

// ============================================================================
// Adding and removing
// ============================================================================

describe('draw.use', () => {
  it('runs setup once, at once, and returns what it returns', () => {
    const view = open();
    const seen: PluginContext[] = [];
    const api = view.draw.use({
      name: 'acme-api',
      setup(ctx) {
        seen.push(ctx);
        return { answer: 42 };
      },
    });
    expect(api).toEqual({ answer: 42 });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.draw).toBe(view.draw);
    expect(seen[0]?.map).toBe(view.engine.map);
    expect(seen[0]?.signal.aborted).toBe(false);
  });

  it('adds the plugins of the options in their order', () => {
    const order: string[] = [];
    const named = (name: string): Plugin => ({ name, setup: () => void order.push(name) });
    open({ plugins: [named('acme-a'), named('acme-b')] });
    expect(order).toEqual(['acme-a', 'acme-b']);
  });

  it('refuses a name taken, a name of the library and what is not a plugin', () => {
    const view = open();
    view.draw.use({ name: 'acme-a', setup() {} });
    expect(() => view.draw.use({ name: 'acme-a', setup() {} })).toThrow(
      expect.objectContaining({ code: 'alreadyExists' }),
    );
    expect(() => view.draw.use({ name: '', setup() {} })).toThrow(
      expect.objectContaining({ code: 'invalidInput' }),
    );
    expect(() => view.draw.use({ name: 'acme-b' } as never)).toThrow(
      expect.objectContaining({ code: 'invalidInput' }),
    );
    view.draw.use({
      name: 'acme-c',
      setup(ctx) {
        expect(() =>
          ctx.addFeatureType({ name: 'maplibre-gl-draw:own', footprint: () => null }),
        ).toThrow(expect.objectContaining({ code: 'invalidInput' }));
        expect(() => ctx.addFeatureType({ name: 'Polygon', footprint: () => null })).toThrow(
          expect.objectContaining({ code: 'alreadyExists' }),
        );
        expect(() => ctx.addMode({ name: 'select', input: () => false })).toThrow(
          expect.objectContaining({ code: 'alreadyExists' }),
        );
      },
    });
  });

  it('removes the plugin with what it added when its signal is aborted', () => {
    const view = open();
    const controller = new AbortController();
    const told: string[] = [];
    let context: PluginContext | undefined;
    view.draw.use(
      {
        name: 'acme-all',
        setup(ctx) {
          context = ctx;
          ctx.signal.addEventListener('abort', () => told.push('signal'));
          ctx.addFeatureType({ name: 'acme:thing', footprint: (f) => f.geometry });
          ctx.addMode({
            name: 'acme:mode',
            exit: () => void told.push('exit'),
            input: () => false,
          });
          ctx.addCompanion({ name: 'acme-companion', has: () => true });
          ctx.setOverlay([{ geometry: { type: 'Point', coordinates: [0, 0] } }]);
        },
      },
      { signal: controller.signal },
    );
    view.draw.mode.set('acme:mode');
    expect(view.draw.extensions.featureTypes.has('acme:thing')).toBe(true);
    expect(view.draw.extensions.companionProviders.has('acme-companion')).toBe(true);
    expect(view.draw.extensions.overlays.count()).toBe(1);

    controller.abort();
    // The mode of the plugin is left before its signal is aborted
    expect(told).toEqual(['exit', 'signal']);
    expect(view.draw.getMode()).toBe('select');
    expect(view.draw.extensions.featureTypes.has('acme:thing')).toBe(false);
    expect(view.draw.extensions.modes.has('acme:mode')).toBe(false);
    expect(view.draw.extensions.companionProviders.has('acme-companion')).toBe(false);
    expect(view.draw.extensions.overlays.count()).toBe(0);
    expect(view.draw.extensions.plugins.has('acme-all')).toBe(false);
    expect(() => view.draw.mode.set('acme:mode')).toThrow(DrawError);

    // Nothing more can be added
    const ctx = context as PluginContext;
    for (const add of [
      () => ctx.addFeatureType({ name: 'acme:other', footprint: () => null }),
      () => ctx.addMode({ name: 'acme:other', input: () => false }),
      () => ctx.addCompanion({ name: 'acme-other', has: () => false }),
      () => ctx.setOverlay([]),
    ]) {
      expect(add).toThrow(expect.objectContaining({ code: 'invalidState' }));
    }
    // The name is free again
    view.draw.use({ name: 'acme-all', setup() {} });
  });

  it('adds nothing when the signal is aborted already, and when setup throws', () => {
    const view = open();
    const failure = new Error('setup failed');
    let signal: AbortSignal | undefined;
    expect(() =>
      view.draw.use({
        name: 'acme-throws',
        setup(ctx) {
          signal = ctx.signal;
          ctx.addFeatureType({ name: 'acme:thing', footprint: () => null });
          throw failure;
        },
      }),
    ).toThrow(failure);
    expect(view.draw.extensions.featureTypes.has('acme:thing')).toBe(false);
    expect(view.draw.extensions.plugins.has('acme-throws')).toBe(false);
    expect(signal?.aborted).toBe(true);

    const aborted = AbortSignal.abort();
    view.draw.use(
      {
        name: 'acme-late',
        setup: (ctx) => ctx.addFeatureType({ name: 'acme:late', footprint: () => null }),
      },
      { signal: aborted },
    );
    expect(view.draw.extensions.featureTypes.has('acme:late')).toBe(false);
  });

  it('removes the plugins with the instance', () => {
    const view = open();
    let signal: AbortSignal | undefined;
    view.draw.use({
      name: 'acme-a',
      setup(ctx) {
        signal = ctx.signal;
      },
    });
    view.draw.destroy();
    expect(signal?.aborted).toBe(true);
  });
});

describe('the failures of a plugin', () => {
  it('are told in status.problems, the same failure once with its count', async () => {
    const view = open();
    const failure = new Error('cannot measure');
    view.draw.use({
      name: 'acme-broken',
      setup(ctx) {
        ctx.addFeatureType({
          name: 'acme:broken',
          footprint: () => {
            throw failure;
          },
        });
      },
    });
    const feature = create(view, { type: 'Point', coordinates: [0, 0] }, {}, 'acme:broken');
    // Drawn as the geometry it has in the document
    expect(drawn(view, feature.id).pointShapeRenderer.draw).toHaveBeenCalled();
    view.draw.use({ name: 'acme-other', setup() {} });
    await view.draw.write((tx) => tx.features.update(feature.id, { properties: { a: 1 } }));
    drawn(view, feature.id);
    const problems = view.draw.status.value.problems.filter((p) => p.label === 'acme-broken');
    expect(problems).toHaveLength(1);
    const [problem] = problems;
    expect(problem?.type).toBe('failed');
    expect(problem?.error.code).toBe('invalidState');
    expect(problem?.error.cause).toBe(failure);
    expect(problem?.commit).toBeNull();
    expect(problem?.count).toBeGreaterThanOrEqual(2);
  });

  it('of the drawing of a type stop that drawing, told once', () => {
    const view = open();
    const render = vi.fn(() => {
      throw new Error('cannot draw');
    });
    view.draw.use({
      name: 'acme-unseen',
      setup: (ctx) =>
        ctx.addFeatureType({ name: 'acme:unseen', footprint: (f) => f.geometry, render }),
    });
    const feature = create(view, { type: 'Point', coordinates: [0, 0] }, {}, 'acme:unseen');
    drawn(view, feature.id);
    drawn(view, feature.id);
    expect(render).toHaveBeenCalledTimes(1);
    const problems = view.draw.status.value.problems.filter((p) => p.label === 'acme-unseen');
    expect(problems.map((p) => p.count)).toEqual([1]);
  });

  it('of the input of a mode, and of the promise it returns, are told', async () => {
    const view = open();
    view.draw.use({
      name: 'acme-mode',
      setup(ctx) {
        ctx.addMode({
          name: 'acme:mode',
          input(input) {
            if (input.type === 'click') throw new Error('click failed');
            if (input.type === 'keydown') return Promise.reject(new Error('later'));
          },
        });
      },
    });
    view.draw.mode.set('acme:mode');
    const input = createSyntheticInput(view.engine);
    input.click([0, 0], { snap: false });
    input.key('a');
    await Promise.resolve();
    await Promise.resolve();
    const messages = view.draw.status.value.problems.map((p) => p.error.message);
    expect(messages.some((m) => m.includes('click failed'))).toBe(true);
    expect(messages.some((m) => m.includes('later'))).toBe(true);
    // The mode goes on
    expect(view.draw.getMode()).toBe('acme:mode');
  });
});

// ============================================================================
// The examples
// ============================================================================

describe('a type drawn and hit by its footprint (a range)', () => {
  it('is drawn by the library as the circle of its footprint, and hit inside it', () => {
    const view = open({ plugins: [range()] });
    const feature = create(
      view,
      { type: 'Point', coordinates: [0, 0] },
      { [RADIUS]: 50_000 },
      'acme:range',
    );
    const context = drawn(view, feature.id);
    // A filled area with its outline, of the 65 positions of the circle
    const fill = vi.mocked(context.fillShaderManager.drawPolygonRings);
    expect(fill).toHaveBeenCalledTimes(1);
    expect(fill.mock.calls[0]?.[0][0]).toHaveLength(65);
    // Hit 30 px east of its point, inside the circle (45 px wide)
    expect(hitAt(view, [0.3, 0])).toBe(feature.id);
    expect(hitAt(view, [0.6, 0])).toBeNull();
    // Its extent is that of the circle
    expect(view.draw.features.list({ bbox: [0.4, -0.01, 0.5, 0.01] })).toHaveLength(1);
    expect(view.draw.features.list({ bbox: [0.5, -0.01, 0.6, 0.01] })).toHaveLength(0);
  });

  it('is made by its mode with an automatic name, and its handle sets its radius', () => {
    const view = open({ plugins: [range()] });
    view.draw.mode.set('acme:range');
    createSyntheticInput(view.engine).click([1, 1], { snap: false });
    return vi.waitFor(() => {
      const [made] = view.draw.features.list({ type: 'acme:range' });
      expect(made?.properties[RADIUS]).toBe(100);
      expect(made?.geometry.coordinates).toEqual([1, 1]);
      expect(typeof made?.properties.name).toBe('string');
    });
  });

  it('has its radius set by the drag of its handle, in one write', () => {
    vi.useFakeTimers();
    const view = open({ plugins: [range()] });
    const feature = create(
      view,
      { type: 'Point', coordinates: [0, 0] },
      { [RADIUS]: 50_000 },
      'acme:range',
    );
    view.draw.selection.set('feature', [feature.id]);
    const writes = vi.fn();
    view.draw.on('change', writes);
    const east = 50_000 / 111320;
    pointerDrag(view.engine, [east, 0], [east * 2, 0]);
    vi.runAllTimers();
    expect(writes).toHaveBeenCalledTimes(1);
    expect(view.draw.features.get(feature.id)?.properties[RADIUS]).toBeCloseTo(100_000, -3);
  });

  it('has its radius scaled with its geometry by a resize', async () => {
    const view = open({ plugins: [range()] });
    const feature = create(
      view,
      { type: 'Point', coordinates: [0, 0] },
      { [RADIUS]: 100 },
      'acme:range',
    );
    await view.draw.write((tx) =>
      tx.features.scale(feature.id, {
        center: [0, 0],
        eastFactor: 2,
        northFactor: 2,
        sizeFactor: 2,
      }),
    );
    expect(view.draw.features.get(feature.id)?.properties[RADIUS]).toBeCloseTo(200);
  });
});

describe('a mode that measures (no feature)', () => {
  it('shows its line in the overlay and tells the distance', () => {
    const view = open();
    const meters = view.draw.use(distance());
    const told: Meters[] = [];
    meters.subscribe((value) => told.push(value));
    view.draw.mode.set('acme:distance');
    const input = createSyntheticInput(view.engine);
    input.click([0, 0], { snap: false });
    input.move([1, 0], { snap: false });
    expect(meters.value).toBeCloseTo(111_195, -2);
    expect(view.draw.extensions.overlays.count()).toBe(1);
    const overlay = view.draw.extensions.overlays.list()[0] as string;
    const recorded = recordingContext(view.draw);
    view.draw.extensions.overlays.get(overlay)?.draw(recorded.context);
    expect(recorded.line).toHaveBeenCalledWith(
      [
        [0, 0],
        [1, 0],
      ],
      expect.objectContaining({ width: expect.any(Number) }),
    );
    // Leaving the mode clears it
    view.draw.mode.set('select');
    expect(meters.value).toBeNull();
    const cleared = recordingContext(view.draw);
    view.draw.extensions.overlays.get(overlay)?.draw(cleared.context);
    expect(cleared.line).not.toHaveBeenCalled();
    expect(told[0]).toBeNull();
  });

  it('is left out of an image of the map', () => {
    const view = open();
    view.draw.use({
      name: 'acme-shown',
      setup: (ctx) => ctx.setOverlay([{ geometry: { type: 'Point', coordinates: [0, 0] } }]),
    });
    const overlay = view.draw.extensions.overlays.list()[0] as string;
    const shown = recordingContext(view.draw);
    view.draw.extensions.overlays.get(overlay)?.draw(shown.context);
    expect(shown.point).toHaveBeenCalledTimes(1);
    // The image waits for the next frame of the map, which the stub does not draw
    void view.draw.captureImage().catch(() => {});
    const captured = recordingContext(view.draw);
    view.draw.extensions.overlays.get(overlay)?.draw(captured.context);
    expect(captured.point).not.toHaveBeenCalled();
  });

  it('refuses an overlay past its bounds', () => {
    const view = open();
    view.draw.use({
      name: 'acme-many',
      setup(ctx) {
        const shape: OverlayShape = { geometry: { type: 'Point', coordinates: [0, 0] } };
        expect(() => ctx.setOverlay(Array.from({ length: 1_001 }, () => shape))).toThrow(
          expect.objectContaining({ code: 'tooLarge' }),
        );
        const line: OverlayShape = {
          geometry: {
            type: 'LineString',
            coordinates: Array.from({ length: 10_001 }, (_, i): Position => [i * 1e-5, 0]),
          },
        };
        expect(() => ctx.setOverlay([line])).toThrow(expect.objectContaining({ code: 'tooLarge' }));
        expect(() => ctx.setOverlay([{ geometry: null } as never])).toThrow(
          expect.objectContaining({ code: 'invalidInput' }),
        );
      },
    });
  });

  it('takes Escape back to select when the mode does not take it', () => {
    const view = open();
    view.draw.use(distance());
    view.draw.mode.set('acme:distance');
    createSyntheticInput(view.engine).key('Escape');
    expect(view.draw.getMode()).toBe('select');
  });

  it('tells the mode whether it was set to repeat', () => {
    const view = open();
    const entered: boolean[] = [];
    view.draw.use({
      name: 'acme-enter',
      setup(ctx) {
        ctx.addMode({
          name: 'acme:enter',
          enter: ({ repeat }) => void entered.push(repeat),
          input: () => false,
        });
      },
    });
    view.draw.mode.set('acme:enter', { repeat: true });
    view.draw.mode.set('select');
    view.draw.mode.set('acme:enter');
    expect(entered).toEqual([true, false]);
  });
});

describe('a type drawn from the features it joins (a link)', () => {
  it('draws its line where they are drawn, is hit near its ends and joins another by its handle', () => {
    vi.useFakeTimers();
    let view: Opened | undefined;
    const pick = (point: readonly [number, number]) =>
      view?.engine.extensions.hitAt({ x: point[0], y: point[1] })?.id ?? null;
    view = open({ plugins: [link(pick)] });
    const a = create(view, { type: 'Point', coordinates: [0, 0] });
    const b = create(view, { type: 'Point', coordinates: [1, 0] });
    const c = create(view, { type: 'Point', coordinates: [0, 2] });
    const joined = create(
      view,
      {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 0],
        ],
      },
      { [FROM]: a.id, [TO]: b.id },
      'acme:link',
    );
    // Hit by its own test near its ends, above the features it joins, and not along its line
    expect(hitAt(view, [1.01, 0])).toBe(joined.id);
    expect(hitAt(view, [0.5, 0])).toBeNull();
    // The end follows the feature it joins
    writesOf(view.draw).features.update(b.id, { geometry: { type: 'Point', coordinates: [1, 1] } });
    const context = drawn(view, joined.id);
    const lines = vi.mocked(context.sdfLineRenderer.draw);
    expect(lines.mock.calls[0]?.[0]).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(context.fillShaderManager.drawPolygonRings).toHaveBeenCalled();
    // Its handle is on the end; its mark is drawn as the plugin draws it
    view.draw.selection.set('feature', [joined.id]);
    const definition = view.draw.extensions.featureTypes.get('acme:link');
    const handles =
      definition?.handles?.(view.draw.features.get(joined.id) as Feature, {
        screen: recordingContext(view.draw).context.screen,
        selectionBox: null,
        selectionStyle: selectionStyleOf(view),
      }) ?? [];
    expect(handles).toEqual([
      { kind: 'custom', id: 'tip', position: [1, 1], sizePx: 10, cursor: 'grab' },
    ]);
    const marks = recordingContext(view.draw);
    definition?.drawHandles?.(
      view.draw.features.get(joined.id) as Feature,
      handles.filter((handle) => handle.kind === 'custom'),
      marks.context,
    );
    expect(marks.point).toHaveBeenCalledWith(
      [1, 1],
      expect.objectContaining({ size: 10, fillColor: '#cc3333' }),
      undefined,
    );
    expect(marks.line).toHaveBeenCalledWith(
      [
        [0, 0],
        [1, 1],
      ],
      expect.objectContaining({ lineStyle: 'dashed' }),
      undefined,
    );
    // Dragged to another feature and let go there, it joins it
    pointerDrag(view.engine, [1, 1], [0, 2]);
    vi.runAllTimers();
    expect(view.draw.features.get(joined.id)?.properties[TO]).toBe(c.id);
  });
});

describe('a companion of every type (a ring)', () => {
  it('goes with the features marked, draws below them, is pressed and has a handle', async () => {
    const view = open({ plugins: [halo()] });
    const area = create(
      view,
      {
        type: 'Polygon',
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
      { [IMPORTANT]: true },
    );
    const plain = create(view, { type: 'Point', coordinates: [3, 3] });
    const provider = view.draw.extensions.companionProviders.get('acme-halo');
    const featureOf = (id: string) => view.draw.features.get(id) as Feature;
    expect(provider?.has(featureOf(area.id))).toBe(true);
    expect(provider?.has(featureOf(plain.id))).toBe(false);
    expect(provider?.rows?.classifyKeys).toEqual([IMPORTANT]);
    const { context, line } = recordingContext(view.draw);
    provider?.draw(featureOf(area.id), context);
    expect(line).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ color: '#ffcc00', width: 6 }),
      { closed: true },
    );
    // Pressed on its ring, it takes the mark off and leaves the selection
    const box = view.draw.rendered.getFootprint(area.id);
    expect(box?.kind).toBe('ground');
    const corner = (box as { corners: { topRight: Position } }).corners.topRight;
    const hit = provider?.hitTest(featureOf(area.id), {
      point: context.screen.project(corner),
      lngLat: corner,
      tolerancePx: 4,
      screen: context.screen,
    });
    expect(hit).toEqual({ id: 'ring', distancePx: 0 });
    view.draw.selection.set('feature', [plain.id]);
    const taken = provider?.onClick?.(
      featureOf(area.id),
      { kind: 'companion', id: 'ring', distancePx: 0 },
      {
        point: context.screen.project(corner),
        lngLat: corner,
        snapped: { lngLat: corner },
        modifiers: MODIFIERS,
        pointerType: 'mouse',
        original: inert('click', { x: 0, y: 0 }) as PointerEvent,
      },
    );
    expect(taken).toBe(true);
    await vi.waitFor(() => expect(featureOf(area.id).properties[IMPORTANT]).toBe(false));
    expect(view.draw.selection.value).toMatchObject({ ids: [plain.id] });
    // Its handle is a handle of the engine on the corner of a feature marked
    const handles = view.draw.extensions.handleProviders.get('acme-halo');
    await view.draw.write((tx) =>
      tx.features.update(area.id, { properties: { [IMPORTANT]: true } }),
    );
    expect(
      handles?.handles(featureOf(area.id), {
        screen: context.screen,
        selectionBox: null,
        selectionStyle: selectionStyleOf(view),
      }),
    ).toEqual([{ kind: 'resize', id: 'width', position: corner }]);
  });

  it('answers from the rows of a layer held as rows, without features', () => {
    const view = open({ plugins: [halo()], rows: true });
    const marked = create(view, { type: 'Point', coordinates: [0, 0] }, { [IMPORTANT]: true });
    create(view, { type: 'Point', coordinates: [1, 0] });
    const provider = view.draw.extensions.companionProviders.get('acme-halo');
    const table = view.store.tables?.get('l');
    if (!table) throw new Error('no rows');
    const rows = Array.from(table.listDrawnRows([-10, -10, 10, 10]));
    const answered = rows.filter((row) => provider?.rows?.has(table, row) === true);
    expect(answered).toHaveLength(1);
    expect(table.getRow(answered[0] as number)?.id).toBe(marked.id);
  });
});

describe('the rows read without features (a count of vertices)', () => {
  it('counts the vertices drawn in view, again when the map moves', () => {
    const view = open({ rows: true });
    const on = vi.spyOn(view.engine.map, 'on');
    const counted = view.draw.use(density('l'));
    create(view, {
      type: 'LineString',
      coordinates: [
        [0, 0],
        [0.5, 0.5],
        [0.9, 0],
      ],
    });
    create(view, { type: 'Point', coordinates: [0.2, 0.2] });
    const moveend = on.mock.calls.find(([type]) => type === 'moveend')?.[1];
    if (typeof moveend !== 'function') throw new Error('no listener of moveend');
    moveend({} as never);
    expect(counted.value).toBe(4);
  });
});

describe('a type turned and resized by the library (a plan)', () => {
  it('measures its footprint again when the plugin says, snaps to its center, and turns', async () => {
    const units = observable(1);
    const view = open({ plugins: [plan(units)] });
    const feature = create(
      view,
      { type: 'Point', coordinates: [0, 0] },
      { [SIDE]: 2_226.4 },
      'acme:plan',
    );
    const corners = () =>
      (view.draw.rendered.getFootprint(feature.id) as { corners: { topRight: Position } }).corners
        .topRight;
    expect(corners()[0]).toBeCloseTo(0.01, 6);
    units.set(2);
    expect(corners()[0]).toBeCloseTo(0.02, 6);
    // Snapped to its center alone
    const snap = view.engine.context.snapTargets.get('acme:plan');
    const candidates = snap?.(view.store.getFeature(feature.id) as StoredFeature, {
      point: { x: 400, y: 300 },
      lngLat: { lng: 0, lat: 0 },
      tolerancePx: 10,
      toleranceLngDeg: 0.1,
      toleranceLatDeg: 0.1,
      zoom: 10,
      modifiers: MODIFIERS,
    });
    expect(candidates?.map((c) => ('coordinate' in c ? c.coordinate : null))).toEqual([[0, 0]]);
    // A rotation of the library writes its angle
    await view.draw.write((tx) =>
      tx.features.rotate(feature.id, { center: [0, 0], angleDegrees: 30 }),
    );
    expect(view.draw.features.get(feature.id)?.properties[ROTATION]).toBeCloseTo(30);
    // Its handle is on the east edge of the box drawn
    const definition = view.draw.extensions.featureTypes.get('acme:plan');
    const handles = definition?.handles?.(view.draw.features.get(feature.id) as Feature, {
      screen: recordingContext(view.draw).context.screen,
      selectionBox: {
        kind: 'ground',
        corners: {
          topLeft: [-1, 1],
          topRight: [1, 1],
          bottomRight: [1, -1],
          bottomLeft: [-1, -1],
        },
      },
      selectionStyle: selectionStyleOf(view),
    });
    expect(handles).toEqual([
      { kind: 'resize', id: 'east', position: [1, 0], cursor: 'ew-resize' },
    ]);
  });
});

describe('a DOM element that follows a point', () => {
  it('is placed where the point is drawn, again when it changes in a frame', () => {
    const view = open();
    const element: Element = { hidden: true, style: { transform: '' } };
    const follow = view.draw.use(popup(element));
    const feature = create(view, { type: 'Point', coordinates: [0, 0] });
    follow(feature.id);
    expect(element.hidden).toBe(false);
    expect(element.style.transform).toBe('translate(400px, 300px)');
    writesOf(view.draw).features.update(feature.id, {
      geometry: { type: 'Point', coordinates: [1, 1] },
    });
    view.drawFrame();
    expect(element.style.transform).toBe('translate(500px, 200px)');
    follow(null);
    expect(element.hidden).toBe(true);
  });
});

// ============================================================================
// The examples that draw with WebGL of their own: they type-check with `/webgl`
// ============================================================================

describe('the examples that draw with WebGL of their own', () => {
  it('type-check against /webgl', () => {
    // The types are checked by the compiler; these are not run
    const compass = (): Plugin => ({
      name: 'acme-compass',
      setup(ctx) {
        ctx.webgl.addOverlay({
          gpuShare: 0.001,
          prepare(gpu) {
            const { gl } = gpu;
            const program = gpu.program('', '');
            const view = gl.getUniformLocation(program, 'view');
            const vertices = gpu.vertexArray();
            gl.bindVertexArray(vertices);
            gpu.buffer(new Float32Array([0, 1, -0.4, -1, 0.4, -1]));
            gl.enableVertexAttribArray(0);
            gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
            return ({ screen }) => {
              const { drawingBufferWidth: w, drawingBufferHeight: h } = gl;
              const size = 48 * screen.pixelRatio;
              gl.useProgram(program);
              gl.bindVertexArray(vertices);
              gl.uniform3f(view, ctx.map.getBearing(), size / w, size / h);
              gl.drawArrays(gl.TRIANGLES, 0, 3);
            };
          },
        });
      },
    });
    const particles = (): Plugin => ({
      name: 'acme-particles',
      setup(ctx) {
        ctx.webgl.addOverlay({
          gpuShare: 0.01,
          prepare(gpu) {
            const { gl } = gpu;
            const compiling = gpu.compile('', '', { varyings: ['nextPosition'] });
            let front = gpu.buffer(65_536 * 8);
            let back = gpu.buffer(65_536 * 8);
            const vertices = gpu.vertexArray();
            const feedback = gpu.transformFeedback();
            return () => {
              if (!compiling.done) return;
              gl.useProgram(compiling.program);
              gl.bindVertexArray(vertices);
              gl.bindBuffer(gl.ARRAY_BUFFER, front);
              gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, feedback);
              gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, back);
              gl.beginTransformFeedback(gl.POINTS);
              gl.drawArrays(gl.POINTS, 0, 65_536);
              gl.endTransformFeedback();
              [front, back] = [back, front];
              ctx.map.triggerRepaint();
            };
          },
        });
      },
    });
    // A ring on each point drawn: what follows the number of points is allocated as rows
    const rings = (layerId: string): Plugin => ({
      name: 'acme-rings',
      setup(ctx) {
        ctx.webgl.addOverlay({
          gpuShare: 0.001,
          prepare(gpu) {
            const { gl } = gpu;
            const program = gpu.program('', '');
            const vertices = gpu.vertexArray();
            let points: WebGLBuffer | null = null;
            let capacity = 0;
            return () => {
              const view = ctx.webgl.rows(layerId);
              if (!view) return;
              const b = ctx.map.getBounds();
              const drawn = view.listDrawnRows([
                b.getWest(),
                b.getSouth(),
                b.getEast(),
                b.getNorth(),
              ]);
              if (drawn.length > capacity) {
                if (points) gpu.rows.release(points);
                capacity = drawn.length * 2;
                points = gpu.rows.buffer(capacity * 8);
              }
              const data = new Float32Array(drawn.length * 2);
              drawn.forEach((row, i) => {
                const [x = 0, y = 0] = view.getRowPoint(row) ?? [];
                data.set([x, y], i * 2);
              });
              gl.useProgram(program);
              gl.bindVertexArray(vertices);
              gl.bindBuffer(gl.ARRAY_BUFFER, points);
              gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
              gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, drawn.length);
            };
          },
        });
      },
    });
    expect([compass(), particles(), rings('l')].map((p) => p.name)).toEqual([
      'acme-compass',
      'acme-particles',
      'acme-rings',
    ]);
  });
});
