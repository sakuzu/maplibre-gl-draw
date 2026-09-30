// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.features`: the features of the document
 */

import { differenceAll, intersectionAll, unionAll } from '../../geometry/boolean.js';
import type { AreaCoordinates, MultiPolygonCoordinates } from '../../geometry/types.js';
import { getBoundingBox } from '../../shared/utils/feature-bbox.js';
import { isFeatureLocked } from '../../store/lock.js';
import { listEveryFeatureInOrder } from '../../store/ordering.js';
import type { Store } from '../../store/store.js';
import type {
  Feature as StoredFeature,
  FeatureStyle as StoredFeatureStyle,
} from '../../store/types.js';
import { getStyleRuleChannel, resolveFeatureStyle } from '../../view/style-rule.js';
import { DrawError } from '../errors.js';
import type { FeaturesCollection } from '../features.js';
import type {
  Feature,
  FeatureFilter,
  FeatureInput,
  FeaturePatch,
  FeatureStyleResolved,
  MoveTarget,
} from '../model.js';
import type { RuntimeOptions } from '../options.js';
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
  matches,
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

/**
 * Creates `draw.features`
 *
 * @internal
 */
export function createFeatures(deps: ResourceDeps): FeaturesCollection {
  const { store } = deps;
  const geometryDeps: GeometryDeps = {
    store,
    generateFeatureId: deps.generateId,
  };

  const require = (id: unknown): StoredFeature => {
    const feature = typeof id === 'string' ? store.getFeature(id) : undefined;
    if (!feature) throw notFound('feature', id);
    return feature;
  };
  const requireAll = (ids: unknown): StoredFeature[] => requireIds(ids).map(require);

  /** The features in stacking order, from the back */
  const inStackingOrder = (features: StoredFeature[]): StoredFeature[] => {
    const position = new Map(listEveryFeatureInOrder(store).map((f, index) => [f.id, index]));
    return [...features].sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));
  };

  /**
   * The checks of a filter: the entries compared as they are, and the IDs within the extent
   * when the filter has one
   */
  const filterOf = (filter: FeatureFilter | undefined) => {
    const all = filterEntries(filter, FILTER_KEYS);
    const shown = all.find(([key]) => key === 'shown')?.[1];
    if (shown !== undefined && typeof shown !== 'boolean') {
      throw invalidInput('shown must be a boolean');
    }
    const entries = all.filter(([key]) => key !== 'shown');
    const bbox = entries.find(([key]) => key === 'bbox')?.[1];
    if (bbox === undefined) return { entries, inside: null, shown };
    if (
      !Array.isArray(bbox) ||
      bbox.length !== 4 ||
      bbox.some((value) => typeof value !== 'number' || !Number.isFinite(value))
    ) {
      throw invalidInput('bbox must be [west, south, east, north] in degrees');
    }
    const [minX, minY, maxX, maxY] = bbox as number[];
    const bounds = { minX, minY, maxX, maxY };
    const inside = new Set(
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
    return { entries: entries.filter(([key]) => key !== 'bbox'), inside, shown };
  };
  /** Whether the feature, its group and its layer are all visible in the document */
  const isShown = (feature: StoredFeature): boolean =>
    feature.visible &&
    (feature.groupId === undefined || store.getGroup(feature.groupId)?.visible !== false) &&
    store.getLayer(feature.layerId)?.visible !== false;
  const keep = (
    feature: StoredFeature,
    { entries, inside, shown }: ReturnType<typeof filterOf>,
  ): boolean =>
    (inside === null || inside.has(feature.id)) &&
    (shown === undefined || isShown(feature) === shown) &&
    matches(feature, entries);

  const list = (filter?: FeatureFilter): Feature[] => {
    const checks = filterOf(filter);
    return listEveryFeatureInOrder(store).filter((feature) => keep(feature, checks));
  };

  return {
    get: (id) => store.getFeature(id),
    getMany(ids) {
      if (!Array.isArray(ids)) throw invalidInput('The IDs must be an array');
      return ids.map((id) => store.getFeature(id));
    },
    list,
    count(filter) {
      const checks = filterOf(filter);
      if (checks.entries.length === 0 && checks.inside === null && checks.shown === undefined) {
        return store.listFeatures().length;
      }
      return store.listFeatures().filter((feature) => keep(feature, checks)).length;
    },
    has: (id) => store.getFeature(id) !== undefined,

    create(input) {
      const feature = prepareFeature(deps, input, new Set());
      if (store.isReadOnly()) return null;
      store.createFeature(feature);
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
      store.transact(() => {
        for (const feature of features) store.createFeature(feature);
      });
      return features.map((feature) => store.getFeature(feature.id) as StoredFeature);
    },

    update(id, patch) {
      const feature = require(id);
      const updates = preparePatch(feature, patch);
      if (store.isReadOnly()) return null;
      if (featureLocked(store, feature) && !onlyLockOrVisibility(patch)) return null;
      store.updateFeature(feature.id, updates);
      return store.getFeature(feature.id) ?? null;
    },

    updateMany(patches) {
      if (!Array.isArray(patches)) throw invalidInput('The patches must be an array');
      const seen = new Set<string>();
      const prepared = patches.map((entry) => {
        requireRecord(entry, 'Each entry');
        const feature = require((entry as { id: unknown }).id);
        if (seen.has(feature.id)) throw invalidInput(`The ID ${feature.id} is given twice`);
        seen.add(feature.id);
        return { feature, patch: entry.patch, updates: preparePatch(feature, entry.patch) };
      });
      if (store.isReadOnly()) return null;
      const refused = prepared.some(
        ({ feature, patch }) => featureLocked(store, feature) && !onlyLockOrVisibility(patch),
      );
      if (refused) return null;
      store.transact(() => {
        for (const { feature, updates } of prepared) store.updateFeature(feature.id, updates);
      });
      return prepared.map(({ feature }) => store.getFeature(feature.id) as StoredFeature);
    },

    delete(id) {
      const feature = require(id);
      if (store.isReadOnly() || featureLocked(store, feature)) return false;
      return store.deleteFeature(feature.id);
    },

    deleteMany(ids) {
      const features = requireAll(ids);
      if (store.isReadOnly()) return false;
      if (features.some((feature) => featureLocked(store, feature))) return false;
      store.transact(() => {
        for (const feature of features) {
          if (store.getFeature(feature.id)) store.deleteFeature(feature.id);
        }
      });
      return true;
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
      const area = require(id);
      const line = require(lineId);
      if (!isAreaFeature(area)) throw invalidInput(`The feature ${area.id} is not an area`);
      if (!isSplitLineFeature(line)) throw invalidInput(`The feature ${line.id} is not a line`);
      if (refuseChange([area])) return null;
      return runSplit(geometryDeps, area, line, false).map(
        (resultId) => store.getFeature(resultId) as StoredFeature,
      );
    },

    buffer(ids, options) {
      const inputs = inStackingOrder(requireAll(ids));
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
      return runBuffer(geometryDeps, inputs, { distanceMeters, segments }, false).map(
        (resultId) => store.getFeature(resultId) as StoredFeature,
      );
    },
  };

  function moveMany(ids: readonly string[], to: MoveTarget): boolean {
    const features = inStackingOrder(requireAll(ids));
    const target = resolveMoveTarget(store, to);
    if (store.isReadOnly()) return false;
    if (features.some((feature) => featureLocked(store, feature))) return false;
    if (target.locked) return false;
    moveFeatures(store, features, target);
    return true;
  }

  /** The features as areas in stacking order, at least `min` of them */
  function requireAreas(ids: unknown, min: number): StoredFeature[] {
    const features = inStackingOrder(requireAll(ids));
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
    const resultId = store.transact(() =>
      applyResult(geometryDeps, {
        anchor,
        removedIds: removed.map((feature) => feature.id),
        geometry,
      }),
    );
    return store.getFeature(resultId) ?? null;
  }
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
      throw new DrawError('already-exists', `The ID ${JSON.stringify(id)} is already taken`, {
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
      throw new DrawError('invalid-state', 'There is no layer to put the feature in');
    }
  }

  return {
    id,
    type: input.type,
    geometry: input.geometry,
    layerId,
    groupId: group?.id,
    properties: withoutUndefined(input.properties ?? {}),
    style: withoutUndefined(input.style ?? {}) as StoredFeatureStyle,
    visible: input.visible ?? true,
    locked: input.locked ?? false,
  };
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
  store: Store,
  feature: StoredFeature,
  style: RuntimeOptions['style'],
): FeatureStyleResolved {
  const defaults = toAppliedDefaults(style, feature.type);
  const layer = store.getLayer(feature.layerId);
  const own =
    resolveFeatureStyle(feature, layer?.styleRule, getStyleRuleChannel(feature.type)) ?? {};
  return { ...defaults, ...withoutUndefined(own) } as FeatureStyleResolved;
}
