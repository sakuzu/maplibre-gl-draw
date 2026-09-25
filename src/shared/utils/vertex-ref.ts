// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Vertex reference utilities
 *
 * A vertex is pointed at by the triple of part number + ring number + vertex index
 * (VertexRef), so comparison and lookup use the functions here rather than numeric === or
 * Array#includes.
 *
 * part is optional, and when omitted it means 0 (the first part). The vertex reference of a
 * single geometry has no part, so comparison treats undefined and 0 as the same.
 */

import type { VertexRef } from '../types/model.js';

/**
 * Gets the part number of a vertex reference (0 when omitted)
 */
export function getVertexPart(ref: VertexRef): number {
  return ref.part ?? 0;
}

/**
 * Whether two vertex references point at the same vertex
 */
export function isSameVertexRef(a: VertexRef, b: VertexRef): boolean {
  return getVertexPart(a) === getVertexPart(b) && a.ring === b.ring && a.index === b.index;
}

/**
 * Whether an array of vertex references contains the given vertex
 */
export function hasVertexRef(refs: readonly VertexRef[], ref: VertexRef): boolean {
  return refs.some((r) => isSameVertexRef(r, ref));
}
