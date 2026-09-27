// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Style resolution tests for FeatureDrawer
 *
 * These verify the fill resolution of getPolygonStyles. In particular, they check as a
 * regression that for a feature with only fillColor specified and no fillOpacity, the
 * rendering alpha matches the default polygon fill alpha (which comes from the config).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_FEATURE_STYLE_CONFIG,
  type FeatureStyleConfig,
  mergeFeatureStyleConfig,
} from '../../shared/config/feature-style.js';
import type { FeatureCoordinates } from '../../shared/types/model.js';
import { geometryFromCoordinates } from '../../shared/utils/coordinates.js';
import type { Coordinate, Feature, FeatureStyle, Layer, StyleRule } from '../../store/types.js';
import { StyleRuleCache } from '../cache/style-rule.js';
import { FeatureDrawer } from './drawer.js';
import type { ImageRenderer } from './image.js';
import type { SDFLineRenderer } from './line/sdf-line.js';
import type { PointShapeRenderer } from './point/point-shape.js';

/**
 * A stub that has only the GL functions called by StrokeRenderer / FillShaderManager
 * when FeatureDrawer is constructed
 */
function createStubGL(): WebGL2RenderingContext {
  return {
    createBuffer: (): object => ({}),
    createVertexArray: (): object => ({}),
    bindBuffer: (): void => {},
    bindVertexArray: (): void => {},
    enableVertexAttribArray: (): void => {},
    vertexAttribPointer: (): void => {},
  } as unknown as WebGL2RenderingContext;
}

/** The style rule cache the drawers of a test share (one draw instance) */
let styleRules = new StyleRuleCache();

/**
 * getPolygonStyles references neither gl nor map nor any of the renderers, so
 * FeatureDrawer is created from stubs and only the style resolution is verified.
 */
function createDrawer(featureStyle: FeatureStyleConfig): FeatureDrawer {
  return new FeatureDrawer({
    gl: createStubGL(),
    map: {} as never,
    sdfLineRenderer: {} as SDFLineRenderer,
    pointShapeRenderer: {} as PointShapeRenderer,
    imageRenderer: {} as ImageRenderer,
    featureStyle,
    styleRules,
  });
}

/**
 * Style resolution takes (feature, layer), so even when only the per-feature style is
 * verified, a minimal Polygon feature is assembled.
 */
function polygonWith(style: FeatureStyle): Feature {
  return {
    id: 'polygon-1',
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
    layerId: 'layer-1',
    properties: {},
    style: style ?? {},
    locked: false,
    visible: true,
  };
}

describe('FeatureDrawer#getPolygonStyles fill resolution', () => {
  const defaultFillAlpha = DEFAULT_FEATURE_STYLE_CONFIG.polygon.fill.color[3];

  it('has a default polygon fill alpha of 0.25 (checking the premise)', () => {
    expect(defaultFillAlpha).toBe(0.25);
  });

  it('returns the default fill color as is when no feature is given', () => {
    const drawer = createDrawer(DEFAULT_FEATURE_STYLE_CONFIG);
    const { fillColor } = drawer.getPolygonStyles(undefined);
    expect(fillColor).toEqual(DEFAULT_FEATURE_STYLE_CONFIG.polygon.fill.color);
  });

  it('uses the default alpha when fillColor is given and fillOpacity is not set', () => {
    const drawer = createDrawer(DEFAULT_FEATURE_STYLE_CONFIG);
    const style: FeatureStyle = { fillColor: '#00ff00' };
    const { fillColor } = drawer.getPolygonStyles(polygonWith(style));
    // rgb is the given color and the alpha is the default 0.25 (not the opaque 1)
    expect(fillColor).toEqual([0, 1, 0, defaultFillAlpha]);
    expect(fillColor[3]).toBe(0.25);
  });

  it('uses the given alpha when both fillColor and fillOpacity are given', () => {
    const drawer = createDrawer(DEFAULT_FEATURE_STYLE_CONFIG);
    const style: FeatureStyle = { fillColor: '#00ff00', fillOpacity: 0.5 };
    const { fillColor } = drawer.getPolygonStyles(polygonWith(style));
    expect(fillColor).toEqual([0, 1, 0, 0.5]);
  });

  it('gives priority to 0 when fillOpacity is 0 (it is not swallowed by ??)', () => {
    const drawer = createDrawer(DEFAULT_FEATURE_STYLE_CONFIG);
    const style: FeatureStyle = { fillColor: '#00ff00', fillOpacity: 0 };
    const { fillColor } = drawer.getPolygonStyles(polygonWith(style));
    expect(fillColor[3]).toBe(0);
  });

  it('puts the given alpha on the default rgb when fillColor is unset and fillOpacity set', () => {
    const drawer = createDrawer(DEFAULT_FEATURE_STYLE_CONFIG);
    const defaultRgb = DEFAULT_FEATURE_STYLE_CONFIG.polygon.fill.color;
    const style: FeatureStyle = { fillOpacity: 0.8 };
    const { fillColor } = drawer.getPolygonStyles(polygonWith(style));
    expect(fillColor).toEqual([defaultRgb[0], defaultRgb[1], defaultRgb[2], 0.8]);
  });

  it('takes the default alpha from the config rather than from a hardcoded value', () => {
    // Even with a config that overrides the default polygon fill alpha to 0.6,
    // the alpha of a feature with only fillColor specified follows 0.6.
    const customConfig = mergeFeatureStyleConfig(DEFAULT_FEATURE_STYLE_CONFIG, {
      polygon: {
        ...DEFAULT_FEATURE_STYLE_CONFIG.polygon,
        fill: { color: [1, 0, 0, 0.6] },
      },
    });
    const drawer = createDrawer(customConfig);
    const style: FeatureStyle = { fillColor: '#00ff00' };
    const { fillColor } = drawer.getPolygonStyles(polygonWith(style));
    expect(fillColor[3]).toBe(0.6);
  });
});

