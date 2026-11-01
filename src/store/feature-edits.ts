// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The edits of features a Store applies (`Store.applyEdits`), made into the updates of the
 * features
 *
 * A patch is merged into the feature here, for the edits and for `features.update` alike: the
 * keys of `properties` and `style` one by one (a key given as `undefined` is removed), the
 * other fields whole. The edits of the vertices change the coordinates through
 * `shared/utils/vertex-edits.ts`, as the vertex operations of the select mode do, and write the
 * geometry whole.
 *
 * The edits that move, rotate and scale features (`translate`, `rotate`, `scale`) are computed by
 * the computation of the Store (`Store.transforms`), or by the one of the library
 * (`geometry/enu-transforms.ts`) for a Store without it, over the geometry and the fields of the
 * roles of each feature (`transform-roles.ts`).
 *
 * Everything is checked before anything is written: an edit that cannot apply throws a
 * DrawError `invalid-input`, and the Store writes none of the edits then.
 */

import type { Value } from '@sakuzu/tabane';
import type { Geometry } from 'geojson';
import { acceptsEnuEdit, applyEnuEdit } from '../geometry/enu-transforms.js';
import { DrawError } from '../shared/draw-error.js';
import { describeGeometryProblem } from '../shared/geometry-validation.js';
import { describeStyleProblem } from '../shared/style-validation.js';
import { coordinatesOf } from '../shared/utils/coordinates.js';
import { setOwnProperty } from '../shared/utils/own-property.js';
import {
  deleteVertexAt,
  insertVertexAt,
  isClosedRing,
  isVertexOf,
  setVertices,
  sortVertexRefsForDeletion,
} from '../shared/utils/vertex-edits.js';
import { getVertexPart } from '../shared/utils/vertex-ref.js';
import { drawValueOfInput } from '../table/value-input.js';
import type {
  FeatureEdit,
  FeaturePatch,
  GeometryTransforms,
  TransformEdit,
  TransformValues,
  VertexTarget,
} from './store.js';
import {
  roleFieldsOf,
  type TransformFieldsRegistry,
  type TransformRoles,
  transformEditOf,
  transformRolesOf,
  transformValuesOf,
} from './transform-roles.js';
import type { Coordinate, Feature, FeatureCoordinates, FeatureStyle, VertexRef } from './types.js';

/** The keys a patch may have */
const PATCH_KEYS: readonly string[] = ['geometry', 'properties', 'style', 'visible', 'locked'];

/** The keys an edit of each kind may have */
const EDIT_KEYS: Readonly<Record<FeatureEdit['kind'], readonly string[]>> = {
  set: ['kind', 'featureId', 'patch'],
  'vertex-move': ['kind', 'featureId', 'vertices', 'positions'],
  'vertex-insert': ['kind', 'featureId', 'after', 'before', 'position'],
  'vertex-delete': ['kind', 'featureId', 'vertices'],
  translate: ['kind', 'target', 'from', 'to'],
  rotate: ['kind', 'target', 'center', 'angleDegrees'],
  scale: ['kind', 'target', 'center', 'eastFactor', 'northFactor', 'sizeFactor'],
};

/**
 * The computation of the edits that move, rotate and scale features for a Store that gives none
 *
 * @internal
 */
export const DEFAULT_TRANSFORMS: GeometryTransforms = {
  accepts: acceptsEnuEdit,
  apply: applyEnuEdit,
};

/** The edits that move, rotate and scale features */
type FeaturesEdit = Extract<FeatureEdit, { kind: TransformEdit['kind'] }>;

/** The edits of one feature */
type OneFeatureEdit = Exclude<FeatureEdit, FeaturesEdit>;

/**
 * Whether an edit moves, rotates or scales features
 *
 * @internal
 */
export function isTransformEdit(edit: FeatureEdit): edit is FeaturesEdit {
  return edit.kind === 'translate' || edit.kind === 'rotate' || edit.kind === 'scale';
}

/**
 * Whether edits hold an edit that moves, rotates or scales features (an edit of a wrong shape is
 * not one)
 *
 * @internal
 */
