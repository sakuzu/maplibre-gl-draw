// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.features`: the features of the document
 */

import { pageRowBox } from '@sakuzu/kasane/render';
import type { Value } from '@sakuzu/tabane';
import { featureTablesInternals, readWithoutKeeping } from '../../feature-table/feature-tables.js';
import { differenceAll, intersectionAll, unionAll } from '../../geometry/boolean.js';
import type { AreaCoordinates, BBox, MultiPolygonCoordinates } from '../../geometry/types.js';
import { describeGeometryProblem } from '../../shared/geometry-validation.js';
import { describeStyleProblem } from '../../shared/style-validation.js';
import { getBoundingBox } from '../../shared/utils/feature-bbox.js';
import { setOwnProperty } from '../../shared/utils/own-property.js';
import { featureUpdatesOfPatch, mergedKeys, propertiesPatchOf } from '../../store/feature-edits.js';
import {
  forEachMatchingRow,
  layerIdsInOrder,
  type RowFilter,
  rowMatcher,
} from '../../store/feature-stream.js';
import { featuresInStackingOrder } from '../../store/item-lists.js';
import { isFeatureLocked } from '../../store/lock.js';
import { listEveryFeatureInOrder } from '../../store/ordering.js';
import type { Store } from '../../store/store.js';
import type {
  Feature as StoredFeature,
  FeatureStyle as StoredFeatureStyle,
} from '../../store/types.js';
import { drawValueOfInput } from '../../table/value-input.js';
import { DrawError } from '../errors.js';
import type {
  StoredFeature as Feature,
  FeatureFilter,
  StoredFeatureInput as FeatureInput,
  FeatureListOptions,
  StoredFeaturePatch as FeaturePatch,
  MoveTarget,
} from '../model.js';
import { featuresExtent, rowsExtent } from './feature-extent.js';
import type { FeatureResource } from './feature-resource.js';
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
import { moveFeatures, resolveMoveTarget } from './placement.js';
import { createRestore } from './restore.js';
import type { ResourceDeps } from './shared.js';
import {
  featureLocked,
  filterEntries,
  invalidInput,
  invalidState,
  isRecord,
  matches,
  notFound,
  onlyKeys,
  onlyLockOrVisibility,
  optionalBoolean,
  requireId,
  requireIds,
  requireNewId,
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
export function createFeatures(deps: ResourceDeps): FeatureResource {
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
  const inStackingOrder = (features: StoredFeature[]): StoredFeature[] =>
    featuresInStackingOrder(store, features);

  const checkedEntries = (filter: FeatureFilter | undefined) => checkedFilterEntries(filter);
  const filterOf = (filter: FeatureFilter | undefined) => featureFilterOf(deps, filter);
  const keep = (feature: StoredFeature, checks: FeatureFilterChecks): boolean =>
    featureKept(store, feature, checks);

  /**
   * Visits the rows of a Store of rows that match a filter, in stacking order, without making
   * features
   */
  const forEachRow = (
    filter: FeatureFilter | undefined,
    visit: (id: string) => boolean,
    after?: number,
  ): void => {
    const rowFilter = Object.fromEntries(checkedEntries(filter)) as RowFilter;
    const tables = store.tables;
    if (!tables) return;
    forEachMatchingRow(
      store,
      rowFilter,
      (handle) => visit(tables.getRowId(handle) as string),
      after,
    );
  };

  /**
   * The number of the rows of every layer, of a layer or of the members of a group, read from the
   * tables without reading the rows (the deleted ones left out), when the filter names nothing, a
   * layer, a group or both and nothing else (undefined otherwise)
   */
  const countByPlace = (entries: Array<[string, unknown]>): number | undefined => {
    const tables = store.tables;
    if (!tables) return undefined;
    if (entries.length === 0) {
      let count = 0;
      for (const layerId of layerIdsInOrder(store)) count += tables.get(layerId)?.rowCount ?? 0;
      return count;
    }
    if (entries.some(([key]) => key !== 'layerId' && key !== 'groupId')) return undefined;
    const { layerId, groupId } = Object.fromEntries(entries) as {
      layerId?: unknown;
      groupId?: unknown;
    };
    if (groupId !== undefined) {
      const group = typeof groupId === 'string' ? store.getGroup(groupId) : undefined;
      if (!group || (layerId !== undefined && group.layerId !== layerId)) return 0;
      const handle = tables.findGroup(group.id);
      const view = tables.get(group.layerId);
      return handle === undefined || !view ? 0 : view.countGroupMembers(handle);
    }
    if (typeof layerId !== 'string' || !store.getLayer(layerId)) return 0;
    return tables.get(layerId)?.rowCount ?? 0;
  };

  function list(filter?: FeatureFilter, options?: FeatureListOptions): Feature[] {
    const page = options === undefined ? undefined : pageOf(options);
    const tables = store.tables;
    if (!tables) {
      const checks = filterOf(filter);
      let features = listEveryFeatureInOrder(store);
      if (page?.after !== undefined) {
        const at = features.findIndex((feature) => feature.id === page.after);
        if (at < 0) throw notFound('feature', page.after);
        features = features.slice(at + 1);
      }
      features = features.filter((feature) => keep(feature, checks));
      return page === undefined ? features : features.slice(0, page.limit);
    }
    if (page === undefined) {
      throw invalidState(
        'The features of a Store that holds them as rows are listed up to a limit: pass { limit }',
      );
    }
    const after = page.after === undefined ? undefined : tables.getRowRef(page.after);
    if (page.after !== undefined && after === undefined) throw notFound('feature', page.after);
    const features: Feature[] = [];
    if (page.limit === 0) return features;
    // A page of many rows keeps none of the features it makes
    readWithoutKeeping(tables, () =>
      forEachRow(
        filter,
        (id) => {
          const feature = store.getFeature(id);
          if (feature) features.push(feature);
          return features.length < page.limit;
        },
        after,
      ),
    );
    return features;
  }

  return {
    ...createRestore(deps),
    get: (id) => store.getFeature(id),
    getMany(ids) {
      if (!Array.isArray(ids)) throw invalidInput('The IDs must be an array');
      return ids.map((id) => store.getFeature(id));
    },
    list,
    count(filter) {
      if (store.tables) {
        const counted = countByPlace(checkedEntries(filter));
        if (counted !== undefined) return counted;
        let count = 0;
        forEachRow(filter, () => {
          count++;
          return true;
        });
        return count;
      }
      const checks = filterOf(filter);
      if (checks.entries.length === 0 && checks.inside === null && checks.shown === undefined) {
        return store.listFeatures().length;
      }
      return store.listFeatures().filter((feature) => keep(feature, checks)).length;
    },
    has: (id) => store.getFeature(id) !== undefined,
    bbox(filter) {
      if (store.tables)
        return rowsExtent(store, Object.fromEntries(checkedEntries(filter)) as RowFilter);
      const checks = filterOf(filter);
      return featuresExtent(store.listFeatures().filter((feature) => keep(feature, checks)));
    },

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
      store.transact(() => store.createFeatures(features));
      return features.map((feature) => store.getFeature(feature.id) as StoredFeature);
    },

    update(id, patch) {
      const feature = require(id);
      // The patch is checked before the refusals of the state
      preparePatch(feature, patch);
      if (store.isReadOnly()) return null;
      if (featureLocked(store, feature) && !onlyLockOrVisibility(patch)) return null;
      store.applyEdits([{ kind: 'set', featureId: feature.id, patch }]);
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
        // The patch is checked before the refusals of the state
        preparePatch(feature, entry.patch);
        return { feature, patch: entry.patch };
      });
      if (store.isReadOnly()) return null;
      const refused = prepared.some(
        ({ feature, patch }) => featureLocked(store, feature) && !onlyLockOrVisibility(patch),
      );
      if (refused) return null;
      store.applyEdits(
        prepared.map(({ feature, patch }) => ({ kind: 'set', featureId: feature.id, patch })),
      );
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
      // A copy: the look is kept for the feature, and the caller may change what it is given
      return { ...deps.appliedStyle(feature) };
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

    writeResults(results) {
      if (store.isReadOnly()) return false;
      let written = 0;
      store.transact(() => {
        for (const result of results) {
          const anchor =
            store.getFeature(result.anchor.id) ??
            (result.removedIds.length === 0 ? undefined : undefined);
          if (!anchor && !result.removedIds.every((id) => !store.getFeature(id))) continue;
          const source = anchor ?? result.anchor;
          if (!anchor && !store.getLayer(source.layerId)) continue;
          applyResult(
            { store, generateFeatureId: () => result.id },
            {
              anchor: source,
              removedIds: result.removedIds,
              geometry: result.geometry as never,
              ...(result.properties !== undefined && { properties: result.properties }),
            },
          );
          written++;
        }
      });
      return written > 0;
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

/** The entries of a filter checked: `shown` a boolean and `bbox` an extent in degrees */
function checkedFilterEntries(filter: FeatureFilter | undefined): Array<[string, unknown]> {
  const entries = filterEntries(filter, FILTER_KEYS);
  const shown = entries.find(([key]) => key === 'shown')?.[1];
  if (shown !== undefined && typeof shown !== 'boolean') {
    throw invalidInput('shown must be a boolean');
  }
  const bbox = entries.find(([key]) => key === 'bbox')?.[1];
  if (
    bbox !== undefined &&
    (!Array.isArray(bbox) ||
      bbox.length !== 4 ||
      bbox.some((value) => typeof value !== 'number' || !Number.isFinite(value)))
  ) {
    throw invalidInput('bbox must be [west, south, east, north] in degrees');
  }
  return entries;
}

/** The checks of a filter of features */
interface FeatureFilterChecks {
  /** The entries compared as they are */
  readonly entries: Array<[string, unknown]>;
  /** The IDs within the extent, when the filter has one */
  readonly inside: ReadonlySet<string> | null;
  readonly shown: boolean | undefined;
}

/**
 * The checks of a filter: the entries compared as they are, and the IDs within the extent when
 * the filter has one
 */
function featureFilterOf(
  deps: ResourceDeps,
  filter: FeatureFilter | undefined,
): FeatureFilterChecks {
  const { store } = deps;
  const all = checkedFilterEntries(filter);
  const shown = all.find(([key]) => key === 'shown')?.[1] as boolean | undefined;
  const entries = all.filter(([key]) => key !== 'shown');
  const bbox = entries.find(([key]) => key === 'bbox')?.[1];
  if (bbox === undefined) return { entries, inside: null, shown };
  const [minX, minY, maxX, maxY] = bbox as number[];
  const inside = new Set(
    deps.spatialIndex
      ? deps.spatialIndex.findInBounds(bbox as BBox)
      : store
          .listFeatures()
          .filter((feature) => {
            const box = getBoundingBox(feature);
            return box[0] <= maxX && box[2] >= minX && box[1] <= maxY && box[3] >= minY;
          })
          .map((feature) => feature.id),
  );
  return { entries: entries.filter(([key]) => key !== 'bbox'), inside, shown };
}

/** Whether the feature, its group and its layer are all visible in the document */
function featureShown(store: Store, feature: StoredFeature): boolean {
  return (
    feature.visible &&
    (feature.groupId === undefined || store.getGroup(feature.groupId)?.visible !== false) &&
    store.getLayer(feature.layerId)?.visible !== false
  );
}

/** Whether a feature passes the checks of a filter */
function featureKept(store: Store, feature: StoredFeature, checks: FeatureFilterChecks): boolean {
  return (
    (checks.inside === null || checks.inside.has(feature.id)) &&
    (checks.shown === undefined || featureShown(store, feature) === checks.shown) &&
    matches(feature, checks.entries)
  );
}

/**
 * The test of a filter of features on a feature (the filter checked once: a filter of the wrong
 * shape throws here)
 *
 * @internal
 */
export function featureMatcher(
  deps: ResourceDeps,
  filter: FeatureFilter | undefined,
): (feature: StoredFeature) => boolean {
  const checks = featureFilterOf(deps, filter);
  return (feature) => featureKept(deps.store, feature, checks);
}

/**
 * The test of a filter of features on a row of a Store of rows (the filter checked once: a filter
 * of the wrong shape throws here); null when no row can match
 *
 * @internal
 */
export function featureRowMatcher(
  store: Store,
  filter: FeatureFilter | undefined,
): ((handle: number) => boolean) | null {
  const rowFilter = Object.fromEntries(checkedFilterEntries(filter)) as RowFilter;
  const matches = rowMatcher(store, rowFilter);
  if (!matches) return null;
  const bbox = rowFilter.bbox;
  if (!bbox) return matches;
  const internals = featureTablesInternals(store.tables);
  const b = new Float64Array(4);
  return (handle) => {
    if (!matches(handle)) return false;
    const place = internals?.placeOf(handle);
    if (!place || !pageRowBox(place.group.data, place.row, b)) return false;
    return b[0] <= bbox[2] && b[2] >= bbox[0] && b[1] <= bbox[3] && b[3] >= bbox[1];
  };
}

/**
 * The limit and the feature to read on after of a reading of features, checked
 *
 * @internal
 */
export function pageOf(options: FeatureListOptions): {
  limit: number;
  after: string | undefined;
} {
  requireRecord(options, 'The options');
  onlyKeys(options as unknown as Record<string, unknown>, ['limit', 'after'], 'The options');
  const { limit, after } = options;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 0) {
    throw invalidInput('limit must be a non-negative integer');
  }
  if (after !== undefined && typeof after !== 'string') {
    throw invalidInput('after must be the ID of a feature');
  }
  return { limit, after };
}

// ============================================================================
// Inputs and patches
// ============================================================================

/**
 * Checks the input of a feature a sketch creates and builds the feature `features.create` would
 * store: with the ID given when the input has none, in the layer given when it names neither layer
 * nor group
 *
 * @param partial - Whether it is a shape being drawn, whose geometry may have fewer positions than
 *   a feature (a line of one, a ring of fewer than four)
 * @throws DrawError as `features.create` does for a wrong input
 * @internal
 */
export function prepareFeatureInput(
  store: Store,
  input: FeatureInput,
  id: string,
  layerId: string,
  partial = false,
): StoredFeature {
  return prepareFeature(
    { store, generateId: () => id, getActiveLayerId: () => layerId },
    input,
    new Set(),
    partial,
  );
}

/**
 * Checks an input and builds the feature to store; throws DrawError on a wrong input
 *
 * @internal
 */
export function prepareFeature(
  deps: Pick<ResourceDeps, 'store' | 'generateId' | 'getActiveLayerId'>,
  input: FeatureInput,
  pending: ReadonlySet<string>,
  partial = false,
): StoredFeature {
  const { store } = deps;
  requireRecord(input, 'The input');
  const record = input as unknown as Record<string, unknown>;
  onlyKeys(record, INPUT_KEYS, 'The input');
  if (typeof input.type !== 'string' || input.type === '') {
    throw invalidInput('type must be a non-empty string');
  }
  const geometryProblem = describeGeometryProblem(input.type, input.geometry, partial);
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

  const id = input.id === undefined ? deps.generateId() : requireNewId(store, input.id, pending);

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

  return {
    id,
    type: input.type,
    geometry: input.geometry,
    layerId,
    groupId: group?.id,
    properties: propertiesOfInput(input.properties ?? {}),
    style: withoutUndefined(input.style ?? {}) as StoredFeatureStyle,
    visible: input.visible ?? true,
    locked: input.locked ?? false,
  };
}

/**
 * Checks a patch of `selection.update`, which is given to many features: as a patch of
 * `features.update`, without a geometry
 *
 * @throws DrawError `invalidInput` for a patch of another shape, or one with a geometry
 * @internal
 */
export function checkSharedPatch(patch: unknown): FeaturePatch {
  requireRecord(patch, 'The patch');
  const record = patch as Record<string, unknown>;
  onlyKeys(record, PATCH_KEYS, 'The patch');
  if (record.geometry !== undefined) {
    throw invalidInput('A patch given to many features does not change their geometry');
  }
  optionalBoolean(record, 'visible');
  optionalBoolean(record, 'locked');
  if (record.properties !== undefined && !isRecord(record.properties)) {
    throw invalidInput('properties must be an object');
  }
  if (record.properties !== undefined) propertiesPatchOf(record.properties);
  if (record.style !== undefined) {
    const problem = describeStyleProblem(record.style as never);
    if (problem) throw invalidInput(`The patch has ${problem}`);
  }
  return patch as FeaturePatch;
}

/**
 * The test of a filter of features as a filter of rows (the filter checked)
 *
 * @internal
 */
export function featureRowFilter(filter: FeatureFilter | undefined): RowFilter {
  return Object.fromEntries(checkedFilterEntries(filter)) as RowFilter;
}

/**
 * Checks a patch and builds the updates of the Store (`featureUpdatesOfPatch`); throws DrawError
 * on a wrong patch
 *
 * @internal
 */
export function preparePatch(feature: StoredFeature, patch: FeaturePatch): Partial<StoredFeature> {
  return featureUpdatesOfPatch(feature, patch);
}

/** A copy without the keys whose value is undefined */
function withoutUndefined(value: object): Record<string, unknown> {
  return mergedKeys({}, value as Record<string, unknown>);
}

/**
 * The properties of an input, each value in the one form of a value, without the keys whose
 * value is undefined
 *
 * @throws DrawError `invalidInput` when a value is not a value
 */
function propertiesOfInput(properties: Record<string, unknown>): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value !== undefined)
      setOwnProperty(out, key, drawValueOfInput(value, `The property ${key}`));
  }
  return out;
}
