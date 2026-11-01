// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The look of a custom feature type
 *
 * - A type declares the look of its features without a style of their own (`defaultStyle`), and
 *   `features.getAppliedStyle` puts the layer rule and the style of the feature over it, in place
 *   of the defaults of its geometry; the keys it leaves out keep those defaults
 * - The layer rule colors the channel of the type only: the one it declares
 *   (`styleRuleChannel`), so a box on a Point drawn with a paper of `fillColor` that declares
 *   `'fill'` is colored by the rule, and its outline is not; a type that declares none takes the
 *   channel of the geometry of the feature, as a built-in type of that geometry does (`pointColor`
 *   for a Point, `strokeColor` for a LineString, `fillColor` for a Polygon)
 * - A channel that is not one, and one in a definition that overrides a built-in type, are refused
 * - The style of a feature wins over the rule
 * - A type that declares none, and the built-in types, keep the defaults of their geometry
 * - The renderer of the type reads the same look from its render context
 *   (`RenderContext.appliedStyle`), the same object however many times it reads it while nothing
 *   changes, and the new look once the rule or the style changes
 * - Its type has every key the library defines, and no more: a key an extension adds to
 *   `FeatureStyle` by declaration merging is not made required by it
 */

import type { ProjectionData } from 'maplibre-gl';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { FeatureTypeRenderer, FrameDrawContext } from '../../extension/renderers.js';
import type { Store } from '../../store/store.js';
import type { Feature as StoredFeature } from '../../store/types.js';
import { createMapStub, STORE_KINDS } from '../../test-utils.js';
import type { TerrainContext } from '../../view/terrain/context.js';
import type { Draw } from '../draw.js';
import type { FeatureTypeDefinition } from '../extension/feature-type.js';
import type { RenderContext } from '../extension/render.js';
import type { Feature, FeatureStyle, FeatureStyleResolved } from '../model.js';
import { createDrawOnEngine } from './create-draw.js';
import { createEngine, type Engine } from './engine.js';

/** The look of a card without a style of its own: a pale paper with a darker edge */
const CARD_LOOK: FeatureStyle = {
  fillColor: '#fff3c4',
  fillOpacity: 1,
  strokeColor: '#c9a227',
  strokeWidth: 1,
  strokeOpacity: 1,
};

/** What each renderer of the types read from its render context, by type */
const reads = new Map<string, Array<{ feature: Feature; ctx: RenderContext }>>();

function rendererOf(type: string): FeatureTypeDefinition['renderer'] {
  return {
    onAdd() {},
    draw(feature, ctx) {
      const list = reads.get(type) ?? [];
      list.push({ feature, ctx });
      reads.set(type, list);
    },
    onRemove() {},
  };
}

/** A card: a paper laid on the map around its point, with a look of its own */
const CARD: FeatureTypeDefinition = {
  type: 'card',
  geometry: 'Point',
  defaultStyle: CARD_LOOK,
  styleRuleChannel: 'fill',
  renderer: rendererOf('card'),
};

/** A pin: a type that declares no look */
const PIN: FeatureTypeDefinition = {
  type: 'pin',
  geometry: 'Point',
  renderer: rendererOf('pin'),
};

/** A trail: a type of lines that declares no look */
const TRAIL: FeatureTypeDefinition = {
  type: 'trail',
  geometry: 'LineString',
  renderer: rendererOf('trail'),
};

/** A plot: a type of areas that declares no look */
const PLOT: FeatureTypeDefinition = {
  type: 'plot',
  geometry: 'Polygon',
  renderer: rendererOf('plot'),
};

/** A route: a type of lines whose rule colors its fill */
const SWATH: FeatureTypeDefinition = {
  type: 'swath',
  geometry: 'LineString',
  styleRuleChannel: 'fill',
  renderer: rendererOf('swath'),
};

const PROJECTION = { mainMatrix: new Float32Array(16) } as unknown as ProjectionData;
const GL = {} as WebGL2RenderingContext;

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

interface Opened {
  engine: Engine;
  draw: Draw;
  store: Store;
  /** The renderers of the engine the types were put in as, by type */
  renderers: Map<string, FeatureTypeRenderer>;
}

