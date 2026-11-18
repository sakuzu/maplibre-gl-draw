// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The public columns of the geometries of rows (`GeometryColumn`: every geometry as parts made of
 * rings made of positions, the rows one after the other) written as the columns the tables take
 * (`ShapeValues`: a form per type of geometry, with its points and its offsets, and the form and
 * the row there of each row).
 *
 * The rows are walked twice, to count and then to copy, into arrays made once at their sizes: one
 * form per type of geometry the rows have, whatever their number. Nothing is made per row. The
 * geometries have been checked (`validate.ts`).
 *
 * @internal
 */

import { createShapeValues, type ShapeValues } from '@sakuzu/kasane';
import { countWork, type WorkCounts } from '../../shared/work-counts.js';
import { GEOMETRY_TYPES, type GeometryColumn } from './types.js';

/** The type of a row without a geometry, in `GeometryColumn.types` */
const NO_TYPE = 255;

/** The depth of the shape of each type of geometry, by its index in `GEOMETRY_TYPES` */
const DEPTHS: readonly (0 | 1 | 2 | 3)[] = [0, 1, 2, 1, 2, 3];

/**
 * What the entries of each level of the offsets of a form count, by the index of the type: the
 * parts of a row (`part`), the rings of a part or of the one part of a row (`ring`), or the
 * positions (`position`). Level 0 has an entry per row of the form, and each level after it an
 * entry per entry the level before counts; the levels a type has one entry of each (the part and
 * the ring of a LineString) are left out
 */
const LEVELS: readonly (readonly ('part' | 'ring' | 'position')[])[] = [
  [],
  ['position'],
  ['ring', 'position'],
  ['part'],
  ['part', 'position'],
  ['part', 'ring', 'position'],
];

/** What one form counts as the rows are walked the first time */
interface FormCount {
  rows: number;
  /** The entries of each level of its offsets */
  readonly entries: number[];
  points: number;
}

/** The parts, the rings or the positions of the parts `[from, to)` of a geometry column */
function countIn(
  geometry: GeometryColumn,
  from: number,
  to: number,
  what: 'part' | 'ring' | 'position',
): number {
  const { ringStarts, positionStarts } = geometry;
  if (what === 'part') return to - from;
  if (what === 'ring') return ringStarts[to] - ringStarts[from];
  return positionStarts[ringStarts[to]] - positionStarts[ringStarts[from]];
}

/**
 * The geometries of rows as the tables take them
 *
 * @param geometry - The geometries, one per row (a row of type 255 has its shape left as it is)
 * @param dimensions - The dimensions of the table the rows are written to
 * @param counts - The numbers the objects made are counted in
 * @internal
 */
export function shapeValuesOf(
  geometry: GeometryColumn,
  dimensions: 'xy' | 'xyz' | 'xym' | 'xyzm',
  counts: WorkCounts,
): ShapeValues {
  const { types, coordinates, partStarts, ringStarts, positionStarts } = geometry;
  const n = geometry.valuesPerPosition;
  const rows = types.length;
  const formIndex = new Int16Array(rows).fill(-1);
  const formRow = new Int32Array(rows);
  // The arrays of the forms of each row, the list of the counts of the forms
  countWork(counts, 'objectsCreated', 3);

  // The first walk counts the rows, the entries of each level and the points of each form
  const formCounts: Array<FormCount | undefined> = [];
  for (let row = 0; row < rows; row++) {
    const type = types[row];
    if (type === NO_TYPE) continue;
    let count = formCounts[type];
    if (!count) {
      count = { rows: 0, entries: LEVELS[type].map(() => 0), points: 0 };
      formCounts[type] = count;
      countWork(counts, 'objectsCreated', 2);
    }
    formRow[row] = count.rows;
    count.rows++;
    const firstPart = partStarts[row];
    const lastPart = partStarts[row + 1];
    const levels = LEVELS[type];
    for (let l = 0; l < levels.length; l++) {
      count.entries[l] += countIn(geometry, firstPart, lastPart, levels[l]);
    }
    count.points += countIn(geometry, firstPart, lastPart, 'position');
  }

  // The forms, in the order of the types, with their arrays at their sizes
  const forms: Array<{
    readonly name: string;
    readonly depth: 0 | 1 | 2 | 3;
    readonly rows: number;
    readonly offsets: Int32Array[];
    readonly points: Float64Array;
  }> = [];
  const formOf: number[] = [];
  /** Where the next entry of each level, and the next point, of each form is written */
  const at: Array<{ readonly entries: number[]; points: number }> = [];
  const stride = dimensions.length;
  for (let type = 0; type < formCounts.length; type++) {
    const count = formCounts[type];
    if (!count) continue;
    formOf[type] = forms.length;
    // Every level starts with 0, and has one entry more than the rows, or than the entries the
    // level before counts
    const offsets = count.entries.map(
      (_, l) => new Int32Array((l === 0 ? count.rows : count.entries[l - 1]) + 1),
    );
    forms.push({
      name: GEOMETRY_TYPES[type],
      depth: DEPTHS[type],
      rows: count.rows,
      offsets,
      points: new Float64Array(count.points * stride).fill(Number.NaN),
    });
    at.push({ entries: count.entries.map(() => 0), points: 0 });
    // The form, its offsets and points, and where its next entries are written
    countWork(counts, 'objectsCreated', 4 + offsets.length + 2);
  }
  // The forms, where they are in the forms of the types and where their next entries go
  countWork(counts, 'objectsCreated', 3);

  // The second walk copies the offsets and the points of each row
  for (let row = 0; row < rows; row++) {
    const type = types[row];
    if (type === NO_TYPE) continue;
    const index = formOf[type];
    formIndex[row] = index;
    const form = forms[index];
    const place = at[index];
    const firstPart = partStarts[row];
    const lastPart = partStarts[row + 1];
    const levels = LEVELS[type];
    // The offsets: an entry for the row on level 0, and for each part or ring of the row on the
    // levels after it, with the number of what the level counts in it
    for (let l = 0; l < levels.length; l++) {
      const offsets = form.offsets[l];
      const counted = levels[l];
      let entry = place.entries[l];
      const parent = l === 0 ? 'row' : levels[l - 1];
      if (parent === 'row') {
        offsets[entry + 1] = offsets[entry] + countIn(geometry, firstPart, lastPart, counted);
        entry++;
      } else if (parent === 'part') {
        for (let part = firstPart; part < lastPart; part++) {
          offsets[entry + 1] = offsets[entry] + countIn(geometry, part, part + 1, counted);
          entry++;
        }
      } else {
        for (let ring = ringStarts[firstPart]; ring < ringStarts[lastPart]; ring++) {
          offsets[entry + 1] = offsets[entry] + positionStarts[ring + 1] - positionStarts[ring];
          entry++;
        }
      }
      place.entries[l] = entry;
    }
    // The points, in the dimensions of the table (a value the positions do not have is NaN)
    const from = positionStarts[ringStarts[firstPart]];
    const to = positionStarts[ringStarts[lastPart]];
    const copied = Math.min(n, stride);
    for (let p = from; p < to; p++) {
      const target = place.points * stride;
      for (let k = 0; k < copied; k++) form.points[target + k] = coordinates[p * n + k];
      place.points++;
    }
  }
  // The values of the column, as the tables take them
  countWork(counts, 'objectsCreated', 2);
  return createShapeValues({ dimensions, forms, formIndex, formRow });
}