export function hasTransformEdits(edits: readonly FeatureEdit[]): boolean {
  if (!Array.isArray(edits)) return false;
  for (const edit of edits) {
    const kind = isRecord(edit) ? edit.kind : undefined;
    if (kind === 'translate' || kind === 'rotate' || kind === 'scale') return true;
  }
  return false;
}

/**
 * The IDs of the features of an edit that moves, rotates or scales features (checked)
 *
 * @internal
 */
export function featureIdsOf(edit: FeaturesEdit): readonly string[] {
  return (edit.target as { featureIds: readonly string[] }).featureIds;
}

/**
 * Checks edits, each as its kind takes it and the edits that move, rotate and scale features
 * as the computation takes them, before any is applied
 *
 * @returns The edit each of those gives its computation, at its index (undefined for the others)
 * @throws DrawError `invalid-input` when an edit cannot apply
 * @internal
 */
export function checkEdits(
  edits: readonly FeatureEdit[],
  transforms: GeometryTransforms,
): Array<TransformEdit | undefined> {
  if (!Array.isArray(edits)) throw invalidInput('The edits must be an array');
  return edits.map((edit) => {
    checkEdit(edit);
    if (!isTransformEdit(edit)) return undefined;
    const computed = transformEditOf(edit);
    if (!transforms.accepts(computed)) {
      throw invalidInput(`The edit ${edit.kind} has values the Store does not take`, {
        edit: computed,
      });
    }
    return computed;
  });
}

/**
 * The fields an edit that moves, rotates or scales features writes over one of them: its
 * geometry and the keys of `properties` of its roles (none when it changes nothing)
 *
 * @param type The type of the feature
 * @param read Reads a key of its `properties` (undefined for a key that is not there)
 * @param fields The fields the custom types of the instance declare
 * @throws DrawError `invalid-input` when the computation gives a geometry the feature cannot have
 * @internal
 */
export function transformedFields(
  transforms: GeometryTransforms,
  edit: TransformEdit,
  id: string,
  type: string,
  geometry: Geometry,
  read: (key: string) => unknown,
  fields?: TransformFieldsRegistry | null,
): { geometry: Geometry | undefined; properties: Array<[string, number]> } | null {
  const roles: TransformRoles = transformRolesOf(type, (key) => read(key) !== undefined, fields);
  const before: TransformValues = transformValuesOf(geometry, roles, read);
  const after = transforms.apply(edit, before);
  if (after === before) return null;
  const moved = after.geometry !== geometry ? after.geometry : undefined;
  if (moved !== undefined) {
    const problem = describeGeometryProblem(type, moved);
    if (problem) {
      throw invalidInput(`The edit ${edit.kind} gives the feature ${id} ${problem}`, { id });
    }
  }
  const properties = roleFieldsOf(roles, before, after);
  if (moved === undefined && properties.length === 0) return null;
  return { geometry: moved, properties };
}

/** The kinds of the edits */
const EDIT_KINDS: ReadonlySet<string> = new Set(Object.keys(EDIT_KEYS));

/** The kinds of coordinates whose lines and rings take a vertex inserted */
const LINE_KINDS: ReadonlySet<string> = new Set([
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
]);

/**
 * The update of a feature an edit makes
 *
 * @internal
 */
export interface FeatureUpdate {
  /** The ID of the feature */
  readonly id: string;
  /** The fields written */
  readonly updates: Partial<Feature>;
}

/**
 * Checks edits and makes them into the updates of the features, in their order: each edit over
 * the feature as the edits before it leave it
 *
 * An edit of a feature `getFeature` does not find is left out and counted.
 *
 * @param fields The fields the custom types of the instance declare
 * @throws DrawError `invalid-input` when an edit cannot apply
 * @internal
 */