const opened: Draw[] = [];

afterEach(() => {
  for (const draw of opened.splice(0)) draw.destroy();
  reads.clear();
});

/** The geometry of a feature of each type of the tests */
function geometryOf(type: string): StoredFeature['geometry'] {
  if (type === 'trail' || type === 'swath') {
    return {
      type: 'LineString',
      coordinates: [
        [0, 0],
        [1, 1],
      ],
    };
  }
  if (type === 'plot') {
    return {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
    };
  }
  return { type: 'Point', coordinates: [0, 0] };
}

function featureOf(id: string, type: string, style: FeatureStyle = {}): StoredFeature {
  return {
    id,
    type,
    geometry: geometryOf(type),
    layerId: 'l',
    groupId: undefined,
    properties: { kind: 'a' },
    style,
    visible: true,
    locked: false,
  };
}

/** An instance over a Store with the types registered and a layer `l` of the features given */
function open(store: Store, features: readonly StoredFeature[]): Opened {
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
  const renderers = new Map<string, FeatureTypeRenderer>();
  const register = engine.customLayer.registerFeatureRenderer.bind(engine.customLayer);
  vi.spyOn(engine.customLayer, 'registerFeatureRenderer').mockImplementation((type, renderer) => {
    renderers.set(type, renderer);
    return register(type, renderer);
  });
  draw.extensions.featureTypes.addMany([CARD, PIN, TRAIL, PLOT, SWATH]);
  store.transact(() => {
    for (const feature of features) store.createFeature(feature);
  });
  for (const renderer of renderers.values()) renderer.onAdd(GL, engine.map);
  return { engine, draw, store, renderers };
}

/** What the renderer of a type read last */
function lastRead(type: string): { feature: Feature; ctx: RenderContext } | undefined {
  const list = reads.get(type) ?? [];
  return list[list.length - 1];
}

/** The look the renderer of the type of a feature reads in a frame, as it draws the feature */
function drawnLook(view: Opened, id: string, context = frame()): FeatureStyleResolved {
  const feature = view.store.getFeature(id) as StoredFeature;
  const renderer = view.renderers.get(feature.type);
  if (!renderer) throw new Error(`no renderer of ${feature.type}`);
  renderer.draw(feature, PROJECTION, 12, context);
  const last = lastRead(feature.type);
  if (!last) throw new Error(`${id} was not drawn`);
  return last.ctx.appliedStyle(last.feature);
}

