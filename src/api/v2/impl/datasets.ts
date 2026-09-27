// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.datasets`: the large data that is drawn but not edited, over the dataset manager of
 * the engine
 *
 * A `Dataset` of the API wraps one dataset of the engine and speaks in rows: GeoJSON features,
 * `BBox` arrays and `Position` arrays. The same dataset always gives the same object.
 */

import type { DatasetManager } from '../../../dataset/manager.js';
import type {
  DatasetClickPayload,
  DatasetEventMap,
  DatasetHoverPayload,
  Dataset as EngineDataset,
  DatasetOptions as EngineDatasetOptions,
  DatasetRow as EngineDatasetRow,
} from '../../../dataset/types.js';
import type { EventEmitter } from '../../../shared/utils/event-emitter.js';
import type { Feature as StoredFeature } from '../../../store/types.js';
import { describeStyleProblem } from '../../import-export/style-validation.js';
import type {
  Dataset,
  DatasetBaseStyle,
  DatasetCollisionThinning,
  DatasetEvents,
  DatasetOptions,
  DatasetPlacement,
  DatasetRow,
  DatasetsCollection,
} from '../datasets.js';
import { DrawError } from '../errors.js';
import type { ScreenPoint } from '../events.js';
import type { StyleRule } from '../model.js';
import type { EventHub } from './events.js';
import { toBBox, toBoundingBox, toDatasetRow } from './rows.js';
import {
  invalidInput,
  isRecord,
  notFound,
  onlyKeys,
  optionalIndex,
  requireId,
  requireIds,
} from './shared.js';

const ORDERS: readonly string[] = ['below-store', 'above-store', 'layer-order'];

const OPTION_KEYS = [
  'id',
  'rows',
  'table',
  'provider',
  'styleRule',
  'baseStyle',
  'interactive',
  'order',
  'zoomScale',
  'collisionThinning',
  'externalPointRender',
] as const;

/** The names of the events of a dataset of the engine for those of the API */
const EVENT_NAMES = {
  clicked: 'click',
  hovered: 'hover',
  changed: 'change',
} as const satisfies Record<keyof DatasetEvents, keyof DatasetEventMap>;

// ============================================================================
// Checks
// ============================================================================

function checkBaseStyle(value: unknown): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw invalidInput('baseStyle must be an object');
  onlyKeys(value, ['point', 'stroke', 'fill'], 'baseStyle');
  for (const [key, style] of Object.entries(value)) {
    if (style === undefined) continue;
    const problem = describeStyleProblem(style);
    if (problem) throw invalidInput(`baseStyle.${key} is ${problem}`);
  }
}

function checkThinning(value: unknown): void {
  if (value === undefined || value === null) return;
  if (!isRecord(value)) throw invalidInput('collisionThinning must be an object');
  onlyKeys(value, ['enabled', 'fullDisplayZoom', 'marginPx'], 'collisionThinning');
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    throw invalidInput('collisionThinning.enabled must be a boolean');
  }
  for (const key of ['fullDisplayZoom', 'marginPx']) {
    const number = value[key];
    if (number !== undefined && (typeof number !== 'number' || !Number.isFinite(number))) {
      throw invalidInput(`collisionThinning.${key} must be a number`);
    }
  }
}

function checkFunction(value: unknown, what: string): void {
  if (value !== undefined && typeof value !== 'function') {
    throw invalidInput(`${what} must be a function`);
  }
}

function checkRows(value: unknown): void {
  if (!Array.isArray(value) || value.some((row) => !isRecord(row))) {
    throw invalidInput('The rows must be an array of GeoJSON features');
  }
}

function checkTable(value: unknown): void {
  if (!isRecord(value)) throw invalidInput('The table must be a table or a prepared table');
}

