// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The moves, rotations and scalings of any number of features (the bulk edits `translate`,
 * `rotate` and `scale`): what an edit writes to each batch of its features
 *
 * - A batch is read from the rows of the Store as arrays, a run of the rows of one layer at a
 *   time: the positions as the Store gives them, and the fields of rotation, direction and size
 *   that the type of each feature declares (`FeatureTypeDefinition.transformFields`), or those
 *   of the built-in types (the rotation and the scale of an image, the radius of a circle). A
 *   definition that overrides a built-in type and declares fields gives them to the features it
 *   takes (`appliesTo`) in place of all those of the built-in type; one that declares none leaves
 *   those of the built-in type.
 * - A field a type declares and a feature does not hold (or holds as anything but a finite
 *   number) starts from 0 for a rotation and a direction, and from 1 for a size. A feature whose
 *   type declares no such field is given NaN there, and the field is not written.
 * - The computation (the provider set, or the built-in one) is called once per run with those
 *   arrays, so that it makes no object per feature, with the number of the operation of the edit
 *   in every call.
 * - The values after are written through the layer, feature by feature (`updateFeature`): the
 *   locks, the values before and the writes of the instance are those of every write. A feature
 *   whose values do not change is not written, nor counted; nor is one whose values after are
 *   not all finite numbers, nor one deleted meanwhile. A field is written only when its value
 *   changes, so that a feature without it is not given it for nothing.
 *
 * The rows are read per layer because the Store reads the rows of one layer at a time (one
 * number of values per position).
 */

import type { Geometry, Position } from 'geojson';
import type { FeatureTypeDefinition, TransformFields } from '../api/extension/feature-type.js';
import { drawPropertyKey } from '../shared/properties.js';
import type {
  TransformInput,
  TransformOperation,
  TransformOutput,
  TransformProvider,
} from '../shared/types/model.js';
import { countWork, workCountsOf } from '../shared/work-counts.js';
import type {
  FeatureRowField,
  GeometryColumn,
  LayerTableView,
  Store as RowStore,
} from '../store/built-in/types.js';
import { GEOMETRY_TYPES } from '../store/built-in/types.js';
import type { InstanceDocument } from '../store/document-access.js';
import type { Feature } from '../store/types.js';

/**
 * The definition registered under the name of a type, and whether it overrides a built-in type
 *
 * @internal
 */
export interface RegisteredType {
  readonly definition: FeatureTypeDefinition;
  /** True for a definition that overrides a built-in type (`featureTypes.override`) */
  readonly overrides: boolean;
}

/**
 * What the moves, rotations and scalings read and write
 *
 * @internal
 */
export interface TransformDeps {
  /** The layer over the Store, through which the features are written */
  readonly layer: Pick<InstanceDocument, 'getFeature' | 'getFeaturePlace' | 'updateFeature'>;
  /** The Store of the instance, whose rows are read as arrays */
  readonly store: RowStore;
  /** The definition registered under the name of a type, or undefined for none */
  readonly typeOf: (type: string) => RegisteredType | undefined;
}

/**
 * What an edit writes to its features several at a time (the shape the bulk edits call)
 *
 * @internal
 */
export interface TransformWork {
  /**
   * Writes the operation to the features, through the layer
   *
   * @param changed - One entry per ID: set to 1 for each feature written
   */
  writeFeatures(ids: readonly string[], changed: Uint8Array): void;
}

/**
 * The keys of the fields of a feature that an operation changes with its geometry
 *
 * @internal
 */
export interface Fields {
  readonly rotation: string | undefined;
  readonly bearing: string | undefined;
  readonly size: string | undefined;
  readonly uniform: boolean;
}

/**
 * Gives the fields of a feature by its type (and, for some, by the feature itself)
 *
 * @internal
 */
export type FieldsResolver = (type: string, id: string) => Fields;

/**
 * Makes the function that reads the fields of the features from their types. The definitions
 * are read again at every call, so that a type added, overridden or removed while the edit
 * writes counts from the next batch on
 *
 * @internal
 */
