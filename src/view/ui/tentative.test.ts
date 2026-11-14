// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The look of the shapes being drawn (TentativeRenderer): the look of the configuration, and the
 * look of a sketch put over it for its shapes alone
 *
 * - the line through the vertices placed is solid, the lines to the pointer and back to the first
 *   vertex dashed, in the color and the width of the look; the outline of a circle and a freehand
 *   line are solid
 * - the fill of an area and of a circle takes the fill keys of the look
 * - a shape without a look of its own is drawn with the configuration
 */

import type { CustomRenderMethodInput } from 'maplibre-gl';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_FEATURE_STYLE_CONFIG,
  type TentativeStyle,
} from '../../shared/config/feature-style.js';
import type { FeatureStyle } from '../../shared/types/model.js';
import type { Color, PointStyle } from '../../shared/types/style.js';
import type { Coordinate } from '../../store/types.js';
import type { GpuLedger } from '../gpu-ledger.js';
import type { SDFLineRenderer, SDFStrokeStyle } from '../renderers/line/sdf-line.js';
import type { PointShapeRenderer } from '../renderers/point/point-shape.js';
import { type DrawnTentative, TentativeRenderer } from './tentative.js';

/** The fills drawn, as the shader of the fills is asked to draw them */
const fills: { ring: Coordinate[]; color: Color }[] = [];

vi.mock('../renderers/polygon/fill.js', () => ({
  FillShaderManager: class {
    drawPolygon(ring: Coordinate[], color: Color): void {
      fills.push({ ring, color });
    }
    ensureShader(): void {}
    setOffsetUniforms(): void {}
    dispose(): void {}
  },
}));

const PROJECTION_DATA = {} as CustomRenderMethodInput['defaultProjectionData'];

/** A renderer over recording renderers of lines and points, with the default configuration */
function renderer(style: TentativeStyle = structuredClone(DEFAULT_FEATURE_STYLE_CONFIG.tentative)) {
  const lines: { coords: [number, number][]; style: SDFStrokeStyle; closed: boolean }[] = [];
  const points: { coord: Coordinate; style: PointStyle }[] = [];
  const sdfLineRenderer = {
    draw: (coords: [number, number][], stroke: SDFStrokeStyle, options: { closed?: boolean }) => {
      lines.push({ coords, style: stroke, closed: options.closed ?? false });
    },
  } as unknown as SDFLineRenderer;
  const pointShapeRenderer = {
    draw: (coord: Coordinate, point: PointStyle) => points.push({ coord, style: point }),
  } as unknown as PointShapeRenderer;
  fills.length = 0;
  const tentative = new TentativeRenderer({
    gl: {} as WebGL2RenderingContext,
    map: {} as never,
    sdfLineRenderer,
    pointShapeRenderer,
    tentativeStyle: style,
    ledger: {} as GpuLedger,
  });
  return { tentative, lines, points };
}

/** A line of three vertices, two of them placed and the last one at the pointer */
function lineBeingDrawn(previewStyle?: Partial<FeatureStyle>): DrawnTentative {
  return {
    type: 'LineString',
    coordinates: [
      [0, 0],
      [1, 0],
      [2, 1],
    ],
    layerId: 'roads',
    confirmedCount: 2,
    ...(previewStyle !== undefined && { previewStyle }),
  };
}

/** An area of three vertices placed and the fourth at the pointer, its ring closed */
function areaBeingDrawn(previewStyle?: Partial<FeatureStyle>): DrawnTentative {
  return {
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
    layerId: 'parcels',
    confirmedCount: 3,
    ...(previewStyle !== undefined && { previewStyle }),
  };
}

