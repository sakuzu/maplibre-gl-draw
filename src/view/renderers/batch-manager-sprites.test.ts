// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The points drawn at once with the pictures of a sheet (the Store, the rows drawn at once)
 *
 * A point a sheet gives a picture is drawn with it in the place of its marker, in its order among
 * the markers: a batch of pictures holds the points of one sheet, and ends where a marker or a
 * point of another sheet comes. A picture that turns is given the rotation of its point; one that
 * stays upright is not. The Store draws such a point at once (its run is `immediate`), where the
 * BatchManager draws its picture.
 */

import type { Map as MapLibreMap, ProjectionData } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FEATURE_STYLE_CONFIG } from '../../shared/config/feature-style.js';
import { drawPropertyKey } from '../../shared/properties.js';
import type { Feature } from '../../store/types.js';
import { createFeatureCompanionRegistry } from '../feature-companion.js';
import { GpuLedger } from '../gpu-ledger.js';
import { classifyFeature } from '../layer/store-retained-classify.js';
import { createBatchManager } from './batch-manager.js';
import { FeatureDrawer } from './drawer.js';
import type { ImageRenderer } from './image.js';
import type { SDFLineRenderer } from './line/sdf-line.js';
import {
  buildPointSpriteInstanceData,
  type PointInstanceRenderer,
  type PointSpriteInstance,
} from './point/point-instance.js';
import { pointAngleSteps } from './point/point-sdf.js';
import type { PointShapeRenderer } from './point/point-shape.js';
import {
  type PointSprite,
  type PointSpriteSheetSource,
  PointSpriteSheets,
} from './point/point-sprites.js';
import type { PolygonBatchRenderer } from './polygon/batch.js';
import type { SDFPolygonRenderer } from './polygon/sdf-polygon.js';
import type { RowSpritePictures } from './rows/rows-format.js';

const ROTATION = drawPropertyKey('rotation');

function stubGL(): WebGL2RenderingContext {
  return {
    createBuffer: (): object => ({}),
    createVertexArray: (): object => ({}),
    bindBuffer: (): void => {},
    bindVertexArray: (): void => {},
    enableVertexAttribArray: (): void => {},
    vertexAttribPointer: (): void => {},
    canvas: { width: 800, height: 600 },
    drawingBufferWidth: 800,
    drawingBufferHeight: 600,
  } as unknown as WebGL2RenderingContext;
}

function drawer(): FeatureDrawer {
  return new FeatureDrawer({
    ledger: new GpuLedger(),
    gl: stubGL(),
    map: {} as MapLibreMap,
    sdfLineRenderer: {} as SDFLineRenderer,
    pointShapeRenderer: {} as PointShapeRenderer,
    imageRenderer: {} as ImageRenderer,
    featureStyle: DEFAULT_FEATURE_STYLE_CONFIG,
  });
}

function sheetOf(pictures: ReadonlyMap<string, PointSprite>): PointSpriteSheetSource {
  return {
    texture: null,
    active: true,
    spriteOfRow: () => null,
    spriteOfFeature: (f) => pictures.get(f.id) ?? null,
    onAdd: () => {},
    onRemove: () => {},
    beginFrame: () => {},
  };
}

function point(id: string, coord: [number, number], rotation?: number): Feature {
  return {
    id,
    type: 'Point',
    geometry: { type: 'Point', coordinates: coord },
    layerId: 'layer',
    groupId: undefined,
    properties: rotation === undefined ? {} : { [ROTATION]: rotation },
    style: {},
    locked: false,
    visible: true,
  } as Feature;
}

type Draw =
  | { kind: 'markers'; ids: number }
  | { kind: 'pictures'; sheet: RowSpritePictures; points: PointSpriteInstance[] };

