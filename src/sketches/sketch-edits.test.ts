// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The edits of the sketches as pure functions: their checks, what is left of them when features or
 * vertices are gone, the shape of the vertices, and the edits of features they are made into
 */

import { describe, expect, it } from 'vitest';
import type { SketchEdit } from '../api/sketches.js';
import { DEFAULT_TRANSFORMS } from '../store/feature-edits.js';
import {
  checkSketchEdits,
  featureEditsOf,
  vertexShapeOf,
  withoutFeatures,
  withoutVertices,
} from './sketch-edits.js';

const translate = (ids: string[]): SketchEdit => ({
  kind: 'translate',
  target: { featureIds: ids },
  from: [0, 0],
  to: [1, 1],
});

describe('checkSketchEdits', () => {
  it('takes the edits of features, the selection, the IDs of vertices given, and create', () => {
    expect(() =>
      checkSketchEdits(
        [
          translate(['a']),
          { kind: 'rotate', target: { selection: true }, center: [0, 0], angleDegrees: 10 },
          {
            kind: 'create',
            feature: { type: 'Point', geometry: { type: 'Point', coordinates: [0, 0] } },
            placedVertexCount: 1,
            below: null,
          },
        ],
        false,
        DEFAULT_TRANSFORMS,
      ),
    ).not.toThrow();
    const byId: SketchEdit = { kind: 'vertex-delete', featureId: 'a', vertices: ['v1'] };
    expect(() => checkSketchEdits([byId], true, DEFAULT_TRANSFORMS)).not.toThrow();
    expect(() => checkSketchEdits([byId], false, DEFAULT_TRANSFORMS)).toThrow(/by its place/);
    expect(() =>
      checkSketchEdits(
        [{ kind: 'create', feature: {}, placedVertexCount: -1, below: null } as never],
        false,
        DEFAULT_TRANSFORMS,
      ),
    ).toThrow(/placedVertexCount/);
    expect(() =>
      checkSketchEdits(
        [{ kind: 'translate', target: { selection: false }, from: [0, 0], to: [0, 0] } as never],
        false,
        DEFAULT_TRANSFORMS,
      ),
    ).toThrow(/target/);
    expect(() => checkSketchEdits('x', false, DEFAULT_TRANSFORMS)).toThrow(/array/);
  });
});

describe('what is left of the edits', () => {
  it('leaves out the features gone, each counted once', () => {
    const edits: SketchEdit[] = [
      { kind: 'set', featureId: 'a', patch: { visible: false } },
      translate(['a', 'b']),
      translate(['a']),
    ];
    const { edits: left, dropped } = withoutFeatures(edits, new Set(['a']));
    expect(dropped).toBe(3);
    expect(left).toEqual([translate(['b'])]);
  });

  it('leaves out the vertices gone and the insertions next to them', () => {
    const edits: SketchEdit[] = [
      {
        kind: 'vertex-move',
        featureId: 'a',
        vertices: ['1', '2'],
        positions: [
          [0, 0],
          [1, 1],
        ],
      },
      { kind: 'vertex-insert', featureId: 'a', after: '2', position: [3, 3] },
      { kind: 'vertex-delete', featureId: 'b', vertices: ['2'] },
    ];
    const { edits: left, dropped } = withoutVertices(edits, 'a', (v) => v !== '2');
    expect(dropped).toBe(2);
    expect(left).toEqual([
      { kind: 'vertex-move', featureId: 'a', vertices: ['1'], positions: [[0, 0]] },
      { kind: 'vertex-delete', featureId: 'b', vertices: ['2'] },
    ]);
  });
});

describe('vertexShapeOf', () => {
  it('reads the parts, the rings and the number of positions, not where they are', () => {
    expect(
      vertexShapeOf({
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      }),
    ).toBe(
      vertexShapeOf({
        type: 'LineString',
        coordinates: [
          [5, 5],
          [6, 7],
        ],
      }),
    );
    expect(
      vertexShapeOf({
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      }),
    ).not.toBe(
      vertexShapeOf({
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 1],
          [2, 2],
        ],
      }),
    );
    expect(
      vertexShapeOf({
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
          [
            [0.2, 0.2],
            [0.3, 0.2],
            [0.3, 0.3],
            [0.2, 0.2],
          ],
        ],
      }),
    ).toBe('Polygon:[4,4]');
    expect(vertexShapeOf({ type: 'Point', coordinates: [0, 0] })).toBe('Point:p');
  });
});

describe('featureEditsOf', () => {
  it('makes the selection the features selected and finds the vertices, leaving out create', () => {
    const edits: SketchEdit[] = [
      { kind: 'translate', target: { selection: true }, from: [0, 0], to: [1, 1] },
      {
        kind: 'vertex-move',
        featureId: 'a',
        vertices: ['x', 'y'],
        positions: [
          [0, 0],
          [1, 1],
        ],
      },
      {
        kind: 'create',
        feature: { type: 'Point', geometry: { type: 'Point', coordinates: [0, 0] } },
        placedVertexCount: 1,
        below: null,
      },
    ];
    const out = featureEditsOf(
      edits,
      () => ['s'],
      (_, vertices) => vertices.map((v) => (v === 'x' ? { ring: 0, index: 4 } : null)),
    );
    expect(out).toEqual([
      { kind: 'translate', target: { featureIds: ['s'] }, from: [0, 0], to: [1, 1] },
      {
        kind: 'vertex-move',
        featureId: 'a',
        vertices: [{ ring: 0, index: 4 }],
        positions: [[0, 0]],
      },
    ]);
    expect(featureEditsOf(edits.slice(0, 1), () => [])).toEqual([]);
  });
});
