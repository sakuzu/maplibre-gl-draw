// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The boxes of the frames of the rows of a selection of many features
 *
 * On documents made at random (points, lines, areas, circles with a radius, with none and with one
 * of 0, images, on both sides of the antimeridian), the instance of a row holds the box
 * `computeBoundingBox` gives for its feature, or, for a box without an area, the extent of its
 * marker; the features framed from themselves have no instance. A selection of circles alone is
 * framed by the boxes of its circles.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { FEATURES_KEPT } from '../../store/document-access.js';
import type { Feature } from '../../store/types.js';
import { createCountedInstance } from '../../test-utils.js';
import type { DrawnRowGroup } from '../layer/table-retained.js';
import { type BulkFrameRows, BulkFramesRenderer, buildFrameInstances } from './bulk-frames.js';
import { computeBoundingBox, hasZeroArea } from './selection-ui/bounding-box.js';

const RADIUS = 'maplibre-gl-draw:radiusMeters';

/** The floats of an instance: its box, its row, the half extent of its marker, its kind */
const FLOATS = 8;

type Instance = ReturnType<typeof createCountedInstance>;

const instances: Instance[] = [];

afterEach(() => {
  for (const instance of instances.splice(0)) instance.draw.destroy();
  vi.restoreAllMocks();
});

function instanceOf(): Instance {
  const instance = createCountedInstance();
  instances.push(instance);
  return instance;
}

/** Draws frames until the drawing has no work left */
function settle({ map, draw }: Instance): void {
  for (let frame = 0; frame < 60; frame++) {
    map.render();
    if (!draw.hasPendingWork()) return;
  }
  throw new Error('the drawing still has work after 60 frames');
}

