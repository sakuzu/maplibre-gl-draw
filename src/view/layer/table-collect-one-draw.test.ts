// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The packing of the rows drawn in one draw (`collectRow`)
 *
 * Read back, the instances, the coordinates and the styles of a row give each branch of the
 * program the inputs the renderer of its kind is given for the same row (`writePointRow`,
 * `writeLineRow`, `writePolygonRow`): the same positions, colors, widths, sizes and created
 * zooms. The instances of a row follow each other in the order they are drawn: a polygon is
 * drawn part by part, its fill then its outline. The pairs of triangles are the triangles of the
 * row with their winding, a polygon without an outline has no instance of one, and the instances
 * of the points are also in the buffer of the points, in the same order.
 */

import { ValueStringCache } from '@sakuzu/tabane';
import { describe, expect, it } from 'vitest';
import type { RowGroup } from '../../feature-table/layer-table.js';
import { drawPropertyKey } from '../../shared/properties.js';
import type { Feature, Layer } from '../../shared/types/model.js';
import { pairTriangles } from '../../table/row-geometry.js';
import { createTestDrawer, feature, tablesOfFeatures } from '../../test-utils.js';
import { dashSegmentLength } from '../renderers/line/dash.js';
import { ROW_LINE_STRIDE } from '../renderers/line/line-geometry.js';
import { ROW_POINT_STRIDE } from '../renderers/point/point-instance.js';
import { ROW_POLYGON_STRIDE } from '../renderers/polygon/sdf-polygon.js';
import {
  ROWS_INSTANCE_FLOATS,
  ROWS_KIND,
  ROWS_STYLE_FLOATS,
  type RowSprite,
  type RowSpriteSource,
  type RowsChunkData,
  RowsPalette,
  readRowsInstance,
} from '../renderers/rows/rows-format.js';
import { TerrainContext } from '../terrain/context.js';
import {
  collectRow,
  createLineRowArrays,
  linePartsOf,
  planPolygonRow,
  pointInstancesOf,
  type RowPackContext,
  RowStyleSlots,
  RowsDraft,
  type RowsPackContext,
  RowsStyles,
  writeLineRow,
  writePointRow,
  writePolygonRow,
} from './table-collect.js';

const ORIGIN: [number, number] = [Math.fround(139.5), Math.fround(35.5)];
const RATIO = 2;
const CREATED = { [drawPropertyKey('createdZoom')]: 12 };

const LAYER: Layer = {
  id: 'layer',
  name: 'layer',
  visible: true,
  locked: false,
  opacity: 1,
  items: [],
  styleRule: { kind: 'categorical', property: 'kind', map: { a: '#336699' }, other: '#996633' },
  metadata: undefined,
};

const ring = [
  [139.7, 35.6],
  [139.72, 35.6],
  [139.72, 35.62],
  [139.7, 35.62],
  [139.7, 35.6],
];
const hole = [
  [139.705, 35.605],
  [139.71, 35.605],
  [139.71, 35.61],
  [139.705, 35.605],
];

function setup(features: Feature[], sprites?: Map<number, RowSpriteSource>) {
  const { internals, table } = tablesOfFeatures('layer', features);
  const group = table.groupAt(0);
  const slots = new RowStyleSlots(createTestDrawer(), internals.styles, LAYER.styleRule);
  const base: RowPackContext = {
    slots,
    strings: new ValueStringCache(),
    pixelRatio: RATIO,
    terrain: new TerrainContext(),
  };
  const palette = new RowsPalette();
  const context: RowsPackContext = {
    ...base,
    rowsStyles: new RowsStyles(slots, palette, RATIO),
    spriteSourceOf: (row) => sprites?.get(row),
  };
  return { group, base, context, palette };
}

/** Packs every row of a group into one chunk */
function pack(group: RowGroup, context: RowsPackContext, palette: RowsPalette): RowsChunkData {
  const rows = group.data.length;
  const draft = new RowsDraft(rows, 0);
  for (let row = 0; row < rows; row++) collectRow(group, row, row, draft, ORIGIN, context);
  return draft.finish(ORIGIN, palette, null);
}

