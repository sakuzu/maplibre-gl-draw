// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the members about the drawing: getLayerStack, hasPendingWork and debug.terrain
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import { createDraw } from '../draw.js';
import { DrawError } from '../errors.js';

let draw: Draw;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  draw.destroy();
  vi.useRealTimers();
});

describe('getLayerStack', () => {
  it('gives one frozen entry per run of layers', () => {
    draw = createDraw(createMapStub().map);
    const stack = draw.getLayerStack();
    expect(stack).toHaveLength(1);
    expect(stack[0]).toMatchObject({ from: 0, to: 1 });
    expect(typeof stack[0].layerId).toBe('string');
    expect(Object.isFrozen(stack)).toBe(true);
    expect(Object.isFrozen(stack[0])).toBe(true);
  });

  it('asks the function of the entries from outside the document', () => {
    draw = createDraw(createMapStub().map, { isExternalEntry: (id) => id.startsWith('base:') });
    expect(draw.getLayerStack()).toHaveLength(1);
  });
});

describe('hasPendingWork and debug.terrain', () => {
  it('has no pending work and reports the terrain as inactive before anything is drawn', () => {
    draw = createDraw(createMapStub().map);
    expect(draw.hasPendingWork()).toBe(false);
    const terrain = draw.debug.terrain();
    expect(terrain.render.active).toBe(false);
    expect(terrain.render.atlasRect).toHaveLength(4);
    expect(terrain.render.atlasSize).toHaveLength(2);
    expect(terrain.drape).toMatchObject({ used: false, reason: 'not-evaluated', featureCount: 0 });
    expect(Object.isFrozen(terrain)).toBe(true);
  });
});

describe('drawing', () => {
  it('draws a line from two vertices and finishes it', () => {
    draw = createDraw(createMapStub().map);
    expect(draw.drawing.isActive()).toBe(false);
    expect(draw.drawing.addVertex([0, 0])).toBe(false);
    expect(draw.drawing.finish()).toBe(false);

    draw.setMode('draw_line');
    expect(draw.drawing.isActive()).toBe(true);
    expect(draw.drawing.isDrawing()).toBe(false);
    expect(draw.drawing.addVertex([0, 0])).toBe(true);
    expect(draw.drawing.isDrawing()).toBe(true);
    // One vertex is too few to finish
    expect(draw.drawing.finish()).toBe(false);
    expect(draw.drawing.addVertex([1, 0.5])).toBe(true);
    expect(draw.drawing.finish()).toBe(true);

    const [line] = draw.features.list({ type: 'LineString' });
    expect(line.geometry).toEqual({
      type: 'LineString',
      coordinates: [
        [0, 0],
        [1, 0.5],
      ],
    });
    expect(draw.getMode()).toBe('select');
    expect(draw.drawing.isActive()).toBe(false);
  });

  it('draws an area, with the preview following moveTo and the vertices undone and redone', () => {
    draw = createDraw(createMapStub().map);
    draw.setMode('draw_polygon');
    const previews: unknown[] = [];
    draw.on('preview.changed', ({ feature }) => previews.push(feature?.geometry));
    draw.drawing.addVertex([0, 0]);
    draw.drawing.addVertex([1, 0]);
    draw.drawing.moveTo([1, 1]);
    expect(previews[previews.length - 1]).toMatchObject({ type: 'Polygon' });
    expect(JSON.stringify(previews[previews.length - 1])).toContain('[1,1]');
    draw.drawing.addVertex([1, 1]);
    expect(draw.drawing.undoVertex()).toBe(true);
    expect(draw.drawing.redoVertex()).toBe(true);
    expect(draw.drawing.finish()).toBe(true);

    const [area] = draw.features.list({ type: 'Polygon' });
    expect(area.geometry).toEqual({
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
  });

  it('places a point with one vertex, and cancels a shape in progress', () => {
    draw = createDraw(createMapStub().map);
    draw.setMode('draw_point');
    expect(draw.drawing.isActive()).toBe(true);
    expect(draw.drawing.addVertex([0.25, -0.5])).toBe(true);
    expect(draw.features.list({ type: 'Point' })[0].geometry).toEqual({
      type: 'Point',
      coordinates: [0.25, -0.5],
    });

    draw.setMode('draw_line');
    draw.drawing.addVertex([0, 0]);
    expect(draw.drawing.cancel()).toBe(true);
    expect(draw.drawing.isDrawing()).toBe(false);
    expect(draw.drawing.isActive()).toBe(true);
    expect(draw.drawing.cancel()).toBe(false);
  });

  it('goes through the input receivers of the plugins, which can consume it', () => {
    draw = createDraw(createMapStub().map);
    const clicks: unknown[] = [];
    let consume = false;
    let contextDrawing: unknown = null;
    draw.extensions.plugins.add({
      name: 'listener',
      onAdd(ctx) {
        contextDrawing = ctx.drawing;
      },
      input: {
        onClick(event) {
          clicks.push({ lngLat: event.lngLat, snapped: event.snapped, point: event.point });
          return consume;
        },
      },
    });
    expect(contextDrawing).toBe(draw.drawing);

    draw.setMode('draw_line');
    draw.drawing.addVertex([1, 1]);
    expect(clicks).toEqual([{ lngLat: [1, 1], snapped: { lngLat: [1, 1] }, point: [500, 200] }]);
    consume = true;
    expect(draw.drawing.addVertex([2, 2])).toBe(true);
    // The plugin consumed the click: the mode placed no second vertex
    draw.drawing.finish();
    expect(draw.features.list({ type: 'LineString' })).toHaveLength(0);
  });

  it('refuses a position that is not two finite numbers', () => {
    draw = createDraw(createMapStub().map);
    draw.setMode('draw_line');
    expect(() => draw.drawing.addVertex([Number.NaN, 0])).toThrow(DrawError);
    expect(() => draw.drawing.moveTo([0] as unknown as [number, number])).toThrow(DrawError);
  });
});