/** Numbers from 0 to 1, the same for a seed */
function randomOf(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KINDS = ['point', 'line', 'area', 'circle', 'bare circle', 'zero circle', 'image'] as const;

/** A feature made at random, at a longitude and a latitude */
function shapeOf(random: () => number, at: [number, number], kind: (typeof KINDS)[number]) {
  const to: [number, number] = [at[0] + random() / 2, at[1] + random() / 2];
  const style = { pointRadius: 4 + Math.floor(random() * 5) * 3 };
  const geometry = { type: 'Point', coordinates: at };
  switch (kind) {
    case 'line':
      return { type: 'LineString', geometry: { type: 'LineString', coordinates: [at, to] } };
    case 'area':
      return {
        type: 'Polygon',
        geometry: { type: 'Polygon', coordinates: [[at, [to[0], at[1]], to, at]] },
      };
    case 'circle':
      return { type: 'Circle', geometry, style, properties: { [RADIUS]: 1 + random() * 80_000 } };
    case 'bare circle':
      return { type: 'Circle', geometry, style };
    case 'zero circle':
      return { type: 'Circle', geometry, style, properties: { [RADIUS]: 0 } };
    case 'image':
      return {
        type: 'Image',
        geometry,
        properties: {
          'maplibre-gl-draw:imageWidth': 100 + random() * 400,
          'maplibre-gl-draw:imageHeight': 100 + random() * 400,
          'maplibre-gl-draw:createdZoom': 8,
          'maplibre-gl-draw:rotation': random() * 360,
        },
      };
    default:
      return { type: 'Point', geometry, style };
  }
}

/** The IDs of the features made */
function idsOf(made: unknown): string[] {
  return (made as Array<{ id: string }>).map((feature) => feature.id);
}

/** Selects features, draws a frame, and gives what the frames of the rows are drawn with */
function framesOf(instance: Instance, ids: string[]) {
  const draws = vi.spyOn(BulkFramesRenderer.prototype, 'drawGroups');
  instance.draw.selection.set('feature', ids);
  instance.map.render();
  expect(draws).toHaveBeenCalled();
  const rows = draws.mock.calls[0][1] as BulkFrameRows;
  const groups: DrawnRowGroup[] = [];
  instance.engine.customLayer.getTableRenderer()?.forEachDrawnGroup((entry) => {
    groups.push(entry);
  });
  return { rows, groups };
}

/** The instance of each row framed, by the ID of its feature: its values and its origin */
function framedRows({ rows, groups }: Pick<ReturnType<typeof framesOf>, 'rows' | 'groups'>) {
  const out = new Map<string, { values: Float32Array; from: [number, number] }>();
  for (const entry of groups) {
    const built = buildFrameInstances(entry.group, rows, (row) => entry.drawnAtOnce(row));
    for (let i = 0; i < built.count; i++) {
      const values = built.data.subarray(i * FLOATS, (i + 1) * FLOATS);
      const ref = rows.reader.refOf(entry.group, values[4]);
      // A row of a group written since is read from the delta
      if (rows.reader.placeOf(ref)?.group !== entry.group) continue;
      const from = values[7] >= 2 ? built.second : built.origin;
      out.set(rows.reader.idOf(ref) as string, { values, from });
    }
  }
  return out;
}

/** The box of a feature from an origin, as an instance holds it */
function boxFrom(feature: Feature, from: readonly [number, number]): number[] {
  const bbox = computeBoundingBox(feature);
  if (!bbox) throw new Error('no box');
  return [
    bbox.bottomLeft[0] - from[0],
    bbox.bottomLeft[1] - from[1],
    bbox.topRight[0] - from[0],
    bbox.topRight[1] - from[1],
  ].map(Math.fround);
}

describe('the instance of a row of a selection of many features', () => {
  for (const seed of [1, 2, 3, 4]) {
    it(`holds the box of its feature (document ${seed})`, () => {
      const random = randomOf(seed);
      const instance = instanceOf();
      const { draw, engine } = instance;
      const layers = [0, 1].map((i) => draw.layers.create({ name: `l${i}` })?.id as string);
      // Around the antimeridian, on both sides of it, and anywhere
      const place = (): [number, number] => {
        const lng = random() < 0.5 ? 178 + random() * 4 : random() * 360 - 180;
        return [lng > 180 ? lng - 360 : lng, random() * 160 - 80];
      };
      const ids = layers.flatMap((layerId) =>
        idsOf(
          draw.features.createMany(
            Array.from({ length: 800 }, () => ({
              ...shapeOf(random, place(), KINDS[Math.floor(random() * KINDS.length)]),
              layerId,
            })) as never,
          ),
        ),
      );
      settle(instance);
      // Some rows written since they were taken in
      for (const id of ids) {
        if (random() < 0.95 || draw.features.get(id)?.type !== 'Circle') continue;
        draw.features.update(id, { properties: { [RADIUS]: random() * 50_000 } });
      }
      const frames = framesOf(instance, ids);
      const framed = framedRows(frames);
      const extensions = engine.context.selectionScope.extensions;
      const found = { box: 0, point: 0, circleBox: 0, circlePoint: 0 };
      for (const id of ids) {
        const feature = draw.features.get(id) as unknown as Feature;
        const row = framed.get(id);
        if (feature.type === 'Image') {
          expect(row, id).toBeUndefined();
          continue;
        }
        const bbox = computeBoundingBox(feature);
        if (!row || !bbox) throw new Error(`no frame of the ${feature.type} ${id}`);
        expect([...row.values.subarray(0, 4)], feature.type).toEqual(boxFrom(feature, row.from));
        const point = row.values[7] % 2 === 1;
        expect(point, feature.type).toBe(hasZeroArea(bbox));
        const extent = point
          ? extensions.resolvePointFrameExtent(feature)
          : { halfWidth: 0, halfHeight: 0 };
        expect([row.values[5], row.values[6]]).toEqual(
          [extent.halfWidth, extent.halfHeight].map(Math.fround),
        );
        found[point ? 'point' : 'box']++;
        if (feature.type === 'Circle') found[point ? 'circlePoint' : 'circleBox']++;
      }
      for (const count of Object.values(found)) expect(count).toBeGreaterThan(50);
      // The boxes of both sides of the antimeridian are of one group
      expect([...framed.values()].some(({ values }) => values[7] >= 2)).toBe(true);
    });
  }
});

describe('a selection of many circles alone', () => {
  /** Circles of a grid, every one with a radius */
  function circles(count: number) {
    return Array.from({ length: count }, (_, i) => ({
      type: 'Circle',
      geometry: { type: 'Point', coordinates: [(i % 40) / 40, Math.floor(i / 40) / 40] },
      properties: { [RADIUS]: 100 + (i % 7) * 50 },
    }));
  }

  it('is framed by the boxes of its circles', () => {
    const instance = instanceOf();
    const ids = idsOf(instance.draw.features.createMany(circles(FEATURES_KEPT + 1) as never));
    settle(instance);
    const framed = framedRows(framesOf(instance, ids));
    expect(framed.size).toBe(FEATURES_KEPT + 1);
    for (const { values } of framed.values()) {
      expect(values[7] % 2).toBe(0);
      expect(values[2]).toBeGreaterThan(values[0]);
      expect(values[3]).toBeGreaterThan(values[1]);
    }
  });
});
