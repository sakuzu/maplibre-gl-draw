// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Whether a geometry is another one moved as a whole: every position moved by the same
 * translation
 *
 * A move of many rows held as features (a drag of a selection) writes every row in every frame.
 * When the geometry written is the one the row holds moved as a whole, the row is not written:
 * it is drawn moved by the state of its row and the translation of its moving set, and written
 * once the move ends.
 */

import type { Geometry } from 'geojson';

/**
 * How far a position may be from where the translation puts it (in the units of the positions):
 * a translation found from the first position and added to the others may round a little
 * differently from the one that moved them
 */
const TRANSLATION_TOLERANCE = 1e-9;

/**
 * The translation that moves every position of a geometry to the one of another, `[dx, dy]`
 *
 * @returns The translation, or null when the two are not one geometry moved as a whole (another
 *   shape, another number of positions, another elevation, or positions moved differently)
 * @internal
 */
export function translationBetween(
  before: Geometry | null | undefined,
  after: Geometry | null | undefined,
): [number, number] | null {
  if (!before || !after || before.type !== after.type) return null;
  const found = { dx: Number.NaN, dy: Number.NaN };
  if (!sameMove(before, after, found)) return null;
  // A geometry without positions is not moved
  if (Number.isNaN(found.dx)) return null;
  return [found.dx, found.dy];
}

/** Whether every position of `after` is the one of `before` moved by one translation */
function sameMove(before: Geometry, after: Geometry, found: { dx: number; dy: number }): boolean {
  if (before.type === 'GeometryCollection') {
    if (after.type !== 'GeometryCollection') return false;
    if (before.geometries.length !== after.geometries.length) return false;
    for (let i = 0; i < before.geometries.length; i++) {
      const a = before.geometries[i];
      const b = after.geometries[i];
      if (a.type !== b.type || !sameMove(a, b, found)) return false;
    }
    return true;
  }
  if (after.type === 'GeometryCollection') return false;
  return samePositions(before.coordinates, after.coordinates, found);
}

/** Whether nested arrays of positions are the same shape, moved by one translation */
function samePositions(
  before: unknown,
  after: unknown,
  found: { dx: number; dy: number },
): boolean {
  if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length) {
    return false;
  }
  if (before.length === 0) return true;
  if (typeof before[0] === 'number') {
    if (typeof after[0] !== 'number') return false;
    // A position: its elevation (and anything after it) does not move
    for (let k = 2; k < before.length; k++) if (before[k] !== after[k]) return false;
    const dx = (after[0] as number) - (before[0] as number);
    const dy = (after[1] as number) - (before[1] as number);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
    if (Number.isNaN(found.dx)) {
      found.dx = dx;
      found.dy = dy;
      return true;
    }
    return (
      Math.abs(dx - found.dx) <= TRANSLATION_TOLERANCE &&
      Math.abs(dy - found.dy) <= TRANSLATION_TOLERANCE
    );
  }
  for (let i = 0; i < before.length; i++) {
    if (!samePositions(before[i], after[i], found)) return false;
  }
  return true;
}