export function createFieldsResolver(deps: TransformDeps): FieldsResolver {
  const none: Fields = { rotation: undefined, bearing: undefined, size: undefined, uniform: false };
  const image: Fields = {
    rotation: drawPropertyKey('rotation'),
    bearing: undefined,
    size: drawPropertyKey('scale'),
    uniform: true,
  };
  const circle: Fields = {
    rotation: undefined,
    bearing: undefined,
    size: drawPropertyKey('radiusMeters'),
    uniform: true,
  };
  const builtIn = (type: string): Fields =>
    type === 'Image' ? image : type === 'Circle' ? circle : none;
  // One object of fields per declaration, not per feature
  const declared = new Map<TransformFields, Fields>();
  const fromDeclared = (fields: TransformFields): Fields => {
    let known = declared.get(fields);
    if (!known) {
      known = {
        rotation: fields.rotationDegreesKey,
        bearing: fields.bearingDegreesKey,
        size: fields.sizeKey,
        uniform: fields.isScaledUniformly === true,
      };
      declared.set(fields, known);
    }
    return known;
  };
  return (type, id) => {
    const registered = deps.typeOf(type);
    if (!registered) return builtIn(type);
    const { definition, overrides } = registered;
    const own = definition.transformFields;
    // A custom type has its own fields or none
    if (!overrides) return own ? fromDeclared(own) : none;
    // A definition that overrides a built-in type without fields leaves those of the built-in type
    if (!own) return builtIn(type);
    if (definition.appliesTo) {
      const feature = deps.layer.getFeature(id);
      if (!feature || definition.appliesTo(feature as never) === false) return builtIn(type);
    }
    return fromDeclared(own);
  };
}

/**
 * The center a rotation of a single feature turns about: the position of that feature when it
 * has a `Point` geometry and a field of rotation, or undefined
 *
 * @param id - The feature, when the target of the edit has one feature only
 * @internal
 */
export function rotationCenterOf(
  deps: TransformDeps,
  id: string | undefined,
): Position | undefined {
  if (id === undefined) return undefined;
  const feature = deps.layer.getFeature(id);
  if (feature?.geometry?.type !== 'Point') return undefined;
  if (createFieldsResolver(deps)(feature.type, id).rotation === undefined) return undefined;
  const [lon, lat] = feature.geometry.coordinates;
  if (typeof lon !== 'number' || typeof lat !== 'number') return undefined;
  return [lon, lat];
}

/** The value of a field of a row, or the value it starts from when it holds none */
function startOf(value: unknown, otherwise: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : otherwise;
}

/** Whether the numbers of a range of two arrays differ */
function differs(a: Float64Array, b: Float64Array, from: number, to: number): boolean {
  for (let k = from; k < to; k++) if (a[k] !== b[k]) return true;
  return false;
}

/** Whether every number of a range of an array is finite */
function allFinite(values: Float64Array, from: number, to: number): boolean {
  for (let k = from; k < to; k++) if (!Number.isFinite(values[k])) return false;
  return true;
}

/** The GeoJSON geometry of one row of a column, with the positions of `coordinates` */
function geometryAt(column: GeometryColumn, coordinates: Float64Array, row: number): Geometry {
  const type = GEOMETRY_TYPES[column.types[row]];
  const { valuesPerPosition, partStarts, ringStarts, positionStarts } = column;
  const positionAt = (index: number): Position => {
    const base = index * valuesPerPosition;
    const position: number[] = new Array(valuesPerPosition);
    for (let k = 0; k < valuesPerPosition; k++) position[k] = coordinates[base + k];
    return position;
  };
  const parts: Position[][][] = [];
  for (let p = partStarts[row]; p < partStarts[row + 1]; p++) {
    const rings: Position[][] = [];
    for (let r = ringStarts[p]; r < ringStarts[p + 1]; r++) {
      const ring: Position[] = [];
      for (let q = positionStarts[r]; q < positionStarts[r + 1]; q++) ring.push(positionAt(q));
      rings.push(ring);
    }
    parts.push(rings);
  }
  switch (type) {
    case 'Point':
      return { type, coordinates: parts[0]?.[0]?.[0] ?? [] };
    case 'LineString':
      return { type, coordinates: parts[0]?.[0] ?? [] };
    case 'Polygon':
      return { type, coordinates: parts[0] ?? [] };
    case 'MultiPoint':
      return { type, coordinates: parts.map((rings) => rings[0]?.[0] ?? []) };
    case 'MultiLineString':
      return { type, coordinates: parts.map((rings) => rings[0] ?? []) };
    default:
      return { type: 'MultiPolygon', coordinates: parts };
  }
}

