// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.memory`: the memory the documents drawn on the page take, against the limit of the device
 *
 * The GPU memory is the ledger of every instance of the page (what their renderers allocated).
 * The JavaScript heap is not measured (a browser tells it only in some engines, and never for the
 * documents alone): it is estimated from the features of the documents and their positions, with
 * the bytes a feature and a position take held as rows (columns of typed arrays) or as features
 * (objects), from the measurements of layers of buildings and of mixed features. The same factors
 * estimate what a document to open would take, so that a host compares the two in the same terms.
 */

import type { Geometry } from 'geojson';
import { featureTablesInternals } from '../../feature-table/feature-tables.js';
import type { StoreView } from '../extension/store.js';
import type { DocumentSize, MemoryBytes, MemoryResource, MemoryUsage } from '../memory.js';
import { invalidInput } from './shared.js';

const MIB = 1024 * 1024;

/** The limit of an iPhone (and of an iPod touch) */
export const PHONE_MEMORY_LIMIT_BYTES = 400 * MIB;
/** The limit of an iPad */
export const TABLET_MEMORY_LIMIT_BYTES = 500 * MIB;
/** The limit of every other device */
export const DEFAULT_MEMORY_LIMIT_BYTES = 1024 * MIB;

/**
 * The bytes a feature and a position take, held as rows and as features (measured on layers of
 * buildings and of mixed features of 100,000 and 1,000,000 features, the heap of the page and the
 * GPU ledger divided by the features and their positions)
 *
 * @internal
 */
export const MEMORY_FACTORS = {
  rows: { jsPerFeature: 400, jsPerPosition: 40, gpuPerFeature: 100, gpuPerPosition: 40 },
  features: { jsPerFeature: 3000, jsPerPosition: 350, gpuPerFeature: 100, gpuPerPosition: 350 },
} as const;

/** What `navigator` tells of the device (the parts read here) */
interface DeviceNavigator {
  readonly userAgent?: string;
  readonly platform?: string;
  readonly maxTouchPoints?: number;
}

/**
 * The limit of the memory of the device the page runs on: 400 MiB on an iPhone, 500 MiB on an
 * iPad (an iPad that tells itself a Mac, by its touch points, included), 1 GiB elsewhere
 *
 * @internal
 */
export function deviceMemoryLimitBytes(
  device: DeviceNavigator | undefined = deviceNavigator(),
): number {
  const agent = device?.userAgent ?? '';
  if (/iPhone|iPod/.test(agent)) return PHONE_MEMORY_LIMIT_BYTES;
  if (/iPad/.test(agent)) return TABLET_MEMORY_LIMIT_BYTES;
  // An iPad asks for the pages of a desktop by default: it tells itself a Mac with touch points
  if (/Macintosh/.test(agent) && (device?.maxTouchPoints ?? 0) > 1)
    return TABLET_MEMORY_LIMIT_BYTES;
  return DEFAULT_MEMORY_LIMIT_BYTES;
}

function deviceNavigator(): DeviceNavigator | undefined {
  return typeof navigator === 'undefined' ? undefined : (navigator as DeviceNavigator);
}

/** An estimate of the memory of features and their positions, held as rows or as features */
function bytesOf(size: DocumentSize, asRows: boolean): MemoryBytes {
  const f = asRows ? MEMORY_FACTORS.rows : MEMORY_FACTORS.features;
  const jsBytes = Math.round(size.features * f.jsPerFeature + size.positions * f.jsPerPosition);
  const gpuBytes = Math.round(size.features * f.gpuPerFeature + size.positions * f.gpuPerPosition);
  return { jsBytes, gpuBytes, bytes: jsBytes + gpuBytes };
}

