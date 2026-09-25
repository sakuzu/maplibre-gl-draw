// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the provider (dynamic fetching)
 *
 * They verify the pure functions of the tile keys, and the debounce, the tile cache and the
 * ignoring of stale responses with fake timers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoundingBox, Feature } from '../store/types.js';
import { createDatasetManager, type DatasetManager } from './manager.js';
import {
  DEFAULT_TILE_CACHE_SIZE,
  DisplayProviderLoader,
  latToTileY,
  lngToTileX,
  TileFeatureCache,
  tileRangeBounds,
  tileRangeKey,
  toTileRange,
  toZoomStage,
} from './provider.js';
import type { DatasetFeatureInput, DatasetFeatureProvider } from './types.js';

describe('the pure functions of the tile keys', () => {
  it('the zoom stage is floored to an integer and clamped into 0-22', () => {
    expect(toZoomStage(10.9)).toBe(10);
    expect(toZoomStage(-3)).toBe(0);
    expect(toZoomStage(99)).toBe(22);
    expect(toZoomStage(Number.NaN)).toBe(0);
  });

  it('the tile coordinates are computed from a longitude and a latitude', () => {
    // Zoom 1 is 2x2 tiles
    expect(lngToTileX(-179, 1)).toBe(0);
    expect(lngToTileX(179, 1)).toBe(1);
    expect(latToTileY(80, 1)).toBe(0);
    expect(latToTileY(-80, 1)).toBe(1);
  });

  it('the tile coordinates stay in range even for out-of-range input', () => {
    expect(lngToTileX(1000, 2)).toBe(3);
    expect(lngToTileX(-1000, 2)).toBe(0);
    // The latitude is capped at the limit of Web Mercator (north is Y = 0)
    expect(latToTileY(90, 2)).toBe(0);
    expect(latToTileY(-90, 2)).toBe(3);
  });

  it('tile Y is smaller towards the north (the reverse of a bbox)', () => {
    const range = toTileRange({ minX: -10, minY: 10, maxX: 10, maxY: 30 }, 5);

    expect(range.minY).toBe(latToTileY(30, 5));
    expect(range.maxY).toBe(latToTileY(10, 5));
    expect(range.minY).toBeLessThanOrEqual(range.maxY);
  });

  it('bboxes that fall in the same tile range get the same key', () => {
    const a = toTileRange({ minX: 139.7, minY: 35.6, maxX: 139.72, maxY: 35.62 }, 10);
    const b = toTileRange({ minX: 139.701, minY: 35.601, maxX: 139.719, maxY: 35.619 }, 10);

    expect(tileRangeKey(a)).toBe(tileRangeKey(b));
  });

  it('a different zoom stage gives a different key', () => {
    const bounds: BoundingBox = { minX: 139.7, minY: 35.6, maxX: 139.72, maxY: 35.62 };

    expect(tileRangeKey(toTileRange(bounds, 10))).not.toBe(tileRangeKey(toTileRange(bounds, 11)));
  });

  it('the bbox of a tile range contains the original bbox', () => {
    const bounds: BoundingBox = { minX: 139.7, minY: 35.6, maxX: 140.2, maxY: 36.1 };
    const snapped = tileRangeBounds(toTileRange(bounds, 8));

    expect(snapped.minX).toBeLessThanOrEqual(bounds.minX);
    expect(snapped.maxX).toBeGreaterThanOrEqual(bounds.maxX);
    expect(snapped.minY).toBeLessThanOrEqual(bounds.minY);
    expect(snapped.maxY).toBeGreaterThanOrEqual(bounds.maxY);
  });
});

describe('TileFeatureCache', () => {
  const features: Feature[] = [];

  it('values can be put in and taken out by key', () => {
    const cache = new TileFeatureCache();
    cache.set('a', features);

    expect(cache.get('a')).toBe(features);
    expect(cache.get('b')).toBeUndefined();
  });

  it('the least recently used key is discarded beyond the maximum count', () => {
    const cache = new TileFeatureCache(2);
    cache.set('a', features);
    cache.set('b', features);
    // Using a and then inserting c makes b the one discarded
    cache.get('a');
    cache.set('c', features);

    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBe(features);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(features);
  });

  it('the default number of entries kept is 32', () => {
    expect(DEFAULT_TILE_CACHE_SIZE).toBe(32);
  });
});

