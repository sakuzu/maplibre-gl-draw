// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The edits of the sketches (`SketchEdit`), as pure functions: their checks, the features and the
 * vertices they name, what is left of them when some of those are gone, and the edits of features
 * they are made into to be shown and written
 *
 * A sketch holds its edits as they were given, the vertices of a Store that gives its vertices IDs
 * by those IDs (made from their places when the sketch is added). To be shown and written, the
 * edits of `{ selection: true }` name the features selected, and the vertices are found where they
 * are now.
 */

import type { Geometry } from 'geojson';
import type { SketchEdit } from '../api/sketches.js';
import { DrawError } from '../shared/draw-error.js';
import { checkEdits, isTransformEdit } from '../store/feature-edits.js';
import type {
  FeatureEdit,
  GeometryTransforms,
  TransformEdit,
  VertexTarget,
} from '../store/store.js';
import type { VertexRef } from '../store/types.js';

/** The edit of a sketch that draws a new feature */
export type CreateEdit = Extract<SketchEdit, { kind: 'create' }>;

/** The edits of features that move, rotate and scale them */
type FeaturesEdit = Extract<FeatureEdit, { kind: TransformEdit['kind'] }>;

/** The edits of the vertices of one feature */
type VertexEdit = Extract<FeatureEdit, { kind: 'vertex-move' | 'vertex-insert' | 'vertex-delete' }>;

/** The keys of an edit `create` */
const CREATE_KEYS: readonly string[] = [
  'kind',
  'feature',
  'placedVertexCount',
  'highlightedVertexIndex',
  'below',
];

/** A place of a vertex that stands for an ID of a vertex while the shape of an edit is checked */
const ID_PROBE: VertexRef = { ring: 0, index: 0 };

/**
 * Whether an edit of a sketch draws a new feature
 *
 * @internal
 */
export function isCreateEdit(edit: SketchEdit): edit is CreateEdit {
  return edit.kind === 'create';
}

/**
 * Whether an edit names the features selected (`{ selection: true }`)
 *
 * @internal
 */
export function isSelectionEdit(edit: SketchEdit): boolean {
  return (
    isTransformEdit(edit as FeatureEdit) &&
    (edit as FeaturesEdit).target !== null &&
    typeof (edit as FeaturesEdit).target === 'object' &&
    (edit as { target: { selection?: unknown } }).target.selection === true
  );
}

/**
 * Checks the edits of a sketch, each as its kind takes it, before anything is changed
 *
 * The edits of features are checked as a Store takes them (`checkEdits`), with the features
 * selected for `{ selection: true }` and, for a Store that gives its vertices IDs, the IDs of
 * vertices taken. The feature of a `create` is checked when it is made (`prepareFeature`).
 *
 * @param vertexIds Whether the Store gives its vertices IDs (an ID of a vertex is taken then)
 * @throws DrawError `invalid-input` when an edit has the wrong shape or values the computation
 *   does not take
 * @internal
 */
export function checkSketchEdits(
  edits: unknown,
  vertexIds: boolean,
  transforms: GeometryTransforms,
): asserts edits is readonly SketchEdit[] {
  if (!Array.isArray(edits)) throw invalidInput('The edits must be an array');
  for (const edit of edits) {
    if (!isRecord(edit)) throw invalidInput('Each edit must be an object');
    if (edit.kind === 'create') {
      checkCreate(edit);
      continue;
    }
    checkEdits([probeOf(edit as unknown as FeatureEdit, vertexIds)], transforms);
  }
}

/** Checks the shape of an edit `create` (its feature is checked when it is made) */
function checkCreate(edit: Record<string, unknown>): void {
  for (const key of Object.keys(edit)) {
    if (!CREATE_KEYS.includes(key)) throw invalidInput(`An edit create cannot have the key ${key}`);
  }
  if (!isRecord(edit.feature))
    throw invalidInput('The feature of an edit create must be an object');
  if (!isIndex(edit.placedVertexCount)) {
    throw invalidInput('placedVertexCount must be an integer from 0');
  }
  if (edit.highlightedVertexIndex !== undefined && !isIndex(edit.highlightedVertexIndex)) {
    throw invalidInput('highlightedVertexIndex must be an integer from 0');
  }
  if (edit.below !== null && (typeof edit.below !== 'string' || edit.below === '')) {
    throw invalidInput('below must be the ID of an item, or null');
  }
}

/**
 * The edit a Store would take for the shape of an edit of a sketch: the selection as no feature
 * yet, and the IDs of vertices as a place
 */
