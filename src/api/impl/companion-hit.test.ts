// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the order in which a click finds a feature, its companion, the handles and the
 * datasets, driven through the input router as the pointer drives it
 *
 * A companion is drawn one step below its feature and hit at the feature's step: at the same
 * point, what the feature draws (its marker, with the tolerance) wins over its own companion,
 * the stacking order decides between different features, the handles of the selection come
 * before everything, and a feature and its companion come before the rows of a dataset
 * below them. The map stub projects one degree to one hundred pixels.
 */

import type { LineString, Point } from 'geojson';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DragNormalizedEvent, MouseNormalizedEvent } from '../../dispatcher/types.js';
import { createMapStub, createSyntheticInput } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import type { DrawEvents } from '../events.js';
import type { Feature } from '../model.js';
import { createDrawOnEngine } from './create-draw.js';
import type { Engine } from './engine.js';
import { createEngine } from './engine.js';

let engine: Engine;
let draw: Draw;

beforeEach(() => {
  engine = createEngine(createMapStub().map, {}, { deferDefaultMode: true });
  draw = createDrawOnEngine(engine);
  engine.enterDefaultMode();
});

afterEach(() => {
  engine.destroy();
});

const MODIFIERS = { shift: false, ctrl: false, alt: false, meta: false };

/** The original event of a synthetic press, a release or a drag */
function original(type: string, point: { x: number; y: number }): MouseEvent {
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

/** The screen point of a position */
function screenOf(lngLat: [number, number]): { x: number; y: number } {
  const { x, y } = engine.map.project(lngLat);
  return { x, y };
}

/** A press, a release and the click of the pointer at a position, through the input router */
function pointerClick(lngLat: [number, number]): void {
  const point = screenOf(lngLat);
  const mouse = (type: MouseNormalizedEvent['type']): MouseNormalizedEvent => ({
    type,
    point,
    lngLat: { lng: lngLat[0], lat: lngLat[1] },
    originalEvent: original(type, point),
    modifiers: MODIFIERS,
    snap: false,
  });
  const input = createSyntheticInput(engine);
  input.move(lngLat, { snap: false });
  engine.inputRouter.dispatch(mouse('mousedown'));
  engine.inputRouter.dispatch(mouse('mouseup'));
  input.click(lngLat, { snap: false });
}

/** A press at a position that is dragged to another, through the input router */
function pointerDrag(from: [number, number], to: [number, number]): void {
  const start = screenOf(from);
  const drag = (type: DragNormalizedEvent['type'], at: [number, number]): DragNormalizedEvent => ({
    type,
    point: screenOf(at),
    lngLat: { lng: at[0], lat: at[1] },
    originalEvent: original(type, screenOf(at)),
    modifiers: MODIFIERS,
    dragStartPoint: start,
    dragStartLngLat: { lng: from[0], lat: from[1] },
    snap: false,
  });
  engine.inputRouter.dispatch({
    type: 'mousedown',
    point: start,
    lngLat: { lng: from[0], lat: from[1] },
    originalEvent: original('mousedown', start),
    modifiers: MODIFIERS,
    snap: false,
  });
  engine.inputRouter.dispatch(drag('dragstart', from));
  engine.inputRouter.dispatch(drag('dragmove', to));
  engine.inputRouter.dispatch(drag('dragend', to));
}

/** A point feature of the document */
function point(lngLat: [number, number], style: Feature['style'] = {}): Feature {
  const feature = draw.features.create({
    type: 'Point',
    geometry: { type: 'Point', coordinates: lngLat },
    style,
  });
  if (!feature) throw new Error('no feature');
  return feature;
}

/**
 * Adds a companion to the given features that is hit anywhere within `radiusPx` of the
 * position of its feature, as the padding of a leader line starting there is
 *
 * @returns The IDs of the features whose companion received a click
 */
function companionOf(ids: string[], radiusPx: number, consume = true): string[] {
  const clicked: string[] = [];
  draw.extensions.companionProviders.add({
    name: 'lead',
    has: (feature) => ids.includes(feature.id),
    draw() {},
    hitTest(feature, ctx) {
      const [x, y] = ctx.screen.project((feature.geometry as Point).coordinates);
      const distancePx = Math.hypot(ctx.point[0] - x, ctx.point[1] - y);
      return distancePx <= radiusPx
        ? { kind: 'companion', id: `lead-${feature.id}`, featureId: feature.id, distancePx }
        : null;
    },
    onClick(feature) {
      clicked.push(feature.id);
      return consume;
    },
  });
  return clicked;
}

describe('a feature and its own companion', () => {
  beforeEach(() => {
    draw.setMode('select');
  });

  it('selects the feature with a click anywhere on its marker, and never asks the companion', () => {
    const p = point([0, 0]);
    const clicked = companionOf([p.id], 100);
    // The center, the edge of the tolerance, and the outline of the marker (a radius of 6 px
    // and an outline of 2 px by default), beyond the tolerance of the position
    for (const at of [
      [0, 0],
      [0.06, 0],
      [0, -0.075],
      [0.055, 0.055],
    ] as Array<[number, number]>) {
      draw.selection.clear();
      pointerClick(at);
      expect(draw.selection.get().ids).toEqual([p.id]);
    }
    expect(clicked).toEqual([]);
  });

  it('gives a click on the companion away from the marker to its onClick, and keeps the selection', () => {
    const p = point([0, 0]);
    const other = point([3, 3]);
    const clicked = companionOf([p.id], 100);
    draw.selection.set('feature', [other.id]);
    pointerClick([0.5, 0]);
    expect(clicked).toEqual([p.id]);
    expect(draw.selection.get().ids).toEqual([other.id]);
  });

  it('selects the feature when onClick leaves the click to the select mode', () => {
    const p = point([0, 0]);
    const clicked = companionOf([p.id], 100, false);
    pointerClick([0.5, 0]);
    expect(clicked).toEqual([p.id]);
    expect(draw.selection.get().ids).toEqual([p.id]);
  });

  it('follows the size of the marker a feature names', () => {
    const p = point([0, 0], { pointRadius: 20 });
    const clicked = companionOf([p.id], 100);
    pointerClick([0.21, 0]);
    expect(draw.selection.get().ids).toEqual([p.id]);
    // Beyond the marker and its tolerance, the companion is what is under the pointer
    pointerClick([0.3, 0]);
    expect(clicked).toEqual([p.id]);
  });
});

describe('a Point type that takes only some points', () => {
  it('keeps the marker of the points it leaves to the built-in type, and its own test for the others', () => {
    const tolerances: number[] = [];
    draw.extensions.featureTypes.override({
      type: 'Point',
      geometry: 'Point',
      appliesTo: (feature) => feature.properties.icon === true,
      renderer: { onAdd() {}, draw() {}, onRemove() {} },
      hitTest(feature, ctx) {
        tolerances.push(ctx.tolerancePx);
        const [x, y] = ctx.screen.project((feature.geometry as Point).coordinates);
        const distancePx = Math.hypot(ctx.point[0] - x, ctx.point[1] - y);
        return distancePx <= ctx.tolerancePx
          ? { kind: 'feature', id: feature.id, distancePx }
          : null;
      },
    });
    const plain = point([0, 0]);
    const icon = draw.features.create({
      type: 'Point',
      geometry: { type: 'Point', coordinates: [3, 0] },
      properties: { icon: true },
    });
    if (!icon) throw new Error('no feature');
    const clicked = companionOf([plain.id, icon.id], 100);
    draw.setMode('select');

    pointerClick([0.07, 0]);
    expect(draw.selection.get().ids).toEqual([plain.id]);
    // The test of the type is not widened by the marker of the built-in point
    pointerClick([3.07, 0]);
    expect(clicked).toEqual([icon.id]);
    expect(new Set(tolerances)).toEqual(new Set([6]));
  });
});

describe('the stacking order between features', () => {
  beforeEach(() => {
    draw.setMode('select');
  });

  it('lets the upper feature win over the companion of a lower one under its marker', () => {
    const low = point([0, 0]);
    const high = point([0.3, 0]);
    const clicked = companionOf([low.id], 100);
    pointerClick([0.37, 0]);
    expect(draw.selection.get().ids).toEqual([high.id]);
    expect(clicked).toEqual([]);
  });

  it('lets the companion of the upper feature win over the marker of a lower one', () => {
    point([0, 0]);
    const high = point([0.3, 0]);
    const clicked = companionOf([high.id], 100);
    pointerClick([0, 0]);
    expect(clicked).toEqual([high.id]);
    expect(draw.selection.get().ids).toEqual([]);
  });
});

describe('the handles of the selection', () => {
  it('select and drag a vertex under the companion of a feature in front', () => {
    const line = draw.features.create({
      type: 'LineString',
      geometry: {
        type: 'LineString',
        coordinates: [
          [-1, -1],
          [0.3, 0.3],
        ],
      },
    });
    if (!line) throw new Error('no line');
    const p = point([0, 0]);
    const clicked = companionOf([p.id], 1000);
    draw.setMode('select');
    draw.selection.set('feature', [line.id]);

    pointerClick([0.3, 0.3]);
    expect(engine.context.store.getVertexSelection()?.featureId).toBe(line.id);
    expect(draw.selection.get().ids).toEqual([line.id]);

    pointerDrag([0.3, 0.3], [0.5, 0.6]);
    const moved = draw.features.get(line.id)?.geometry as LineString | undefined;
    expect(moved?.coordinates[1]).toEqual([0.5, 0.6]);
    expect(clicked).toEqual([]);
  });
});

describe('a dataset below the document', () => {
  it('gets neither a click on the marker of a feature nor one on its companion', () => {
    draw.datasets.add({
      id: 'land',
      interactive: true,
      rows: [
        {
          type: 'Feature',
          id: 'all',
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [-2, -2],
                [2, -2],
                [2, 2],
                [-2, 2],
                [-2, -2],
              ],
            ],
          },
          properties: {},
        },
      ],
    });
    const rows: Array<DrawEvents['dataset.clicked']> = [];
    draw.on('dataset.clicked', (payload) => rows.push(payload));
    const p = point([0, 0]);
    const clicked = companionOf([p.id], 100);
    draw.setMode('select');

    pointerClick([0.07, 0]);
    expect(draw.selection.get().ids).toEqual([p.id]);
    pointerClick([0.5, 0]);
    expect(clicked).toEqual([p.id]);
    expect(rows).toEqual([]);

    pointerClick([1.5, 1.5]);
    expect(rows.map((row) => row.datasetId)).toEqual(['land']);
  });
});
