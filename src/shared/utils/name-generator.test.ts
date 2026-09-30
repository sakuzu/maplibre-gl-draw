// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests of AutoNameGenerator
 *
 * In addition to sequential generation, carrying over existing names, the gaps left after
 * deletion and custom configuration, it verifies that existing names are taken in as "a full
 * scan the first time + the increments of the Store from then on".
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../store/memory.js';
import type { Feature, FeatureType } from '../../store/types.js';
import { geometryFromCoordinates } from './coordinates.js';
import { AutoNameGenerator, normalizeAutoNameConfig } from './name-generator.js';

let store: MemoryStore;
let idSeq: number;

function createFeature(type: FeatureType, name?: string, layerId = 'l1'): Feature {
  const feature: Feature = {
    groupId: undefined,
    id: `f-${++idSeq}`,
    type,
    geometry: geometryFromCoordinates(type, [0, 0]),
    layerId,
    properties: name === undefined ? {} : { name },
    locked: false,
    visible: true,
    style: {},
  };
  store.createFeature(feature);
  return feature;
}

beforeEach(() => {
  store = new MemoryStore();
  idSeq = 0;
  store.createLayer({
    id: 'l1',
    name: 'l1',
    visible: true,
    locked: false,
    opacity: 1,
    items: [],
    styleRule: undefined,
    metadata: undefined,
  });
});

describe('normalizeAutoNameConfig', () => {
  it('undefined / true are enabled and false is disabled', () => {
    expect(normalizeAutoNameConfig(undefined)).toEqual({ enabled: true });
    expect(normalizeAutoNameConfig(true)).toEqual({ enabled: true });
    expect(normalizeAutoNameConfig(false)).toEqual({ enabled: false });
  });

  it('an object is returned as is', () => {
    const config = { enabled: true, typeNames: { Point: '地点' } };
    expect(normalizeAutoNameConfig(config)).toBe(config);
  });
});

describe('AutoNameGenerator.generateName', () => {
  it('generates sequential numbers per type', () => {
    const generator = new AutoNameGenerator(store);

    expect(generator.generateName('Point')).toBe('Point 1');
    expect(generator.generateName('Point')).toBe('Point 2');
    expect(generator.generateName('LineString')).toBe('LineString 1');
    expect(generator.generateName('Point')).toBe('Point 3');
  });

  it('numbers from the next after the largest number of the existing features', () => {
    createFeature('Point', 'Point 7');
    createFeature('Point', 'Point 3');
    // Names of another type and names without a number are ignored
    createFeature('LineString', 'LineString 99');
    createFeature('Point', '名前');

    const generator = new AutoNameGenerator(store);

    expect(generator.generateName('Point')).toBe('Point 8');
    expect(generator.generateName('LineString')).toBe('LineString 100');
  });

  it('a deleted number is not reused and becomes a gap', () => {
    const generator = new AutoNameGenerator(store);

    expect(generator.generateName('Point')).toBe('Point 1');
    const second = createFeature('Point', generator.generateName('Point'));
    expect(second.properties.name).toBe('Point 2');

    store.deleteFeature(second.id);

    expect(generator.generateName('Point')).toBe('Point 3');
  });

  it('gives features no name when disabled, and layers / groups the word alone', () => {
    const generator = new AutoNameGenerator(store, false);

    expect(generator.isEnabled()).toBe(false);
    expect(generator.generateName('Point')).toBeUndefined();
    expect(generator.generateLayerName()).toBe('Layer');
    expect(generator.generateGroupName()).toBe('Group');
  });

  it('takes the word of a disabled layer / group from typeNames', () => {
    const generator = new AutoNameGenerator(store, {
      enabled: false,
      typeNames: { Layer: 'レイヤー', Group: 'グループ' },
      formatter: (typeName, n) => `${typeName}-${n}`,
    });

    expect(generator.generateLayerName()).toBe('レイヤー');
    expect(generator.generateGroupName()).toBe('グループ');
  });

  it('names every built-in type in English by default, and a custom type with its id', () => {
    const generator = new AutoNameGenerator(store);

    expect(generator.generateName('Circle')).toBe('Circle 1');
    expect(generator.generateName('Freehand')).toBe('Freehand 1');
    expect(generator.generateName('Stamp')).toBe('Stamp 1');
  });

  it('takes the word of a custom type from typeNames', () => {
    const generator = new AutoNameGenerator(store, {
      enabled: true,
      typeNames: { Stamp: 'スタンプ' },
    });

    expect(generator.generateName('Stamp')).toBe('スタンプ 1');
  });

  it('uses a custom typeNames and a custom formatter', () => {
    const generator = new AutoNameGenerator(store, {
      enabled: true,
      typeNames: { Point: '地点', Layer: 'レイヤー', Group: 'グループ' },
      formatter: (typeName, number) => `${typeName}#${number}`,
    });

    expect(generator.generateName('Point')).toBe('地点#1');
    expect(generator.generateLayerName()).toBe('レイヤー#1');
    expect(generator.generateGroupName()).toBe('グループ#1');
  });

  it('carries over the number of an existing name with a custom typeName', () => {
    createFeature('Point', '地点 4');

    const generator = new AutoNameGenerator(store, {
      enabled: true,
      typeNames: { Point: '地点' },
    });

    expect(generator.generateName('Point')).toBe('地点 5');
  });
});