function probeOf(edit: FeatureEdit, vertexIds: boolean): FeatureEdit {
  let probe = edit;
  if (isRecord(edit) && isTransformEdit(edit)) {
    const target = (edit as FeaturesEdit).target as unknown;
    if (isRecord(target) && 'selection' in target) {
      if (target.selection !== true || Object.keys(target).length !== 1) {
        throw invalidInput('target must be { featureIds } or { selection: true }');
      }
      probe = { ...edit, target: { featureIds: [] } } as FeatureEdit;
    }
    return probe;
  }
  if (!vertexIds || !isRecord(edit)) return probe;
  const asPlace = (vertex: unknown): unknown => {
    if (typeof vertex !== 'string') return vertex;
    if (vertex === '') throw invalidInput('The ID of a vertex must be a non-empty string');
    return ID_PROBE;
  };
  const record = edit as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { ...record };
  if (Array.isArray(record.vertices)) out.vertices = record.vertices.map(asPlace);
  if (record.after !== undefined) out.after = asPlace(record.after);
  if (record.before !== undefined) out.before = asPlace(record.before);
  return out as unknown as FeatureEdit;
}

/**
 * The features an edit names: its feature, the features of its target (the ones `selected`
 * gives for `{ selection: true }`), none for `create`
 *
 * @internal
 */
export function featureIdsOfEdit(
  edit: SketchEdit,
  selected: () => readonly string[],
): readonly string[] {
  if (edit.kind === 'create') return [];
  if (!isTransformEdit(edit)) return [edit.featureId];
  if (isSelectionEdit(edit)) return selected();
  return (edit.target as { featureIds: readonly string[] }).featureIds;
}

/**
 * Whether an edit edits vertices of a feature
 *
 * @internal
 */
export function isVertexEdit(edit: SketchEdit): edit is VertexEdit {
  return (
    edit.kind === 'vertex-move' || edit.kind === 'vertex-insert' || edit.kind === 'vertex-delete'
  );
}

/**
 * The edits without the ones of the features gone: an edit of one of them is left out, and a
 * feature gone is taken out of the features an edit moves, rotates or scales (the edit left out
 * once it names none). Each edit of a feature left out counts once
 *
 * @internal
 */
export function withoutFeatures(
  edits: readonly SketchEdit[],
  gone: ReadonlySet<string>,
): { edits: SketchEdit[]; dropped: number } {
  const out: SketchEdit[] = [];
  let dropped = 0;
  for (const edit of edits) {
    if (edit.kind === 'create' || isSelectionEdit(edit)) {
      out.push(edit);
      continue;
    }
    if (!isTransformEdit(edit)) {
      if (gone.has(edit.featureId)) dropped++;
      else out.push(edit);
      continue;
    }
    const ids = (edit.target as { featureIds: readonly string[] }).featureIds;
    const kept = ids.filter((id) => !gone.has(id));
    dropped += ids.length - kept.length;
    if (kept.length === ids.length) out.push(edit);
    else if (kept.length > 0) out.push({ ...edit, target: { featureIds: kept } } as SketchEdit);
  }
  return { edits: out, dropped };
}

/**
 * The edits with the vertices of a feature that `keep` leaves out taken away: a vertex moved or
 * deleted goes from its edit (the edit left out once it names none), and a vertex inserted next
 * to a vertex left out is left out. Each vertex left out counts once
 *
 * @internal
 */
export function withoutVertices(
  edits: readonly SketchEdit[],
  featureId: string,
  keep: (vertex: VertexTarget) => boolean,
): { edits: SketchEdit[]; dropped: number } {
  const out: SketchEdit[] = [];
  let dropped = 0;
  for (const edit of edits) {
    if (!isVertexEdit(edit) || edit.featureId !== featureId) {
      out.push(edit);
      continue;
    }
    if (edit.kind === 'vertex-insert') {
      if (keep((edit.after ?? edit.before) as VertexTarget)) out.push(edit);
      else dropped++;
      continue;
    }
    const kept: number[] = [];
    edit.vertices.forEach((vertex, i) => {
      if (keep(vertex)) kept.push(i);
    });
    dropped += edit.vertices.length - kept.length;
    if (kept.length === edit.vertices.length) out.push(edit);
    else if (kept.length > 0) out.push(keptVertices(edit, kept));
  }
  return { edits: out, dropped };
}

/** An edit of vertices with the vertices at the indices given only */
function keptVertices(
  edit: Extract<VertexEdit, { kind: 'vertex-move' | 'vertex-delete' }>,
  kept: readonly number[],
): SketchEdit {
  const vertices = kept.map((i) => edit.vertices[i]);
  if (edit.kind === 'vertex-delete') return { ...edit, vertices };
  return { ...edit, vertices, positions: kept.map((i) => edit.positions[i]) };
}