/** The reading back of a packed chunk */
function reader(data: RowsChunkData) {
  return {
    instance: (i: number) => readRowsInstance(data.instances, i),
    coord: (i: number): number[] => [data.coords[i * 2], data.coords[i * 2 + 1]],
    style: (row: number, texel: number): number[] => {
      const n = data.rowStyles[row * 4];
      const at = n * ROWS_STYLE_FLOATS + texel * 4;
      return Array.from(data.palette.values.subarray(at, at + 4));
    },
    createdZoom: (row: number) => data.rowStyles[row * 4 + 1],
    hasCreatedZoom: (row: number) => data.rowStyles[row * 4 + 2] > 0.5,
    kinds: (row: number) => {
      const out: number[] = [];
      for (let i = data.rowFirst[row]; i < data.rowFirst[row + 1]; i++) {
        out.push(readRowsInstance(data.instances, i).kind);
      }
      return out;
    },
  };
}

/** A Float32 value, as the arrays hold it */
const f32 = (value: number) => Math.fround(value);

describe('the packing of the points drawn in one draw', () => {
  it('gives the point branch the values the instances of the points carry', () => {
    const features = [
      feature('a', 'Point', [139.7, 35.6], { properties: { kind: 'a' } }),
      feature('b', 'Point', [139.71, 35.61], {
        style: { pointColor: '#ff0000', pointRadius: 9, pointShape: 'star' },
      }),
      feature('c', 'MultiPoint', [
        [139.72, 35.62],
        [139.73, 35.63],
      ]),
    ];
    const { group, base, context, palette } = setup(features);
    const data = pack(group, context, palette);
    const read = reader(data);

    const count = features.reduce((n, _, row) => n + pointInstancesOf(group, row), 0);
    const legacy = new Float32Array(count * ROW_POINT_STRIDE);
    let at = 0;
    for (let row = 0; row < features.length; row++) {
      at += writePointRow(group, row, legacy, at, ORIGIN, base);
    }

    expect(data.instanceCount).toBe(count);
    for (let i = 0; i < count; i++) {
      const instance = read.instance(i);
      const l = Array.from(legacy.subarray(i * ROW_POINT_STRIDE, (i + 1) * ROW_POINT_STRIDE));
      const row = instance.row;
      expect(instance.kind).toBe(ROWS_KIND.point);
      expect(row).toBe(l[14]);
      expect(read.coord(instance.indices[0])).toEqual([l[0], l[1]]);
      expect(read.style(row, 0)).toEqual(l.slice(2, 6));
      expect(read.style(row, 1)).toEqual(l.slice(6, 10));
      // The radius and the stroke width in device pixels, and the shape
      expect(read.style(row, 2).slice(0, 3)).toEqual([l[10], l[11], l[13]]);
    }
  });

  it('writes the instances of the points to the buffer of the points as well, in order', () => {
    const features = [
      feature('a', 'Point', [139.7, 35.6]),
      feature('g', 'Polygon', [ring]),
      feature('c', 'MultiPoint', [
        [139.72, 35.62],
        [139.73, 35.63],
      ]),
    ];
    const { group, context, palette } = setup(features);
    const data = pack(group, context, palette);
    expect(data.pointCount).toBe(3);
    expect(Array.from(data.pointFirst)).toEqual([0, 1, 1, 3]);
    const points: number[] = [];
    for (let i = 0; i < data.instanceCount; i++) {
      const instance = readRowsInstance(data.instances, i);
      if (instance.kind !== ROWS_KIND.point) continue;
      points.push(...Array.from(data.instances.subarray(i * 8, i * 8 + ROWS_INSTANCE_FLOATS)));
    }
    expect(Array.from(data.points.subarray(0, data.pointCount * 8))).toEqual(points);
  });
});