/** Checks what `datasets.add` takes */
function checkOptions(options: unknown): asserts options is DatasetOptions {
  if (!isRecord(options)) throw invalidInput('The options of a dataset must be an object');
  onlyKeys(options, OPTION_KEYS, 'The options of a dataset');
  requireId(options.id);
  const sources = (['rows', 'table', 'provider'] as const).filter(
    (key) => options[key] !== undefined,
  );
  if (sources.length !== 1) {
    throw invalidInput('A dataset takes exactly one of rows, table and provider');
  }
  if (options.rows !== undefined) checkRows(options.rows);
  if (options.table !== undefined) checkTable(options.table);
  checkFunction(options.provider, 'provider');
  if (options.styleRule !== undefined && !isRecord(options.styleRule)) {
    throw invalidInput('styleRule must be an object');
  }
  checkBaseStyle(options.baseStyle);
  if (options.interactive !== undefined && typeof options.interactive !== 'boolean') {
    throw invalidInput('interactive must be a boolean');
  }
  if (options.order !== undefined && !ORDERS.includes(options.order as string)) {
    throw invalidInput(`order must be one of ${ORDERS.join(', ')}`);
  }
  checkFunction(options.zoomScale, 'zoomScale');
  checkThinning(options.collisionThinning);
  checkFunction(options.externalPointRender, 'externalPointRender');
}

/** Checks where a dataset goes */
function checkPlacement(placement: unknown): DatasetPlacement {
  if (!isRecord(placement)) throw invalidInput('The placement must be an object');
  onlyKeys(placement, ['order', 'index'], 'The placement');
  if (placement.order !== undefined && !ORDERS.includes(placement.order as string)) {
    throw invalidInput(`order must be one of ${ORDERS.join(', ')}`);
  }
  optionalIndex(placement.index);
  return placement as DatasetPlacement;
}

// ============================================================================
// The conversions
// ============================================================================

/** A predicate on rows as a predicate on the features of the engine */
function onFeatures(
  predicate: ((row: DatasetRow) => boolean) | undefined,
): ((feature: StoredFeature) => boolean) | undefined {
  return predicate ? (feature) => predicate(toDatasetRow(feature)) : undefined;
}

/** The options of the engine for the options of the API */
function toEngineOptions(options: DatasetOptions): EngineDatasetOptions {
  const result: EngineDatasetOptions = { id: options.id };
  if ('rows' in options && options.rows !== undefined) {
    result.rows = options.rows as readonly EngineDatasetRow[];
  }
  if ('table' in options && options.table !== undefined) result.table = options.table;
  if ('provider' in options && options.provider !== undefined) {
    const provider = options.provider;
    result.provider = async (bounds, zoom) =>
      (await provider(toBBox(bounds), zoom)) as EngineDatasetRow[];
  }
  if (options.styleRule !== undefined) result.styleRule = options.styleRule;
  if (options.baseStyle !== undefined) result.baseStyle = options.baseStyle;
  if (options.interactive !== undefined) result.interactive = options.interactive;
  if (options.order !== undefined) result.order = options.order;
  if (options.zoomScale !== undefined) result.zoomScale = options.zoomScale;
  if (options.collisionThinning !== undefined) {
    result.collisionThinning = options.collisionThinning;
  }
  if (options.externalPointRender !== undefined) {
    result.externalPointRender = onFeatures(options.externalPointRender);
  }
  return result;
}

/** A point on the screen of a payload of the engine */
function toScreenPoint(point: { x: number; y: number } | undefined): ScreenPoint {
  return point ? [point.x, point.y] : [Number.NaN, Number.NaN];
}

function toClicked(payload: DatasetClickPayload): DatasetEvents['clicked'] {
  return {
    datasetId: payload.datasetId,
    rowIndex: payload.row,
    row: toDatasetRow(payload.feature),
    lngLat: [payload.lngLat[0], payload.lngLat[1]],
    point: toScreenPoint(payload.point),
  };
}

function toHovered(payload: DatasetHoverPayload): DatasetEvents['hovered'] {
  return {
    datasetId: payload.datasetId,
    rowIndex: payload.row,
    row: payload.feature ? toDatasetRow(payload.feature) : null,
    lngLat: [payload.lngLat[0], payload.lngLat[1]],
    point: toScreenPoint(payload.point),
  };
}