export function updatesOfEdits(
  edits: readonly FeatureEdit[],
  getFeature: (id: string) => Feature | undefined,
  transforms: GeometryTransforms = DEFAULT_TRANSFORMS,
  fields?: TransformFieldsRegistry | null,
): { updates: FeatureUpdate[]; dropped: number } {
  const computed = checkEdits(edits, transforms);
  // The features as the edits before leave them
  const edited = new Map<string, Feature>();
  const updates: FeatureUpdate[] = [];
  let dropped = 0;
  edits.forEach((edit, i) => {
    if (!isTransformEdit(edit)) {
      const feature = edited.get(edit.featureId) ?? getFeature(edit.featureId);
      if (!feature) {
        dropped++;
        return;
      }
      const fields = featureUpdatesOfEdit(feature, edit);
      edited.set(feature.id, { ...feature, ...fields });
      updates.push({ id: feature.id, updates: fields });
      return;
    }
    const transform = computed[i] as TransformEdit;
    for (const id of featureIdsOf(edit)) {
      const feature = edited.get(id) ?? getFeature(id);
      if (!feature) {
        dropped++;
        continue;
      }
      const written = transformedFeatureFields(transforms, transform, feature, fields);
      if (!written) continue;
      edited.set(feature.id, { ...feature, ...written });
      updates.push({ id: feature.id, updates: written });
    }
  });
  return { updates, dropped };
}

/**
 * The fields an edit of one feature writes over it
 *
 * @throws DrawError `invalid-input` when it cannot apply
 * @internal
 */
export function featureUpdatesOfEdit(feature: Feature, edit: OneFeatureEdit): Partial<Feature> {
  return edit.kind === 'set'
    ? featureUpdatesOfPatch(feature, edit.patch)
    : { geometry: editedGeometry(feature, edit) };
}

/**
 * The fields an edit that moves, rotates or scales features writes over one of them (null when
 * it changes nothing)
 *
 * @param fields The fields the custom types of the instance declare
 * @throws DrawError `invalid-input` when the computation gives a geometry the feature cannot have
 * @internal
 */
export function transformedFeatureFields(
  transforms: GeometryTransforms,
  edit: TransformEdit,
  feature: Feature,
  fields?: TransformFieldsRegistry | null,
): Partial<Feature> | null {
  const properties = (feature.properties ?? {}) as Record<string, unknown>;
  const written = transformedFields(
    transforms,
    edit,
    feature.id,
    feature.type,
    feature.geometry,
    (key) => (key in properties ? properties[key] : undefined),
    fields,
  );
  if (!written) return null;
  const out: Partial<Feature> = {};
  if (written.geometry !== undefined) out.geometry = written.geometry;
  if (written.properties.length > 0) {
    const next: Record<string, Value> = { ...(properties as Record<string, Value>) };
    for (const [key, value] of written.properties) setOwnProperty(next, key, value);
    out.properties = next;
  }
  return out;
}

/**
 * Checks a patch and makes the fields written from it over a feature: the keys of `properties`
 * and `style` merged into the ones of the feature, the other fields given whole
 *
 * @throws DrawError `invalid-input` on a wrong patch
 * @internal
 */
export function featureUpdatesOfPatch(feature: Feature, patch: FeaturePatch): Partial<Feature> {
  const record = patch as unknown as Record<string, unknown>;
  if (!isRecord(record)) throw invalidInput('The patch must be an object');
  onlyKeys(record, PATCH_KEYS, 'The patch');
  optionalBoolean(record, 'visible');
  optionalBoolean(record, 'locked');
  const updates: Partial<Feature> = {};
  if (patch.geometry !== undefined) {
    const problem = describeGeometryProblem(feature.type, patch.geometry);
    if (problem) throw invalidInput(`The patch has ${problem}`);
    updates.geometry = patch.geometry;
  }
  if (patch.properties !== undefined) {
    if (!isRecord(patch.properties)) throw invalidInput('properties must be an object');
    updates.properties = mergedKeys(
      feature.properties,
      propertiesPatchOf(patch.properties as Record<string, unknown>),
    ) as Record<string, Value>;
  }
  if (patch.style !== undefined) {
    const problem = describeStyleProblem(patch.style);
    if (problem) throw invalidInput(`The patch has ${problem}`);
    updates.style = mergedKeys(
      feature.style as Record<string, unknown>,
      patch.style as Record<string, unknown>,
    ) as FeatureStyle;
  }
  if (patch.visible !== undefined) updates.visible = patch.visible;
  if (patch.locked !== undefined) updates.locked = patch.locked;
  return updates;
}