/**
 * The vertices the vertex edits of a feature name, in their order (each target once per place it
 * is named)
 *
 * @internal
 */
export function verticesOf(edits: readonly SketchEdit[], featureId: string): VertexTarget[] {
  const out: VertexTarget[] = [];
  for (const edit of edits) {
    if (!isVertexEdit(edit) || edit.featureId !== featureId) continue;
    if (edit.kind === 'vertex-insert') out.push((edit.after ?? edit.before) as VertexTarget);
    else out.push(...edit.vertices);
  }
  return out;
}

/**
 * The edits with each vertex of a feature replaced by what `replace` gives for it (an ID for a
 * place, or a place for an ID)
 *
 * @internal
 */
export function mapVertices(
  edits: readonly SketchEdit[],
  featureId: string,
  replace: (vertex: VertexTarget) => VertexTarget,
): SketchEdit[] {
  return edits.map((edit) => {
    if (!isVertexEdit(edit) || edit.featureId !== featureId) return edit;
    if (edit.kind === 'vertex-insert') {
      return edit.after !== undefined
        ? { ...edit, after: replace(edit.after) }
        : { ...edit, before: replace(edit.before as VertexTarget) };
    }
    return { ...edit, vertices: edit.vertices.map(replace) };
  });
}

/**
 * The features each vertex edit names
 *
 * @internal
 */
export function vertexFeatureIds(edits: readonly SketchEdit[]): Set<string> {
  const out = new Set<string>();
  for (const edit of edits) if (isVertexEdit(edit)) out.add(edit.featureId);
  return out;
}

/**
 * The shape of the vertices of a geometry: its parts, rings and the number of positions of each,
 * not where they are. The places of the vertices of a Store that gives them no IDs name the same
 * vertices while it stays the same
 *
 * @internal
 */
export function vertexShapeOf(geometry: Geometry): string {
  if (geometry.type === 'GeometryCollection') {
    return `(${geometry.geometries.map(vertexShapeOf).join(';')})`;
  }
  return `${geometry.type}:${shapeOf(geometry.coordinates as unknown[])}`;
}

/** The shape of nested coordinates: the number of positions of each innermost list */
function shapeOf(coordinates: unknown[]): string {
  if (coordinates.length === 0) return '0';
  if (typeof coordinates[0] === 'number') return 'p';
  if (Array.isArray(coordinates[0]) && typeof (coordinates[0] as unknown[])[0] === 'number') {
    return String(coordinates.length);
  }
  return `[${coordinates.map((child) => shapeOf(child as unknown[])).join(',')}]`;
}

/**
 * The edits of features a set of edits of a sketch is made into, to be shown or written: the edits
 * `create` left out, `{ selection: true }` made the features `selected` gives (the edit left out
 * when they are none), and the vertices of a feature found by `findVertex` (an edit of a vertex
 * not found left out, as the Store leaves out an edit of a feature that is not there)
 *
 * @internal
 */
export function featureEditsOf(
  edits: readonly SketchEdit[],
  selected: () => readonly string[],
  findVertex?: (featureId: string, vertices: readonly VertexTarget[]) => (VertexRef | null)[],
): FeatureEdit[] {
  const out: FeatureEdit[] = [];
  let resolved = edits;
  if (findVertex) {
    for (const featureId of vertexFeatureIds(edits)) {
      const targets = verticesOf(resolved, featureId);
      const places = findVertex(featureId, targets);
      const placeOf = new Map<VertexTarget, VertexRef | null>();
      targets.forEach((target, i) => {
        placeOf.set(target, places[i] ?? null);
      });
      resolved = withoutVertices(
        resolved,
        featureId,
        (vertex) => placeOf.get(vertex) != null,
      ).edits;
      resolved = mapVertices(resolved, featureId, (vertex) => placeOf.get(vertex) as VertexRef);
    }
  }
  for (const edit of resolved) {
    if (edit.kind === 'create') continue;
    if (isSelectionEdit(edit)) {
      const ids = selected();
      if (ids.length > 0) out.push({ ...edit, target: { featureIds: ids } } as FeatureEdit);
      continue;
    }
    out.push(edit);
  }
  return out;
}

/** The error for an input of the wrong shape or value */
function invalidInput(message: string): DrawError {
  return new DrawError('invalid-input', message);
}

/** Whether the value is a plain object (not null, not an array) */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether the value is an integer from 0 */
function isIndex(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
