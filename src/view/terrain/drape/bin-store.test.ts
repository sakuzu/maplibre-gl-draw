// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the storage of the analytic drape tile index
 *
 * Two rules are enforced: never re-bin every frame, and keep drawing with the
 * previous version while a rebuild is in progress.
 */

import { describe, expect, it } from 'vitest';
import type { Coordinate } from '../../../store/types.js';
import { DRAPE_SELECTION_TEXEL, DRAPE_STYLE_TEXELS, DrapeTileStore } from './bin-store.js';
import { type DrapeElement, type DrapeTile, drapeSelectionKey } from './binning.js';
import { buildDrapeGeometry } from './geometry.js';

/** Derives the bounding box from a geometry (test helper) */
function geometryBounds(geometry: ReturnType<typeof buildDrapeGeometry>) {
  return {
    minX: geometry.minX,
    minY: geometry.minY,
    maxX: geometry.maxX,
    maxY: geometry.maxY,
  };
}

/** Builds a polygon element */
function element(size: number, color: number, selectionKey = ''): DrapeElement {
  const ring: Coordinate[] = [
    [-size, -size],
    [size, -size],
    [size, size],
    [-size, size],
  ];
  return {
    kind: 0,
    bounds: geometryBounds(buildDrapeGeometry([ring], true)),
    geometry: () => buildDrapeGeometry([ring], true),
    fill: [color, 0, 0, 1],
    stroke: [0, 0, 0, 1],
    strokeWidthPx: 2,
    source: 0,
    widthZoom: -1,
    selectionKey,
  };
}

const tiles: DrapeTile[] = [
  { x: 0, y: 0, z: 1 },
  { x: 1, y: 0, z: 1 },
  { x: 0, y: 1, z: 1 },
  { x: 1, y: 1, z: 1 },
];

describe('DrapeTileStore', () => {
  it('does not rebuild on the second call for the same version and tile', () => {
    const store = new DrapeTileStore();
    store.sync('rev-1', [element(60, 1)]);

    const first = store.prepare(tiles, 100);
    expect(first.built).toBe(4);
    expect(first.complete).toBe(true);

    const second = store.prepare(tiles, 100);
    expect(second.built).toBe(0);
    expect(second.pending).toBe(false);
  });

  it('builds only the new tiles', () => {
    const store = new DrapeTileStore();
    store.sync('rev-1', [element(60, 1)]);
    store.prepare(tiles.slice(0, 2), 100);

    const next = store.prepare(tiles, 100);
    expect(next.built).toBe(2);
  });

  it('builds at least one tile even when the budget runs out', () => {
    const store = new DrapeTileStore();
    store.sync('rev-1', [element(60, 1)]);
    // With a positive budget, however small, at least one tile advances.
    const result = store.prepare(tiles, 0.000001);
    expect(result.built).toBe(1);
    expect(result.pending).toBe(true);
  });

  it('builds nothing when the budget is 0 or less (deferred while the camera moves)', () => {
    const store = new DrapeTileStore();
    store.sync('rev-1', [element(60, 1)]);
    const result = store.prepare(tiles, 0);
    expect(result.built).toBe(0);
    expect(result.pending).toBe(true);
    // After deferring, a positive budget builds.
    const retry = store.prepare(tiles, 8);
    expect(retry.built).toBeGreaterThan(0);
  });

  it('keeps drawing the previous version until the new one is complete', () => {
    const store = new DrapeTileStore();
    store.sync('rev-1', [element(60, 1)]);
    store.prepare(tiles, 100);
    const oldPack = store.pack;
    expect(oldPack).not.toBeNull();

    // Move to a new version (element with a changed color)
    store.sync('rev-2', [element(60, 0.5)]);
    // With budget 0 only one tile can be built, so it is not swapped yet
    store.prepare(tiles, 0);
    expect(store.pack).toBe(oldPack);

    // Once complete, it is swapped
    store.prepare(tiles, 100);
    expect(store.pack).not.toBe(oldPack);
  });

  it('survives an empty element list', () => {
    const store = new DrapeTileStore();
    store.sync('rev-1', []);
    const result = store.prepare(tiles, 100);
    expect(result.complete).toBe(true);
    expect(store.pack?.edgeCount).toBe(0);
  });

  it('keeps only the tiles in view once the retained amount exceeds the limit', () => {
    const store = new DrapeTileStore();
    store.sync('rev-1', [element(80, 1)]);

    // Pass through 100 tiles at z = 5
    for (let i = 0; i < 100; i++) {
      store.prepare([{ x: i % 32, y: Math.floor(i / 32), z: 5 }], 100);
    }
    const last: DrapeTile = { x: 3, y: 3, z: 5 };
    store.prepare([last], 100);
    // The tiles currently in view can still be looked up after repacking
    expect(store.entryOf(last)).toBeDefined();
  });

  it('discards everything on clear', () => {
    const store = new DrapeTileStore();
    store.sync('rev-1', [element(60, 1)]);
    store.prepare(tiles, 100);
    store.clear();
    expect(store.pack).toBeNull();
    expect(store.entryOf(tiles[0])).toBeUndefined();
  });
});