function toChanged(payload: DatasetEventMap['change']): DatasetEvents['changed'] {
  return { reason: payload.reason === 'features' ? 'rows' : payload.reason };
}

// ============================================================================
// Dataset
// ============================================================================

/**
 * A dataset of the API over a dataset of the engine
 *
 * @internal
 */
export function wrapDataset(dataset: EngineDataset): Dataset {
  /** The handlers given to the engine, by event and listener, so that off finds them */
  const handlers = new Map<string, Map<unknown, (payload: never) => void>>();

  const on = <K extends keyof DatasetEvents>(
    event: K,
    listener: (payload: DatasetEvents[K]) => void,
  ): (() => void) => {
    const name = EVENT_NAMES[event];
    if (!name) throw invalidInput(`There is no event ${JSON.stringify(event)} of a dataset`);
    if (typeof listener !== 'function') throw invalidInput('The listener must be a function');
    const convert = (payload: unknown): DatasetEvents[K] => {
      if (event === 'clicked') return toClicked(payload as DatasetClickPayload) as DatasetEvents[K];
      if (event === 'hovered') return toHovered(payload as DatasetHoverPayload) as DatasetEvents[K];
      return toChanged(payload as DatasetEventMap['change']) as DatasetEvents[K];
    };
    const handler = (payload: unknown) => listener(convert(payload));
    const byListener = handlers.get(event) ?? new Map();
    handlers.set(event, byListener);
    const previous = byListener.get(listener);
    if (previous) dataset.off(name, previous as never);
    byListener.set(listener, handler);
    dataset.on(name, handler as never);
    return () => off(event, listener);
  };

  const off = <K extends keyof DatasetEvents>(
    event: K,
    listener: (payload: DatasetEvents[K]) => void,
  ): void => {
    const name = EVENT_NAMES[event];
    const handler = handlers.get(event)?.get(listener);
    if (!name || !handler) return;
    handlers.get(event)?.delete(listener);
    dataset.off(name, handler as never);
  };

  return {
    get id() {
      return dataset.id;
    },
    get order() {
      return dataset.order;
    },
    get interactive() {
      return dataset.interactive;
    },
    get visible() {
      return dataset.visible;
    },
    setVisible(visible) {
      if (typeof visible !== 'boolean') throw invalidInput('visible must be a boolean');
      dataset.setVisible(visible);
    },
    setRows(rows) {
      checkRows(rows);
      dataset.setRows(rows as readonly EngineDatasetRow[]);
    },
    setTable(table) {
      checkTable(table);
      dataset.setTable(table);
    },
    setStyleRule(rule: StyleRule | undefined) {
      if (rule !== undefined && !isRecord(rule)) throw invalidInput('The rule must be an object');
      dataset.setStyleRule(rule);
    },
    setZoomScale(zoomScale) {
      if (zoomScale !== null) checkFunction(zoomScale, 'zoomScale');
      dataset.setZoomScale(zoomScale ?? null);
    },
    getZoomScale: () => dataset.getZoomScale(),
    setBaseStyle(style: DatasetBaseStyle | undefined) {
      checkBaseStyle(style);
      dataset.setBaseStyle(style);
    },
    setExternalPointRender(predicate) {
      checkFunction(predicate, 'The predicate');
      dataset.setExternalPointRender(onFeatures(predicate));
    },
    getBaseStyle: () => dataset.getBaseStyle(),
    listRows: () => dataset.getFeatures().map(toDatasetRow),
    listVisibleRows: (bbox) => dataset.collectVisible(toBoundingBox(bbox)).map(toDatasetRow),
    listDrawnRows: (bbox) => dataset.collectDrawnRows(toBoundingBox(bbox)),
    getRow(index) {
      const feature = dataset.getRow(index);
      return feature ? toDatasetRow(feature) : undefined;
    },
    getRowId: (index) => dataset.getRowId(index),
    getRowType: (index) => dataset.getRowType(index),
    getRowBounds(index) {
      const bounds = dataset.getRowBounds(index);
      return bounds ? toBBox(bounds) : null;
    },
    getRowPoint(index) {
      const point = dataset.getRowPoint(index);
      return point ? [point[0], point[1]] : null;
    },
    findRow: (id) => dataset.findRow(id),
    setSelectedRowIds(ids) {
      dataset.setSelectedIds(requireIds(ids));
    },
    getSelectedRowIds: () => dataset.getSelectedIds(),
    setCollisionThinning(options: DatasetCollisionThinning | null) {
      checkThinning(options);
      dataset.setCollisionThinning(options ?? null);
    },
    getCollisionThinning() {
      const thinning = dataset.getCollisionThinning();
      return thinning ? { ...thinning } : null;
    },
    listVisibleRowIds: () => dataset.getVisibleFeatureIds(),
    getThinningStats: () => dataset.getThinningStats(),
    getDrawnRowsRevision: () => dataset.getDrawnRowsRevision(),
    refresh: () => dataset.invalidateProviderCache(),
    on,
    off,
  };
}