describe('the packing of the lines drawn in one draw', () => {
  it('gives the segment branch the values the instances of the lines carry', () => {
    const features = [
      feature(
        'a',
        'LineString',
        [
          [139.7, 35.6],
          [139.71, 35.62],
          [139.72, 35.6],
        ],
        { properties: { ...CREATED, kind: 'a' } },
      ),
      feature(
        'b',
        'MultiLineString',
        [
          [
            [139.8, 35.7],
            [139.81, 35.71],
          ],
          [[139.9, 35.9]],
          [
            [139.82, 35.7],
            [139.83, 35.72],
            [139.84, 35.7],
          ],
        ],
        { style: { strokeColor: '#00ff00', strokeOpacity: 0.5, strokeWidth: 4 } },
      ),
      feature('c', 'Freehand', [
        [139.6, 35.5],
        [139.61, 35.51],
      ]),
    ];
    const { group, base, context, palette } = setup(features);
    const data = pack(group, context, palette);
    const read = reader(data);

    const parts: number[] = [];
    let coords = 0;
    let instances = 0;
    for (let row = 0; row < features.length; row++) {
      parts.length = 0;
      linePartsOf(group, row, parts);
      for (let k = 0; k < parts.length; k += 2) {
        coords += parts[k + 1] - parts[k];
        instances += parts[k + 1] - parts[k] - 1;
      }
    }
    const arrays = createLineRowArrays(coords, instances);
    for (let row = 0; row < features.length; row++) {
      writeLineRow(group, row, arrays, ORIGIN, base, parts);
    }

    expect(data.instanceCount).toBe(arrays.instanceCount);
    expect(data.coordCount).toBe(coords);
    const legacyCoord = (i: number) => [arrays.texData[i * 4], arrays.texData[i * 4 + 1]];
    for (let i = 0; i < arrays.instanceCount; i++) {
      const l = Array.from(
        arrays.instanceData.subarray(i * ROW_LINE_STRIDE, (i + 1) * ROW_LINE_STRIDE),
      );
      const instance = read.instance(i);
      const row = instance.row;
      expect(instance.kind).toBe(ROWS_KIND.segment);
      expect(row).toBe(l[12]);
      const [prev, start, end, next] = instance.indices;
      // The same coordinates, before, at the start, at the end and after the segment
      expect(read.coord(start)).toEqual(legacyCoord(l[0]));
      expect(read.coord(end)).toEqual(legacyCoord(l[1]));
      expect(prev < 0 ? -1 : read.coord(prev)).toEqual(l[2] < 0 ? -1 : legacyCoord(l[2]));
      expect(next < 0 ? -1 : read.coord(next)).toEqual(l[3] < 0 ? -1 : legacyCoord(l[3]));
      // The width the row picks (the negative one is fixed on screen), its created zoom, color
      const widths = read.style(row, 1);
      expect(read.hasCreatedZoom(row) ? widths[0] : widths[1]).toBe(l[5]);
      expect(read.createdZoom(row)).toBe(l[6]);
      expect(read.style(row, 0)).toEqual(l.slice(8, 12));
      // A solid line carries no length
      expect(instance.extra).toBe(0);
      expect(widths[3]).toBe(0);
    }
  });

  it('gives a dashed line the length of its part before each segment, and its pattern', () => {
    const coords = [
      [139.7, 35.6],
      [139.71, 35.62],
      [139.72, 35.6],
      [139.73, 35.61],
    ];
    const features = [
      feature('a', 'MultiLineString', [coords, coords.map(([x, y]) => [x, y + 0.1])], {
        style: { lineStyle: 'dashed', strokeWidth: 3 },
      }),
      feature(
        'b',
        'LineString',
        [
          [139.8, 35.7],
          [139.81, 35.71],
        ],
        { style: { lineStyle: 'dotted' } },
      ),
    ];
    const { group, context, palette } = setup(features);
    const data = pack(group, context, palette);
    const read = reader(data);
    expect(read.style(0, 1).slice(2)).toEqual([3, 1]);
    expect(read.style(1, 1)[3]).toBe(2);
    const expected: number[] = [];
    for (const part of [coords, coords.map(([x, y]) => [x, y + 0.1])]) {
      let before = 0;
      for (let k = 0; k < part.length - 1; k++) {
        expected.push(f32(before));
        before += dashSegmentLength(part[k][0], part[k][1], part[k + 1][0], part[k + 1][1], 0);
      }
    }
    expected.push(0);
    const extras = Array.from({ length: data.instanceCount }, (_, i) => read.instance(i).extra);
    expect(extras).toEqual(expected);
    // The ends of each part have no coordinate before or after them
    expect(read.instance(0).indices[0]).toBe(-1);
    expect(read.instance(2).indices[3]).toBe(-1);
    expect(read.instance(3).indices[0]).toBe(-1);
  });
});

/** The positions of a triangle, from its first in the order of the positions (winding kept) */
function triangleKey(points: number[][]): string {
  let first = 0;
  for (let i = 1; i < 3; i++) {
    if (
      points[i][0] < points[first][0] ||
      (points[i][0] === points[first][0] && points[i][1] < points[first][1])
    ) {
      first = i;
    }
  }
  return [0, 1, 2].map((k) => points[(first + k) % 3].join(',')).join(' ');
}

