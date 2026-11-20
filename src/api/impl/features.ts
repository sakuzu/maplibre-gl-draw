// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.features`: the features of the document
 */

import type { Position } from 'geojson';
import { differenceAll, intersectionAll, unionAll } from '../../geometry/boolean.js';
import type { AreaCoordinates, MultiPolygonCoordinates } from '../../geometry/types.js';
import {
  createTransformWork,
  rotationCenterOf,
  type TransformDeps,
} from '../../operations/bulk-transform.js';
import { createBuiltInTransform } from '../../shared/math/enu-transform.js';
import { drawPropertyKey } from '../../shared/properties.js';
import type { TransformOperation } from '../../shared/types/model.js';
import { getBoundingBox } from '../../shared/utils/feature-bbox.js';
import type { Store as RowStore } from '../../store/built-in/types.js';
import type { DocumentAccess, FeatureMatch } from '../../store/document-access.js';
import { isFeatureLocked } from '../../store/lock.js';
import { listEveryFeatureInOrder } from '../../store/ordering.js';
import type {
  Feature as StoredFeature,
  FeatureStyle as StoredFeatureStyle,
} from '../../store/types.js';
import { getStyleRuleChannel, resolveFeatureStyle } from '../../view/style-rule.js';
import { DrawError } from '../errors.js';
import type { ExtensionsCollections } from '../extensions.js';
import type { EditCounts, EditOptions, FeaturesCollection, FeatureTarget } from '../features.js';
import type {
  Feature,
  FeatureFilter,
  FeatureInput,
  FeaturePatch,
  FeatureStyleResolved,
  MoveTarget,
} from '../model.js';
import type { RuntimeOptions } from '../options.js';
import type { BulkEdits } from './bulk-edits.js';
import { OVERRIDABLE_TYPES } from './extensions.js';
import { applyResult } from './geometry/apply.js';
import { runBuffer } from './geometry/buffer.js';
import { runSplit } from './geometry/split.js';
import {
  isAreaFeature,
  isBufferableFeature,
  isSplitLineFeature,
  toAreaCoordinates,
  toResultGeometry,
} from './geometry/targets.js';
import type { GeometryDeps } from './geometry/types.js';
import { describeGeometryProblem } from './import-export/geometry-validation.js';
import { setOwnProperty } from './import-export/own-property.js';
import { describeStyleProblem } from './import-export/style-validation.js';
import { toAppliedDefaults } from './options.js';
import { moveFeatures, resolveMoveTarget } from './placement.js';
import type { ResourceDeps } from './shared.js';
import {
  featureLocked,
  filterEntries,
  invalidInput,
  isRecord,
  isTaken,
  notFound,
  onlyKeys,
  onlyLockOrVisibility,
  optionalBoolean,
  requireId,
  requireIds,
  requireRecord,
} from './shared.js';

const INPUT_KEYS = [
  'type',
  'geometry',
  'id',
  'layerId',
  'groupId',
  'properties',
  'style',
  'visible',
  'locked',
] as const;
const PATCH_KEYS = ['geometry', 'properties', 'style', 'visible', 'locked'] as const;
const FILTER_KEYS = ['layerId', 'groupId', 'type', 'visible', 'shown', 'locked', 'bbox'] as const;

/** The most features a list returns at once */
const LIST_LIMIT = 10_000;

/**
 * What the bulk edits of `draw.features` are written with
 *
 * @internal
 */
export interface FeatureBulkDeps {
  /** The bulk edits of the instance */
  readonly edits: BulkEdits;
  /** The computation set and the feature types, read only */
  readonly extensions: Pick<ExtensionsCollections, 'getTransformProvider' | 'featureTypes'>;
  /** The Store of the instance, whose rows the moves, rotations and scalings read */
  readonly store: RowStore;
}

/**
 * Creates `draw.features`
 *
 * @param bulk - What the bulk edits are written with; `translate`, `rotate` and `scale` throw
 *   `invalidState` without it
 * @internal
 */
