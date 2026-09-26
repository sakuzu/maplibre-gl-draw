// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tile cache of the dynamic fetching (provider)
 *
 * The provider is called, debounced, when the displayed range changes. So that the same range is
 * not fetched over and over, a request is rounded to a zoom stage (an integer) and a range of
 * tile coordinates, and the result is cached under that key. Because of the rounding, a pan or
 * zoom that moves only a little causes no call.
 *
 * The pure functions and the small cache come first. `DisplayProviderLoader` at the end holds the
 * timing (the debounce) and the order in which the responses are applied, for one dataset.
 */

import type { BoundingBox, Feature } from '../shared/types/model.js';
import type { DatasetFeatureProvider } from './types.js';
import { normalizeDisplayFeature } from './types.js';

/** Maximum zoom stage of the tile coordinates */
const MAX_TILE_ZOOM = 22;

/** Upper limit of the latitude that Web Mercator can express */
const MAX_MERCATOR_LAT = 85.0511287798066;

/**
 * A range of tile coordinates
 *
 * z is the zoom stage (an integer) and x / y are slippy map tile coordinates.
 *
 * @internal
 */
export interface TileRange {
  z: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Clamps a value into a range */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Computes the zoom stage (floored to an integer and clamped into 0-22)
 *
 * @internal
 */
export function toZoomStage(zoom: number): number {
  if (!Number.isFinite(zoom)) return 0;
  return clamp(Math.floor(zoom), 0, MAX_TILE_ZOOM);
}

/**
 * Computes the tile X coordinate from a longitude
 *
 * @internal
 */
export function lngToTileX(lng: number, z: number): number {
  const n = 2 ** z;
  return clamp(Math.floor(((clamp(lng, -180, 180) + 180) / 360) * n), 0, n - 1);
}

/**
 * Computes the tile Y coordinate from a latitude
 *
 * @internal
 */
export function latToTileY(lat: number, z: number): number {
  const n = 2 ** z;
  const clamped = clamp(lat, -MAX_MERCATOR_LAT, MAX_MERCATOR_LAT);
  const rad = (clamped * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
  return clamp(Math.floor(y), 0, n - 1);
}

/**
 * Computes the longitude of the western edge of a tile X coordinate
 *
 * @internal
 */
export function tileXToLng(x: number, z: number): number {
  const n = 2 ** z;
  return (x / n) * 360 - 180;
}

/**
 * Computes the latitude of the northern edge of a tile Y coordinate
 *
 * @internal
 */
export function tileYToLat(y: number, z: number): number {
  const n = 2 ** z;
  const t = Math.PI * (1 - (2 * y) / n);
  return (Math.atan(Math.sinh(t)) * 180) / Math.PI;
}

/**
 * Rounds a displayed range to a range of tile coordinates
 *
 * @internal
 */
export function toTileRange(bounds: BoundingBox, zoom: number): TileRange {
  const z = toZoomStage(zoom);
  return {
    z,
    minX: lngToTileX(bounds.minX, z),
    maxX: lngToTileX(bounds.maxX, z),
    // Tile Y gets smaller towards the north, so the latitudes and minY / maxY are inverted
    minY: latToTileY(bounds.maxY, z),
    maxY: latToTileY(bounds.minY, z),
  };
}

/**
 * Cache key of a tile range
 *
 * @internal
 */
export function tileRangeKey(range: TileRange): string {
  return `${range.z}/${range.minX}/${range.minY}/${range.maxX}/${range.maxY}`;
}

/**
 * Computes the bbox that covers a tile range (the range passed to the provider)
 *
 * A range rounded to the tile boundaries is passed, so a request with the same key always gets
 * the same bbox.
 *
 * @internal
 */
export function tileRangeBounds(range: TileRange): BoundingBox {
  return {
    minX: tileXToLng(range.minX, range.z),
    maxX: tileXToLng(range.maxX + 1, range.z),
    minY: tileYToLat(range.maxY + 1, range.z),
    maxY: tileYToLat(range.minY, range.z),
  };
}

/**
 * Default number of entries kept in the cache
 *
 * @internal
 */
export const DEFAULT_TILE_CACHE_SIZE = 32;

/**
 * Cache that keeps the results of the provider under a tile key
 *
 * Once the maximum count is exceeded, the least recently used key is discarded (LRU).
 *
 * @internal
 */
export class TileFeatureCache {
  private entries = new Map<string, Feature[]>();
  private maxSize: number;

  constructor(maxSize: number = DEFAULT_TILE_CACHE_SIZE) {
    this.maxSize = Math.max(1, maxSize);
  }

  /** Number of keys held */
  get size(): number {
    return this.entries.size;
  }

  /** Takes out the result of a key (the key taken out counts as most recently used) */
  get(key: string): Feature[] | undefined {
    const value = this.entries.get(key);
    if (!value) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  /** Stores the result of a key */
  set(key: string, features: Feature[]): void {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    }
    this.entries.set(key, features);
    while (this.entries.size > this.maxSize) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  /** Empties the cache */
  clear(): void {
    this.entries.clear();
  }
}

/**
 * What the provider loader of a dataset calls back into
 *
 * @internal
 */
export interface DisplayProviderLoaderHost {
  /** The id of the dataset (for the error message) */
  readonly id: string;
  /** Debounce time of the provider (ms) */
  readonly debounceMs: number;
  /** Applies a result (normalized features) to the display and requests a repaint */
  apply(features: Feature[]): void;
}

/**
 * The receiver of the loading and the updates of one dataset with a provider
 *
 * The range is handled through a key rounded to a zoom stage plus tile coordinates. Nothing
 * happens when it equals the key already applied; when it is in the cache it is applied at once;
 * otherwise the call is debounced. While a fetch is in flight, the previous result keeps being
 * shown. Only the response of the last request is applied.
 *
 * @internal
 */
export class DisplayProviderLoader {
  private readonly tileCache = new TileFeatureCache();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The key waiting for the debounce */
  private pendingKey: string | null = null;
  /** The key already applied to the display */
  private appliedKey: string | null = null;
  /** Serial number of the issued requests (so that only the last one is applied) */
  private requestSeq = 0;
  /**
   * Generation of the cache
   *
   * It is advanced by invalidate. A response in flight across the discard is thrown away by this
   * mark before it is written back into the cache (with the serial number alone the response
   * would be dropped only after it entered tileCache, so a stale result would remain).
   */
  private cacheGeneration = 0;
  /** The serial number of the request whose response is awaited (null = none in flight) */
  private awaitedSeq: number | null = null;
  private disposed = false;

  constructor(
    private readonly provider: DatasetFeatureProvider,
    private readonly host: DisplayProviderLoaderHost,
  ) {}

  /**
   * Whether a call is waiting for its debounce, or the response of the last call has not
   * arrived yet (the features shown will change without anything else happening)
   */
  get busy(): boolean {
    return !this.disposed && (this.timer !== null || this.awaitedSeq !== null);
  }

  /** Schedules the call of the provider for a displayed range */
  schedule(bounds: BoundingBox, zoom: number): void {
    if (this.disposed) return;

    const range = toTileRange(bounds, zoom);
    const key = tileRangeKey(range);

    if (key === this.appliedKey) {
      // It came back to the range being shown. The pending call is cancelled
      this.cancelPending();
      return;
    }

    const cached = this.tileCache.get(key);
    if (cached) {
      this.cancelPending();
      this.appliedKey = key;
      this.host.apply(cached);
      return;
    }

    if (key === this.pendingKey) return;

    this.cancelPending();
    this.pendingKey = key;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pendingKey = null;
      this.run(range, key, zoom);
    }, this.host.debounceMs);
  }

  /**
   * Discards the cache and fetches the displayed range again
   *
   * A response in flight reaches neither the cache nor the display.
   */
  invalidate(bounds: BoundingBox, zoom: number): void {
    if (this.disposed) return;

    this.cacheGeneration++;
    this.tileCache.clear();
    // Fetch again even for the same range (the early return is cleared)
    this.appliedKey = null;
    this.cancelPending();
    this.schedule(bounds, zoom);
  }

  /** Stops the timer and empties the cache. A response in flight is not applied afterwards */
  dispose(): void {
    this.disposed = true;
    this.cancelPending();
    this.tileCache.clear();
  }

  /** Calls the provider and applies only the response of the last request */
  private run(range: TileRange, key: string, zoom: number): void {
    if (this.disposed) return;

    const seq = ++this.requestSeq;
    const generation = this.cacheGeneration;
    const bounds = tileRangeBounds(range);
    this.awaitedSeq = seq;
    const settle = (): void => {
      if (this.awaitedSeq === seq) this.awaitedSeq = null;
    };

    void this.provider(bounds, zoom).then(
      (features) => {
        settle();
        if (this.disposed) return;
        // A response in flight across the discard is thrown away with its contents. It does not
        // enter the cache either
        if (generation !== this.cacheGeneration) return;

        const normalized = features.map(normalizeDisplayFeature);
        this.tileCache.set(key, normalized);

        // Even when an old response overtakes a new one, nothing but the last request is applied
        if (seq !== this.requestSeq) return;

        this.appliedKey = key;
        this.host.apply(normalized);
      },
      (error) => {
        settle();
        console.error(`Dataset "${this.host.id}": provider failed`, error);
      },
    );
  }

  /** Cancels the call waiting for the debounce */
  private cancelPending(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pendingKey = null;
  }
}
