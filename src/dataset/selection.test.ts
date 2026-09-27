// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the selection highlight and the hit testing of a dataset (selection.ts)
 *
 * The functions are called directly with stub inputs. The drawing goes to a stub batch without
 * GL and is judged by what goes onto the batch.
 */

import type { ProjectionData } from 'maplibre-gl';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_FEATURE_STYLE_CONFIG } from '../shared/config/feature-style.js';
import { SELECTION_HIGHLIGHT_COLOR } from '../shared/config/selection-highlight.js';
import type { BoundingBox, Feature } from '../shared/types/model.js';
import { FeatureDrawer } from '../view/renderers/drawer.js';
import type { ImageRenderer } from '../view/renderers/image.js';
import type { SDFLineRenderer } from '../view/renderers/line/sdf-line.js';
import type { PointShapeRenderer } from '../view/renderers/point/point-shape.js';
import { TerrainContext } from '../view/terrain/context.js';
import {
  drawSelectionHighlight,
  highlightFeature,
  hitTestDisplayFeatures,
  isHandedToDrape,
  maxStylePointRadiusOf,
  type SelectionHighlightInput,
  sameFeatureIds,
} from './selection.js';
import type { DatasetFeatureInput, DisplayBatchTarget } from './types.js';
import { normalizeDisplayFeature } from './types.js';

const WORLD: BoundingBox = { minX: -180, minY: -85, maxX: 180, maxY: 85 };

function feature(input: DatasetFeatureInput): Feature {
  return normalizeDisplayFeature(input);
}

const POINT = feature({ id: 'p', type: 'Point', coordinates: [0, 0] });
const LINE = feature({
  id: 'l',
  type: 'LineString',
  coordinates: [
    [0, 0],
    [1, 1],
  ],
});
const POLYGON = feature({
  id: 'g',
  type: 'Polygon',
  coordinates: [
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 0],
    ],
  ],
});

function createStyles(): FeatureDrawer {
  return new FeatureDrawer({
    gl: {
      createBuffer: (): object => ({}),
      createVertexArray: (): object => ({}),
      bindBuffer: (): void => {},
      bindVertexArray: (): void => {},
      enableVertexAttribArray: (): void => {},
      vertexAttribPointer: (): void => {},
    } as unknown as WebGL2RenderingContext,
    map: {} as never,
    sdfLineRenderer: {} as SDFLineRenderer,
    pointShapeRenderer: {} as PointShapeRenderer,
    imageRenderer: {} as ImageRenderer,
    featureStyle: DEFAULT_FEATURE_STYLE_CONFIG,
  });
}

function createTarget(): { target: DisplayBatchTarget; drawn: Feature[] } {
  const drawn: Feature[] = [];
  return {
    drawn,
    target: {
      beginFrame: vi.fn(),
      processFeature: (f: Feature): boolean => {
        drawn.push(f);
        return true;
      },
      endFrame: vi.fn(),
    },
  };
}

function highlightInput(
  target: DisplayBatchTarget,
  overrides: Partial<SelectionHighlightInput>,
): SelectionHighlightInput {
  return {
    target,
    projectionData: {} as ProjectionData,
    zoom: 10,
    bounds: WORLD,
    selected: [],
    styles: undefined,
    terrain: new TerrainContext(),
    datasetId: 'c',
    drapedFills: false,
    prepare: (f) => f,
    isExternalPoint: () => false,
    ...overrides,
  };
}

describe('highlightFeature', () => {
  it('a point becomes a larger point of the key color', () => {
    const lit = highlightFeature(POINT);
    expect(lit.style?.pointColor).toBe(SELECTION_HIGHLIGHT_COLOR);
    expect(lit.style?.pointRadius).toBeGreaterThan(6);
    // The original is not rewritten
    expect(POINT.style).toEqual({});
  });

  it('a line and a polygon are painted in the key color with a wider stroke', () => {
    expect(highlightFeature(LINE).style?.strokeColor).toBe(SELECTION_HIGHLIGHT_COLOR);
    const polygon = highlightFeature(POLYGON).style;
    expect(polygon?.fillColor).toBe(SELECTION_HIGHLIGHT_COLOR);
    expect(polygon?.strokeWidth).toBeGreaterThan(2);
  });
});