/** `properties` with one key set, as an own key whatever its name */
function withValue(
  properties: Record<string, unknown>,
  key: string,
  value: number,
): Record<string, unknown> {
  Object.defineProperty(properties, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return properties;
}

/**
 * The arrays of a run of rows of one layer, as the computation takes them: the input, the
 * output to be written, and what each row declares
 *
 * @internal
 */
export interface TransformRun {
  readonly input: TransformInput;
  readonly output: TransformOutput;
  readonly geometry: GeometryColumn;
  /** The fields of each row (one shared object per kind of row) */
  readonly fields: readonly Fields[];
}

/**
 * Reads a run of rows of one layer as the arrays of the computation
 *
 * @internal
 */
export function readTransformRun(
  store: RowStore,
  view: LayerTableView,
  refs: Int32Array,
  ids: readonly string[],
  index: Int32Array,
  fieldsOf: FieldsResolver,
  operationId: number,
): TransformRun {
  const counts = workCountsOf(store);
  const n = refs.length;
  const fields: Fields[] = new Array(n);
  const keys = new Set<string>();
  let rotations = false;
  let bearings = false;
  let sizes = false;
  let uniform = false;
  for (let i = 0; i < n; i++) {
    const own = fieldsOf(view.getRowType(refs[i]) ?? '', ids[index[i]]);
    fields[i] = own;
    if (own.rotation !== undefined) {
      rotations = true;
      keys.add(own.rotation);
    }
    if (own.bearing !== undefined) {
      bearings = true;
      keys.add(own.bearing);
    }
    if (own.size !== undefined) {
      sizes = true;
      keys.add(own.size);
    }
    if (own.uniform) uniform = true;
  }
  const read: FeatureRowField[] = ['geometry'];
  for (const key of keys) read.push(`properties:${key}`);
  const values = store.tables.readValues(refs, read);
  const geometry = values.geometry as GeometryColumn;
  // The positions of each row start at the first position of its first ring
  const positionStarts = new Int32Array(n + 1);
  for (let i = 0; i <= n; i++) {
    positionStarts[i] = geometry.positionStarts[geometry.ringStarts[geometry.partStarts[i]]];
  }
  /** The column of one field: its value per row, the value it starts from, NaN without it */
  const column = (keyOf: (own: Fields) => string | undefined, otherwise: number): Float64Array => {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const key = keyOf(fields[i]);
      out[i] =
        key === undefined
          ? Number.NaN
          : startOf(values.fields.get(`properties:${key}`)?.[i], otherwise);
    }
    return out;
  };
  const rotationDegrees = rotations ? column((own) => own.rotation, 0) : null;
  const bearingDegrees = bearings ? column((own) => own.bearing, 0) : null;
  const size = sizes ? column((own) => own.size, 1) : null;
  let isScaledUniformly: Uint8Array | null = null;
  if (uniform) {
    isScaledUniformly = new Uint8Array(n);
    for (let i = 0; i < n; i++) isScaledUniformly[i] = fields[i].uniform ? 1 : 0;
  }
  const input: TransformInput = {
    operationId,
    featureCount: n,
    coordinates: geometry.coordinates,
    valuesPerPosition: geometry.valuesPerPosition,
    positionStarts,
    rotationDegrees,
    bearingDegrees,
    size,
    isScaledUniformly,
  };
  const like = (array: Float64Array | null): Float64Array | null =>
    array ? new Float64Array(array.length) : null;
  const output: TransformOutput = {
    coordinates: new Float64Array(geometry.coordinates.length),
    rotationDegrees: like(rotationDegrees),
    bearingDegrees: like(bearingDegrees),
    size: like(size),
  };
  // The arrays of the run, its input and its output: as many whatever the number of rows
  countWork(counts, 'objectsCreated', 14);
  return { input, output, geometry, fields };
}

