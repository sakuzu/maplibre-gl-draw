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
 * - a diffed `setStyle` leaves the custom layers where they are (they are not in the serialized
 *   style), adds the new layers on top and fires `style.load`; the `styledata` of the change
 *   comes with the next frame
 */
class StubMap {
  style: { _loaded: boolean } | undefined = { _loaded: false };
  tilesLoading = true;
  layers: string[] = [];
  addCalls: string[] = [];
  moveCalls: string[] = [];
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

  addLayer(layer: { id: string }, before?: string): this {
    if (!this.style?._loaded) throw new Error('Style is not done loading.');
    if (this.layers.includes(layer.id)) throw new Error(`Layer "${layer.id}" already exists`);
    const index = before === undefined ? this.layers.length : this.layers.indexOf(before);
    this.layers.splice(index, 0, layer.id);
    this.addCalls.push(layer.id);
    return this;
  }

  getLayersOrder(): string[] {
    return [...this.layers];
  }

  /** Moves a layer before another one, or to the top (maplibre Style.moveLayer) */
  moveLayer(id: string, before?: string): this {
    if (!this.style?._loaded) throw new Error('Style is not done loading.');
    if (!this.layers.includes(id)) throw new Error(`Layer "${id}" does not exist`);
    this.moveCalls.push(id);
    this.layers.splice(this.layers.indexOf(id), 1);
    const index = before === undefined ? this.layers.length : this.layers.indexOf(before);
    this.layers.splice(index, 0, id);
    return this;
  }

  /** A layer the host adds itself (maplibre fires `styledata` alone) */
  addHostLayer(id: string, before?: string): void {
    const index = before === undefined ? this.layers.length : this.layers.indexOf(before);
    this.layers.splice(index, 0, id);
    this.fire('styledata');
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

  /**
   * A diffed `setStyle` (maplibre Style.setState): the native layers of the old style are
   * removed, the custom layers stay, the layers of the new style are added on top, then
   * `style.load`, and `styledata` with the next frame
   */
  diffStyle(nativeLayers: readonly string[], keep: readonly string[] = []): void {
    this.layers = this.layers.filter((id) => this.isCustom(id) || keep.includes(id));
    for (const id of nativeLayers) if (!this.layers.includes(id)) this.layers.push(id);
    this.fire('style.load');
    this.fire('styledata');
  }

  /** The ids of the custom layers (the slots of the tests) */
  customIds = new Set<string>();
  private isCustom(id: string): boolean {
    return this.customIds.has(id);
  }

  asMap(): MapLibreMap {
    return this as unknown as MapLibreMap;
  }
}

function slots(...ids: string[]): CustomLayerInterface[] {
  return ids.map((id) => ({ id, type: 'custom', render: () => {} }));
}

/** A map with a parsed style made of native layers, and the slots marked as custom */
function loadedMap(native: string[], slotIds: string[]): StubMap {
  const map = new StubMap();
  map.layers = [...native];
  for (const id of slotIds) map.customIds.add(id);
  map.parseStyle();
  map.finishTiles();
  return map;
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

  it('puts the slot back on top after a diffed style change adds layers above it', () => {
    const map = loadedMap(['old-bg'], ['a']);
    attachSlotLayers(map.asMap(), () => slots('a'));
    expect(map.layers).toEqual(['old-bg', 'a']);

    map.diffStyle(['a-bg', 'a-top']);
    expect(map.layers).toEqual(['a-bg', 'a-top', 'a']);
    expect(map.addCalls).toEqual(['a']);
  });

  it('puts several slots back on top in order, with the layers placed between them', () => {
    const map = loadedMap(['old-bg'], ['a', 'b', 'c']);
    attachSlotLayers(map.asMap(), () => slots('a', 'b', 'c'));
    // The host places a native layer between the first two slots
    map.moveLayer('old-bg', 'b');
    expect(map.layers).toEqual(['a', 'old-bg', 'b', 'c']);

    map.diffStyle(['a-bg', 'a-top'], ['old-bg']);
    expect(map.layers).toEqual(['a-bg', 'a-top', 'a', 'old-bg', 'b', 'c']);
  });

  it('adds a missing slot behind the next one and puts the slots back on top in order', () => {
    const map = loadedMap([], ['a', 'b']);
    attachSlotLayers(map.asMap(), () => slots('a', 'b'));
    map.layers = ['b'];

    map.diffStyle(['a-bg']);
    expect(map.layers).toEqual(['a-bg', 'a', 'b']);
  });

  it('adds a missing slot behind the next one on styledata, without moving the others', () => {
    const map = loadedMap(['old-bg'], ['a', 'b']);
    attachSlotLayers(map.asMap(), () => slots('a', 'b'));
    map.layers = ['old-bg', 'b'];

    map.fire('styledata');
    expect(map.layers).toEqual(['old-bg', 'a', 'b']);
    expect(map.moveCalls).toEqual([]);
  });

  it('moves nothing when the slots are already on top, through repeated style changes', () => {
    const map = loadedMap(['old-bg'], ['a']);
    attachSlotLayers(map.asMap(), () => slots('a'));
    map.parseStyle();
    expect(map.moveCalls).toEqual([]);

    map.diffStyle(['a-bg']);
    map.diffStyle(['b-bg', 'b-top']);
    expect(map.layers).toEqual(['b-bg', 'b-top', 'a']);
    expect(map.moveCalls).toEqual(['a', 'a']);
  });

  it('leaves a layer the host puts above the drawing until the style changes', () => {
    const map = loadedMap(['old-bg'], ['a']);
    attachSlotLayers(map.asMap(), () => slots('a'));
    map.addHostLayer('labels');
    expect(map.layers).toEqual(['old-bg', 'a', 'labels']);

    map.diffStyle(['a-bg'], ['labels']);
    expect(map.layers).toEqual(['labels', 'a-bg', 'a']);
  });

  it('does not move the slots after detach', () => {
    const map = loadedMap(['old-bg'], ['a']);
    const detach = attachSlotLayers(map.asMap(), () => slots('a'));
    detach();

    map.diffStyle(['a-bg']);
    expect(map.layers).toEqual(['a', 'a-bg']);
    expect(map.moveCalls).toEqual([]);
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
