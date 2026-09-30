// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for draw.options: the checks, the translation of the options into the configuration
 * of the engine, and the application of each option while the instance runs
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toColor } from '../../shared/color.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import { createDraw } from '../draw.js';
import { DrawError } from '../errors.js';
import type { DrawOptions } from '../options.js';
import type { Engine } from './engine.js';
import { createEngine } from './engine.js';
import type { OptionsState } from './options.js';
import { createOptions, mergeOptions, toEngineOptions } from './options.js';

let engine: Engine;
let options: OptionsState;
let external: ((id: string) => boolean) | undefined;

/** An engine and its draw.options, as createDraw builds them */
function setup(initial: DrawOptions = {}): void {
  external = initial.isExternalEntry;
  engine = createEngine(
    createMapStub().map,
    toEngineOptions(initial, (id) => external?.(id) === true),
  );
  options = createOptions(engine, initial, (fn) => {
    external = fn;
  });
  options.applyCreation();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  engine?.destroy();
  vi.useRealTimers();
});

function expectInvalid(fn: () => void): void {
  try {
    fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(DrawError);
    expect((error as DrawError).code).toBe('invalid-input');
  }
}

describe('mergeOptions', () => {
  it('merges plain objects key by key and replaces every other value', () => {
    const formatter = () => 'x';
    expect(
      mergeOptions<Record<string, unknown>>(
        { a: { b: 1, c: 2 }, d: [1], e: { f: 1 }, g: 1 },
        { a: { b: 3 }, d: [2], e: false as never, g: undefined },
      ),
    ).toEqual({ a: { b: 3, c: 2 }, d: [2], e: false, g: 1 });
    expect(mergeOptions({ autoName: false }, { autoName: { formatter } } as never)).toEqual({
      autoName: { formatter },
    });
  });
});

describe('the options at creation', () => {
  it('translates the options into the configuration of the engine', () => {
    setup({
      style: { polygon: { fillColor: 'rgb(0, 0, 255)', fillOpacity: 0.5 } },
      selectionStyle: {
        boxSelection: { fillColor: 'red', fillOpacity: 0.1, strokeColor: 'red', strokeWidth: 3 },
      },
      snapping: { tolerancePx: 20 },
      tracing: { enabled: false },
      topology: { sharedVertexDrag: true },
      clickTolerance: 9,
      dragThreshold: 7,
      rendering: { renderScale: 0.5, pixelRatio: 2, cacheGeometry: false, timeSlicing: false },
    });
    const { context } = engine;
    expect(context.featureStyle.polygon.fill.color).toEqual([0, 0, 1, 0.5]);
    expect(context.renderingConfig.boxSelectionStyle.fillColor).toEqual([1, 0, 0, 0.1]);
    expect(context.renderingConfig.boxSelectionStyle.strokeWidth).toBe(3);
    expect(context.snapService.getOptions().tolerancePx).toBe(20);
    expect(context.trace.enabled).toBe(false);
    expect(context.topology.sharedVertexDrag).toBe(true);
    expect(context.options.clickTolerance).toBe(9);
    expect(context.options.dragThreshold).toBe(7);
    expect(context.pixelRatioSource.getScaleFactor()).toBe(0.5);
    expect(context.pixelRatioSource.resolve()).toBe(1);
    expect(context.renderingConfig.storeRetained).toBe(false);
    expect(context.renderingConfig.timeSlicing).toBe(false);
  });

  it('gives the engine copies of the defaults, never the defaults themselves', () => {
    setup();
    const first = engine;
    setup({ style: { line: { strokeColor: 'lime' } } });
    expect(engine.context.featureStyle).not.toBe(first.context.featureStyle);
    expect(first.context.featureStyle.lineString.stroke.color).toEqual([1, 0, 0.467, 1]);
    first.destroy();
  });

  it('createDraw throws invalid-input for an unknown option and for a wrong value', () => {
    const map = createMapStub().map;
    for (const bad of [
      { what: 1 },
      { defaultMode: 3 },
      { initDefaultLayer: 'no' },
      { store: {} },
      { selectionStyle: { boundingBox: { stroke: { color: 'nope' } } } },
      { previewStyle: { strokeWidth: -1 } },
      { previewStyle: { pointStrokeWidth: -1 } },
      { style: { point: { pointStrokeColor: 'nope' } } },
      { rendering: { renderScale: 0 } },
      { autoName: true },
      { messages: { snapNorth: 3 } },
    ]) {
      expectInvalid(() => createDraw(map, bad as never));
    }
  });
});

