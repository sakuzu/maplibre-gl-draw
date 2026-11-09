// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The vertices and the edges of the rows held as columns, read on their columns
 *
 * What snaps to the rows (the vertices and the edges near the cursor, their intersections) and
 * what traces along them reads the rows here: the rows found in the indexes of the layers, their
 * positions read in place, with the same vertex references as the vertex handles of a feature
 * of the row (`computeVertexHandles`, `forEachPart`): no row is made a feature.
 */

import type { FeatureTables } from '../api/tables.js';
import type { BBox } from '../geometry/types.js';
import type { PositionRun } from '../shared/math/position-runs.js';
import type { Coordinate, Feature, FeatureType, VertexRef } from '../shared/types/model.js';
import { featureTablesInternals } from './feature-tables.js';
import { rowHitShape } from './hit-test.js';
import { rowFeature, rowType } from './row-read.js';
import { STATE_UNHIT_MASK } from './row-state.js';

/**
 * A row found for snapping or tracing
 *
 * @internal
 */
export interface SnapRow {
  /** Its id */
  readonly id: string;
  /** Its type */
  readonly type: FeatureType;
  /** The runs of its positions, by part (see `HitShape`) */
  readonly parts: ReadonlyArray<readonly PositionRun[]>;
  /** Makes a feature of it (for the type of an extension, which lists its own targets) */
  feature(): Feature;
}

/**
 * Calls `visit` with every row whose bbox meets a box: shown, of a layer shown, not left out by
 * `skip`
 *
 * @param skip Whether a row is left out (its id; the exclusions of a snap, the hidden by this
 *   client)
 * @internal
 */
export function forEachSnapRow(
  tables: FeatureTables | undefined,
  bbox: BBox,
  shown: (layerId: string, groupId: string | undefined) => boolean,
  skip: (id: string) => boolean,
  visit: (row: SnapRow) => void,
): void {
  const internals = featureTablesInternals(tables);
  if (!internals || !tables) return;
  const cursor = tables.scan({ bbox, order: 'any' });
  for (let batch = cursor.next(); batch; batch = cursor.next()) {
    for (const handle of batch) {
      const place = internals.placeOf(handle);
      if (!place || (place.group.state[place.row] & STATE_UNHIT_MASK) !== 0) continue;
      const id = tables.getRowId(handle) as string;
      if (skip(id)) continue;
      const group = place.group.data.groups[place.row];
      if (!shown(place.layer.layerId, group >= 0 ? internals.groups.idOf(group) : undefined)) {
        continue;
      }
      const shape = rowHitShape(place.group, place.row);
      if (!shape) continue;
      visit({
        id,
        type: rowType(place.group.data, place.row),
        parts: shape.parts,
        feature: () =>
          rowFeature(internals.readContext, place.layer.layerId, place.group, place.row),
      });
    }
  }
}

/**
 * The vertices of a row inside a box, with their references, as the vertex handles of the
 * feature of the row list them (a ring does not list its closing position; the types without
 * vertex handles list none)
 *
 * @internal
 */
export function rowVerticesInBBox(
  row: SnapRow,
  bbox: BBox,
  visit: (position: Coordinate, ref: VertexRef) => void,
): void {
  const inside = (run: PositionRun, i: number): boolean => {
    const x = run.x(i);
    const y = run.y(i);
    return x >= bbox[0] && x <= bbox[2] && y >= bbox[1] && y <= bbox[3];
  };
  switch (row.type) {
    case 'Point': {
      const run = row.parts[0]?.[0];
      if (run && run.length > 0 && inside(run, 0)) {
        visit([run.x(0), run.y(0)], { ring: 0, index: 0 });
      }
      return;
    }
    case 'MultiPoint': {
      const run = row.parts[0]?.[0];
      for (let part = 0; run && part < run.length; part++) {
        if (inside(run, part)) visit([run.x(part), run.y(part)], { part, ring: 0, index: 0 });
      }
      return;
    }
    default:
      forEachRowPart(row, (run, ring, part, isRing) => {
        const count = isRing && closed(run) ? run.length - 1 : run.length;
        for (let i = 0; i < count; i++) {
          if (!inside(run, i)) continue;
          visit(
            [run.x(i), run.y(i)],
            part === undefined ? { ring, index: i } : { part, ring, index: i },
          );
        }
      });
  }
}

/**
 * The edges of a row that meet a box, with the references of their ends, as the edges of the
 * feature of the row are listed (the end of the closing edge of a ring is its first vertex)
 *
 * @internal
 */
export function rowSegmentsInBBox(
  row: SnapRow,
  bbox: BBox | null,
  visit: (start: Coordinate, end: Coordinate, startRef: VertexRef, endRef: VertexRef) => void,
): void {
  forEachRowPart(row, (run, ring, part) => {
    if (run.length < 2) return;
    const isClosed = closed(run);
    const count = isClosed ? run.length - 1 : run.length;
    const ref = (index: number): VertexRef =>
      part === undefined ? { ring, index } : { part, ring, index };
    for (let i = 0; i < run.length - 1; i++) {
      const ax = run.x(i);
      const ay = run.y(i);
      const bx = run.x(i + 1);
      const by = run.y(i + 1);
      if (
        bbox &&
        (Math.min(ax, bx) > bbox[2] ||
          Math.max(ax, bx) < bbox[0] ||
          Math.min(ay, by) > bbox[3] ||
          Math.max(ay, by) < bbox[1])
      ) {
        continue;
      }
      const endIndex = isClosed && i + 1 === count ? 0 : i + 1;
      visit([ax, ay], [bx, by], ref(i), ref(endIndex));
    }
  });
}

/**
 * Whether a row has edges (a line, a polygon and their `Multi`, as `hasSnapEdges` says of a
 * feature)
 *
 * @internal
 */
export function rowHasEdges(type: FeatureType): boolean {
  return (
    type === 'LineString' ||
    type === 'Polygon' ||
    type === 'MultiLineString' ||
    type === 'MultiPolygon'
  );
}

/** The lines and rings of a row with their references, as `forEachPart` lists a feature */
function forEachRowPart(
  row: SnapRow,
  visit: (run: PositionRun, ring: number, part: number | undefined, isRing: boolean) => void,
): void {
  switch (row.type) {
    case 'LineString': {
      const run = row.parts[0]?.[0];
      if (run) visit(run, 0, undefined, false);
      return;
    }
    case 'Polygon':
      (row.parts[0] ?? []).forEach((run, ring) => {
        visit(run, ring, undefined, true);
      });
      return;
    case 'MultiLineString':
      (row.parts[0] ?? []).forEach((run, part) => {
        visit(run, 0, part, false);
      });
      return;
    case 'MultiPolygon':
      row.parts.forEach((rings, part) => {
        rings.forEach((run, ring) => {
          visit(run, ring, part, true);
        });
      });
      return;
  }
}

/** Whether a run is closed (its last position is its first) */
function closed(run: PositionRun): boolean {
  if (run.length === 0) return false;
  const last = run.length - 1;
  return run.x(0) === run.x(last) && run.y(0) === run.y(last);
}
