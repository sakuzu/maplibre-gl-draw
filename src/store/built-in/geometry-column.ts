// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The geometries of rows read from the tables as columns (`ShapeValues`: a list of positions and
 * of offsets per shape, and the shape and the row there of each row), written as the public
 * columns of the geometries (`GeometryColumn`: every geometry as parts made of rings made of
 * positions, the rows one after the other).
 *
 * Only the rows read are written, into flat arrays made once at their sizes: the rows are walked
 * twice (to count, then to copy), and nothing is made per row.
 *
 * @internal
 */

import type { ShapeValues } from '@sakuzu/kasane';
import { GEOMETRY_TYPES, type GeometryColumn } from './types.js';

/** The type of a row without a geometry, in `GeometryColumn.types` */
const NO_TYPE = 255;

/** The index of each type of geometry, by the name of its shape */
const TYPE_INDEXES: ReadonlyMap<string, number> = new Map(
  GEOMETRY_TYPES.map((type, index) => [type, index]),
);

/** The types whose members are parts of their own (a shape of one depth more than their parts) */
const MULTI_TYPES: ReadonlySet<string> = new Set(['MultiPoint', 'MultiLineString']);

/**
 * The geometries of rows read as columns, as the public columns of the geometries
 *
 * @param shapes - The shapes of the rows, one entry per row (undefined for no row read)
 * @param rowCount - The number of rows read
 * @param valuesPerPosition - The number of values of a position of the layer of the rows
 * @internal
 */
export function geometryColumnOf(
  shapes: ShapeValues | undefined,
  rowCount: number,
  valuesPerPosition: number,
): GeometryColumn {
  const types = new Uint8Array(rowCount).fill(NO_TYPE);
  const partStarts = new Int32Array(rowCount + 1);
  if (!shapes) {
    return {
      types,
      coordinates: new Float64Array(0),
      valuesPerPosition,
      partStarts,
      ringStarts: new Int32Array(1),
      positionStarts: new Int32Array(1),
    };
  }
  const { forms, formIndex, formRow } = shapes;
  const stride = shapes.dimensions.length;
  const formTypes = forms.map((form) => TYPE_INDEXES.get(form.name) ?? NO_TYPE);
  const formMulti = forms.map((form) => MULTI_TYPES.has(form.name));

  // The first walk counts the parts, the rings and the positions
  let parts = 0;
  let rings = 0;
  let positions = 0;
  for (let i = 0; i < rowCount; i++) {
    const f = formIndex[i];
    if (f < 0) continue;
    const form = forms[f];
    const r = formRow[i];
    const o = form.offsets;
    switch (form.depth) {
      case 0:
        parts += 1;
        rings += 1;
        positions += 1;
        break;
      case 1: {
        const n = o[0][r + 1] - o[0][r];
        parts += formMulti[f] ? n : 1;
        rings += formMulti[f] ? n : 1;
        positions += n;
        break;
      }
      case 2: {
        const n = o[0][r + 1] - o[0][r];
        parts += formMulti[f] ? n : 1;
        rings += n;
        positions += o[1][o[0][r + 1]] - o[1][o[0][r]];
        break;
      }
      case 3: {
        const a = o[0][r];
        const b = o[0][r + 1];
        parts += b - a;
        rings += o[1][b] - o[1][a];
        positions += o[2][o[1][b]] - o[2][o[1][a]];
        break;
      }
    }
  }

  // The second walk writes the arrays
  const coordinates = new Float64Array(positions * valuesPerPosition);
  const ringStarts = new Int32Array(parts + 1);
  const positionStarts = new Int32Array(rings + 1);
  let part = 0;
  let ring = 0;
  let position = 0;
  const copy = (points: Float64Array, from: number, to: number): void => {
    for (let p = from; p < to; p++) {
      const at = position * valuesPerPosition;
      const source = p * stride;
      for (let v = 0; v < valuesPerPosition; v++) {
        coordinates[at + v] = v < stride ? points[source + v] : Number.NaN;
      }
      position += 1;
    }
  };
  const addRing = (points: Float64Array, from: number, to: number): void => {
    copy(points, from, to);
    ring += 1;
    positionStarts[ring] = position;
  };
  const addPart = (): void => {
    part += 1;
    ringStarts[part] = ring;
  };
  for (let i = 0; i < rowCount; i++) {
    const f = formIndex[i];
    if (f >= 0) {
      const form = forms[f];
      const r = formRow[i];
      const o = form.offsets;
      const points = form.points;
      types[i] = formTypes[f];
      switch (form.depth) {
        case 0:
          addRing(points, r, r + 1);
          addPart();
          break;
        case 1:
          if (formMulti[f]) {
            for (let p = o[0][r]; p < o[0][r + 1]; p++) {
              addRing(points, p, p + 1);
              addPart();
            }
          } else {
            addRing(points, o[0][r], o[0][r + 1]);
            addPart();
          }
          break;
        case 2:
          for (let k = o[0][r]; k < o[0][r + 1]; k++) {
            addRing(points, o[1][k], o[1][k + 1]);
            if (formMulti[f]) addPart();
          }
          if (!formMulti[f]) addPart();
          break;
        case 3:
          for (let g = o[0][r]; g < o[0][r + 1]; g++) {
            for (let k = o[1][g]; k < o[1][g + 1]; k++) addRing(points, o[2][k], o[2][k + 1]);
            addPart();
          }
          break;
      }
    }
    partStarts[i + 1] = part;
  }
  return { types, coordinates, valuesPerPosition, partStarts, ringStarts, positionStarts };
}