describe('drawSelectionHighlight', () => {
  it('nothing is drawn without a selection', () => {
    const { target } = createTarget();
    drawSelectionHighlight(highlightInput(target, {}));
    expect(target.beginFrame).not.toHaveBeenCalled();
  });

  it('a point is drawn as the highlight and then the original on top (a ring)', () => {
    const { target, drawn } = createTarget();
    drawSelectionHighlight(highlightInput(target, { selected: [POINT] }));
    expect(drawn.map((f) => f.style?.pointColor)).toEqual([SELECTION_HIGHLIGHT_COLOR, undefined]);
  });

  it('a point drawn by an external renderer keeps only the halo underneath', () => {
    const { target, drawn } = createTarget();
    drawSelectionHighlight(
      highlightInput(target, { selected: [POINT], isExternalPoint: () => true }),
    );
    expect(drawn).toHaveLength(1);
  });

  it('a hidden feature or one out of view is not highlighted', () => {
    const { target, drawn } = createTarget();
    const hidden = { ...LINE, id: 'h', visible: false };
    drawSelectionHighlight(
      highlightInput(target, {
        selected: [hidden, POLYGON],
        bounds: { minX: 10, minY: 10, maxX: 11, maxY: 11 },
      }),
    );
    expect(drawn).toHaveLength(0);
  });

  it('a polygon handed to the drape is left to the drape', () => {
    const { target, drawn } = createTarget();
    drawSelectionHighlight(
      highlightInput(target, { selected: [POLYGON], styles: createStyles(), drapedFills: true }),
    );
    expect(drawn).toHaveLength(0);

    drawSelectionHighlight(
      highlightInput(target, { selected: [POLYGON], styles: createStyles(), drapedFills: false }),
    );
    expect(drawn).toHaveLength(1);
  });

  it('the features are prepared (styled) before they are highlighted', () => {
    const { target, drawn } = createTarget();
    drawSelectionHighlight(
      highlightInput(target, {
        selected: [LINE],
        prepare: (f) => ({ ...f, style: { strokeWidth: 10 } }),
      }),
    );
    expect(drawn[0].style?.strokeWidth).toBeGreaterThan(10);
  });
});

describe('isHandedToDrape', () => {
  it('solid polygons and lines go to the drape, points and dashed lines do not', () => {
    const styles = createStyles();
    expect(isHandedToDrape(POLYGON, styles)).toBe(true);
    expect(isHandedToDrape(LINE, styles)).toBe(true);
    expect(isHandedToDrape(POINT, styles)).toBe(false);
    expect(isHandedToDrape({ ...LINE, style: { lineStyle: 'dashed' } }, styles)).toBe(false);
  });
});

describe('hitTestDisplayFeatures', () => {
  const base = {
    toleranceLngLat: 0.0001,
    zoom: 10,
    scale: 1,
    baseStyle: undefined,
    pointDefaults: DEFAULT_FEATURE_STYLE_CONFIG.point.point,
    maxStylePointRadius: 0,
    isDrawn: () => true,
  };

  it('the frontmost candidate that passes the precise test wins', () => {
    const a = feature({ id: 'a', type: 'Point', coordinates: [0, 0] });
    const b = feature({ id: 'b', type: 'Point', coordinates: [0, 0] });
    const hit = hitTestDisplayFeatures({
      ...base,
      coordinate: [0, 0],
      test: () => true,
      search: () => [0, 1],
      featureAt: (row) => [a, b][row],
    });
    expect(hit?.feature.id).toBe('b');
    expect(hit?.row).toBe(1);
  });

  it('a thinned or hidden feature cannot be grabbed', () => {
    const a = feature({ id: 'a', type: 'Point', coordinates: [0, 0] });
    const b = feature({ id: 'b', type: 'Point', coordinates: [0, 0], visible: false });
    const hit = hitTestDisplayFeatures({
      ...base,
      coordinate: [0, 0],
      test: () => true,
      search: () => [0, 1],
      featureAt: (row) => [a, b][row],
      isDrawn: (row) => row !== 0,
    });
    expect(hit).toBeNull();
  });

  it('a point is tested with the radius of the marker drawn, not only with the tolerance', () => {
    const tolerances: number[] = [];
    const search = vi.fn(() => [0]);
    hitTestDisplayFeatures({
      ...base,
      featureAt: () => POINT,
      coordinate: [0, 0],
      maxStylePointRadius: 40,
      test: (_f, _c, tolerance) => {
        tolerances.push(tolerance);
        return false;
      },
      search,
    });
    expect(tolerances[0]).toBeGreaterThan(base.toleranceLngLat);
    // The narrowing of the index reaches as far as the largest marker
    const bounds = (search.mock.calls[0] as unknown as [BoundingBox])[0];
    expect(bounds.maxX).toBeGreaterThan(tolerances[0]);
  });
});

describe('the helpers', () => {
  it('maxStylePointRadiusOf looks only at the points', () => {
    expect(
      maxStylePointRadiusOf([
        { ...POINT, style: { pointRadius: 9 } },
        { ...LINE, style: { pointRadius: 50 } },
        POINT,
      ]),
    ).toBe(9);
    expect(maxStylePointRadiusOf([])).toBe(0);
  });

  it('sameFeatureIds compares the ids in order', () => {
    expect(sameFeatureIds([POINT, LINE], [POINT, LINE])).toBe(true);
    expect(sameFeatureIds([POINT], [LINE])).toBe(false);
    expect(sameFeatureIds([POINT], [])).toBe(false);
  });
});