function setup(sheets: PointSpriteSheets) {
  const draws: Draw[] = [];
  const renderer = {
    drawAll: (points: unknown[]) => draws.push({ kind: 'markers', ids: points.length }),
    drawSprites: (points: PointSpriteInstance[], sheet: RowSpritePictures) =>
      draws.push({ kind: 'pictures', sheet, points: points.map((p) => ({ ...p })) }),
  } as unknown as PointInstanceRenderer;
  const manager = createBatchManager({
    gl: stubGL(),
    featureDrawer: drawer(),
    pointInstanceRenderer: renderer,
    sdfLineRenderer: {} as SDFLineRenderer,
    polygonBatchRenderer: {} as PolygonBatchRenderer,
    sdfPolygonRenderer: {} as SDFPolygonRenderer,
    pointSprites: sheets,
  });
  manager.beginFrame({} as ProjectionData, 14);
  return { manager, draws };
}

const FLAG: PointSprite = { uv: [0, 0, 0.5, 0.5], halfWidth: 12, halfHeight: 8, rotates: false };
const ARROW: PointSprite = { uv: [0.5, 0, 1, 0.5], halfWidth: 10, halfHeight: 10, rotates: true };

describe('the points drawn at once with pictures', () => {
  it('draws them in their order among the markers, a batch per sheet', () => {
    const sheets = new PointSpriteSheets();
    const a = sheetOf(
      new Map([
        ['a1', FLAG],
        ['a2', ARROW],
      ]),
    );
    const b = sheetOf(new Map([['b1', FLAG]]));
    sheets.add(a);
    sheets.add(b);
    const { manager, draws } = setup(sheets);
    for (const f of [
      point('m1', [139.7, 35.6]),
      point('a1', [139.71, 35.6]),
      point('a2', [139.72, 35.6], 30),
      point('b1', [139.73, 35.6]),
      point('m2', [139.74, 35.6]),
    ]) {
      manager.processFeature(f, false);
    }
    manager.endFrame();
    expect(draws.map((d) => (d.kind === 'markers' ? `m${d.ids}` : `p${d.points.length}`))).toEqual([
      'm1',
      'p2',
      'p1',
      'm1',
    ]);
    const [, first, second] = draws as Extract<Draw, { kind: 'pictures' }>[];
    expect(first.sheet).toBe(a);
    expect(second.sheet).toBe(b);
    // The picture that stays upright is not given the rotation, the one that turns is
    expect(first.points[0]).toMatchObject({ uv: FLAG.uv, halfWidth: 12, halfHeight: 8 });
    expect(first.points[0].rotation).toBeUndefined();
    expect(first.points[1].rotation).toBe(30);
  });

  it('keeps the markers without a sheet', () => {
    const { manager, draws } = setup(new PointSpriteSheets());
    manager.processFeature(point('a1', [139.7, 35.6]), false);
    manager.endFrame();
    expect(draws).toEqual([{ kind: 'markers', ids: 1 }]);
  });

  it('draws a point of the Store with a picture at once', () => {
    const sheets = new PointSpriteSheets();
    sheets.add(sheetOf(new Map([['a1', FLAG]])));
    const styles = drawer();
    const companions = createFeatureCompanionRegistry();
    const given = classifyFeature(
      point('a1', [0, 0]),
      styles,
      new Map(),
      companions,
      undefined,
      sheets,
    );
    const without = classifyFeature(
      point('m1', [0, 0]),
      styles,
      new Map(),
      companions,
      undefined,
      sheets,
    );
    expect(given).toBe('immediate');
    expect(without).toBe('point');
  });
});

describe('the instances of the pictures drawn at once', () => {
  it('hold the rectangle, the ghost, the half size in device pixels and the steps of rotation', () => {
    const data = buildPointSpriteInstanceData(
      [
        { coord: [1, 2], uv: [0.25, 0, 0.5, 0.5], halfWidth: 12, halfHeight: 8, ghost: 0.5 },
        { coord: [1, 2], uv: [0, 0, 1, 1], halfWidth: 4, halfHeight: 4, rotation: 90 },
      ],
      [1, 2],
      2,
    );
    expect(Array.from(data.subarray(0, 14))).toEqual([
      0, 0, 0.25, 0, 0.5, 0.5, 0.5, 0, 0, 0, 24, 16, 0, 0,
    ]);
    expect(data[14 + 6]).toBe(1);
    expect(data[14 + 13]).toBe(pointAngleSteps(90));
  });
});