describe('TentativeRenderer', () => {
  it('draws a proposed line in gray dashes, the pointer line still dashed', () => {
    const { tentative, lines, points } = renderer();
    tentative.drawGeometry(
      lineBeingDrawn({ strokeColor: '#808080', strokeWidth: 3, lineStyle: 'dashed' }),
      PROJECTION_DATA,
      10,
    );
    tentative.drawVertices(lineBeingDrawn({ strokeColor: '#808080', pointColor: '#808080' }));
    const gray: Color = [128 / 255, 128 / 255, 128 / 255, 1];
    expect(lines).toHaveLength(2);
    // The line through the vertices placed takes every stroke key, its dashes too
    expect(lines[0].coords).toEqual([
      [0, 0],
      [1, 0],
    ]);
    expect(lines[0].style).toMatchObject({ color: gray, width: 3, lineStyle: 'dashed' });
    // The line to the pointer takes the color and the width, and keeps its dashes
    expect(lines[1].coords).toEqual([
      [1, 0],
      [2, 1],
    ]);
    expect(lines[1].style).toMatchObject({
      color: gray,
      width: 3,
      lineStyle: 'dashed',
      dashArray: [8, 6],
    });
    expect(points.map((p) => p.style.fillColor)).toEqual([gray, gray, gray]);
  });

  it('tells two candidates of an area apart by their colors, and leaves the others as configured', () => {
    const { tentative, lines } = renderer();
    const blue = { strokeColor: '#0000ff', fillColor: '#0000ff', fillOpacity: 0.2 };
    const green = { strokeColor: '#00ff00', fillColor: '#00ff00', fillOpacity: 0.3 };
    for (const shape of [areaBeingDrawn(blue), areaBeingDrawn(green), areaBeingDrawn()]) {
      tentative.drawGeometry(shape, PROJECTION_DATA, 10);
    }
    expect(fills.map((f) => f.color)).toEqual([
      [0, 0, 1, 0.2],
      [0, 1, 0, 0.3],
      DEFAULT_FEATURE_STYLE_CONFIG.tentative.fill.color,
    ]);
    // Each area: the edges placed solid, the edge to the pointer and the closing edge dashed
    const ofArea = (i: number) => lines.slice(i * 3, i * 3 + 3);
    for (const [i, color] of [
      [0, [0, 0, 1, 1]],
      [1, [0, 1, 0, 1]],
      [2, DEFAULT_FEATURE_STYLE_CONFIG.tentative.stroke.color],
    ] as const) {
      const [placed, toPointer, closing] = ofArea(i);
      expect(placed.coords).toEqual([
        [0, 0],
        [1, 0],
        [1, 1],
      ]);
      expect(placed.style).toMatchObject({ color, lineStyle: 'solid' });
      expect(toPointer.coords).toEqual([
        [1, 1],
        [0, 1],
      ]);
      expect(closing.coords).toEqual([
        [0, 1],
        [0, 0],
      ]);
      for (const dashed of [toPointer, closing]) {
        expect(dashed.style).toMatchObject({ color, lineStyle: 'dashed', dashArray: [8, 6] });
      }
    }
  });

  it('draws the outline of a circle and a freehand line solid, in the look of the sketch', () => {
    const { tentative, lines } = renderer();
    const look = { strokeColor: '#ff0000', fillColor: '#ff0000', fillOpacity: 0.2 };
    tentative.drawGeometry(
      {
        type: 'Circle',
        coordinates: [0, 0],
        layerId: 'zones',
        radiusMeters: 1000,
        previewStyle: look,
      },
      PROJECTION_DATA,
      10,
    );
    tentative.drawGeometry(
      {
        type: 'Freehand',
        coordinates: [
          [0, 0],
          [1, 1],
          [2, 0],
        ],
        layerId: 'zones',
        previewStyle: look,
      },
      PROJECTION_DATA,
      10,
    );
    expect(fills.map((f) => f.color)).toEqual([[1, 0, 0, 0.2]]);
    const [outline, , freehand] = lines;
    expect(outline.closed).toBe(true);
    expect(outline.style).toMatchObject({ color: [1, 0, 0, 1], lineStyle: 'solid' });
    expect(freehand.style).toMatchObject({ color: [1, 0, 0, 1], lineStyle: 'solid' });
  });

  it('puts the look of the sketch over the configuration, and reads it once', () => {
    const style = structuredClone(DEFAULT_FEATURE_STYLE_CONFIG.tentative);
    style.stroke.width = 5;
    const { tentative, lines } = renderer(style);
    const look = { strokeColor: '#0000ff' };
    tentative.drawGeometry(lineBeingDrawn(look), PROJECTION_DATA, 10);
    tentative.drawGeometry(lineBeingDrawn(look), PROJECTION_DATA, 10);
    // The width of the configuration stays where the look of the sketch gives none
    expect(lines[0].style).toMatchObject({ color: [0, 0, 1, 1], width: 5 });
    // The same look is the same style, not worked out again
    expect(lines[2].style).toBe(lines[0].style);
    // The configuration is not changed by the look of a sketch
    expect(style.stroke.color).toEqual(DEFAULT_FEATURE_STYLE_CONFIG.tentative.stroke.color);
  });
});