/** The number of positions of a geometry */
function positionsOf(geometry: Geometry | null | undefined): number {
  if (!geometry) return 0;
  if (geometry.type === 'GeometryCollection') {
    let total = 0;
    for (const child of geometry.geometries) total += positionsOf(child);
    return total;
  }
  const walk = (value: unknown): number => {
    if (!Array.isArray(value) || value.length === 0) return 0;
    if (typeof value[0] === 'number') return 1;
    let total = 0;
    for (const item of value) total += walk(item);
    return total;
  };
  return walk(geometry.coordinates);
}

/**
 * An estimate of the JavaScript heap a document takes: its rows and their positions when the Store
 * holds its features as rows (the features made of rows are few, and left out), its features and
 * their positions otherwise
 */
function documentJsBytes(store: StoreView): number {
  const tables = featureTablesInternals(store.tables);
  if (tables) return bytesOf(rowsSize(tables.size()), true).jsBytes;
  let features = 0;
  let positions = 0;
  for (const feature of store.listFeatures()) {
    features++;
    positions += positionsOf(feature.geometry);
  }
  return bytesOf({ features, positions }, false).jsBytes;
}

function rowsSize(size: { readonly rows: number; readonly positions: number }): DocumentSize {
  return { features: size.rows, positions: size.positions };
}

/**
 * What one draw instance takes: the bytes of its GPU ledger and the estimate of the heap of its
 * documents
 */
interface InstanceMemory {
  gpuBytes(): number;
  peakGpuBytes(): number;
  gpuAllocations(): number;
  jsBytes(): number;
}

/** The draw instances of the page */
const instances = new Set<InstanceMemory>();

/**
 * Creates `draw.memory` for an instance, and counts the instance among those of the page
 *
 * @param deps - The Store of the instance, the documents it draws (the Store, and a document
 *   shown in its place), and its GPU ledger
 * @returns The resource, and the function that takes the instance out of the page (at destroy)
 * @internal
 */
export function createMemory(deps: {
  readonly store: StoreView;
  readonly shownStores: () => readonly StoreView[];
  readonly gpu: () => { bytes: number; peakBytes: number; allocations: number };
}): { memory: MemoryResource; dispose: () => void } {
  /** The limit set (null: the one of the device) */
  let limit: number | null = null;
  const instance: InstanceMemory = {
    gpuBytes: () => deps.gpu().bytes,
    peakGpuBytes: () => deps.gpu().peakBytes,
    gpuAllocations: () => deps.gpu().allocations,
    jsBytes: () => {
      let bytes = 0;
      for (const store of deps.shownStores()) bytes += documentJsBytes(store);
      return bytes;
    },
  };
  instances.add(instance);
  const memory: MemoryResource = {
    get(): MemoryUsage {
      let jsBytes = 0;
      let gpuBytes = 0;
      let peakGpuBytes = 0;
      let gpuAllocations = 0;
      for (const each of instances) {
        jsBytes += each.jsBytes();
        gpuBytes += each.gpuBytes();
        peakGpuBytes += each.peakGpuBytes();
        gpuAllocations += each.gpuAllocations();
      }
      return Object.freeze({
        jsBytes,
        gpuBytes,
        peakGpuBytes,
        gpuAllocations,
        bytes: jsBytes + gpuBytes,
        limitBytes: limit ?? deviceMemoryLimitBytes(),
      });
    },
    setLimit(bytes: number | null): void {
      if (bytes !== null && (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0)) {
        throw invalidInput('The limit must be a number of bytes above 0, or null');
      }
      limit = bytes;
    },
    estimate(size: DocumentSize): MemoryBytes {
      if (typeof size !== 'object' || size === null)
        throw invalidInput('The size must be an object');
      for (const key of ['features', 'positions'] as const) {
        const value = size[key];
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
          throw invalidInput(`size.${key} must be a finite number of 0 or more`);
        }
      }
      return Object.freeze(bytesOf(size, deps.store.tables !== undefined));
    },
  };
  return {
    memory,
    dispose: () => {
      instances.delete(instance);
    },
  };
}