describe('FeatureDrawer#drawFeature iteration over the parts of the Multi kinds', () => {
  /**
   * The Multi kinds have no dedicated shader; they call the existing renderers part by part.
   * Here the part iteration is verified through the call counts and the coordinates
   * of the line and point renderers.
   */
  function createDrawerWithStubs(): {
    drawer: FeatureDrawer;
    lineCalls: Coordinate[][];
    pointCalls: Coordinate[];
  } {
    const lineCalls: Coordinate[][] = [];
    const pointCalls: Coordinate[] = [];

    const sdfLineRenderer = {
      draw: (coords: Coordinate[]): void => {
        lineCalls.push(coords);
      },
      drawClosed: (): void => {},
    } as unknown as SDFLineRenderer;

    const pointShapeRenderer = {
      draw: (coord: Coordinate): void => {
        pointCalls.push(coord);
      },
    } as unknown as PointShapeRenderer;

    const drawer = new FeatureDrawer({
      gl: createStubGL(),
      map: {} as never,
      sdfLineRenderer,
      pointShapeRenderer,
      imageRenderer: {} as ImageRenderer,
      featureStyle: DEFAULT_FEATURE_STYLE_CONFIG,
    });

    return { drawer, lineCalls, pointCalls };
  }

  function createFeature(type: string, coordinates: FeatureCoordinates): Feature {
    return {
      id: 'multi-1',
      type,
      geometry: geometryFromCoordinates(type, coordinates),
      layerId: 'layer-1',
      properties: {},
      locked: false,
      visible: true,
      style: {},
    };
  }

  it('draws a point for each part of a MultiPoint', () => {
    const { drawer, pointCalls } = createDrawerWithStubs();

    drawer.drawFeature(
      createFeature('MultiPoint', [
        [0, 0],
        [1, 1],
        [2, 2],
      ]),
      {} as never,
      14,
    );

    expect(pointCalls).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
  });

  it('draws a line for each part of a MultiLineString', () => {
    const { drawer, lineCalls } = createDrawerWithStubs();

    drawer.drawFeature(
      createFeature('MultiLineString', [
        [
          [0, 0],
          [10, 0],
        ],
        [
          [0, 10],
          [10, 10],
        ],
      ]),
      {} as never,
      14,
    );

    expect(lineCalls).toHaveLength(2);
    expect(lineCalls[0]).toEqual([
      [0, 0],
      [10, 0],
    ]);
    expect(lineCalls[1]).toEqual([
      [0, 10],
      [10, 10],
    ]);
  });

  it('does not draw a MultiLineString part with one vertex (same as LineString)', () => {
    const { drawer, lineCalls } = createDrawerWithStubs();

    drawer.drawFeature(
      createFeature('MultiLineString', [
        [[0, 0]],
        [
          [0, 10],
          [10, 10],
        ],
      ]),
      {} as never,
      14,
    );

    expect(lineCalls).toHaveLength(1);
  });
});

