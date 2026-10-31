// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests of `draw.rendered`: the features as they are drawn (the sketches applied), their
 * selection boxes made by the function the selection UI draws and hits them with, and
 * `rendered.changed`, told once the frame that draws a change is drawn
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCoordinateTransform } from '../../shared/math/index.js';
import type { Feature as StoredFeature } from '../../store/types.js';
import { createMapStub } from '../../test-utils.js';
import { selectionBoxOf } from '../../view/ui/bounds.js';
import type { Draw } from '../draw.js';
import type { Feature } from '../model.js';
import { createDrawOnEngine } from './create-draw.js';
import type { Engine } from './engine.js';
import { createEngine } from './engine.js';

let engine: Engine;
let draw: Draw;
/** Draws a frame: the drawing tells the frames drawn by this one signal */
let drawFrame: () => void;

beforeEach(() => {
  const listeners = new Set<() => void>();
  engine = createEngine(createMapStub().map, {}, { deferDefaultMode: true });
  engine.customLayer.onFrameDrawn = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  drawFrame = () => {
    for (const listener of [...listeners]) listener();
  };
  draw = createDrawOnEngine(engine);
  engine.enterDefaultMode();
});
afterEach(() => {
  draw.destroy();
});

const line = (): Feature =>
  draw.features.create({
    type: 'LineString',
    geometry: {
      type: 'LineString',
      coordinates: [
        [0, 0],
        [1, 1],
      ],
    },
  }) as Feature;

describe('draw.rendered', () => {
  it('reads the features as they are drawn, with the sketches applied over the document', () => {
    const a = line();
    draw.sketches.add({
      edits: [
        {
          kind: 'vertex-move',
          featureId: a.id,
          vertices: [{ ring: 0, index: 1 }],
          positions: [[2, 2]],
        },
      ],
    });
    const second = (feature: Feature | undefined) =>
      (feature?.geometry as GeoJSON.LineString | undefined)?.coordinates[1];
    expect(second(draw.features.get(a.id))).toEqual([1, 1]);
    expect(second(draw.rendered.get(a.id))).toEqual([2, 2]);
    expect(draw.rendered.getMany([a.id, 'none', a.id]).map((f) => f?.id)).toEqual([
      a.id,
      undefined,
      a.id,
    ]);
    expect(draw.rendered.get('none')).toBeUndefined();
  });

  it('gives the selection box the selection UI draws: the footprint with the margin', () => {
    const a = line();
    const point = draw.features.create({
      type: 'Point',
      geometry: { type: 'Point', coordinates: [1, 1] },
    }) as Feature;
    const { context } = engine;
    const margin = context.selectionStyle.box.margin;
    const extensions = context.selectionScope.extensions;
    const transform = createCoordinateTransform(draw.getMap());
    const expected = selectionBoxOf(
      context.store.getFeature(a.id) as StoredFeature,
      transform,
      margin,
      extensions,
    );
    expect(expected?.kind).toBe('ground');
    const box = draw.rendered.getSelectionBox(a.id);
    if (box?.kind !== 'ground' || expected?.kind !== 'ground') throw new Error('not on the map');
    expect(box.corners).toEqual({
      topLeft: expected.topLeft,
      topRight: expected.topRight,
      bottomRight: expected.bottomRight,
      bottomLeft: expected.bottomLeft,
    });
    // Outside the extent of the line on every side
    expect(box.corners.topLeft[0]).toBeLessThan(0);
    expect(box.corners.bottomRight[1]).toBeLessThan(0);
    // A point is a box of the screen: its marker (a radius of 6 px, an outline of 2 px) and the
    // margin around it
    expect(draw.rendered.getSelectionBox(point.id)).toEqual({
      kind: 'screen',
      position: [1, 1],
      halfWidthPx: 8 + margin,
      halfHeightPx: 8 + margin,
    });
    expect(draw.rendered.getSelectionBox('none')).toBeNull();
  });

  it('has no dragged rows over a Store of objects', () => {
    expect(draw.rendered.getDraggedRows()).toBeNull();
  });
});

describe('rendered.changed', () => {
  it('tells the features changed once the frame that draws them is drawn, once a frame', () => {
    const told: (readonly string[])[] = [];
    draw.on('rendered.changed', ({ ids }) => told.push(ids));
    const a = line();
    const b = line();
    draw.features.update(a.id, { style: { strokeWidth: 4 } });
    expect(told).toEqual([]);
    drawFrame();
    expect(told).toEqual([[a.id, b.id]]);
    // Nothing changed since: nothing is told
    drawFrame();
    expect(told).toHaveLength(1);
  });

  it('tells the features a sketch edits, then edits no more, and those deleted', () => {
    const told: (readonly string[])[] = [];
    const a = line();
    const b = line();
    drawFrame();
    draw.on('rendered.changed', ({ ids }) => told.push([...ids].sort()));
    const sketch = draw.sketches.add({
      edits: [{ kind: 'set', featureId: a.id, patch: { style: { strokeWidth: 3 } } }],
    });
    drawFrame();
    // The sketch moves to the other feature: both are drawn otherwise
    draw.sketches.update(sketch?.id as string, {
      edits: [{ kind: 'set', featureId: b.id, patch: { style: { strokeWidth: 3 } } }],
    });
    drawFrame();
    draw.sketches.remove(sketch?.id as string);
    draw.features.delete(a.id);
    drawFrame();
    expect(told).toEqual([[a.id], [a.id, b.id].sort(), [a.id, b.id].sort()]);
  });
});