/**
 * The keys of `base` with the keys of `patch` set, and removed where they are undefined
 *
 * @internal
 */
export function mergedKeys(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) setOwnProperty(result, key, value);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete result[key];
    else setOwnProperty(result, key, value);
  }
  return result;
}

/**
 * A patch of properties with each value in the one form of a value; undefined stays, to take
 * the key off
 *
 * @throws DrawError `invalid-input` when a value is not a value
 * @internal
 */
export function propertiesPatchOf(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    setOwnProperty(
      out,
      key,
      value === undefined ? undefined : drawValueOfInput(value, `The property ${key}`),
    );
  }
  return out;
}

// ============================================================================
// The checks of an edit that do not read its feature
// ============================================================================

/** Checks the shape of an edit */
function checkEdit(edit: FeatureEdit): void {
  if (!isRecord(edit)) throw invalidInput('Each edit must be an object');
  const record = edit as unknown as Record<string, unknown>;
  const kind = record.kind;
  if (typeof kind !== 'string' || !EDIT_KINDS.has(kind)) {
    throw invalidInput(`An edit cannot have the kind ${JSON.stringify(kind)}`);
  }
  onlyKeys(record, EDIT_KEYS[kind as FeatureEdit['kind']], `An edit ${kind}`);
  if (isTransformEdit(edit)) {
    checkTransformEdit(edit);
    return;
  }
  if (typeof record.featureId !== 'string' || record.featureId === '') {
    throw invalidInput('featureId must be a non-empty string');
  }
  switch (edit.kind) {
    case 'set':
      if (!isRecord(edit.patch)) throw invalidInput('The patch must be an object');
      return;
    case 'vertex-move':
      checkVertices(edit.vertices);
      if (!Array.isArray(edit.positions) || edit.positions.length !== edit.vertices.length) {
        throw invalidInput('positions must be an array with a position for each vertex');
      }
      for (const position of edit.positions) checkPosition(position);
      return;
    case 'vertex-insert': {
      const { after, before } = edit;
      if ((after === undefined) === (before === undefined)) {
        throw invalidInput('An edit vertex-insert has exactly one of after and before');
      }
      checkVertex((after ?? before) as VertexTarget);
      checkPosition(edit.position);
      return;
    }
    case 'vertex-delete':
      checkVertices(edit.vertices);
      return;
  }
}

/**
 * Checks the shape of an edit that moves, rotates or scales features: its features by their IDs,
 * each once, its points two numbers or more, its angle and its factors numbers (their ranges are
 * the ones of the computation)
 */
function checkTransformEdit(edit: FeaturesEdit): void {
  const target = edit.target as unknown;
  if (!isRecord(target)) throw invalidInput('target must be { featureIds }');
  if ('selection' in target) {
    throw invalidInput(
      'The Store takes the features of an edit by their IDs ({ featureIds }), not the selection',
    );
  }
  onlyKeys(target, ['featureIds'], 'target');
  const ids = target.featureIds;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || id === '')) {
    throw invalidInput('featureIds must be an array of non-empty strings');
  }
  if (new Set(ids).size !== ids.length) throw invalidInput('featureIds names a feature twice');
  switch (edit.kind) {
    case 'translate':
      checkEditPoint(edit.from, 'from');
      checkEditPoint(edit.to, 'to');
      return;
    case 'rotate':
      checkEditPoint(edit.center, 'center');
      checkNumber(edit.angleDegrees, 'angleDegrees');
      return;
    case 'scale':
      checkEditPoint(edit.center, 'center');
      checkNumber(edit.eastFactor, 'eastFactor');
      checkNumber(edit.northFactor, 'northFactor');
      checkNumber(edit.sizeFactor, 'sizeFactor');
      return;
  }
}

/** Checks a point of an edit that moves, rotates or scales features: two numbers or more */
function checkEditPoint(point: unknown, name: string): void {
  if (
    !Array.isArray(point) ||
    point.length < 2 ||
    point.some((value) => typeof value !== 'number')
  ) {
    throw invalidInput(`${name} must be [longitude, latitude], numbers`);
  }
}