describe('FeatureDrawer evaluation of style rules', () => {
  const rule: StyleRule = {
    kind: 'categorical',
    property: 'type',
    map: { a: '#ff0000', b: '#00ff00' },
    other: '#0000ff',
  };

  function makeLayer(styleRule?: StyleRule): Layer {
    return {
      id: 'layer-1',
      name: 'Layer 1',
      visible: true,
      locked: false,
      opacity: 1,
      order: [],
      styleRule,
    };
  }

  function makeFeature(
    id: string,
    type: Feature['type'],
    properties: Record<string, unknown>,
    style?: FeatureStyle,
  ): Feature {
    return {
      id,
      type,
      geometry: geometryFromCoordinates(type, type === 'Point' ? [0, 0] : [[0, 0]]),
      layerId: 'layer-1',
      properties,
      style: style ?? {},
      locked: false,
      visible: true,
    };
  }

  beforeEach(() => {
    // The evaluation results go into the draw instance's cache, so they must not carry over
    styleRules = new StyleRuleCache();
  });

  it('makes the rule color the fill of a Polygon (the alpha is the default value)', () => {
    const drawer = createDrawer(DEFAULT_FEATURE_STYLE_CONFIG);
    const { fillColor } = drawer.getPolygonStyles(
      makeFeature('p1', 'Polygon', { type: 'a' }),
      makeLayer(rule),
    );

    expect(fillColor).toEqual([1, 0, 0, DEFAULT_FEATURE_STYLE_CONFIG.polygon.fill.color[3]]);
  });

  it('makes the rule color the fill of a Point', () => {
    const drawer = createDrawer(DEFAULT_FEATURE_STYLE_CONFIG);
    const style = drawer.getPointStyle(makeFeature('pt1', 'Point', { type: 'b' }), makeLayer(rule));

    expect(style.fillColor).toEqual([0, 1, 0, 1]);
  });

  it('makes the rule color the line color of a LineString', () => {
    const drawer = createDrawer(DEFAULT_FEATURE_STYLE_CONFIG);
    const style = drawer.getLineStringStrokeStyle(
      makeFeature('l1', 'LineString', { type: 'a' }),
      makeLayer(rule),
    );

    expect(style.color).toEqual([1, 0, 0, 1]);
  });

  it('gives a feature with no attribute the color of other (not the default color)', () => {
    const drawer = createDrawer(DEFAULT_FEATURE_STYLE_CONFIG);
    const { fillColor } = drawer.getPolygonStyles(
      makeFeature('p2', 'Polygon', {}),
      makeLayer(rule),
    );

    expect(fillColor[0]).toBe(0);
    expect(fillColor[1]).toBe(0);
    expect(fillColor[2]).toBe(1);
  });

  it('lets a feature with its own style win over the rule', () => {
    const drawer = createDrawer(DEFAULT_FEATURE_STYLE_CONFIG);
    const { fillColor } = drawer.getPolygonStyles(
      makeFeature('p3', 'Polygon', { type: 'a' }, { fillColor: '#00ff00' }),
      makeLayer(rule),
    );

    expect(fillColor[0]).toBe(0);
    expect(fillColor[1]).toBe(1);
  });

  it('keeps the default color in a layer with no rules', () => {
    const drawer = createDrawer(DEFAULT_FEATURE_STYLE_CONFIG);
    const { fillColor } = drawer.getPolygonStyles(
      makeFeature('p4', 'Polygon', { type: 'a' }),
      makeLayer(),
    );

    expect(fillColor).toEqual(DEFAULT_FEATURE_STYLE_CONFIG.polygon.fill.color);
  });

  it('caches the result of evaluating the rules and does not re-evaluate on redraw', () => {
    const drawer = createDrawer(DEFAULT_FEATURE_STYLE_CONFIG);
    const layer = makeLayer(rule);
    const feature = makeFeature('p5', 'Polygon', { type: 'a' });

    drawer.getPolygonStyles(feature, layer);
    drawer.getPolygonStyles(feature, layer);

    const stats = styleRules.getStats();
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(1);
  });

  it('re-evaluates when the layer rules are replaced', () => {
    const drawer = createDrawer(DEFAULT_FEATURE_STYLE_CONFIG);
    const feature = makeFeature('p6', 'Polygon', { type: 'a' });

    drawer.getPolygonStyles(feature, makeLayer(rule));
    const { fillColor } = drawer.getPolygonStyles(
      feature,
      makeLayer({ ...rule, map: { a: '#0000ff' } }),
    );

    expect(fillColor[2]).toBe(1);
    expect(styleRules.getStats().hits).toBe(0);
  });

  it('keeps the evaluations of two draw instances apart for a feature with the same id', () => {
    // Two instances (a duplicated document, say) hold a feature with the same id and the same
    // layer rule. A cache keyed by the id alone would hand the second instance the color the
    // first one evaluated
    const layer = makeLayer(rule);
    const first = new FeatureDrawer({
      gl: createStubGL(),
      map: {} as never,
      sdfLineRenderer: {} as SDFLineRenderer,
      pointShapeRenderer: {} as PointShapeRenderer,
      imageRenderer: {} as ImageRenderer,
      featureStyle: DEFAULT_FEATURE_STYLE_CONFIG,
      styleRules: new StyleRuleCache(),
    });
    const second = new FeatureDrawer({
      gl: createStubGL(),
      map: {} as never,
      sdfLineRenderer: {} as SDFLineRenderer,
      pointShapeRenderer: {} as PointShapeRenderer,
      imageRenderer: {} as ImageRenderer,
      featureStyle: DEFAULT_FEATURE_STYLE_CONFIG,
      styleRules: new StyleRuleCache(),
    });

    const inFirst = first.getPolygonStyles(makeFeature('same', 'Polygon', { type: 'a' }), layer);
    const inSecond = second.getPolygonStyles(makeFeature('same', 'Polygon', { type: 'b' }), layer);

    expect(inFirst.fillColor.slice(0, 3)).toEqual([1, 0, 0]);
    expect(inSecond.fillColor.slice(0, 3)).toEqual([0, 1, 0]);
  });
});