// ============================================================================
// draw.datasets
// ============================================================================

/**
 * Creates `draw.datasets` and announces the datasets that come, go and move as events
 *
 * @param manager - The dataset manager of the engine
 * @param events - The emitter of the events of the instance
 * @param signals - The internal emitter the manager announces the datasets on
 * @internal
 */
export function createDatasets(
  manager: DatasetManager,
  events: EventHub,
  signals: EventEmitter,
): DatasetsCollection {
  const wrappers = new WeakMap<EngineDataset, Dataset>();
  const wrap = (dataset: EngineDataset): Dataset => {
    let wrapper = wrappers.get(dataset);
    if (!wrapper) {
      wrapper = wrapDataset(dataset);
      wrappers.set(dataset, wrapper);
    }
    return wrapper;
  };

  let order = manager.list().map((dataset) => dataset.id);
  signals.on('dataset.add', ({ datasetId }) => {
    order = manager.list().map((dataset) => dataset.id);
    const dataset = manager.get(datasetId);
    if (dataset) events.emit('dataset.added', { dataset: wrap(dataset) });
  });
  signals.on('dataset.remove', ({ datasetId }) => {
    order = manager.list().map((dataset) => dataset.id);
    events.emit('dataset.removed', { datasetId });
  });
  signals.on('dataset.reorder', ({ order: next }) => {
    const previous = order;
    order = [...next];
    events.emit('dataset.reordered', { order: [...next], previous });
  });

  const require = (id: unknown): EngineDataset => {
    const dataset = manager.get(requireId(id));
    if (!dataset) throw notFound('dataset', id);
    return dataset;
  };

  const checkNew = (options: unknown, taken: Set<string>): DatasetOptions => {
    checkOptions(options);
    if (manager.get(options.id) || taken.has(options.id)) {
      throw new DrawError('already-exists', `A dataset with the ID ${options.id} exists`, {
        id: options.id,
      });
    }
    taken.add(options.id);
    return options;
  };

  const collection: DatasetsCollection = {
    get(id) {
      const dataset = manager.get(requireId(id));
      return dataset ? wrap(dataset) : undefined;
    },
    list: () => manager.list().map(wrap),
    count: () => manager.list().length,
    has: (id) => manager.get(requireId(id)) !== undefined,
    add(options) {
      const checked = checkNew(options, new Set());
      return wrap(manager.add(toEngineOptions(checked)));
    },
    addMany(options) {
      if (!Array.isArray(options)) throw invalidInput('The options must be an array');
      const taken = new Set<string>();
      const checked = options.map((entry) => checkNew(entry, taken));
      return checked.map((entry) => wrap(manager.add(toEngineOptions(entry))));
    },
    remove(id) {
      require(id);
      return manager.remove(id);
    },
    removeMany(ids) {
      const unique = requireIds(ids);
      for (const id of unique) require(id);
      for (const id of unique) manager.remove(id);
      return true;
    },
    move(id, placement) {
      require(id);
      return manager.move(id, checkPlacement(placement));
    },
  };
  return collection;
}