export function createFeatures(deps: ResourceDeps, bulk?: FeatureBulkDeps): FeaturesCollection {
  const { store } = deps;
  // The computation used when none is set, made once for the instance
  const builtInTransform = createBuiltInTransform();
  const transformDeps: TransformDeps | undefined = bulk && {
    layer: store,
    store: bulk.store,
    typeOf: (type) => {
      const definition = bulk.extensions.featureTypes.get(type);
      return definition && { definition, overrides: OVERRIDABLE_TYPES.has(type) };
    },
  };

  /**
   * Starts a move, a rotation or a scaling of features: the computation is the one set when it
   * starts, asked whether it computes the operation once the target is read; a wrong input
   * rejects the promise, and changes nothing
   */
  const startTransform = (
    target: FeatureTarget,
    options: EditOptions | undefined,
    read: () => TransformOperation,
  ): Promise<EditCounts | null> => {
    if (!bulk || !transformDeps) {
      throw new DrawError('invalidState', 'The bulk edits are not available on these features');
    }
    try {
      const operation = read();
      return bulk.edits.start(target, options, (started) => {
        let computed = operation;
        // A single feature of a Point geometry with a field of rotation turns about its position
        if (operation.kind === 'rotate') {
          // Its position is read to make the values written: the edit being written is applied
          // to it first
          if (started.onlyId !== undefined) store.applyEditFirst?.(started.onlyId);
          const center = rotationCenterOf(transformDeps, started.onlyId);
          if (center) computed = { ...operation, center };
        }
        const provider = bulk.extensions.getTransformProvider() ?? builtInTransform;
        if (!provider.accepts(computed)) {
          throw invalidInput(
            `The computation ${JSON.stringify(provider.name)} does not compute it`,
          );
        }
        return createTransformWork(transformDeps, provider, computed, started.operationId);
      });
    } catch (error) {
      if (error instanceof DrawError && error.code === 'invalidInput') return Promise.reject(error);
      throw error;
    }
  };
  const geometryDeps: GeometryDeps = {
    store,
    generateFeatureId: deps.generateId,
  };

  const require = (id: unknown): StoredFeature => {
    const feature = typeof id === 'string' ? store.getFeature(id) : undefined;
    if (!feature) throw notFound('feature', id);
    return feature;
  };
  /**
   * A feature read to be written, or to make the values a write writes: the edit being written in
   * parts is applied to it first, before it is read, so that the write starts from the values the
   * edit gives it
   */
  const requireToWrite = (id: unknown): StoredFeature => {
    if (typeof id === 'string') store.applyEditFirst?.(id);
    return require(id);
  };
  const requireAllToWrite = (ids: unknown): StoredFeature[] => requireIds(ids).map(requireToWrite);

  /** The features in stacking order, from the back */
  const inStackingOrder = (features: StoredFeature[]): StoredFeature[] => {
    if (features.length < 2) return features;
    const position = new Map(listEveryFeatureInOrder(store).map((f, index) => [f.id, index]));
    return [...features].sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));
  };

  /** What a filter keeps, as the layer over the Store reads it from the rows */
  const matchOf = (filter: FeatureFilter | undefined): FeatureMatch | undefined => {
    const all = filterEntries(filter, FILTER_KEYS);
    if (all.length === 0) return undefined;
    const match: Record<string, unknown> = {};
    for (const [key, value] of all) {
      if (key === 'shown' && typeof value !== 'boolean') {
        throw invalidInput('shown must be a boolean');
      }
      if (key !== 'bbox') match[key] = value;
    }
    const bbox = all.find(([key]) => key === 'bbox')?.[1];
    if (bbox !== undefined) {
      if (
        !Array.isArray(bbox) ||
        bbox.length !== 4 ||
        bbox.some((value) => typeof value !== 'number' || !Number.isFinite(value))
      ) {
        throw invalidInput('bbox must be [west, south, east, north] in degrees');
      }
      const [minX, minY, maxX, maxY] = bbox as number[];
      const bounds = { minX, minY, maxX, maxY };
      match.ids = new Set(
        deps.spatialIndex
          ? deps.spatialIndex.findInBounds(bounds)
          : store
              .listFeatures()
              .filter((feature) => {
                const box = getBoundingBox(feature);
                return box.minX <= maxX && box.maxX >= minX && box.minY <= maxY && box.maxY >= minY;
              })
              .map((feature) => feature.id),
      );
    }
    return match as FeatureMatch;
  };

  const list = (filter?: FeatureFilter): Feature[] => {
    const match = matchOf(filter);
    const count = store.countFeatures(match);
    if (count > LIST_LIMIT) {
      throw new DrawError(
        'tooManyItems',
        `${count} features match, more than the ${LIST_LIMIT} a list returns; read them with features.iterate`,
        { count },
      );
    }
    return [...store.iterateFeatures(match)];
  };

  return {
    get: (id) => store.getFeature(id),
    getMany(ids) {
      if (!Array.isArray(ids)) throw invalidInput('The IDs must be an array');
      return ids.map((id) => store.getFeature(id));
    },
    getProperty(id, key) {
      if (!store.hasFeature(id)) throw notFound('feature', id);
      if (typeof key !== 'string') throw invalidInput('The key must be a string');
      return store.getFeatureProperty(id, key);
    },
    list,
    iterate: (filter) => store.iterateFeatures(matchOf(filter)),
    count: (filter) => store.countFeatures(matchOf(filter)),
    has: (id) => store.hasFeature(id),

    create(input) {
      const feature = prepareFeature(deps, input, new Set());
      if (store.isReadOnly()) return null;
      if (!store.createFeature(feature)) return null;
      return store.getFeature(feature.id) ?? null;
    },

    createMany(inputs) {
      if (!Array.isArray(inputs)) throw invalidInput('The inputs must be an array');
      const pending = new Set<string>();
      const features = inputs.map((input) => {
        const feature = prepareFeature(deps, input, pending);
        pending.add(feature.id);
        return feature;
      });
      if (store.isReadOnly()) return null;
      // The features written are read back as they are kept made, not from their rows
      return store.holdFeatures(() => {
        if (!store.createFeatures(features)) return null;
        return features.map((feature) => store.getFeature(feature.id) as StoredFeature);
      });
    },

    update(id, patch) {
      const feature = requireToWrite(id);
      const updates = preparePatch(feature, patch);
      if (store.isReadOnly()) return null;
      if (featureLocked(store, feature) && !onlyLockOrVisibility(patch)) return null;
      if (!store.updateFeature(feature.id, updates)) return null;
      return store.getFeature(feature.id) ?? null;
    },

    updateMany(patches) {
      if (!Array.isArray(patches)) throw invalidInput('The patches must be an array');
      const seen = new Set<string>();
      const prepared = patches.map((entry) => {
        requireRecord(entry, 'Each entry');
        const feature = requireToWrite((entry as { id: unknown }).id);
        if (seen.has(feature.id)) throw invalidInput(`The ID ${feature.id} is given twice`);
        seen.add(feature.id);
        return { feature, patch: entry.patch, updates: preparePatch(feature, entry.patch) };
      });
      if (store.isReadOnly()) return null;
      const refused = prepared.some(
        ({ feature, patch }) => featureLocked(store, feature) && !onlyLockOrVisibility(patch),
      );
      if (refused) return null;
      const written = store.transactUntilRefused(() => {
        for (const { feature, updates } of prepared) store.updateFeature(feature.id, updates);
        return true;
      });
      if (written === null) return null;
      return prepared.map(({ feature }) => store.getFeature(feature.id) as StoredFeature);
    },

    delete(id) {
      const feature = requireToWrite(id);
      if (store.isReadOnly() || featureLocked(store, feature)) return false;
      return store.deleteFeature(feature.id);
    },

    deleteMany(ids) {
      const features = requireAllToWrite(ids);
      if (store.isReadOnly()) return false;
      if (features.some((feature) => featureLocked(store, feature))) return false;
      const written = store.transactUntilRefused(() => {
        for (const feature of features) {
          if (store.getFeature(feature.id)) store.deleteFeature(feature.id);
        }
        return true;
      });
      return written !== null;
    },

    move(id, to) {
      return moveMany([id], to);
    },

    moveMany,

    isEditable(id) {
      const feature = require(id);
      return !store.isReadOnly() && !isFeatureLocked(feature, store);
    },

    getAppliedStyle(id) {
      const feature = store.getFeature(id);
      if (!feature) return undefined;
      return appliedStyle(store, feature, deps.getStyleOptions());
    },

    union(ids) {
      const inputs = requireAreas(ids, 2);
      if (refuseChange(inputs)) return null;
      return runAreaOperation(inputs, inputs[inputs.length - 1], inputs, unionAll);
    },

    difference(id, subtractIds) {
      const [subject] = requireAreas([id], 1);
      const others = requireAreas(subtractIds, 1);
      if (others.some((other) => other.id === subject.id)) {
        throw invalidInput('An area cannot be subtracted from itself');
      }
      if (refuseChange([subject])) return null;
      const inputs = inStackingOrder([subject, ...others]);
      return runAreaOperation(inputs, subject, [subject], (areas) =>
        differenceAll(
          areas[inputs.indexOf(subject)],
          areas.filter((_, index) => inputs[index] !== subject),
        ),
      );
    },

    intersection(ids) {
      const inputs = requireAreas(ids, 2);
      if (refuseChange(inputs)) return null;
      return runAreaOperation(inputs, inputs[inputs.length - 1], inputs, intersectionAll);
    },

    split(id, lineId) {
      // The area is deleted, the line stays
      const area = requireToWrite(id);
      const line = requireToWrite(lineId);
      if (!isAreaFeature(area)) throw invalidInput(`The feature ${area.id} is not an area`);
      if (!isSplitLineFeature(line)) throw invalidInput(`The feature ${line.id} is not a line`);
      if (refuseChange([area])) return null;
      const results = store.transactUntilRefused(() => runSplit(geometryDeps, area, line, false));
      if (results === null) return null;
      return results.map((resultId) => store.getFeature(resultId) as StoredFeature);
    },

    translate: (target, translation, options) =>
      startTransform(target, options, () => {
        requireRecord(translation, 'The translation');
        return {
          kind: 'translate',
          from: requirePosition(translation.from, 'from'),
          to: requirePosition(translation.to, 'to'),
        };
      }),

    rotate: (target, rotation, options) =>
      startTransform(target, options, () => {
        requireRecord(rotation, 'The rotation');
        const center = requirePosition(rotation.center, 'center');
        const { counterclockwiseDegrees } = rotation;
        if (
          typeof counterclockwiseDegrees !== 'number' ||
          !Number.isFinite(counterclockwiseDegrees)
        ) {
          throw invalidInput('counterclockwiseDegrees must be a finite number');
        }
        return { kind: 'rotate', center, counterclockwiseDegrees };
      }),

    scale: (target, scaling, options) =>
      startTransform(target, options, () => {
        requireRecord(scaling, 'The scaling');
        return {
          kind: 'scale',
          center: requirePosition(scaling.center, 'center'),
          eastFactor: requireFactor(scaling.eastFactor, 'eastFactor'),
          northFactor: requireFactor(scaling.northFactor, 'northFactor'),
          sizeFactor: requireFactor(scaling.sizeFactor, 'sizeFactor'),
        };
      }),

    buffer(ids, options) {
      const inputs = inStackingOrder(requireAllToWrite(ids));
      requireRecord(options, 'The options');
      const { distanceMeters, segments } = options;
      if (typeof distanceMeters !== 'number' || !Number.isFinite(distanceMeters)) {
        throw invalidInput('distanceMeters must be a finite number');
      }
      if (segments !== undefined && (typeof segments !== 'number' || !(segments > 0))) {
        throw invalidInput('segments must be a positive number');
      }
      for (const input of inputs) {
        if (!isBufferableFeature(input)) {
          throw invalidInput(`The feature ${input.id} cannot be buffered`);
        }
      }
      if (refuseChange(inputs)) return null;
      if (distanceMeters === 0 || inputs.length === 0) return [];
      const results = store.transactUntilRefused(() =>
        runBuffer(geometryDeps, inputs, { distanceMeters, segments }, false),
      );
      if (results === null) return null;
      return results.map((resultId) => store.getFeature(resultId) as StoredFeature);
    },
  };

  function moveMany(ids: readonly string[], to: MoveTarget): boolean {
    const features = inStackingOrder(requireAllToWrite(ids));
    const target = resolveMoveTarget(store, to);
    if (store.isReadOnly()) return false;
    if (features.some((feature) => featureLocked(store, feature))) return false;
    if (target.locked) return false;
    return moveFeatures(store, features, target);
  }

  /**
   * The features as areas in stacking order, at least `min` of them, with the edit being written
   * applied to them first: those the operation deletes, and those it only reads to make its result
   */
  function requireAreas(ids: unknown, min: number): StoredFeature[] {
    const features = inStackingOrder(requireAllToWrite(ids));
    if (features.length < min) {
      throw invalidInput(`At least ${min} areas are needed`);
    }
    for (const feature of features) {
      if (!isAreaFeature(feature)) throw invalidInput(`The feature ${feature.id} is not an area`);
    }
    return features;
  }

  /** Whether a change of these features is refused: read-only, or one of them is locked */
  function refuseChange(features: StoredFeature[]): boolean {
    return store.isReadOnly() || features.some((feature) => featureLocked(store, feature));
  }

  /**
   * Runs a boolean operation on areas and puts the result in the place of `anchor`
   *
   * @returns The result, or null when the result has no area (nothing changes then)
   */
  function runAreaOperation(
    inputs: StoredFeature[],
    anchor: StoredFeature,
    removed: StoredFeature[],
    compute: (areas: AreaCoordinates[]) => MultiPolygonCoordinates,
  ): Feature | null {
    const areas = inputs.map((feature) => toAreaCoordinates(feature) as AreaCoordinates);
    const geometry = toResultGeometry(compute(areas));
    if (geometry === null) return null;
    const resultId = store.transactUntilRefused(() =>
      applyResult(geometryDeps, {
        anchor,
        removedIds: removed.map((feature) => feature.id),
        geometry,
      }),
    );
    if (resultId === null) return null;
    return store.getFeature(resultId) ?? null;
  }
}