describe.each(STORE_KINDS)('the look of a custom type over %s', (_, makeStore) => {
  it('is the look the type declares, under the layer rule and the style of the feature', () => {
    const view = open(makeStore(), [featureOf('c', 'card')]);
    expect(view.draw.features.getAppliedStyle('c')).toMatchObject(CARD_LOOK);
    // The keys the type leaves out keep the defaults of its geometry
    expect(view.draw.features.getAppliedStyle('c')).toMatchObject({
      lineStyle: 'solid',
      pointStrokeColor: '#ffffff',
      imageOpacity: 1,
    });
  });

  it('takes the color of the layer rule as its fill, and keeps its outline', () => {
    const view = open(makeStore(), [featureOf('c', 'card')]);
    view.draw.layers.update('l', { styleRule: { kind: 'single', color: '#00ff00' } });
    expect(view.draw.features.getAppliedStyle('c')).toMatchObject({
      ...CARD_LOOK,
      fillColor: '#00ff00',
    });
  });

  it('takes the style of the feature over the layer rule', () => {
    const view = open(makeStore(), [featureOf('c', 'card', { fillColor: '#123456' })]);
    view.draw.layers.update('l', { styleRule: { kind: 'single', color: '#00ff00' } });
    expect(view.draw.features.getAppliedStyle('c')).toMatchObject({
      ...CARD_LOOK,
      fillColor: '#123456',
    });
  });

  it('takes the channel of the geometry for a type that declares none, as the built-in types', () => {
    const view = open(makeStore(), [featureOf('p', 'pin'), featureOf('q', 'Point')]);
    const defaults = {
      fillColor: '#ff0077',
      fillOpacity: 0.25,
      strokeColor: '#ff0077',
      strokeWidth: 2,
      pointStrokeColor: '#ffffff',
    };
    expect(view.draw.features.getAppliedStyle('p')).toMatchObject(defaults);
    expect(view.draw.features.getAppliedStyle('q')).toMatchObject(defaults);
    view.draw.layers.update('l', { styleRule: { kind: 'single', color: '#00ff00' } });
    // A type of points that declares no channel: the point, as a built-in point
    expect(view.draw.features.getAppliedStyle('p')).toMatchObject({
      ...defaults,
      pointColor: '#00ff00',
    });
    expect(view.draw.features.getAppliedStyle('q')).toMatchObject({
      ...defaults,
      pointColor: '#00ff00',
    });
  });

  it('takes the stroke of a type of lines and the fill of a type of areas that declare none', () => {
    const view = open(makeStore(), [featureOf('t', 'trail'), featureOf('a', 'plot')]);
    view.draw.layers.update('l', { styleRule: { kind: 'single', color: '#00ff00' } });
    expect(view.draw.features.getAppliedStyle('t')).toMatchObject({
      strokeColor: '#00ff00',
      fillColor: '#ff0077',
    });
    expect(view.draw.features.getAppliedStyle('a')).toMatchObject({
      fillColor: '#00ff00',
      strokeColor: '#ff0077',
    });
  });

  it('takes the channel a type declares over the one of its geometry', () => {
    const view = open(makeStore(), [featureOf('s', 'swath')]);
    view.draw.layers.update('l', { styleRule: { kind: 'single', color: '#00ff00' } });
    expect(view.draw.features.getAppliedStyle('s')).toMatchObject({
      fillColor: '#00ff00',
    });
    expect(view.draw.features.getAppliedStyle('s')?.strokeColor).not.toBe('#00ff00');
  });

  it('is read by the renderer from its render context as getAppliedStyle answers it', () => {
    const view = open(makeStore(), [
      featureOf('c', 'card'),
      featureOf('d', 'card', { strokeWidth: 3 }),
      featureOf('p', 'pin'),
    ]);
    view.draw.layers.update('l', { styleRule: { kind: 'single', color: '#00ff00' } });
    for (const id of ['c', 'd', 'p']) {
      expect(drawnLook(view, id)).toEqual(view.draw.features.getAppliedStyle(id));
    }
  });

  it('is the same object however many times a frame reads it, until it changes', () => {
    const view = open(makeStore(), [featureOf('c', 'card')]);
    const context = frame();
    const first = drawnLook(view, 'c', context);
    const { feature, ctx } = lastRead('card') ?? {};
    if (!feature || !ctx) throw new Error('not drawn');
    expect(ctx.appliedStyle(feature)).toBe(first);
    // The next frame reads the same look while nothing changed
    expect(drawnLook(view, 'c')).toBe(first);
    // A change of the rule, then of the style, is read in the next frame
    view.draw.layers.update('l', { styleRule: { kind: 'single', color: '#00ff00' } });
    expect(drawnLook(view, 'c').fillColor).toBe('#00ff00');
    view.draw.features.update('c', { style: { fillColor: '#0000ff' } });
    expect(drawnLook(view, 'c').fillColor).toBe('#0000ff');
    expect(drawnLook(view, 'c')).toEqual(view.draw.features.getAppliedStyle('c'));
  });
});