/** Checks a value of an edit that must be a number */
function checkNumber(value: unknown, name: string): void {
  if (typeof value !== 'number') throw invalidInput(`${name} must be a number`);
}

/** Checks the vertices of an edit: a non-empty array of places of vertices */
function checkVertices(vertices: readonly VertexTarget[]): void {
  if (!Array.isArray(vertices) || vertices.length === 0) {
    throw invalidInput('vertices must be a non-empty array');
  }
  for (const vertex of vertices) checkVertex(vertex);
}

/**
 * Checks a vertex of an edit: the place of a vertex (the Stores here give their vertices no
 * IDs)
 */
function checkVertex(vertex: VertexTarget): asserts vertex is VertexRef {
  if (typeof vertex === 'string') {
    throw invalidInput(
      'The Store takes a vertex by its place ({ part, ring, index }), not by an ID',
      { vertex },
    );
  }
  if (
    !isRecord(vertex) ||
    !isIndex(vertex.ring) ||
    !isIndex(vertex.index) ||
    (vertex.part !== undefined && !isIndex(vertex.part))
  ) {
    throw invalidInput(
      'A vertex must be { part, ring, index }, integers from 0 (part may be left out)',
    );
  }
}

/** Checks a position of an edit: two finite numbers */
function checkPosition(position: unknown): asserts position is Coordinate {
  if (
    !Array.isArray(position) ||
    position.length !== 2 ||
    position.some((value) => typeof value !== 'number' || !Number.isFinite(value))
  ) {
    throw invalidInput('A position must be [longitude, latitude], two finite numbers');
  }
}

// ============================================================================
// The edits of the vertices
// ============================================================================

/** The edits of the vertices */
type VertexEdit = Exclude<OneFeatureEdit, { kind: 'set' }>;

/**
 * The geometry an edit of the vertices leaves the feature with
 *
 * @throws DrawError `invalid-input` when a vertex is not one of the feature, or the edit leaves
 *   a line or a ring with too few positions
 */
function editedGeometry(feature: Feature, edit: VertexEdit): Geometry {
  const kind = feature.geometry.type;
  const coordinates = coordinatesOf(feature);
  const vertexOf = (vertex: VertexTarget): VertexRef => {
    const ref = vertex as VertexRef;
    if (!isVertexOf(kind, coordinates, ref)) {
      throw invalidInput(`The feature ${feature.id} has no vertex ${JSON.stringify(ref)}`, {
        id: feature.id,
        vertex: ref,
      });
    }
    return ref;
  };
  let edited: FeatureCoordinates;
  switch (edit.kind) {
    case 'vertex-move':
      edited = movedVertices(
        kind,
        coordinates,
        edit.vertices.map(vertexOf),
        edit.positions as readonly Coordinate[],
      );
      break;
    case 'vertex-insert': {
      if (!LINE_KINDS.has(kind)) {
        throw invalidInput(`A vertex cannot be inserted into a ${kind} geometry`);
      }
      const after = edit.after === undefined ? undefined : vertexOf(edit.after);
      const before = edit.before === undefined ? undefined : vertexOf(edit.before);
      edited = insertedVertex(
        kind,
        coordinates,
        (after ?? before) as VertexRef,
        after !== undefined,
        edit.position as Coordinate,
      );
      break;
    }
    case 'vertex-delete': {
      const result = deletedVertices(kind, coordinates, edit.vertices.map(vertexOf));
      if (!result) {
        throw invalidInput(
          `The vertices cannot be deleted from the feature ${feature.id}: a line or a ring ` +
            'would be left with too few positions, or a point with none',
          { id: feature.id },
        );
      }
      edited = result;
      break;
    }
  }
  return { type: kind, coordinates: edited } as Geometry;
}

/**
 * The line or ring a vertex is in, when it is a closed ring of a polygon (its first and last
 * positions are one vertex), or null
 */