describe('the packing of the polygons drawn in one draw', () => {
  const features = [
    feature('a', 'Polygon', [ring, hole], { properties: { kind: 'a' } }),
    // Two parts that touch along an edge
    feature('b', 'MultiPolygon', [[ring], [ring.map(([x, y]) => [x + 0.02, y])]], {
      properties: CREATED,
      style: { fillColor: '#ff00ff', fillOpacity: 0.4, strokeWidth: 3 },
    }),
    // No outline (a transparent outline is drawn: its opacity is in its color, as by kind)
    feature('c', 'Polygon', [ring], { style: { strokeWidth: 0 } }),
    feature('d', 'Polygon', [ring], { style: { strokeOpacity: 0, fillOpacity: 0 } }),
    feature('f', 'Polygon', [ring], { style: { strokeWidth: 0, fillOpacity: 0 } }),
    feature('e', 'Circle', [139.75, 35.65], {
      properties: { [drawPropertyKey('radiusMeters')]: 200 },
    }),
  ];

  it('gives the outline and fill branches the values the vertices of the polygons carry', () => {
    const { group, base, context, palette } = setup(features);
    const data = pack(group, context, palette);
    const read = reader(data);

    features.forEach((_, row) => {
      const plan = planPolygonRow(group, row, base);
      if (!plan) {
        expect(data.rowFirst[row + 1] - data.rowFirst[row]).toBe(0);
        return;
      }
      const vertices = new Float32Array(plan.vertexCount * ROW_POLYGON_STRIDE);
      const indices = new Uint32Array(plan.indexCount);
      writePolygonRow(plan, row, vertices, 0, indices, 0, 0, ORIGIN, RATIO);
      const vertex = (v: number) =>
        Array.from(vertices.subarray(v * ROW_POLYGON_STRIDE, (v + 1) * ROW_POLYGON_STRIDE));

      // The edges of the outline, in the order of the quads of the vertices
      const strokes: number[][] = [];
      const fills = new Map<string, number>();
      let fillColor: number[] | null = null;
      for (let i = 0; i < indices.length; i += 3) {
        const corners = [vertex(indices[i]), vertex(indices[i + 1]), vertex(indices[i + 2])];
        if (corners[0][6] === 0) {
          const key = triangleKey(corners.map((c) => [c[0], c[1]]));
          fills.set(key, (fills.get(key) ?? 0) + 1);
          fillColor = corners[0].slice(2, 6);
        }
      }
      for (let v = 0; v < plan.vertexCount; v += 1) {
        const values = vertex(v);
        // The first vertex of each quad: the start of an edge, on its left
        if (values[6] === 1 && values[11] === 1 && values[12] === 0) strokes.push(values);
      }

      const outlines: number[][] = [];
      const pairs = new Map<string, number>();
      for (let i = data.rowFirst[row]; i < data.rowFirst[row + 1]; i++) {
        const instance = read.instance(i);
        const [i0, i1, i2, i3] = instance.indices;
        if (instance.kind === ROWS_KIND.outline) outlines.push([i0, i1, i2, i3]);
        if (instance.kind === ROWS_KIND.fill) {
          const triangles = [[i0, i1, i2]];
          if (i3 !== i2) triangles.push([i2, i1, i3]);
          for (const t of triangles) {
            const key = triangleKey(t.map(read.coord));
            pairs.set(key, (pairs.get(key) ?? 0) + 1);
          }
        }
      }
      // The same triangles, with the same winding, when the fill is seen
      const fillSeen = plan.slot.fillColor[3] > 0;
      expect(pairs).toEqual(fillSeen ? fills : new Map());
      if (fillSeen && fillColor) expect(read.style(row, 0)).toEqual(fillColor);
      // The same edges: the start, the coordinates before and after it, the color and width
      expect(outlines.length).toBe(strokes.length);
      outlines.forEach(([prev, start, end], k) => {
        const s = strokes[k];
        expect(read.coord(start)).toEqual([s[0], s[1]]);
        expect(read.coord(prev)).toEqual([s[7], s[8]]);
        expect(read.coord(end)).toEqual([s[9], s[10]]);
        expect(read.style(row, 1)).toEqual(s.slice(2, 6));
        const widths = read.style(row, 2);
        expect(read.hasCreatedZoom(row) ? widths[0] : widths[1]).toBe(s[13]);
        expect(read.createdZoom(row)).toBe(s[14]);
      });
    });
  });

  it('packs a polygon part by part, its fill then its outline, and no outline without one', () => {
    const { group, context, palette } = setup(features);
    const data = pack(group, context, palette);
    const read = reader(data);
    const { fill, outline } = ROWS_KIND;
    const runs = (kinds: number[]) =>
      kinds.filter((k, i) => i === 0 || kinds[i - 1] !== k).map((k) => (k === fill ? 'F' : 'O'));
    // A polygon with a hole: its fill, then its outer ring and its hole
    expect(runs(read.kinds(0))).toEqual(['F', 'O']);
    // Two parts: the fill and the outline of each in turn
    expect(runs(read.kinds(1))).toEqual(['F', 'O', 'F', 'O']);
    // No outline: only the fill. A fill unseen and no outline: nothing
    expect(read.kinds(2).every((k) => k === fill)).toBe(true);
    expect(read.kinds(4)).toEqual([]);
    // A Circle: its ring
    expect(read.kinds(5).filter((k) => k === outline).length).toBe(64);
  });

  it('draws a dashed outline as lines around each ring from its first coordinate', () => {
    const dashed = [feature('a', 'Polygon', [ring, hole], { style: { lineStyle: 'dashed' } })];
    const { group, context, palette } = setup(dashed);
    const data = pack(group, context, palette);
    const read = reader(data);
    const edges = Array.from({ length: data.instanceCount }, (_, i) => read.instance(i)).filter(
      (instance) => instance.kind === ROWS_KIND.dashedOutline,
    );
    // The outer ring of 4 coordinates and the hole of 3
    expect(edges.length).toBe(7);
    const outer = edges.slice(0, 4);
    expect(outer[0].indices[0]).toBe(-1);
    expect(outer[3].indices[3]).toBe(-1);
    // The last edge goes back to the first coordinate
    expect(outer[3].indices[2]).toBe(outer[0].indices[1]);
    expect(outer[2].indices[3]).toBe(outer[0].indices[1]);
    let before = 0;
    for (let j = 0; j < 4; j++) {
      expect(outer[j].extra).toBe(f32(before));
      const a = ring[j];
      const b = ring[(j + 1) % 4];
      before += dashSegmentLength(a[0], a[1], b[0], b[1], 0);
    }
    expect(edges[4].extra).toBe(0);
    // The line's color and the polygon's widths and pattern
    expect(read.style(0, 2)[3]).toBe(1);
  });
});