describe('options.update', () => {
  beforeEach(() => setup());

  it('changes the look of the features in place and draws again', () => {
    const { featureStyle } = engine.context;
    const polygon = featureStyle.polygon;
    const refresh = vi.spyOn(engine.customLayer, 'refresh');
    options.update({
      style: {
        point: {
          pointColor: '#00ff00',
          pointRadius: 5,
          pointShape: 'star',
          pointStrokeColor: '#000080',
          pointStrokeWidth: 3,
          strokeColor: '#ff0000',
          strokeWidth: 9,
        },
        line: { strokeColor: 'hsl(240, 100%, 50%)', strokeWidth: 4, lineStyle: 'dashed' },
        polygon: { fillColor: 'blue' },
        circle: { fillColor: 'yellow', fillOpacity: 1 },
        image: { imageOpacity: 0.4 },
      },
    });
    expect(featureStyle.polygon).toBe(polygon);
    expect(featureStyle.point.point).toMatchObject({
      fillColor: [0, 1, 0, 1],
      size: 10,
      shape: 'star',
      // The outline of the marker comes from the point keys, not the stroke keys
      strokeColor: toColor('#000080'),
      strokeWidth: 3,
    });
    expect(featureStyle.lineString.stroke).toMatchObject({
      color: [0, 0, 1, 1],
      width: 4,
      lineStyle: 'dashed',
    });
    // A color without an opacity keeps the alpha of the default fill
    expect(featureStyle.polygon.fill.color).toEqual([0, 0, 1, 0.25]);
    expect(featureStyle.circle?.fill.color).toEqual([1, 1, 0, 1]);
    expect(featureStyle.image).toEqual({ opacity: 0.4 });
    expect(refresh).toHaveBeenCalled();

    // A later patch merges into the style given before
    options.update({ style: { polygon: { fillOpacity: 0.5 } } });
    expect(featureStyle.polygon.fill.color).toEqual([0, 0, 1, 0.5]);
    expect(options.get().style?.polygon).toEqual({ fillColor: 'blue', fillOpacity: 0.5 });
  });

  it('changes the look of the geometry being drawn', () => {
    options.update({
      previewStyle: {
        strokeColor: '#000',
        strokeWidth: 5,
        pointRadius: 3,
        pointStrokeColor: '#f00',
        pointStrokeWidth: 1,
      },
    });
    const { tentative } = engine.context.featureStyle;
    expect(tentative.stroke.color).toEqual([0, 0, 0, 1]);
    expect(tentative.stroke.width).toBe(5);
    expect(tentative.tentativeStroke.lineStyle).toBe('dashed');
    expect(tentative.vertex.size).toBe(6);
    // The outline of the vertices is the outline of a point marker
    expect(tentative.vertex.strokeColor).toEqual([1, 0, 0, 1]);
    expect(tentative.vertex.strokeWidth).toBe(1);
    expect(tentative.circleCenterMarker.strokeColor).toEqual([1, 0, 0, 1]);
  });

  it('changes the look of the selection and of the box selection', () => {
    const { selectionStyle, renderingConfig } = engine.context;
    options.update({
      selectionStyle: {
        boundingBox: {
          stroke: { width: 3, color: 'black', opacity: 1, lineStyle: 'dotted' },
          margin: 4,
        },
        vertexHandle: {
          point: {
            shape: 'square',
            size: 9,
            fillColor: 'white',
            fillOpacity: 1,
            strokeColor: 'rgba(0, 0, 0, 0.5)',
            strokeWidth: 1,
            strokeOpacity: 1,
          },
        } as never,
        boxSelection: { fillColor: 'gray', fillOpacity: 0.3, strokeColor: 'navy', strokeWidth: 1 },
      },
    });
    expect(selectionStyle.boundingBox.stroke).toMatchObject({ width: 3, color: [0, 0, 0, 1] });
    expect(selectionStyle.boundingBox.margin).toBe(4);
    expect(selectionStyle.vertexHandle.point.strokeColor).toEqual([0, 0, 0, 0.5]);
    expect(selectionStyle.vertexHandle.point.shape).toBe('square');
    expect(renderingConfig.boxSelectionStyle.fillColor).toEqual(toColor('gray', 0.3));
    expect(renderingConfig.boxSelectionStyle.strokeColor).toEqual(toColor('navy'));
  });

  it('changes the snapping', () => {
    options.update({
      snapping: {
        enabled: false,
        tolerancePx: 25,
        disableKey: 'shift',
        kinds: { guide: false },
        datasets: false,
        guideStepDegrees: 15,
      },
    });
    const snap = engine.context.snapService.getOptions();
    expect(snap).toMatchObject({
      enabled: false,
      tolerancePx: 25,
      disableKey: 'shift',
      datasets: false,
      guideStepDegrees: 15,
    });
    expect(snap.kinds).toEqual({ vertex: true, edge: true, intersection: true, guide: false });
    // The shared vertices read the same key
    expect(engine.context.snapOptions.disableKey).toBe('shift');
    expect(options.get().snapping?.tolerancePx).toBe(25);
  });

  it('changes the look of the snapping indicator and the guide line, at creation too', () => {
    engine.destroy();
    setup({ snapping: { indicator: { edge: { size: 30 } } } });
    const look = engine.context.snapIndicator;
    expect(look.styles.edge.size).toBe(30);
    expect(look.styles.edge.shape).toBe('square');

    options.update({
      snapping: {
        indicator: { vertex: { strokeColor: 'red', shape: 'star' } },
        guideLine: { width: 3, lineStyle: 'solid' },
      },
    });
    expect(look.styles.vertex).toMatchObject({ strokeColor: toColor('red'), shape: 'star' });
    expect(look.styles.vertex.size).toBe(14);
    expect(look.styles.edge.size).toBe(30);
    expect(look.guideLine).toMatchObject({ width: 3, lineStyle: 'solid', opacity: 1 });
    expect(options.get().snapping?.guideLine).toEqual({ width: 3, lineStyle: 'solid' });

    expectInvalid(() => options.update({ snapping: { indicator: { vertex: { size: -1 } } } }));
    expectInvalid(() =>
      options.update({ snapping: { guideLine: { color: 'nope' } } } as DrawOptions),
    );
  });

  it('changes the tracing, the shared vertices and the scale with the zoom', () => {
    options.update({ tracing: { enabled: false }, topology: { sharedVertexDrag: true } });
    options.update({ scaleWithZoom: false });
    expect(engine.context.trace.enabled).toBe(false);
    expect(engine.context.topology.sharedVertexDrag).toBe(true);
    expect(engine.context.options.scaleWithZoom).toBe(false);
    expect(options.get()).toMatchObject({
      tracing: { enabled: false },
      topology: { sharedVertexDrag: true },
      scaleWithZoom: false,
    });
  });

  it('changes the click tolerance and the drag threshold', () => {
    const tolerance = vi.spyOn(engine.context.hitTestService, 'setClickTolerance');
    const threshold = vi.spyOn(engine.runtime, 'setDragThreshold');
    options.update({ clickTolerance: 12, dragThreshold: 8 });
    expect(tolerance).toHaveBeenCalledWith(12);
    expect(threshold).toHaveBeenCalledWith(8);
    expect(engine.context.options.clickTolerance).toBe(12);
    expect(options.get()).toMatchObject({ clickTolerance: 12, dragThreshold: 8 });
  });

  it('changes the switches of the drawing', () => {
    const { context } = engine;
    const refresh = vi.spyOn(engine.customLayer, 'refresh');
    options.update({ rendering: { renderScale: 2, pixelRatio: 1.5 } });
    expect(context.pixelRatioSource.getScaleFactor()).toBe(2);
    expect(context.pixelRatioSource.resolve()).toBe(3);
    expect(refresh).not.toHaveBeenCalled();
    expect(engine.map.triggerRepaint).toHaveBeenCalled();

    options.update({ rendering: { cacheGeometry: false, timeSlicing: false } });
    expect(context.renderingConfig.storeRetained).toBe(false);
    expect(context.renderingConfig.timeSlicing).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(options.get().rendering).toEqual({
      renderScale: 2,
      pixelRatio: 1.5,
      cacheGeometry: false,
      timeSlicing: false,
    });
  });

  it('changes the entries from outside the document', () => {
    expect(engine.context.isExternalEntry?.('base')).toBe(false);
    options.update({ isExternalEntry: (id) => id === 'base' });
    expect(engine.context.isExternalEntry?.('base')).toBe(true);
  });

  it('changes the messages in place', () => {
    const { messages } = engine.context;
    options.update({ messages: { snapNorth: 'Nord' } });
    expect(engine.context.messages).toBe(messages);
    expect(messages.snapNorth).toBe('Nord');
    expect(messages.snapExtension).toBe('Extension');
  });

  it('changes the automatic names', () => {
    const names = engine.context.autoNameGenerator;
    options.update({ autoName: { typeNames: { Point: 'Pin' }, formatter: (t, n) => `${t}#${n}` } });
    expect(names.generateName('Point')).toBe('Pin#1');
    options.update({ autoName: false });
    expect(names.generateName('Point')).toBeUndefined();
  });

  it('throws invalid-input and changes nothing for a wrong patch', () => {
    const before = options.get();
    for (const bad of [
      null,
      { defaultMode: 'select' },
      { store: {} },
      { snapping: { tolerancePx: -1 } },
      { snapping: { kinds: { corner: true } } },
      { style: { polygon: { fillColor: 'nope' } } },
      { style: { hexagon: {} } },
      { rendering: { pixelRatio: 'high' } },
      { tracing: { enabled: false }, clickTolerance: Number.NaN },
    ]) {
      expectInvalid(() => options.update(bad as never));
    }
    expect(options.get()).toEqual(before);
  });

  it('gives a copy: changing what get returns changes nothing', () => {
    const values = options.get() as { snapping: { tolerancePx: number } };
    values.snapping.tolerancePx = 99;
    expect(options.get().snapping?.tolerancePx).toBe(10);
  });
});

describe('draw.options of createDraw', () => {
  let draw: Draw;

  afterEach(() => draw.destroy());

  it('reads and changes the options', () => {
    draw = createDraw(createMapStub().map, { snapping: { enabled: false } });
    expect(draw.options.get().snapping?.enabled).toBe(false);
    draw.options.update({ snapping: { enabled: true } });
    expect(draw.options.get().snapping?.enabled).toBe(true);
  });
});
