// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import type { CustomLayerInterface, Map as MapLibreMap } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import { attachSlotLayers } from './attach.js';

/**
 * The smallest stand-in for a maplibre Map that follows its loading sequence:
 *
 * - the stylesheet is parsed (`style._loaded` becomes true), then `styledata`, then `style.load`
 * - `load` fires only once, after the first style and its tiles are loaded
 * - `loaded()` is false while tiles are loading, which also happens after every pan or zoom
 * - `addLayer` throws while the style is not parsed, as maplibre does
 */
class StubMap {
  style: { _loaded: boolean } | undefined = { _loaded: false };
  tilesLoading = true;
  layers: string[] = [];
  addCalls: string[] = [];
  private listeners = new Map<string, Set<() => void>>();

  on(type: string, fn: () => void): this {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
    return this;
  }

  off(type: string, fn: () => void): this {
    this.listeners.get(type)?.delete(fn);
    return this;
  }

  fire(type: string): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
  }

  listenerCount(): number {
    let count = 0;
    for (const set of this.listeners.values()) count += set.size;
    return count;
  }

  loaded(): boolean {
    return this.style?._loaded === true && !this.tilesLoading;
  }

  getLayer(id: string): { id: string } | undefined {
    return this.layers.includes(id) ? { id } : undefined;
  }

  addLayer(layer: { id: string }): this {
    if (!this.style?._loaded) throw new Error('Style is not done loading.');
    if (this.layers.includes(layer.id)) throw new Error(`Layer "${layer.id}" already exists`);
    this.layers.push(layer.id);
    this.addCalls.push(layer.id);
    return this;
  }

  /** The stylesheet is parsed (maplibre Style._load) */
  parseStyle(): void {
    if (!this.style) this.style = { _loaded: false };
    this.style._loaded = true;
    this.fire('styledata');
    this.fire('style.load');
  }

  /** The first style and its tiles finish loading (fires `load` the first time only) */
  private loadFired = false;
  finishTiles(): void {
    this.tilesLoading = false;
    if (!this.loadFired) {
      this.loadFired = true;
      this.fire('load');
    }
    this.fire('idle');
  }

  /** A pan or zoom starts loading new tiles */
  moveToNewTiles(): void {
    this.tilesLoading = true;
  }

  /** A full `setStyle`: a new style replaces the old one and drops every layer */
  replaceStyle(): void {
    this.style = { _loaded: false };
    this.layers = [];
    this.tilesLoading = true;
  }

  /** A diffed `setStyle` removes the layers the new stylesheet does not contain */
  diffStyleDroppingLayers(): void {
    this.layers = [];
    this.fire('styledata');
  }

  asMap(): MapLibreMap {
    return this as unknown as MapLibreMap;
  }
}

function slots(...ids: string[]): CustomLayerInterface[] {
  return ids.map((id) => ({ id, type: 'custom', render: () => {} }));
}

describe('attachSlotLayers', () => {
  it('adds the slots once when created before the style is parsed', () => {
    const map = new StubMap();
    attachSlotLayers(map.asMap(), () => slots('a'));
    expect(map.layers).toEqual([]);

    map.parseStyle();
    map.finishTiles();
    expect(map.addCalls).toEqual(['a']);
  });

  it('adds the slots once when created while the first tiles are loading', () => {
    const map = new StubMap();
    map.parseStyle();
    expect(map.loaded()).toBe(false);

    attachSlotLayers(map.asMap(), () => slots('a'));
    map.finishTiles();
    expect(map.addCalls).toEqual(['a']);
  });

  it('adds the slots when created after load while new tiles are loading', () => {
    const map = new StubMap();
    map.parseStyle();
    map.finishTiles();
    map.moveToNewTiles();
    expect(map.loaded()).toBe(false);

    attachSlotLayers(map.asMap(), () => slots('a'));
    expect(map.addCalls).toEqual(['a']);

    map.finishTiles();
    expect(map.addCalls).toEqual(['a']);
  });

  it('adds the slots once when created after the map is fully loaded', () => {
    const map = new StubMap();
    map.parseStyle();
    map.finishTiles();

    attachSlotLayers(map.asMap(), () => slots('a'));
    map.fire('styledata');
    expect(map.addCalls).toEqual(['a']);
  });

  it('adds the slots when the map has no style yet and one is set later', () => {
    const map = new StubMap();
    map.style = undefined;
    attachSlotLayers(map.asMap(), () => slots('a'));
    expect(map.layers).toEqual([]);

    map.parseStyle();
    expect(map.addCalls).toEqual(['a']);
  });

  it('adds several slots in order from the first', () => {
    const map = new StubMap();
    attachSlotLayers(map.asMap(), () => slots('a', 'b', 'c'));
    map.parseStyle();
    expect(map.layers).toEqual(['a', 'b', 'c']);
  });

  it('restores the slots after a full style change', () => {
    const map = new StubMap();
    map.parseStyle();
    map.finishTiles();
    attachSlotLayers(map.asMap(), () => slots('a'));

    map.replaceStyle();
    expect(map.layers).toEqual([]);
    map.parseStyle();
    expect(map.layers).toEqual(['a']);
  });

  it('restores the slots after a diffed style change drops them', () => {
    const map = new StubMap();
    map.parseStyle();
    attachSlotLayers(map.asMap(), () => slots('a'));

    map.diffStyleDroppingLayers();
    expect(map.layers).toEqual(['a']);
  });

  it('stops watching the style after detach', () => {
    const map = new StubMap();
    const detach = attachSlotLayers(map.asMap(), () => slots('a'));
    detach();
    expect(map.listenerCount()).toBe(0);

    map.parseStyle();
    expect(map.layers).toEqual([]);
  });
});