describe('AutoNameGenerator.generateLayerName / generateGroupName', () => {
  it('numbers from the next after the numbers of the existing Layers / Groups', () => {
    store.createLayer({
      id: 'l9',
      name: 'Layer 9',
      visible: true,
      locked: false,
      opacity: 1,
      items: [],
      styleRule: undefined,
      metadata: undefined,
    });
    store.createGroup({
      id: 'g5',
      layerId: 'l1',
      name: 'Group 5',
      featureIds: [],
      locked: false,
      visible: true,
    });

    const generator = new AutoNameGenerator(store);

    expect(generator.generateLayerName()).toBe('Layer 10');
    expect(generator.generateLayerName()).toBe('Layer 11');
    expect(generator.generateGroupName()).toBe('Group 6');
  });
});

describe('the incremental following of AutoNameGenerator', () => {
  it('carries over the number of a name added from outside after a generation', () => {
    const generator = new AutoNameGenerator(store);

    expect(generator.generateName('Point')).toBe('Point 1');
    createFeature('Point', 'Point 500');

    expect(generator.generateName('Point')).toBe('Point 501');
  });

  it('carries it over when name is updated from outside too', () => {
    const generator = new AutoNameGenerator(store);
    expect(generator.generateName('Point')).toBe('Point 1');

    const feature = createFeature('Point');
    store.updateFeature(feature.id, { properties: { name: 'Point 42' } });

    expect(generator.generateName('Point')).toBe('Point 43');
  });

  it('adding another type does not affect the counters of the other types', () => {
    const generator = new AutoNameGenerator(store);
    expect(generator.generateName('Point')).toBe('Point 1');

    createFeature('LineString', 'LineString 300');

    expect(generator.generateName('Point')).toBe('Point 2');
  });

  it('carries over the numbers of Layers / Groups added from outside', () => {
    const generator = new AutoNameGenerator(store);
    expect(generator.generateLayerName()).toBe('Layer 1');
    expect(generator.generateGroupName()).toBe('Group 1');

    store.createLayer({
      id: 'l20',
      name: 'Layer 20',
      visible: true,
      locked: false,
      opacity: 1,
      items: [],
      styleRule: undefined,
      metadata: undefined,
    });
    store.createGroup({
      id: 'g30',
      layerId: 'l1',
      name: 'Group 30',
      featureIds: [],
      locked: false,
      visible: true,
    });

    expect(generator.generateLayerName()).toBe('Layer 21');
    expect(generator.generateGroupName()).toBe('Group 31');
  });

  it('does not take in changes of the Store after dispose', () => {
    const generator = new AutoNameGenerator(store);
    expect(generator.generateName('Point')).toBe('Point 1');

    generator.dispose();
    createFeature('Point', 'Point 500');

    expect(generator.generateName('Point')).toBe('Point 2');
  });
});

describe('the computational cost of AutoNameGenerator', () => {
  it('does not scan everything on every generation', () => {
    for (let i = 0; i < 10_000; i++) {
      createFeature('Point', `Point ${i + 1}`);
    }

    const generator = new AutoNameGenerator(store);
    const spy = vi.spyOn(store, 'listFeatures');

    for (let i = 0; i < 100; i++) {
      generator.generateName('Point');
    }

    // The full scan happens only once per type, the first time
    expect(spy).toHaveBeenCalledTimes(1);
    expect(generator.generateName('Point')).toBe('Point 10101');

    generator.generateName('LineString');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('the full scan happens only once, the first time, even during a bulk import', () => {
    const generator = new AutoNameGenerator(store);
    const spy = vi.spyOn(store, 'listFeatures');

    store.transact(() => {
      for (let i = 0; i < 1_000; i++) {
        createFeature('Point', generator.generateName('Point'));
      }
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(generator.generateName('Point')).toBe('Point 1001');
  });
});
