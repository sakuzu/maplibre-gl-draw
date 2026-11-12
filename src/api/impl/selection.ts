// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.selection` and `draw.vertexSelection`: what this client has selected
 */

import { pageRowBox } from '@sakuzu/kasane/render';
import type { RowUpdate } from '../../feature-table/bulk-plan.js';
import {
  firstRowsInOrder,
  isRowShown,
  type RowContainers,
  rowsByLayerInOrder,
} from '../../feature-table/bulk-rows.js';
import {
  featureTablesInternals,
  keepSelectedRows,
  readWithoutKeeping,
} from '../../feature-table/feature-tables.js';
import { TableSelection } from '../../feature-table/selection.js';
import { groupSelection, ungroupSelection } from '../../operations/layer-operations.js';
import {
  deleteSelectedItems,
  deleteSelectedVertices,
} from '../../operations/selection-operations.js';
import { getDrawProperty } from '../../shared/properties.js';
import { coordinatesOf, supportsVertexEditing } from '../../shared/utils/coordinates.js';
import { getBoundingBox } from '../../shared/utils/feature-bbox.js';
import { forEachMatchingRow } from '../../store/feature-stream.js';
import { isFeatureLocked } from '../../store/lock.js';
import { listEveryFeatureInOrder } from '../../store/ordering.js';
import {
  selectionOfTarget,
  selectionTargetOf,
  selectionValueOf,
} from '../../store/selection-value.js';
import type { Feature as StoredFeature, VertexRef } from '../../store/types.js';
import { ROW_FLAG_HIDDEN, ROW_FLAG_LOCKED } from '../../table/feature-row-columns.js';
import { DrawError } from '../errors.js';
import type {
  Feature,
  StoredFeaturePatch as FeaturePatch,
  FeatureRow,
  FeatureStyleSample,
  FeatureType,
} from '../model.js';
import type { VertexSelectionResource } from '../selection.js';
import type { SelectionTarget, SelectionType, SelectionValue } from '../state.js';
import type { EventHub } from './events.js';
import { observe } from './events.js';
import type { FeatureResource } from './feature-resource.js';
import { toFeature } from './feature-shape.js';
import {
  checkSharedPatch,
  featureMatcher,
  featureRowFilter,
  featureRowMatcher,
  pageOf,
} from './features.js';
import type { GroupResource } from './group-resource.js';
import { moveBulkSelection } from './placement.js';
import type { SelectionWrites } from './selection-resource.js';
import type { ResourceDeps } from './shared.js';
import {
  featureLocked,
  getItem,
  invalidInput,
  invalidState,
  isRecord,
  isShown,
  notFound,
  onlyLockOrVisibility,
  requireId,
  requireIds,
} from './shared.js';

const SELECTION_TYPES: readonly SelectionType[] = ['feature', 'group', 'layer'];

/** How long one slice of `selection.scan` reads for before the next one, in a task of its own (ms) */
const SCAN_SLICE_MS = 8;

/** A task after the ones queued now */
function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A row of a feature read from the tables, its feature made when asked for */
class TableFeatureRow implements FeatureRow {
  #made: Feature | undefined;
  constructor(
    readonly id: string,
    readonly featureType: FeatureType,
    readonly layerId: string,
    readonly groupId: string | null,
    readonly visible: boolean,
    readonly locked: boolean,
    readonly bbox: [number, number, number, number] | null,
    private readonly read: (id: string) => StoredFeature | undefined,
  ) {}

  property(key: PropertyKey): never {
    return (this.toFeature().properties as Record<PropertyKey, unknown>)[key] as never;
  }