describe('pairTriangles', () => {
  it('pairs the triangles that share an edge, with their winding, and leaves the others alone', () => {
    // A square of two triangles, and a third triangle that touches only at a corner
    const triangles = [0, 1, 2, 2, 3, 0, 4, 5, 6];
    const out: number[][] = [];
    pairTriangles(triangles, 0, triangles.length, 0, (a, b, c, d) => out.push([a, b, c, d]));
    expect(out.length).toBe(2);
    const [pair, single] = out;
    // (a, b, c) and (c, b, d) are the two triangles of the square
    const asTriangles = [
      [pair[0], pair[1], pair[2]],
      [pair[2], pair[1], pair[3]],
    ].map((t) => {
      const first = t.indexOf(Math.min(...t));
      return [0, 1, 2].map((k) => t[(first + k) % 3]).join(',');
    });
    expect(asTriangles.sort()).toEqual(['0,1,2', '0,2,3']);
    expect(single).toEqual([4, 5, 6, 6]);
  });

  it('counts the indices from a base', () => {
    const out: number[][] = [];
    pairTriangles([10, 11, 12], 0, 3, 10, (a, b, c, d) => out.push([a, b, c, d]));
    expect(out).toEqual([[0, 1, 2, 2]]);
  });
});

describe('the packing of the points drawn with the pictures of an extension', () => {
  it('gives the sprite branch the picture of the style of the row', () => {
    const sprite: RowSprite = {
      uv: [0.25, 0, 0.5, 0.5],
      halfWidth: 12,
      halfHeight: 8,
      direction: 45,
    };
    const source: RowSpriteSource = {
      texture: null,
      revision: 1,
      sprite: (style) => (style?.pointColor === '#ff0000' ? sprite : null),
    };
    const features = [
      feature('a', 'Point', [139.7, 35.6], { style: { pointColor: '#ff0000' } }),
      feature('b', 'Point', [139.71, 35.61]),
    ];
    const { group, context, palette } = setup(features, new Map([[0, source]]));
    const data = pack(group, context, palette);
    const read = reader(data);
    expect(read.instance(0).kind).toBe(ROWS_KIND.sprite);
    expect(read.instance(1).kind).toBe(ROWS_KIND.point);
    expect(read.style(0, 0)).toEqual([0.25, 0, 0.5, 0.5]);
    expect(read.style(0, 1).slice(0, 3)).toEqual([12, 8, 45]);
    // Both are in the buffer of the points
    expect(data.pointCount).toBe(2);
  });
});