/**
 * Writes the values after of a run, feature by feature, through the layer
 */
function writeRun(
  deps: TransformDeps,
  run: TransformRun,
  ids: readonly string[],
  index: Int32Array,
  changed: Uint8Array,
): void {
  const { input, output, geometry, fields } = run;
  const stride = input.valuesPerPosition;
  for (let i = 0; i < input.featureCount; i++) {
    const from = input.positionStarts[i] * stride;
    const to = input.positionStarts[i + 1] * stride;
    if (!allFinite(output.coordinates, from, to)) continue;
    const moved = differs(input.coordinates, output.coordinates, from, to);
    const own = fields[i];
    const keys: string[] = [];
    const after: number[] = [];
    const field = (
      key: string | undefined,
      before: Float64Array | null,
      written: Float64Array | null,
    ): boolean => {
      if (key === undefined || !before || !written) return true;
      const value = written[i];
      if (!Number.isFinite(value)) return false;
      if (value !== before[i]) {
        keys.push(key);
        after.push(value);
      }
      return true;
    };
    if (
      !field(own.rotation, input.rotationDegrees, output.rotationDegrees) ||
      !field(own.bearing, input.bearingDegrees, output.bearingDegrees) ||
      !field(own.size, input.size, output.size)
    ) {
      continue;
    }
    if (!moved && keys.length === 0) continue;
    const id = ids[index[i]];
    const updates: Partial<Feature> = {};
    if (moved) updates.geometry = geometryAt(geometry, output.coordinates, i);
    if (keys.length > 0) {
      const feature = deps.layer.getFeature(id);
      if (!feature) continue;
      let properties: Record<string, unknown> = { ...feature.properties };
      for (let k = 0; k < keys.length; k++) properties = withValue(properties, keys[k], after[k]);
      updates.properties = properties;
    }
    if (deps.layer.updateFeature(id, updates)) changed[index[i]] = 1;
  }
}

/**
 * The work of a move, a rotation or a scaling of features: each batch is read as arrays, a run
 * of the rows of one layer at a time, computed by `provider` in one call per run, and written
 * through the layer
 *
 * @param provider - The computation used for the whole edit (the one set when it started, or the
 *   built-in one)
 * @param operation - The operation, as `provider.accepts` took it
 * @param operationId - The number of the operation of the edit, given in every call
 * @internal
 */
export function createTransformWork(
  deps: TransformDeps,
  provider: TransformProvider,
  operation: TransformOperation,
  operationId: number,
): TransformWork {
  const fieldsOf = createFieldsResolver(deps);
  const { store, layer } = deps;
  return {
    writeFeatures(ids, changed) {
      const { tables } = store;
      const refs = new Int32Array(ids.length);
      const index = new Int32Array(ids.length);
      countWork(workCountsOf(store), 'objectsCreated', 2);
      let i = 0;
      while (i < ids.length) {
        // The layer of the first row of the run
        const first = tables.getRowRef(ids[i]);
        const place = first === undefined ? undefined : layer.getFeaturePlace(ids[i]);
        const view = place ? tables.get(place.layerId) : undefined;
        if (first === undefined || !view) {
          i += 1;
          continue;
        }
        // The rows that follow in the same layer (a row deleted meanwhile is passed over)
        let n = 0;
        while (i < ids.length) {
          const ref = n === 0 ? first : tables.getRowRef(ids[i]);
          if (ref !== undefined) {
            if (view.getRowType(ref) === null) break;
            refs[n] = ref;
            index[n] = i;
            n += 1;
          }
          i += 1;
        }
        const run = readTransformRun(
          store,
          view,
          refs.subarray(0, n),
          ids,
          index.subarray(0, n),
          fieldsOf,
          operationId,
        );
        provider.apply(operation, run.input, run.output);
        writeRun(deps, run, ids, index.subarray(0, n), changed);
      }
    },
  };
}