// ============================================================================
// The moves, rotations and scalings
// ============================================================================

/**
 * A point of a move, a rotation or a scaling, copied (the edit reads it while it writes): a
 * longitude and a latitude, finite, the latitude from -90 to 90 (what follows them is copied)
 */
function requirePosition(value: unknown, name: string): Position {
  if (
    !Array.isArray(value) ||
    value.length < 2 ||
    typeof value[0] !== 'number' ||
    !Number.isFinite(value[0]) ||
    typeof value[1] !== 'number' ||
    !Number.isFinite(value[1])
  ) {
    throw invalidInput(`${name} must be [longitude, latitude] in degrees, finite numbers`);
  }
  const latitude = value[1];
  if (latitude < -90 || latitude > 90) {
    throw invalidInput(`The latitude of ${name} must be from -90 to 90`);
  }
  return [...(value as number[])];
}

/** A factor of a scaling: a finite number above 0 */
function requireFactor(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !(value > 0)) {
    throw invalidInput(`${name} must be a finite number above 0`);
  }
  return value;
}

// ============================================================================
// Inputs and patches
// ============================================================================

/** Checks an input and builds the feature to store; throws DrawError on a wrong input */
function prepareFeature(
  deps: ResourceDeps,
  input: FeatureInput,
  pending: ReadonlySet<string>,
): StoredFeature {
  const { store } = deps;
  requireRecord(input, 'The input');
  const record = input as unknown as Record<string, unknown>;
  onlyKeys(record, INPUT_KEYS, 'The input');
  if (typeof input.type !== 'string' || input.type === '') {
    throw invalidInput('type must be a non-empty string');
  }
  const geometryProblem = describeGeometryProblem(input.type, input.geometry);
  if (geometryProblem) throw invalidInput(`The input has ${geometryProblem}`);
  if (input.properties !== undefined && !isRecord(input.properties)) {
    throw invalidInput('properties must be an object');
  }
  if (input.style !== undefined) {
    const styleProblem = describeStyleProblem(input.style);
    if (styleProblem) throw invalidInput(`The input has ${styleProblem}`);
  }
  optionalBoolean(record, 'visible');
  optionalBoolean(record, 'locked');

  let id: string;
  if (input.id === undefined) {
    id = deps.generateId();
  } else {
    id = requireId(input.id);
    if (isTaken(store, id) || pending.has(id)) {
      throw new DrawError('alreadyExists', `The ID ${JSON.stringify(id)} is already taken`, {
        id,
      });
    }
  }

  const group = input.groupId === undefined ? undefined : store.getGroup(requireId(input.groupId));
  if (input.groupId !== undefined && !group) throw notFound('group', input.groupId);
  let layerId: string;
  if (input.layerId !== undefined) {
    layerId = requireId(input.layerId);
    if (!store.getLayer(layerId)) throw notFound('layer', layerId);
    if (group && group.layerId !== layerId) {
      throw invalidInput(`The group ${group.id} is not in the layer ${layerId}`);
    }
  } else if (group) {
    layerId = group.layerId;
  } else {
    layerId = deps.getActiveLayerId();
    if (!store.getLayer(layerId)) {
      throw new DrawError('invalidState', 'There is no layer to put the feature in');
    }
  }

  const properties = withoutUndefined(input.properties ?? {});
  if (input.type === 'Image') {
    requireImageSize(properties);
    // Left out, the size on the map is the one a load gives the image it places
    const createdZoom = drawPropertyKey('createdZoom');
    if (properties[createdZoom] === undefined && deps.getZoom) {
      properties[createdZoom] = deps.getZoom();
    }
  }

  return {
    id,
    type: input.type,
    geometry: input.geometry,
    layerId,
    groupId: group?.id,
    properties,
    style: withoutUndefined(input.style ?? {}) as StoredFeatureStyle,
    visible: input.visible ?? true,
    locked: input.locked ?? false,
  };
}