describe('selection highlight marks', () => {
  /** Value of the selection texel in the style table */
  function selectionFlags(store: DrapeTileStore, count: number): number[] {
    const pack = store.pack;
    if (!pack) return [];
    const out: number[] = [];
    for (let f = 0; f < count; f++) {
      out.push(pack.styles[(f * DRAPE_STYLE_TEXELS + DRAPE_SELECTION_TEXEL) * 4]);
    }
    return out;
  }

  it('marks selection with a single style-table texel and leaves the index alone', () => {
    const store = new DrapeTileStore();
    const elements = [element(60, 1, 'c1\u0000a'), element(40, 2, 'c1\u0000b')];
    store.sync('rev-1', elements);
    store.prepare(tiles, 100);

    const pack = store.pack;
    if (!pack) throw new Error('pack is missing');
    const before = {
      edges: pack.edgeCount,
      runs: pack.runCount,
      cells: pack.cellCount,
      styles: Float32Array.from(pack.styles),
    };

    store.setSelection(new Set(['c1\u0000b']));

    expect(selectionFlags(store, 2)).toEqual([0, 1]);
    // The index (edges, runs, cells) does not move at all = no rebuild happened
    expect(pack.edgeCount).toBe(before.edges);
    expect(pack.runCount).toBe(before.runs);
    expect(pack.cellCount).toBe(before.cells);
    // The color and width texels do not change either (all but the selection texel are the same)
    for (let i = 0; i < before.styles.length; i++) {
      const texel = Math.floor(i / 4) % DRAPE_STYLE_TEXELS;
      if (texel === DRAPE_SELECTION_TEXEL) continue;
      expect(pack.styles[i]).toBe(before.styles[i]);
    }
  });

  it('advances the version only when the selection changes (re-upload only then)', () => {
    const store = new DrapeTileStore();
    store.sync('rev-1', [element(60, 1, 'c1\u0000a')]);
    store.prepare(tiles, 100);
    const pack = store.pack;
    if (!pack) throw new Error('pack is missing');

    const initial = pack.selectionVersion;
    store.setSelection(new Set(['c1\u0000a']));
    expect(pack.selectionVersion).toBe(initial + 1);

    // A different set with the same contents does not advance it
    store.setSelection(new Set(['c1\u0000a']));
    expect(pack.selectionVersion).toBe(initial + 1);

    store.setSelection(new Set());
    expect(pack.selectionVersion).toBe(initial + 2);
  });

  it('never selects elements without a key (Store features)', () => {
    const store = new DrapeTileStore();
    store.sync('rev-1', [element(60, 1, ''), element(40, 2, 'c1\u0000b')]);
    store.prepare(tiles, 100);

    // Putting an empty-string key into the selection set does not light anything up
    store.setSelection(new Set(['', 'c1\u0000b']));

    expect(selectionFlags(store, 2)).toEqual([0, 1]);
  });

  it('carries the selection over to the new version even when the element order changes', () => {
    const store = new DrapeTileStore();
    store.sync('rev-1', [element(60, 1, 'c1\u0000a')]);
    store.prepare(tiles, 100);
    store.setSelection(new Set(['c1\u0000a']));

    // Start a new version, cover the view, and swap
    store.sync('rev-2', [element(60, 1, 'c1\u0000a')]);
    store.prepare(tiles, 100);

    expect(selectionFlags(store, 1)).toEqual([1]);
  });

  it('keeps the selection marks after repacking at the retention limit', () => {
    const store = new DrapeTileStore();
    store.sync('rev-1', [element(80, 1, 'c1 a')]);
    store.prepare(tiles, 100);
    store.setSelection(new Set(['c1 a']));
    expect(selectionFlags(store, 1)).toEqual([1]);

    // Pass through tiles until the limit (96) is exceeded to trigger repacking.
    // Repacking starts a new builder, so unless the selection marks are copied
    // over, the rule "setSelection returns early while the set is unchanged"
    // makes the highlight vanish forever (seen in the field as disappearing
    // during zoom)
    for (let i = 0; i < 100; i++) {
      store.prepare([{ x: i % 32, y: Math.floor(i / 32), z: 5 }], 100);
    }
    const last: DrapeTile = { x: 3, y: 3, z: 5 };
    store.prepare([last], 100);
    expect(store.entryOf(last)).toBeDefined();

    // The marks are already set, on the assumption that reporting the same set
    // again returns early
    store.setSelection(new Set(['c1 a']));
    expect(selectionFlags(store, 1)).toEqual([1]);
  });

  it('returns the separators of the version being drawn (unchanged mid-rebuild)', () => {
    // Separators are indices into the element order, so they must be paired with
    // the element list. Drawing the old index with new separators makes the
    // partitioned draw paint another element or nothing at all (seen in the
    // field as "polygons not drawn")
    const store = new DrapeTileStore();
    store.sync('rev-1', [element(60, 1), element(50, 2)], [{ featureId: 'img', afterElements: 1 }]);
    store.prepare(tiles, 100);
    expect(store.quadBreaks).toEqual([{ featureId: 'img', afterElements: 1 }]);

    // Start a new version. The old version is still drawn, so the separators stay old
    store.sync('rev-2', [element(60, 1)], [{ featureId: 'img', afterElements: 0 }]);
    expect(store.elementCount).toBe(2);
    expect(store.quadBreaks).toEqual([{ featureId: 'img', afterElements: 1 }]);

    // Once the new version's tiles are complete, the element list and separators swap as a pair
    store.prepare(tiles, 100);
    expect(store.elementCount).toBe(1);
    expect(store.quadBreaks).toEqual([{ featureId: 'img', afterElements: 0 }]);
  });

  it('builds the key from the dataset ID and the feature ID', () => {
    expect(drapeSelectionKey('c1', 'a')).not.toBe(drapeSelectionKey('c1', 'b'));
    expect(drapeSelectionKey('c1', 'a')).not.toBe(drapeSelectionKey('c2', 'a'));
    // Without a separator, 'c1' + 'a' and 'c' + '1a' collide
    expect(drapeSelectionKey('c1', 'a')).not.toBe(drapeSelectionKey('c', '1a'));
  });
});