function closedRingOf(
  kind: string,
  coordinates: FeatureCoordinates,
  ref: VertexRef,
): Coordinate[] | null {
  let ring: Coordinate[] | undefined;
  if (kind === 'Polygon') ring = (coordinates as Coordinate[][])[ref.ring];
  else if (kind === 'MultiPolygon') {
    ring = (coordinates as Coordinate[][][])[getVertexPart(ref)]?.[ref.ring];
  }
  return ring && isClosedRing(ring) ? ring : null;
}

/** A key of the vertex a reference names (the part left out read as 0) */
function vertexKey(ref: VertexRef): string {
  return `${getVertexPart(ref)}/${ref.ring}/${ref.index}`;
}

/**
 * The coordinates with the vertices put at the positions: both ends of a closed ring when one
 * of them is named
 *
 * @throws DrawError `invalid-input` when a vertex is given two different positions
 */
function movedVertices(
  kind: string,
  coordinates: FeatureCoordinates,
  vertices: readonly VertexRef[],
  positions: readonly Coordinate[],
): FeatureCoordinates {
  const refs: VertexRef[] = [];
  const at: Coordinate[] = [];
  const given = new Map<string, Coordinate>();
  vertices.forEach((ref, i) => {
    const position = positions[i];
    const ring = closedRingOf(kind, coordinates, ref);
    const last = ring ? ring.length - 1 : -1;
    const ends =
      ring && (ref.index === 0 || ref.index === last)
        ? [
            { ...ref, index: 0 },
            { ...ref, index: last },
          ]
        : [ref];
    for (const end of ends) {
      const key = vertexKey(end);
      const before = given.get(key);
      if (before && (before[0] !== position[0] || before[1] !== position[1])) {
        throw invalidInput(`The vertex ${JSON.stringify(ref)} is given two positions`);
      }
      given.set(key, position);
      refs.push(end);
      at.push(position);
    }
  });
  return setVertices(kind, coordinates, refs, at);
}

/**
 * The coordinates with a vertex inserted just after or just before a vertex. In a closed ring,
 * after the last position and before the first both insert between the last vertex and the
 * first
 */
function insertedVertex(
  kind: string,
  coordinates: FeatureCoordinates,
  ref: VertexRef,
  after: boolean,
  position: Coordinate,
): FeatureCoordinates {
  const ring = closedRingOf(kind, coordinates, ref);
  let index = after ? ref.index + 1 : ref.index;
  if (ring && after && ref.index === ring.length - 1) index = 1;
  if (ring && !after && ref.index === 0) index = ring.length - 1;
  return insertVertexAt(kind, coordinates, { ...ref, index }, [position[0], position[1]]);
}

/**
 * The coordinates with the vertices deleted (the last position of a closed ring deletes its
 * first vertex), or null when a line or a ring is left with too few positions, or the last
 * point of a MultiPoint or the vertex of a point would go
 */
function deletedVertices(
  kind: string,
  coordinates: FeatureCoordinates,
  vertices: readonly VertexRef[],
): FeatureCoordinates | null {
  const refs = new Map<string, VertexRef>();
  for (const ref of vertices) {
    const ring = closedRingOf(kind, coordinates, ref);
    const vertex = ring && ref.index === ring.length - 1 ? { ...ref, index: 0 } : ref;
    refs.set(vertexKey(vertex), vertex);
  }
  let edited: FeatureCoordinates | null = coordinates;
  for (const ref of sortVertexRefsForDeletion([...refs.values()])) {
    edited = deleteVertexAt(kind, edited, ref);
    if (!edited) return null;
  }
  return edited;
}

// ============================================================================
// Checks of the arguments
// ============================================================================

/** The error for an input of the wrong shape or value */
function invalidInput(message: string, details?: unknown): DrawError {
  return new DrawError('invalid-input', message, details);
}

/** Whether the value is a plain object (not null, not an array) */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether the value is an integer from 0 */
function isIndex(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Throws unless the keys of the object are all among the allowed ones */
function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw invalidInput(`${what} cannot have the key ${key}`);
  }
}

/** Throws unless the key of the object is absent or a boolean */
function optionalBoolean(value: Record<string, unknown>, key: string): void {
  if (key in value && value[key] !== undefined && typeof value[key] !== 'boolean') {
    throw invalidInput(`${key} must be a boolean`);
  }
}