/** A controllable Promise */
function deferred(): {
  promise: Promise<DatasetFeatureInput[]>;
  resolve: (features: DatasetFeatureInput[]) => void;
} {
  let resolve: (features: DatasetFeatureInput[]) => void = () => {};
  const promise = new Promise<DatasetFeatureInput[]>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A small bbox around the center coordinate (it fits in one tile at zoom 10) */
function around(lng: number, lat: number): BoundingBox {
  return { minX: lng - 0.01, minY: lat - 0.01, maxX: lng + 0.01, maxY: lat + 0.01 };
}

function feature(id: string): DatasetFeatureInput {
  return { id, type: 'Point', coordinates: [0, 0] };
}

describe('the calls of the provider', () => {
  const DEBOUNCE = 200;

  let manager: DatasetManager;
  let bounds: BoundingBox;
  let repaints: number;
  let fireViewportChange: () => void;

  function setup(): void {
    bounds = around(0, 0);
    repaints = 0;
    let handler: (() => void) | null = null;

    manager = createDatasetManager({
      getViewportBounds: () => bounds,
      getZoom: () => 10,
      onViewportChange: (h) => {
        handler = h;
        return () => {
          handler = null;
        };
      },
      requestRepaint: () => {
        repaints++;
      },
      providerDebounceMs: DEBOUNCE,
    });

    fireViewportChange = () => handler?.();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    setup();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('it is not called until the debounce time has passed', async () => {
    const provider = vi.fn(async () => [feature('a')]);
    manager.add({ id: 'c1', provider });

    expect(provider).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DEBOUNCE - 1);
    expect(provider).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('successive changes of the displayed range collapse into a single call', async () => {
    const provider = vi.fn(async () => [feature('a')]);
    manager.add({ id: 'c1', provider });

    for (const lng of [1, 2, 3, 4]) {
      bounds = around(lng, 0);
      fireViewportChange();
      await vi.advanceTimersByTimeAsync(DEBOUNCE / 2);
    }
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(provider).toHaveBeenCalledTimes(1);
    // Only the last range is requested (the bbox rounded to the tile boundaries)
    const [requestedBounds, zoom] = provider.mock.calls[0] as unknown as [BoundingBox, number];
    expect(requestedBounds.minX).toBeLessThanOrEqual(4);
    expect(requestedBounds.maxX).toBeGreaterThanOrEqual(4);
    expect(zoom).toBe(10);
  });

  it('the fetched result is applied to the display and a repaint is requested', async () => {
    const provider = vi.fn(async () => [feature('a'), feature('b')]);
    const dataset = manager.add({ id: 'c1', provider });

    const before = repaints;
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(dataset.getFeatures().map((f) => f.id)).toEqual(['a', 'b']);
    expect(repaints).toBeGreaterThan(before);
  });

  it('a move that stays in the same tile range does not call it', async () => {
    const provider = vi.fn(async () => [feature('a')]);
    manager.add({ id: 'c1', provider });
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(provider).toHaveBeenCalledTimes(1);

    // Move a little within the same tile
    bounds = around(0.001, 0.001);
    fireViewportChange();
    await vi.advanceTimersByTimeAsync(DEBOUNCE * 2);

    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('coming back to a fetched range restores from the cache at once, without a call', async () => {
    const provider = vi.fn(async (b: BoundingBox) => [feature(`f${Math.round(b.minX)}`)]);
    const dataset = manager.add({ id: 'c1', provider });
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    const first = dataset.getFeatures().map((f) => f.id);

    // Move to another range and fetch
    bounds = around(20, 0);
    fireViewportChange();
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(dataset.getFeatures().map((f) => f.id)).not.toEqual(first);

    // Come back to the original range
    bounds = around(0, 0);
    fireViewportChange();
    expect(provider).toHaveBeenCalledTimes(2);
    // It is restored without waiting for the debounce
    expect(dataset.getFeatures().map((f) => f.id)).toEqual(first);

    await vi.advanceTimersByTimeAsync(DEBOUNCE * 2);
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it('the previous result keeps being shown while a fetch is in flight', async () => {
    const first = deferred();
    const second = deferred();
    const provider = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const dataset = manager.add({ id: 'c1', provider });

    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    first.resolve([feature('old')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(dataset.getFeatures().map((f) => f.id)).toEqual(['old']);

    // Even while the next range is being fetched, the previous result stays until the response
    bounds = around(20, 0);
    fireViewportChange();
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(dataset.getFeatures().map((f) => f.id)).toEqual(['old']);

    second.resolve([feature('new')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(dataset.getFeatures().map((f) => f.id)).toEqual(['new']);
  });

  it('a stale response arriving later is not applied', async () => {
    const first = deferred();
    const second = deferred();
    const provider = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const dataset = manager.add({ id: 'c1', provider });

    // Issue the first request (its response is held)
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    // Issue the second request (its response is held)
    bounds = around(20, 0);
    fireViewportChange();
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(provider).toHaveBeenCalledTimes(2);

    // The response of the new request arrives first
    second.resolve([feature('new')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(dataset.getFeatures().map((f) => f.id)).toEqual(['new']);

    // The response of the old request is ignored even when it overtakes
    first.resolve([feature('old')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(dataset.getFeatures().map((f) => f.id)).toEqual(['new']);
  });

  it('after it is removed it is not called and no response is applied', async () => {
    const pending = deferred();
    const provider = vi.fn().mockReturnValue(pending.promise);
    const dataset = manager.add({ id: 'c1', provider });
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    dataset.remove();
    pending.resolve([feature('late')]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE * 2);

    expect(dataset.getFeatures()).toEqual([]);

    bounds = around(20, 0);
    fireViewportChange();
    await vi.advanceTimersByTimeAsync(DEBOUNCE * 2);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('a failure of the provider does not break the display', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const provider = vi.fn(async () => {
      throw new Error('boom');
    });
    const dataset = manager.add({ id: 'c1', provider });

    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(dataset.getFeatures()).toEqual([]);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('a dataset without a provider does nothing when the displayed range changes', async () => {
    const dataset = manager.add({ id: 'c1', features: [feature('a')] });

    bounds = around(20, 0);
    fireViewportChange();
    await vi.advanceTimersByTimeAsync(DEBOUNCE * 2);

    expect(dataset.getFeatures().map((f) => f.id)).toEqual(['a']);
  });

  describe('invalidateProviderCache', () => {
    it('it fetches again for the same range and the result is replaced', async () => {
      const provider = vi
        .fn()
        .mockResolvedValueOnce([feature('old')])
        .mockResolvedValueOnce([feature('new')]);
      const dataset = manager.add({ id: 'c1', provider });

      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      expect(dataset.getFeatures().map((f) => f.id)).toEqual(['old']);

      // The displayed range is not moved (is the early return on the applied key cleared?)
      dataset.invalidateProviderCache();
      await vi.advanceTimersByTimeAsync(DEBOUNCE);

      expect(provider).toHaveBeenCalledTimes(2);
      expect(dataset.getFeatures().map((f) => f.id)).toEqual(['new']);
    });

    it('it cancels the call waiting for the debounce and schedules it again', async () => {
      const provider = vi.fn(async () => [feature('a')]);
      const dataset = manager.add({ id: 'c1', provider });
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      expect(provider).toHaveBeenCalledTimes(1);

      // Put the call for the next range into the state of waiting for the debounce
      bounds = around(20, 0);
      fireViewportChange();
      await vi.advanceTimersByTimeAsync(DEBOUNCE - 1);

      dataset.invalidateProviderCache();
      await vi.advanceTimersByTimeAsync(1);
      // The call that was waiting has been cancelled
      expect(provider).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      // The schedule made after the discard calls it exactly once
      expect(provider).toHaveBeenCalledTimes(2);
    });

    it('a response arriving right after the discard enters neither display nor cache', async () => {
      const pending = deferred();
      const provider = vi
        .fn()
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValueOnce([feature('other')])
        .mockResolvedValueOnce([feature('fresh')]);
      const dataset = manager.add({ id: 'c1', provider });

      // Issue the first request (its response is held)
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      dataset.invalidateProviderCache();

      // Move the re-fetch schedule to another range, then deliver the old response
      bounds = around(20, 0);
      fireViewportChange();
      pending.resolve([feature('stale')]);
      await vi.advanceTimersByTimeAsync(0);
      expect(dataset.getFeatures()).toEqual([]);

      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      expect(dataset.getFeatures().map((f) => f.id)).toEqual(['other']);

      // Come back to the original range. If it stayed in the cache it would restore without a call
      bounds = around(0, 0);
      fireViewportChange();
      expect(dataset.getFeatures().map((f) => f.id)).toEqual(['other']);

      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      expect(provider).toHaveBeenCalledTimes(3);
      expect(dataset.getFeatures().map((f) => f.id)).toEqual(['fresh']);
    });

    it('it does nothing for a dataset without a provider', async () => {
      const dataset = manager.add({ id: 'c1', features: [feature('a')] });

      dataset.invalidateProviderCache();
      await vi.advanceTimersByTimeAsync(DEBOUNCE * 2);

      expect(dataset.getFeatures().map((f) => f.id)).toEqual(['a']);
    });
  });
});

describe('DisplayProviderLoader', () => {
  const VIEW: BoundingBox = { minX: 139.7, minY: 35.6, maxX: 139.8, maxY: 35.7 };
  const OTHER: BoundingBox = { minX: 135.4, minY: 34.6, maxX: 135.5, maxY: 34.7 };

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function createLoader(provider: DatasetFeatureProvider) {
    const applied: Feature[][] = [];
    const loader = new DisplayProviderLoader(provider, {
      id: 'loader',
      debounceMs: 100,
      apply: (features) => applied.push(features),
    });
    return { loader, applied };
  }

  const result = (id: string): DatasetFeatureInput[] => [
    {
      id,
      type: 'Point',
      coordinates: [139.75, 35.65, 12] as unknown as DatasetFeatureInput['coordinates'],
    },
  ];

  it('the call is debounced and the normalized result is applied', async () => {
    const provider = vi.fn(async () => result('a'));
    const { loader, applied } = createLoader(provider);

    loader.schedule(VIEW, 12.3);
    expect(provider).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);

    expect(provider).toHaveBeenCalledTimes(1);
    expect(applied).toHaveLength(1);
    // The elevation of the input is dropped by the normalization
    expect(applied[0][0].coordinates).toEqual([139.75, 35.65]);
  });

  it('a range in the cache is applied at once, and the range applied is not fetched again', async () => {
    const provider = vi.fn(async () => result('a'));
    const { loader, applied } = createLoader(provider);
    loader.schedule(VIEW, 12);
    await vi.advanceTimersByTimeAsync(100);
    loader.schedule(OTHER, 12);
    await vi.advanceTimersByTimeAsync(100);
    expect(provider).toHaveBeenCalledTimes(2);

    loader.schedule(VIEW, 12);
    expect(applied).toHaveLength(3);
    loader.schedule(VIEW, 12);
    await vi.advanceTimersByTimeAsync(100);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(applied).toHaveLength(3);
  });

  it('only the response of the last request is applied', async () => {
    const resolvers: Array<(value: DatasetFeatureInput[]) => void> = [];
    const provider = vi.fn(
      () => new Promise<DatasetFeatureInput[]>((resolve) => resolvers.push(resolve)),
    );
    const { loader, applied } = createLoader(provider);
    loader.schedule(VIEW, 12);
    await vi.advanceTimersByTimeAsync(100);
    loader.schedule(OTHER, 12);
    await vi.advanceTimersByTimeAsync(100);

    resolvers[1](result('new'));
    resolvers[0](result('old'));
    await vi.advanceTimersByTimeAsync(0);
    expect(applied.map((features) => features[0].id)).toEqual(['new']);
  });

  it('a response in flight across invalidate is thrown away and the range is fetched again', async () => {
    const resolvers: Array<(value: DatasetFeatureInput[]) => void> = [];
    const provider = vi.fn(
      () => new Promise<DatasetFeatureInput[]>((resolve) => resolvers.push(resolve)),
    );
    const { loader, applied } = createLoader(provider);
    loader.schedule(VIEW, 12);
    await vi.advanceTimersByTimeAsync(100);

    loader.invalidate(VIEW, 12);
    resolvers[0](result('stale'));
    await vi.advanceTimersByTimeAsync(100);
    expect(provider).toHaveBeenCalledTimes(2);
    resolvers[1](result('fresh'));
    await vi.advanceTimersByTimeAsync(0);
    expect(applied.map((features) => features[0].id)).toEqual(['fresh']);
  });

  it('after dispose nothing is called or applied', async () => {
    const resolvers: Array<(value: DatasetFeatureInput[]) => void> = [];
    const provider = vi.fn(
      () => new Promise<DatasetFeatureInput[]>((resolve) => resolvers.push(resolve)),
    );
    const { loader, applied } = createLoader(provider);
    loader.schedule(VIEW, 12);
    await vi.advanceTimersByTimeAsync(100);
    loader.schedule(OTHER, 12);

    loader.dispose();
    resolvers[0](result('late'));
    await vi.advanceTimersByTimeAsync(100);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(applied).toHaveLength(0);
  });
});