  toFeature(): Feature {
    if (this.#made) return this.#made;
    const feature = this.read(this.id);
    if (!feature) throw notFound('feature', this.id);
    this.#made = toFeature(feature);
    return this.#made;
  }
}

/** A row of a feature held as a feature */
function rowOfFeature(feature: StoredFeature): FeatureRow {
  let made: Feature | undefined;
  const make = (): Feature => {
    made ??= toFeature(feature);
    return made;
  };
  return {
    id: feature.id,
    featureType: feature.type as FeatureType,
    layerId: feature.layerId,
    groupId: feature.groupId ?? null,
    visible: feature.visible !== false,
    locked: feature.locked === true,
    bbox: getBoundingBox(feature),
    property: (key) => (make().properties as Record<PropertyKey, unknown>)[key] as never,
    toFeature: make,
  };
}

/**
 * Creates `draw.selection`
 *
 * The selection holds only what can be seen: an item that is hidden (by its visible flag, the
 * one of its group or layer, or by this client) cannot be selected.
 *
 * @internal
 */
export function createSelection(
  deps: ResourceDeps,
  collections: { features: FeatureResource; groups: GroupResource },
  events: EventHub,
): SelectionWrites {
  const { store } = deps;
  const observable = observe(
    events,
    ['selection.changed'],
    () => selectionValueOf(store) as SelectionValue,
  );

  /** Throws unless every ID names an item of the type */
  const requireItems = (type: SelectionType, ids: unknown): string[] => {
    const list = requireIds(ids);
    for (const id of list) {
      if (!getItem(store, type, id)) throw notFound(type, id);
    }
    return list;
  };

  /** The rows of the features selected in bulk, with the tables they are read from */
  const bulkRows = () => {
    const rows = store.getSelectedRows();
    const internals = featureTablesInternals(store.tables);
    return rows && internals ? { rows, internals } : null;
  };

  /** The selected features (for a group or a layer, the features in it), in stacking order */
  const selectedFeatures = (): StoredFeature[] => {
    const { type, ids } = store.getSelection();
    if (type === 'feature') {
      return ids
        .map((id) => store.getFeature(id))
        .filter((feature): feature is StoredFeature => feature !== undefined);
    }
    if (type === null) return [];
    // A Store of rows: the features of the rows of the groups or the layers, by their rows
    const internals = featureTablesInternals(store.tables);
    const rows = internals ? store.rowsOfSelection() : null;
    if (internals && rows) {
      const out: StoredFeature[] = [];
      for (const handles of rowsByLayerInOrder(internals, rows).values()) {
        for (const handle of handles) {
          const feature = store.getFeature(internals.ids.idOf(handle) as string);
          if (feature) out.push(feature);
        }
      }
      return out;
    }
    const wanted = new Set(ids);
    const inside = (feature: StoredFeature): boolean =>
      type === 'group'
        ? feature.groupId !== undefined && wanted.has(feature.groupId)
        : wanted.has(feature.layerId);
    return listEveryFeatureInOrder(store).filter(inside);
  };

  /** The rows selected in bulk that match a filter, in stacking order */
  const matchingRows = (filter: Parameters<SelectionWrites['count']>[0]): number[] => {
    const found = bulkRows();
    if (!found) return [];
    const matches = featureRowMatcher(store, filter);
    if (!matches) return [];
    const out: number[] = [];
    for (const handles of rowsByLayerInOrder(found.internals, found.rows).values()) {
      for (const handle of handles) if (matches(handle)) out.push(handle);
    }
    return out;
  };

  /** The first rows selected in bulk that match a filter, in stacking order */
  const firstRows = (filter: Parameters<SelectionWrites['count']>[0], limit: number): number[] => {
    const found = bulkRows();
    const layerIds = store.getSelection().bulk?.layerIds;
    const matches = found && layerIds ? featureRowMatcher(store, filter) : null;
    if (!found || !layerIds || !matches) return [];
    return firstRowsInOrder(found.internals, found.rows, layerIds, limit, matches);
  };

  /**
   * What `scan` reads, fixed as the selection is now: the rows in stacking order in a Store of
   * rows (the rows selected in bulk, or those of the groups or the layers selected), or else the
   * IDs of the features
   */
  const toScan = (): { rows: readonly number[] } | { ids: readonly string[] } => {
    if (store.getSelectedRows()) return { rows: matchingRows(undefined) };
    const { type } = store.getSelection();
    const internals = featureTablesInternals(store.tables);
    const rows = type !== 'feature' && type !== null && internals ? store.rowsOfSelection() : null;
    if (internals && rows) {
      const out: number[] = [];
      for (const handles of rowsByLayerInOrder(internals, rows).values()) out.push(...handles);
      return { rows: out };
    }
    return { ids: selectedFeatures().map((feature) => feature.id) };
  };

  /**
   * What reads the rows held in the tables, as they are held when each is read: a row, or null
   * for a row that is gone (null when the Store holds no rows)
   */
  const tableRows = (): ((handle: number) => FeatureRow | null) | null => {
    const tables = store.tables;
    const internals = featureTablesInternals(tables);
    if (!tables || !internals) return null;
    const read = (id: string) => readWithoutKeeping(tables, () => store.getFeature(id));
    const views = new Map<string, ReturnType<typeof tables.get>>();
    const b = new Float64Array(4);
    return (handle) => {
      const place = internals.placeOf(handle);
      const id = internals.ids.idOf(handle);
      if (!place || typeof id !== 'string') return null;
      const data = place.group.data;
      const row = place.row;
      const layerId = place.table.tableId;
      let view = views.get(layerId);
      if (view === undefined) {
        view = tables.get(layerId);
        views.set(layerId, view);
      }
      const flags = data.flags[row] as number;
      const group = data.groups[row] as number;
      pageRowBox(data, row, b);
      const x0 = b[0] as number;
      const y0 = b[1] as number;
      const x1 = b[2] as number;
      const y1 = b[3] as number;
      const finite =
        Number.isFinite(x0) && Number.isFinite(y0) && Number.isFinite(x1) && Number.isFinite(y1);
      return new TableFeatureRow(
        id,
        view?.getRowType(handle) as FeatureType,
        layerId,
        group >= 0 ? (internals.groups.idOf(group) ?? null) : null,
        (flags & ROW_FLAG_HIDDEN) === 0,
        (flags & ROW_FLAG_LOCKED) !== 0,
        finite ? [x0, y0, x1, y1] : null,
        read,
      );
    };
  };

  return {
    get value() {
      return observable.value;
    },
    subscribe: observable.subscribe,

    get target() {
      return selectionTargetOf(store) as SelectionTarget;
    },

    set(typeOrTarget: SelectionType | SelectionTarget, ids?: readonly string[]) {
      if (isRecord(typeOrTarget)) {
        const selection = selectionOfTarget(store, typeOrTarget as SelectionTarget);
        if (!selection) throw invalidInput('The target is not one the instance gave');
        store.restoreSelection(selection);
        return store.getSelection().type !== null;
      }
      const type = typeOrTarget as SelectionType;
      if (!SELECTION_TYPES.includes(type)) {
        throw invalidInput('type must be feature, group or layer');
      }
      const list = requireIds(ids);
      // Many features of rows are selected in bulk: read on their columns, no feature is made
      const tables = store.tables;
      if (type === 'feature' && tables && list.length > store.selectionIdsLimit) {
        const handles = list.map((id) => tables.getRowRef(id) ?? -1);
        if (handles.every((handle) => handle >= 0)) {
          if (!list.some((id) => isShown(store, type, id))) return false;
          store.selectRows(TableSelection.of(handles));
          return true;
        }
      }
      // The features of rows are read on their rows: none is made for the check (the selection
      // keeps the features of its rows)
      const internals = featureTablesInternals(tables);
      if (type === 'feature' && tables && internals) {
        const containers = rowContainersOf(store);
        const shown: string[] = [];
        const handles: number[] = [];
        for (const id of list) {
          const handle = tables.getRowRef(id);
          if (handle === undefined) throw notFound(type, id);
          if (!isRowShown(internals, containers, handle)) continue;
          shown.push(id);
          handles.push(handle);
        }
        if (shown.length === 0) return false;
        // The rows are found by the handles found here when the selection is set
        keepSelectedRows(tables, handles, shown);
        store.setSelection(type, shown);
        return true;
      }
      // Each item is read once
      const selectable = list.filter((id) => {
        const item = getItem(store, type, id);
        if (!item) throw notFound(type, id);
        return isShown(store, type, id, item);
      });
      if (selectable.length === 0) return false;
      store.setSelection(type, selectable);
      return true;
    },

    setAll(filter) {
      if (store.tables) {
        const rowFilter = featureRowFilter(filter);
        const handles: number[] = [];
        forEachMatchingRow(store, rowFilter, (handle) => {
          handles.push(handle);
          return true;
        });
        store.selectRows(TableSelection.of(handles));
        return store.getSelection().type !== null;
      }
      const matches = featureMatcher(deps, filter);
      const ids = listEveryFeatureInOrder(store)
        .filter((feature) => matches(feature) && isShown(store, 'feature', feature.id))
        .map((feature) => feature.id);
      if (ids.length === 0) return false;
      store.setSelection('feature', ids);
      return true;
    },

    add(ids) {
      const current = store.getSelection();
      const list = requireIds(ids);
      // With nothing selected, the type is the one of the first ID
      const type = current.type ?? SELECTION_TYPES.find((t) => getItem(store, t, list[0] ?? ''));
      if (type === undefined) {
        if (list.length === 0) return false;
        throw notFound('feature, group or layer', list[0]);
      }
      const found = current.bulk && type === 'feature' ? bulkRows() : null;
      if (found && store.tables) {
        const tables = store.tables;
        const handles = requireItems(type, list)
          .filter((id) => isShown(store, type, id))
          .map((id) => tables.getRowRef(id) ?? -1)
          .filter((handle) => handle >= 0 && !found.rows.has(handle));
        if (handles.length === 0) return false;
        store.selectRows(found.rows.with(handles));
        return true;
      }
      const added = requireItems(type, list).filter(
        (id) => !current.ids.includes(id) && isShown(store, type, id),
      );
      if (added.length === 0) return false;
      store.setSelection(type, [...current.ids, ...added]);
      return true;
    },

    remove(ids) {
      const current = store.getSelection();
      const list = requireIds(ids);
      const found = current.bulk && current.type === 'feature' ? bulkRows() : null;
      if (found && store.tables) {
        const tables = store.tables;
        const handles = list
          .map((id) => tables.getRowRef(id) ?? -1)
          .filter((handle) => found.rows.has(handle));
        if (handles.length === 0) return false;
        store.selectRows(found.rows.without(handles));
        return true;
      }
      const removed = new Set(list.filter((id) => current.ids.includes(id)));
      if (removed.size === 0) return false;
      const kept = current.ids.filter((id) => !removed.has(id));
      store.setSelection(kept.length > 0 ? current.type : null, kept);
      return true;
    },

    clear() {
      store.setSelection(null, []);
    },

    features(filter, options) {
      const page = options === undefined ? undefined : pageOf(options);
      if (store.getSelectedRows()) {
        if (page === undefined) {
          throw invalidState(
            'The features selected in bulk are read up to a limit: pass { limit }',
          );
        }
        const rows =
          page.after === undefined ? firstRows(filter, page.limit) : matchingRows(filter);
        let from = 0;
        if (page.after !== undefined) {
          const after = store.tables?.getRowRef(page.after);
          const found = bulkRows();
          if (after === undefined || !found?.rows.has(after)) throw notFound('feature', page.after);
          const at = rows.indexOf(after);
          // The feature read last may not match the filter: read on after its place in the order
          from = at >= 0 ? at + 1 : firstAfter(found, rows, after);
        }
        const out: Feature[] = [];
        // A page of many rows keeps none of the features it makes
        readWithoutKeeping(store.tables, () => {
          for (let i = from; i < rows.length && out.length < page.limit; i++) {
            const feature = store.getFeature(store.tables?.getRowId(rows[i]) as string);
            if (feature) out.push(toFeature(feature));
          }
        });
        return out;
      }
      const matches = featureMatcher(deps, filter);
      let features = selectedFeatures();
      if (page?.after !== undefined) {
        const at = features.findIndex((feature) => feature.id === page.after);
        if (at < 0) throw notFound('feature', page.after);
        features = features.slice(at + 1);
      }
      features = features.filter(matches);
      return (page === undefined ? features : features.slice(0, page.limit)).map(toFeature);
    },

    count(filter) {
      if (store.getSelectedRows()) return matchingRows(filter).length;
      const matches = featureMatcher(deps, filter);
      return selectedFeatures().filter(matches).length;
    },

    async scan(visit, options) {
      if (typeof visit !== 'function') throw invalidInput('visit must be a function');
      const signal = options?.signal;
      const onProgress = options?.onProgress;
      const stopped = () =>
        new DrawError('aborted', 'The scan was stopped by its signal', { cause: signal?.reason });
      if (signal?.aborted) throw stopped();
      const what = toScan();
      const total = 'rows' in what ? what.rows.length : what.ids.length;
      const ofHandle = 'rows' in what ? tableRows() : null;
      const rowAt =
        'rows' in what
          ? (i: number) => ofHandle?.(what.rows[i] as number) ?? null
          : (i: number) => {
              const feature = store.getFeature(what.ids[i] as string);
              return feature ? rowOfFeature(feature) : null;
            };
      let done = 0;
      while (done < total) {
        const start = performance.now();
        do {
          const row = rowAt(done++);
          if (row) visit(row);
        } while (done < total && performance.now() - start < SCAN_SLICE_MS);
        onProgress?.({ phase: 'read', done, total });
        if (done < total) {
          await nextTask();
          if (signal?.aborted) throw stopped();
        }
      }
    },

    update(patch, filter) {
      const make =
        typeof patch === 'function'
          ? (sample: FeatureStyleSample) => {
              const made = patch(sample);
              return made === null ? null : checkSharedPatch(made);
            }
          : (() => {
              const checked = checkSharedPatch(patch);
              return () => checked;
            })();
      if (store.getSelectedRows()) {
        const rows = TableSelection.of(matchingRows(filter));
        if (rows.count === 0) return false;
        return store.applyBulk(
          {
            kind: 'update',
            make: (sample) => {
              const made = make(sample);
              return made === null ? null : toRowUpdate(made);
            },
          },
          rows,
        );
      }
      const matches = featureMatcher(deps, filter);
      const features = selectedFeatures().filter(matches);
      // One patch per kind of feature: its type, its style and its created zoom
      const patches = new Map<string, FeaturePatch | null>();
      const prepared: Array<{ feature: StoredFeature; patch: FeaturePatch }> = [];
      for (const feature of features) {
        const createdZoom = getDrawProperty(feature, 'createdZoom');
        const key = JSON.stringify([feature.type, feature.style, createdZoom ?? null]);
        let made = patches.get(key);
        if (made === undefined) {
          made = make({ type: feature.type, style: feature.style, createdZoom });
          patches.set(key, made);
        }
        if (made) prepared.push({ feature, patch: made });
      }
      // A locked feature is left as it is, unless only its lock or its visibility changes
      const written = prepared.filter(
        ({ feature, patch: made }) => !featureLocked(store, feature) || onlyLockOrVisibility(made),
      );
      if (written.length === 0 || store.isReadOnly()) return false;
      store.applyEdits(
        written.map(({ feature, patch: made }) => ({
          kind: 'set',
          featureId: feature.id,
          patch: made,
        })),
      );
      return true;
    },

    delete() {
      return deleteSelectedItems(store);
    },

    group() {
      if (store.isReadOnly()) return null;
      const id = groupSelection(store, deps.generateId, deps.autoNameGenerator);
      return id === null ? null : (store.getGroup(id) ?? null);
    },

    ungroup() {
      // The same operation as the ungroup shortcut
      if (store.isReadOnly()) return false;
      return ungroupSelection(store);
    },

    move(to) {
      const { type, ids, bulk } = store.getSelection();
      if (bulk && type === 'feature') return moveBulkSelection(store, to);
      if (type === 'feature' && ids.length > 0) return collections.features.moveMany(ids, to);
      if (type === 'group' && ids.length > 0) return collections.groups.moveMany(ids, to);
      return false;
    },
  };
}

/** What the document of a Store says of the layers and the groups a row is in */
function rowContainersOf(store: ResourceDeps['store']): RowContainers {
  return {
    layerVisible: (layerId) => store.getLayer(layerId)?.visible === true,
    layerLocked: (layerId) => store.getLayer(layerId)?.locked === true,
    hidden: (id) => store.isHidden(id),
  };
}

/** A patch given to many features as the change of a kind of row */
function toRowUpdate(patch: FeaturePatch): RowUpdate {
  return {
    ...(patch.style !== undefined && { style: patch.style as Record<string, unknown> }),
    ...(patch.properties !== undefined && {
      properties: patch.properties as Record<string, unknown>,
    }),
    ...(patch.visible !== undefined && { visible: patch.visible }),
    ...(patch.locked !== undefined && { locked: patch.locked }),
  };
}

/**
 * Where the reading of the rows selected in bulk goes on after a row that does not match the
 * filter: the first matching row after it in the order
 */
function firstAfter(
  found: {
    rows: TableSelection;
    internals: NonNullable<ReturnType<typeof featureTablesInternals>>;
  },
  matching: readonly number[],
  after: number,
): number {
  const position = new Map<number, number>();
  let n = 0;
  for (const handles of rowsByLayerInOrder(found.internals, found.rows).values()) {
    for (const handle of handles) position.set(handle, n++);
  }
  const from = position.get(after) ?? -1;
  for (let i = 0; i < matching.length; i++) {
    if ((position.get(matching[i]) ?? -1) > from) return i;
  }
  return matching.length;
}

/**
 * Creates `draw.vertexSelection`
 *
 * @internal
 */
export function createVertexSelection(
  deps: Pick<ResourceDeps, 'store'>,
  events: EventHub,
): VertexSelectionResource {
  const { store } = deps;
  const observable = observe(events, ['vertexSelection.changed'], () => store.getVertexSelection());
  return {
    get value() {
      return observable.value;
    },
    subscribe: observable.subscribe,
    get: () => store.getVertexSelection(),

    set(featureId, vertices) {
      const id = requireId(featureId, 'featureId');
      const feature = store.getFeature(id);
      if (!feature) throw notFound('feature', id);
      if (!Array.isArray(vertices)) throw invalidInput('The vertices must be an array');
      const refs = vertices.map((vertex) => {
        if (!isVertexRef(vertex)) throw invalidInput('A vertex must be { part?, ring, index }');
        if (!vertexExists(feature, vertex)) {
          throw notFound('vertex', vertex);
        }
        return { ...vertex };
      });
      if (isFeatureLocked(feature, store)) return false;
      store.setSelectedVertices(refs.length > 0 ? { featureId: id, vertices: refs } : null);
      return true;
    },

    clear() {
      store.setSelectedVertices(null);
    },

    delete() {
      const selection = store.getVertexSelection();
      if (!selection || selection.vertices.length === 0) return false;
      if (store.isReadOnly() || store.isInteractionLocked()) return false;
      return deleteSelectedVertices(store, selection) > 0;
    },
  };
}

/** Whether the value has the shape of a vertex reference */
function isVertexRef(value: unknown): value is VertexRef {
  if (!isRecord(value)) return false;
  const isIndex = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0;
  return (
    (value.part === undefined || isIndex(value.part)) && isIndex(value.ring) && isIndex(value.index)
  );
}

/** Whether the vertex exists on the feature (the closing position of a ring is not a vertex) */
function vertexExists(feature: StoredFeature, ref: VertexRef): boolean {
  if (!supportsVertexEditing(feature.type)) return false;
  const part = ref.part ?? 0;
  const coordinates = coordinatesOf(feature) as unknown[];
  const ringVertices = (ring: unknown): number =>
    Array.isArray(ring) ? Math.max(0, ring.length - 1) : 0;
  switch (feature.geometry.type) {
    case 'LineString':
      return part === 0 && ref.ring === 0 && ref.index < coordinates.length;
    case 'Polygon':
      return part === 0 && ref.index < ringVertices(coordinates[ref.ring]);
    case 'MultiPoint':
      return ref.ring === 0 && ref.index === 0 && part < coordinates.length;
    case 'MultiLineString': {
      const line = coordinates[part];
      return ref.ring === 0 && Array.isArray(line) && ref.index < line.length;
    }
    case 'MultiPolygon': {
      const polygon = coordinates[part];
      return Array.isArray(polygon) && ref.index < ringVertices(polygon[ref.ring]);
    }
    default:
      return false;
  }
}
