// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the snapping indicator
 *
 * They verify how the existing drawing primitives (PointShapeRenderer /
 * SDFLineRenderer) are called depending on whether there is a snapping result and on
 * its kind.
 */

import type { ProjectionData } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import type { FrameDrawContext } from '../extension/index.js';
import type { SDFStrokeOptions, SDFStrokeStyle } from '../view/renderers/line/sdf-line.js';
import type { PointStyle } from '../view/renderers/point/point-shape.js';
import { SnapIndicatorRenderer } from './indicator.js';
import type { SnapResult, SnapService } from './types.js';
import { resolveSnapKinds } from './types.js';

/** A stand-in for SnapService that has only getResult */
function fakeService(result: SnapResult | null): SnapService {
  return {
    resolve: () => ({ lngLat: { lng: 0, lat: 0 } }),
    register: () => () => {},
    setEnabled: () => {},
    setTolerance: () => {},
    setDisableKey: () => {},
    isEnabled: () => true,
    setKindEnabled: () => {},
    isKindEnabled: () => true,
    setDatasetsEnabled: () => {},
    isDatasetsEnabled: () => true,
    setGuideStep: () => {},
    getResult: () => result,
    getOptions: () => ({
      enabled: true,
      tolerancePx: 10,
      disableKey: 'alt',
      kinds: resolveSnapKinds(),
      datasets: true,
      guideStepDegrees: 45,
    }),
  };
}

interface DrawCall {
  coord: [number, number];
  style: PointStyle;
  zoom: number;
}

interface LineCall {
  coords: Array<[number, number]>;
  style: SDFStrokeStyle;
  options: SDFStrokeOptions;
  zoom: number;
}

function fakeContext(calls: DrawCall[], lineCalls: LineCall[] = []): FrameDrawContext {
  return {
    pointShapeRenderer: {
      draw: (coord: [number, number], style: PointStyle, zoom: number) => {
        calls.push({ coord, style, zoom });
      },
    },
    sdfLineRenderer: {
      draw: (
        coords: Array<[number, number]>,
        style: SDFStrokeStyle,
        options: SDFStrokeOptions,
        zoom: number,
      ) => {
        lineCalls.push({ coords, style, options, zoom });
      },
    },
  } as unknown as FrameDrawContext;
}

const PROJECTION = {} as ProjectionData;

describe('SnapIndicatorRenderer', () => {
  it('is an overlay drawn in front of the selection UI', () => {
    const renderer = new SnapIndicatorRenderer({ snapService: fakeService(null) });
    expect(renderer.order).toBe('overlay');
  });

  it('draws nothing when nothing is snapped to', () => {
    const calls: DrawCall[] = [];
    const renderer = new SnapIndicatorRenderer({ snapService: fakeService(null) });
    renderer.draw(PROJECTION, 14, fakeContext(calls));

    const noTarget = new SnapIndicatorRenderer({
      snapService: fakeService({ lngLat: { lng: 1, lat: 2 } }),
    });
    noTarget.draw(PROJECTION, 14, fakeContext(calls));

    expect(calls).toHaveLength(0);
  });

  it('draws a circle for a vertex and a square for an edge, at the snapped position', () => {
    const calls: DrawCall[] = [];

    new SnapIndicatorRenderer({
      snapService: fakeService({ lngLat: { lng: 1, lat: 2 }, target: { kind: 'vertex' } }),
    }).draw(PROJECTION, 14, fakeContext(calls));

    new SnapIndicatorRenderer({
      snapService: fakeService({ lngLat: { lng: 3, lat: 4 }, target: { kind: 'edge' } }),
    }).draw(PROJECTION, 15, fakeContext(calls));

    expect(calls).toHaveLength(2);
    expect(calls[0].coord).toEqual([1, 2]);
    expect(calls[0].style.shape).toBe('circle');
    expect(calls[0].zoom).toBe(14);
    expect(calls[1].coord).toEqual([3, 4]);
    expect(calls[1].style.shape).toBe('square');
    expect(calls[1].zoom).toBe(15);
  });

  it('draws an intersection with a symbol that can be told apart from a vertex (a small filled circle)', () => {
    const calls: DrawCall[] = [];

    new SnapIndicatorRenderer({
      snapService: fakeService({ lngLat: { lng: 5, lat: 6 }, target: { kind: 'intersection' } }),
    }).draw(PROJECTION, 14, fakeContext(calls));

    expect(calls).toHaveLength(1);
    expect(calls[0].coord).toEqual([5, 6]);
    // A vertex is a circle with an outline only (14px). An intersection is a small
    // filled circle
    expect(calls[0].style.fillOpacity).toBe(1);
    expect(calls[0].style.size).toBeLessThan(14);
  });

  it('draws the guide line dashed in addition to the symbol for a guide', () => {
    const calls: DrawCall[] = [];
    const lineCalls: LineCall[] = [];

    new SnapIndicatorRenderer({
      snapService: fakeService({
        lngLat: { lng: 0.5, lat: 0 },
        target: {
          kind: 'guide',
          segment: { start: [0, 0], end: [1, 0] },
        },
      }),
    }).draw(PROJECTION, 12, fakeContext(calls, lineCalls));

    expect(lineCalls).toHaveLength(1);
    expect(lineCalls[0].coords).toEqual([
      [0, 0],
      [1, 0],
    ]);
    expect(lineCalls[0].style.lineStyle).toBe('dashed');
    // A step that can be told apart from the [8, 6] dashes of Tentative
    expect(lineCalls[0].style.dashArray).toEqual([4, 4]);
    expect(lineCalls[0].options.closed).toBe(false);
    expect(lineCalls[0].zoom).toBe(12);

    // The symbol of the snapped point is drawn as well
    expect(calls).toHaveLength(1);
    expect(calls[0].coord).toEqual([0.5, 0]);
  });

  it('draws no guide line for anything other than a guide', () => {
    const calls: DrawCall[] = [];
    const lineCalls: LineCall[] = [];

    new SnapIndicatorRenderer({
      snapService: fakeService({
        lngLat: { lng: 0.5, lat: 0 },
        target: { kind: 'edge', segment: { start: [0, 0], end: [1, 0] } },
      }),
    }).draw(PROJECTION, 12, fakeContext(calls, lineCalls));

    expect(lineCalls).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });

  it('allows the style of the guide line to be replaced', () => {
    const lineCalls: LineCall[] = [];
    const custom: SDFStrokeStyle = {
      width: 3,
      color: [1, 0, 0, 1],
      opacity: 0.5,
      lineStyle: 'dotted',
      dashArray: [2, 2],
    };

    new SnapIndicatorRenderer({
      snapService: fakeService({
        lngLat: { lng: 0, lat: 0 },
        target: { kind: 'guide', segment: { start: [0, 0], end: [1, 0] } },
      }),
      guideLineStyle: custom,
    }).draw(PROJECTION, 12, fakeContext([], lineCalls));

    expect(lineCalls[0].style).toEqual(custom);
  });

  it('allows the styles to be replaced per kind', () => {
    const calls: DrawCall[] = [];
    const custom: PointStyle = {
      shape: 'triangle',
      size: 20,
      fillColor: [1, 0, 0, 1],
      fillOpacity: 1,
      strokeColor: [1, 0, 0, 1],
      strokeWidth: 1,
      strokeOpacity: 1,
    };

    new SnapIndicatorRenderer({
      snapService: fakeService({ lngLat: { lng: 1, lat: 2 }, target: { kind: 'vertex' } }),
      styles: { vertex: custom },
    }).draw(PROJECTION, 14, fakeContext(calls));

    expect(calls[0].style).toEqual(custom);
  });
});