describe('the declaration of the look of a type', () => {
  it('is refused when it is not a style', () => {
    const view = open(STORE_KINDS[0][1](), []);
    const add = (defaultStyle: unknown) =>
      view.draw.extensions.featureTypes.add({
        type: 'bad',
        geometry: 'Point',
        renderer: rendererOf('bad'),
        defaultStyle,
      } as never);
    expect(() => add('yellow')).toThrow(expect.objectContaining({ code: 'invalid-input' }));
    expect(() => add({ fillColor: 'not a color' })).toThrow(
      expect.objectContaining({ code: 'invalid-input' }),
    );
    expect(() => add({ fillOpacity: 2 })).toThrow(
      expect.objectContaining({ code: 'invalid-input' }),
    );
    expect(view.draw.extensions.featureTypes.has('bad')).toBe(false);
  });

  it('is refused in a definition that overrides a built-in type', () => {
    const view = open(STORE_KINDS[0][1](), []);
    expect(() =>
      view.draw.extensions.featureTypes.override({
        type: 'Point',
        geometry: 'Point',
        renderer: rendererOf('Point'),
        defaultStyle: CARD_LOOK,
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid-input' }));
    expect(() =>
      view.draw.extensions.featureTypes.override({
        type: 'Point',
        geometry: 'Point',
        renderer: rendererOf('Point'),
        styleRuleChannel: 'fill',
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid-input' }));
  });

  it('refuses a channel that is not one', () => {
    const view = open(STORE_KINDS[0][1](), []);
    expect(() =>
      view.draw.extensions.featureTypes.add({
        type: 'bad',
        geometry: 'Point',
        renderer: rendererOf('bad'),
        styleRuleChannel: 'outline',
      } as never),
    ).toThrow(expect.objectContaining({ code: 'invalid-input' }));
    expect(view.draw.extensions.featureTypes.has('bad')).toBe(false);
  });

  it('is copied when the type is added, and goes with the type', () => {
    const look: FeatureStyle = { fillColor: '#fff3c4' };
    const view = open(STORE_KINDS[0][1](), [featureOf('s', 'slip')]);
    const remove = view.draw.extensions.featureTypes.add({
      type: 'slip',
      geometry: 'Point',
      renderer: rendererOf('slip'),
      defaultStyle: look,
    });
    look.fillColor = '#000000';
    expect(view.draw.features.getAppliedStyle('s')?.fillColor).toBe('#fff3c4');
    remove();
    expect(view.draw.features.getAppliedStyle('s')?.fillColor).toBe('#ff0077');
  });
});

describe('the type of the look a feature is drawn with', () => {
  it('has every key of the style the library defines, each required', () => {
    // Listed apart from FeatureStyle, so that a key merged into FeatureStyle stays optional; a key
    // the library adds to FeatureStyle and leaves out of the list fails here
    expectTypeOf<FeatureStyleResolved>().toExtend<Required<FeatureStyle>>();
    expectTypeOf<Required<FeatureStyle>>().toExtend<FeatureStyleResolved>();
  });
});

describe('a color a shared renderer cannot read', () => {
  it('is drawn transparent, and told once in the console for each part of each renderer', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const view = open(STORE_KINDS[0][1](), [
      featureOf('s', 'scribble'),
      featureOf('t', 'scribble'),
    ]);
    view.draw.extensions.featureTypes.add({
      type: 'scribble',
      geometry: 'Point',
      renderer: {
        onAdd() {},
        draw(feature, ctx) {
          const at = (feature.geometry as unknown as { coordinates: [number, number] }).coordinates;
          ctx.line.draw([at, at], { width: 1, color: 'tomatoes', opacity: 1, lineStyle: 'solid' });
          ctx.fill.draw([[at, at, at]], { color: 'not a color', opacity: 1 });
          ctx.point.draw(at, {
            shape: 'circle',
            size: 4,
            fillColor: '#ff0000',
            fillOpacity: 1,
            strokeColor: 'nope',
            strokeWidth: 1,
            strokeOpacity: 1,
          });
        },
        onRemove() {},
      },
    });
    const renderer = view.renderers.get('scribble');
    if (!renderer) throw new Error('no renderer');
    renderer.onAdd(GL, view.engine.map);
    const context = frame();
    for (const id of ['s', 't', 's']) {
      renderer.draw(view.store.getFeature(id) as StoredFeature, PROJECTION, 12, context);
    }
    const told = warn.mock.calls.map((call) => String(call[0]));
    expect(told).toHaveLength(3);
    expect(told[0]).toMatch(/"tomatoes" as the color of ctx\.line/);
    expect(told[1]).toMatch(/"not a color" as the color of ctx\.fill/);
    expect(told[2]).toMatch(/"nope" as the strokeColor of ctx\.point/);
    warn.mockRestore();
  });
});