/**
 * Checks the size in pixels of a new Image, which the caller gives and cannot leave out
 */
function requireImageSize(properties: Record<string, unknown>): void {
  for (const name of ['imageWidth', 'imageHeight'] as const) {
    const value = properties[drawPropertyKey(name)];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw invalidInput(`An Image needs its ${name} in pixels, a number greater than 0`);
    }
  }
}

/**
 * Checks a patch and builds the updates of the Store; throws DrawError on a wrong patch
 *
 * @internal
 */
export function preparePatch(feature: StoredFeature, patch: FeaturePatch): Partial<StoredFeature> {
  requireRecord(patch, 'The patch');
  const record = patch as unknown as Record<string, unknown>;
  onlyKeys(record, PATCH_KEYS, 'The patch');
  optionalBoolean(record, 'visible');
  optionalBoolean(record, 'locked');
  const updates: Partial<StoredFeature> = {};
  if (patch.geometry !== undefined) {
    const problem = describeGeometryProblem(feature.type, patch.geometry);
    if (problem) throw invalidInput(`The patch has ${problem}`);
    updates.geometry = patch.geometry;
  }
  if (patch.properties !== undefined) {
    if (!isRecord(patch.properties)) throw invalidInput('properties must be an object');
    updates.properties = merged(feature.properties, patch.properties);
  }
  if (patch.style !== undefined) {
    const problem = describeStyleProblem(patch.style);
    if (problem) throw invalidInput(`The patch has ${problem}`);
    updates.style = merged(
      feature.style as Record<string, unknown>,
      patch.style as Record<string, unknown>,
    ) as StoredFeatureStyle;
  }
  if (patch.visible !== undefined) updates.visible = patch.visible;
  if (patch.locked !== undefined) updates.locked = patch.locked;
  return updates;
}

/** The keys of `base` with the keys of `patch` set, and removed where they are undefined */
function merged(
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

/** A copy without the keys whose value is undefined */
function withoutUndefined(value: object): Record<string, unknown> {
  return merged({}, value as Record<string, unknown>);
}

// ============================================================================
// The applied style
// ============================================================================

/**
 * The look a feature is drawn with: the defaults of the options, the color of the layer rule
 * and the style of the feature, in that order. The colors of the options and of the feature
 * are the strings given, never rounded
 */
function appliedStyle(
  store: DocumentAccess,
  feature: StoredFeature,
  style: RuntimeOptions['style'],
): FeatureStyleResolved {
  const defaults = toAppliedDefaults(style, feature.type);
  const layer = store.getLayer(feature.layerId);
  const own =
    resolveFeatureStyle(feature, layer?.styleRule, getStyleRuleChannel(feature.type)) ?? {};
  return { ...defaults, ...withoutUndefined(own) } as FeatureStyleResolved;
}
