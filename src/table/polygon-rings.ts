// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The rings of a polygon as the fill and the outline draw them
 *
 * A ring is drawn without its closing coordinate (the one equal to the first), and a ring of
 * fewer than 3 coordinates has no area and is left out; when the outer ring is left out, so is
 * the whole polygon. The triangulation of a group and the packing of its vertices both read the
 * rings through these functions, so the indices of the triangles and the vertices they point to
 * cannot disagree. It is the same rule the drawing of a feature follows (its input of earcut).
 *
 * A pure module: it depends on nothing, so it runs in a Worker as well.
 */

/**
 * The runs of coordinates of the rings of one polygon as they are drawn
 *
 * @param coords The coordinates (interleaved)
 * @param stride The number of values per coordinate in `coords`
 * @param ringOffsets The offsets from a ring to its first coordinate
 * @param ringStart The first ring of the polygon
 * @param ringEnd The end of the rings of the polygon (exclusive)
 * @param out Receives `start, end` (the coordinates, end exclusive) of every ring drawn, outer
 *   ring first
 * @returns The number of coordinates of the rings drawn (0 when the polygon is left out)
 * @internal
 */
export function polygonRingRuns(
  coords: Float64Array,
  stride: number,
  ringOffsets: Int32Array,
  ringStart: number,
  ringEnd: number,
  out: number[],
): number {
  const mark = out.length;
  let total = 0;
  for (let r = ringStart; r < ringEnd; r++) {
    const start = ringOffsets[r];
    const end = openEnd(coords, stride, start, ringOffsets[r + 1]);
    if (end - start < 3) {
      if (r === ringStart) {
        out.length = mark;
        return 0;
      }
      continue;
    }
    out.push(start, end);
    total += end - start;
  }
  return total;
}

/**
 * The end of a ring without its closing coordinate
 *
 * @internal
 */
export function openEnd(coords: Float64Array, stride: number, start: number, end: number): number {
  if (end - start < 2) return end;
  const first = start * stride;
  const last = (end - 1) * stride;
  return coords[first] === coords[last] && coords[first + 1] === coords[last + 1] ? end - 1 : end;
}