describe('FeatureDrawer#drawFeature and the opacity of the layer', () => {
  it('passes the opacity of the layer to the image renderer', () => {
    const draw = vi.fn();
    const drawer = new FeatureDrawer({
      gl: createStubGL(),
      map: { triggerRepaint: () => {} } as never,
      sdfLineRenderer: {} as SDFLineRenderer,
      pointShapeRenderer: {} as PointShapeRenderer,
      imageRenderer: { draw } as unknown as ImageRenderer,
      featureStyle: DEFAULT_FEATURE_STYLE_CONFIG,
      styleRules,
    });
    const image = {
      ...polygonWith({}),
      id: 'image-1',
      type: 'Image',
      geometry: { type: 'Point', coordinates: [0, 0] },
    };
    const layer = { id: 'layer-1', opacity: 0.25 } as Layer;

    drawer.drawFeature(image as Feature, {} as never, 14, layer);
    drawer.drawFeature(image as Feature, {} as never, 14);

    expect(draw.mock.calls[0][4]).toBe(0.25);
    expect(draw.mock.calls[1][4]).toBe(1);
  });
});

describe('FeatureDrawer#getPointStyle and the shape of a point', () => {
  function pointWith(style?: FeatureStyle): Feature {
    return {
      id: 'point-1',
      type: 'Point',
      geometry: { type: 'Point', coordinates: [0, 0] },
      layerId: 'layer-1',
      properties: {},
      style: style ?? {},
      locked: false,
      visible: true,
    };
  }

  it('uses the shape of the feature over the default of the instance', () => {
    const drawer = createDrawer(DEFAULT_FEATURE_STYLE_CONFIG);

    expect(drawer.getPointStyle(pointWith({ pointShape: 'star' })).shape).toBe('star');
    expect(drawer.getPointStyle(pointWith({ pointShape: 'triangle' })).shape).toBe('triangle');
  });

  it('keeps the other keys of the feature when only the shape is set', () => {
    const drawer = createDrawer(DEFAULT_FEATURE_STYLE_CONFIG);
    const style = drawer.getPointStyle(pointWith({ pointShape: 'square', pointRadius: 9 }));

    expect(style.shape).toBe('square');
    expect(style.size).toBe(18);
  });

  it('takes the default of the instance when the feature sets no shape', () => {
    const base = DEFAULT_FEATURE_STYLE_CONFIG;
    const config: FeatureStyleConfig = {
      ...base,
      point: { ...base.point, point: { ...base.point.point, shape: 'square' } },
    };
    const drawer = createDrawer(config);

    expect(drawer.getPointStyle(pointWith()).shape).toBe('square');
    expect(drawer.getPointStyle(pointWith({ pointColor: '#00ff00' })).shape).toBe('square');
  });

  it('keeps the default of the instance for a shape a feature may not name', () => {
    const drawer = createDrawer(DEFAULT_FEATURE_STYLE_CONFIG);
    const stray = { pointShape: 'hexagon' } as unknown as FeatureStyle;

    expect(drawer.getPointStyle(pointWith(stray)).shape).toBe('circle');
    expect(drawer.getPointStyle(pointWith({ pointShape: 'icon' } as never)).shape).toBe('circle');
  });
});
