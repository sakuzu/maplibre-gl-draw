// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { getMessages } from '@sakuzu/kata/svelte';
import type { Feature, FeatureStyleResolved } from '@sakuzu/maplibre-gl-draw';
import { describe, expect, it } from 'vitest';
import {
  attributeAdd,
  attributePatch,
  attributeRemove,
  attributeRows,
  descriptionPatch,
  featureName,
  namePatch,
} from '../src/inspector/attributes.js';
import { formatArea, formatLength, measure } from '../src/inspector/measure.js';
import {
  applicableOperations,
  runBuffer,
  runOperation,
  splitPair,
  toMeters,
} from '../src/inspector/operations.js';
import { applicableSections, inspectorSettings } from '../src/inspector/sections.js';
import {
  ownStyleKeys,
  resetPatch,
  sharedStyleKeys,
  styleFields,
  stylePatch,
} from '../src/inspector/style.js';
import type { InspectorDraw } from '../src/inspector/types.js';
import { kindCounts, readView } from '../src/inspector/view.js';
import { en } from '../src/locales/en.js';
import {
  applyKataMessages,
  fillWord,
  inspectorKataMessages,
  resolveMessages,
} from '../src/messages.js';
import { DEFAULT_STYLE, fakeDocument, makeFeature } from './fake-draw.js';

const pt = (id: string, extra: Partial<Feature> = {}) =>
  makeFeature({
    id,
    type: 'Point',
    geometry: { type: 'Point', coordinates: [139.7671, 35.6812] },
    ...extra,
  });
const square = (id: string, type = 'Polygon', extra: Partial<Feature> = {}) =>
  makeFeature({
    id,
    type,
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [0.001, 0],
          [0.001, 0.001],
          [0, 0.001],
          [0, 0],
        ],
      ],
    },
    ...extra,
  });
const line = (id: string, type = 'LineString') =>
  makeFeature({
    id,
    type,
    geometry: {
      type: 'LineString',
      coordinates: [
        [0, 0],
        [0.01, 0],
      ],
    },
  });
const circle = (id: string, radius = 100) =>
  makeFeature({
    id,
    type: 'Circle',
    geometry: { type: 'Point', coordinates: [0, 0] },
    properties: { 'maplibre-gl-draw:radiusMeters': radius },
  });

const resolved = (f: Feature): FeatureStyleResolved => ({ ...DEFAULT_STYLE, ...f.style });
const fields = (features: Feature[]) =>
  styleFields(
    features,
    (id) => {
      const f = features.find((x) => x.id === id);
      return f ? resolved(f) : undefined;
    },
    en,
  );

describe('the fields of the style', () => {
  it('follow the type', () => {
    const keys = (f: Feature) => fields([f]).map((x) => x.key);
    expect(keys(pt('a'))).toEqual([
      'pointColor',
      'pointRadius',
      'pointShape',
      'pointOpacity',
      'pointStrokeColor',
      'pointStrokeWidth',
    ]);
    expect(keys(line('a'))).toEqual(['strokeColor', 'strokeWidth', 'strokeOpacity', 'lineStyle']);
    expect(keys(line('a', 'Freehand'))).toEqual(keys(line('a')));
    expect(keys(square('a'))).toEqual([
      'fillColor',
      'fillOpacity',
      'strokeColor',
      'strokeWidth',
      'strokeOpacity',
      'lineStyle',
    ]);
    expect(keys(circle('a'))).toEqual(keys(square('a')));
    expect(
      keys(
        makeFeature({ id: 'i', type: 'Image', geometry: { type: 'Point', coordinates: [0, 0] } }),
      ),
    ).toEqual(['imageOpacity']);
    expect(
      keys(
        makeFeature({ id: 'c', type: 'Ring', geometry: { type: 'Point', coordinates: [0, 0] } }),
      ),
    ).toEqual([]);
  });

  it('show an opacity as a percentage and the controls of each key', () => {
    const [color, radius, shape, opacity] = fields([pt('a', { style: { pointOpacity: 0.456 } })]);
    expect(color).toMatchObject({ kind: 'color', value: '#3388ff', label: 'Color' });
    expect(radius).toMatchObject({ kind: 'slider', min: 1, max: 40, unit: 'px', value: 6 });
    expect(shape.kind).toBe('segmented');
    expect(shape.options?.map((o) => o.value)).toEqual(['circle', 'square', 'triangle', 'star']);
    expect(opacity).toMatchObject({ kind: 'slider', min: 0, max: 100, unit: '%', value: 46 });
    const width = fields([line('l')]).find((f) => f.key === 'strokeWidth');
    expect(width).toMatchObject({ min: 0.5, max: 20, step: 0.5 });
    const dash = fields([line('l')]).find((f) => f.key === 'lineStyle');
    expect(dash?.options?.map((o) => o.value)).toEqual(['solid', 'dashed', 'dotted']);
  });

  it('are those every feature has, mixed where the values differ', () => {
    const a = square('a', 'Polygon', { style: { strokeColor: '#FF0000' } });
    const b = line('b');
    const shared = fields([a, b]);
    expect(shared.map((f) => f.key)).toEqual([
      'strokeColor',
      'strokeWidth',
      'strokeOpacity',
      'lineStyle',
    ]);
    expect(shared[0]).toMatchObject({ mixed: true });
    expect(shared[0].value).toBeUndefined();
    expect(shared[1]).toMatchObject({ value: 2 });
    expect(shared[1].mixed).toBeUndefined();
    expect(sharedStyleKeys([pt('p'), line('l')])).toEqual([]);
    expect(sharedStyleKeys([])).toEqual([]);
  });

  it('take colors that differ only in case as the same', () => {
    const a = square('a', 'Polygon', { style: { fillColor: '#AABBCC' } });
    const b = square('b', 'Polygon', { style: { fillColor: '#aabbcc' } });
    expect(fields([a, b])[0]).toMatchObject({ value: '#aabbcc' });
  });

  it('are disabled when the features cannot be edited', () => {
    const out = styleFields([pt('a')], () => undefined, en, true);
    expect(out.every((f) => f.disabled)).toBe(true);
  });

  it('make a patch of the style', () => {
    expect(stylePatch('fillOpacity', 40)).toEqual({ fillOpacity: 0.4 });
    expect(stylePatch('fillOpacity', 140)).toEqual({ fillOpacity: 1 });
    expect(stylePatch('fillColor', '#112233')).toEqual({ fillColor: '#112233' });
    expect(stylePatch('strokeWidth', 3.5)).toEqual({ strokeWidth: 3.5 });
    expect(stylePatch('lineStyle', 'dashed')).toEqual({ lineStyle: 'dashed' });
    expect(stylePatch('pointRadius', null)).toEqual({ pointRadius: undefined });
  });

  it('reset only the keys of the fields the features set', () => {
    const a = square('a', 'Polygon', { style: { fillColor: '#ff0000', pointColor: '#00ff00' } });
    expect(ownStyleKeys([a])).toEqual(['fillColor']);
    expect(resetPatch(['fillColor'])).toEqual({ fillColor: undefined });
  });
});

describe('the measurements', () => {
  it('write lengths in metric units', () => {
    expect(formatLength(12.34, 'metric')).toBe('12.3 m');
    expect(formatLength(999, 'metric')).toBe('999 m');
    expect(formatLength(1000, 'metric')).toBe('1.00 km');
    expect(formatLength(12_345.6, 'metric')).toBe('12.35 km');
  });

  it('write areas in metric units', () => {
    expect(formatArea(9999, 'metric')).toBe('9,999 m²');
    expect(formatArea(10_000, 'metric')).toBe('1.00 ha');
    expect(formatArea(999_999, 'metric')).toBe('100.00 ha');
    expect(formatArea(2_500_000, 'metric')).toBe('2.50 km²');
  });

  it('write lengths and areas in imperial units', () => {
    expect(formatLength(3.048, 'imperial')).toBe('10 ft');
    expect(formatLength(1609.344, 'imperial')).toBe('1.00 mi');
    expect(formatArea(0.09290304 * 100, 'imperial')).toBe('100 ft²');
    expect(formatArea(0.09290304 * 43_560 * 2, 'imperial')).toBe('2.00 ac');
    expect(formatArea(0.09290304 * 43_560 * 640 * 3, 'imperial')).toBe('3.00 mi²');
  });

  it('write numbers as the locale does', () => {
    expect(formatLength(12_345.6, 'metric', 'de')).toBe('12,35 km');
  });

  it('measure each type', () => {
    expect(measure(pt('p'), 'metric')).toEqual([
      { key: 'longitude', value: '139.767100°' },
      { key: 'latitude', value: '35.681200°' },
    ]);
    const [len] = measure(line('l'), 'metric');
    expect(len.key).toBe('length');
    expect(len.value).toMatch(/^1\.11 km$/);
    expect(measure(square('s'), 'metric').map((r) => r.key)).toEqual(['area', 'perimeter']);
    expect(measure(circle('c', 100), 'metric')).toEqual([
      { key: 'area', value: '3.14 ha' },
      { key: 'perimeter', value: '628.3 m' },
      { key: 'radius', value: '100 m' },
    ]);
    const multi = makeFeature({
      id: 'mp',
      type: 'MultiPoint',
      geometry: {
        type: 'MultiPoint',
        coordinates: [
          [0, 0],
          [1, 1],
          [2, 2],
        ],
      },
    });
    expect(measure(multi, 'metric')).toEqual([{ key: 'points', value: '3' }]);
    const image = makeFeature({
      id: 'i',
      type: 'Image',
      geometry: { type: 'Point', coordinates: [0, 0] },
    });
    expect(measure(image, 'metric')).toEqual([]);
  });

  it('give the totals of a Multi geometry', () => {
    const multi = makeFeature({
      id: 'ml',
      type: 'MultiLineString',
      geometry: {
        type: 'MultiLineString',
        coordinates: [
          [
            [0, 0],
            [0.01, 0],
          ],
          [
            [0, 1],
            [0.01, 1],
          ],
        ],
      },
    });
    expect(measure(multi, 'metric')).toEqual([{ key: 'length', value: '2.22 km' }]);
  });
});

describe('the attributes', () => {
  const f = makeFeature({
    id: 'a',
    type: 'Point',
    geometry: { type: 'Point', coordinates: [0, 0] },
    properties: {
      name: 'Station',
      description: 'A note',
      kind: 'rail',
      floors: 3,
      tags: ['a', 'b'],
      'maplibre-gl-draw:createdZoom': 12,
    },
  });

  it('leave out the name, the description and the keys of the library', () => {
    expect(attributeRows(f)).toEqual([
      { key: 'kind', value: 'rail' },
      { key: 'floors', value: '3' },
      { key: 'tags', value: '["a","b"]' },
    ]);
    expect(featureName(f)).toBe('Station');
  });

  it('change a value, kept as the string typed', () => {
    expect(attributePatch(f, 0, { key: 'kind', value: 'metro' })).toEqual({
      properties: { kind: 'metro' },
    });
    expect(attributePatch(f, 1, { key: 'floors', value: '4' })).toEqual({
      properties: { floors: '4' },
    });
  });

  it('rename an attribute, keeping the type of its value', () => {
    expect(attributePatch(f, 1, { key: 'levels', value: '3' })).toEqual({
      properties: { floors: undefined, levels: 3 },
    });
    expect(attributePatch(f, 0, { key: 'type', value: 'tram' })).toEqual({
      properties: { kind: undefined, type: 'tram' },
    });
  });

  it('refuse a name that is taken or kept, and a change of nothing', () => {
    expect(attributePatch(f, 0, { key: 'floors', value: 'rail' })).toBeNull();
    expect(attributePatch(f, 0, { key: 'name', value: 'rail' })).toBeNull();
    expect(attributePatch(f, 0, { key: 'maplibre-gl-draw:x', value: 'rail' })).toBeNull();
    expect(attributePatch(f, 0, { key: 'kind', value: 'rail' })).toBeNull();
    expect(attributePatch(f, 9, { key: 'x', value: '1' })).toBeNull();
    expect(attributeAdd(f, { key: 'kind', value: '1' })).toBeNull();
    expect(attributeAdd(f, { key: ' ', value: '1' })).toBeNull();
  });

  it('add and remove attributes', () => {
    expect(attributeAdd(f, { key: ' owner ', value: 'city' })).toEqual({
      properties: { owner: 'city' },
    });
    expect(attributeRemove(f, 2)).toEqual({ properties: { tags: undefined } });
    expect(attributeRemove(f, 5)).toBeNull();
  });

  it('name and describe a feature, an empty text removing the attribute', () => {
    expect(namePatch('  Park ')).toEqual({ properties: { name: 'Park' } });
    expect(namePatch('   ')).toEqual({ properties: { name: undefined } });
    expect(descriptionPatch('Line 1\nLine 2')).toEqual({
      properties: { description: 'Line 1\nLine 2' },
    });
    expect(descriptionPatch('')).toEqual({ properties: { description: undefined } });
  });
});

describe('the operations', () => {
  it('apply to the features they take', () => {
    expect(applicableOperations([square('a'), square('b')])).toEqual([
      'union',
      'intersection',
      'difference',
      'buffer',
    ]);
    expect(applicableOperations([square('a'), circle('c')])).toContain('union');
    expect(applicableOperations([square('a'), line('l')])).toEqual(['split', 'buffer']);
    expect(applicableOperations([line('l', 'Freehand'), circle('c')])).toEqual(['split']);
    expect(applicableOperations([pt('p')])).toEqual(['buffer']);
    expect(applicableOperations([square('a')])).toEqual(['buffer']);
    expect(applicableOperations([line('l'), line('m')])).toEqual(['buffer']);
    expect(applicableOperations([circle('c', 0), square('a')])).toEqual([]);
    expect(applicableOperations([])).toEqual([]);
    expect(splitPair([line('l'), square('a')])?.area.id).toBe('a');
  });

  it('run in core and select what they made', () => {
    const a = square('a');
    const b = square('b');
    const fake = fakeDocument({
      features: [a, b],
      selection: { type: 'feature', ids: ['a', 'b'] },
    });
    const draw = fake.asDraw as unknown as InspectorDraw;
    expect(runOperation(draw, 'difference', [a, b])).toEqual(['difference']);
    expect(fake.mocks.features.difference).toHaveBeenCalledWith('a', ['b']);
    expect(fake.mocks.selection.set).toHaveBeenLastCalledWith('feature', ['difference']);
    expect(runOperation(draw, 'split', [line('l'), a])).toEqual(['part1', 'part2']);
    expect(fake.mocks.features.split).toHaveBeenCalledWith('a', 'l');
    expect(runBuffer(draw, [a], 250)).toEqual(['buffer']);
    expect(fake.mocks.features.buffer).toHaveBeenCalledWith(['a'], { distanceMeters: 250 });
    runBuffer(draw, [a], 250, 16);
    expect(fake.mocks.features.buffer).toHaveBeenLastCalledWith(['a'], {
      distanceMeters: 250,
      segments: 16,
    });
    expect(fake.mocks.transact).toHaveBeenCalled();
  });

  it('convert a distance to meters', () => {
    expect(toMeters(2, 'km')).toBe(2000);
    expect(toMeters(1, 'mi')).toBeCloseTo(1609.344);
    expect(toMeters(10, 'ft')).toBeCloseTo(3.048);
  });
});

describe('what the inspector shows', () => {
  it('follows the selection', () => {
    const fake = fakeDocument({
      features: [pt('p'), line('l')],
      groups: [{ id: 'g', layerId: 'l1', name: 'G', featureIds: [], visible: true, locked: false }],
    });
    const draw = fake.asDraw as unknown as InspectorDraw;
    expect(readView(draw).kind).toBe('empty');
    fake.selectItems('feature', ['p']);
    const one = readView(draw);
    expect(one.kind).toBe('feature');
    if (one.kind === 'feature') {
      expect(one.layer?.name).toBe('Layer 1');
      expect(one.editable).toBe(true);
    }
    fake.selectItems('feature', ['p', 'l', 'gone']);
    const several = readView(draw);
    expect(several.kind).toBe('features');
    if (several.kind === 'features') expect(several.features.map((f) => f.id)).toEqual(['p', 'l']);
    fake.selectItems('layer', ['l1']);
    expect(readView(draw)).toMatchObject({ kind: 'layer', onlyLayer: true });
    fake.selectItems('group', ['g']);
    expect(readView(draw)).toMatchObject({ kind: 'group' });
    fake.selectItems('feature', ['gone']);
    expect(readView(draw).kind).toBe('empty');
  });

  it('counts the features of each type', () => {
    expect(kindCounts([pt('a'), pt('b'), line('c')], en)).toEqual([
      { label: 'Point', count: 2 },
      { label: 'Line', count: 1 },
    ]);
  });
});

describe('the options of the inspector', () => {
  it('have defaults, and the units of the interface', () => {
    expect(inspectorSettings()).toEqual({
      tabs: ['style', 'attributes'],
      measurements: true,
      operations: true,
      units: 'metric',
    });
    expect(inspectorSettings({}, 'imperial').units).toBe('imperial');
    expect(inspectorSettings({ units: 'metric' }, 'imperial').units).toBe('metric');
    expect(() => inspectorSettings({ tabs: ['nope' as never] })).toThrow(/tab/);
  });

  it('keep the sections that apply', () => {
    const spec = { id: 's', title: 'S', appliesTo: (fs: readonly Feature[]) => fs.length === 1 };
    const broken = {
      id: 'b',
      title: 'B',
      appliesTo: () => {
        throw new Error('x');
      },
    };
    expect(applicableSections([spec, broken], [pt('a')]).map((s) => s.id)).toEqual(['s']);
    expect(applicableSections([spec], [pt('a'), pt('b')])).toEqual([]);
  });
});

describe('the words of the inspector', () => {
  it('reach kata, the words with values as functions', () => {
    applyKataMessages(resolveMessages('ja'));
    const words = getMessages();
    expect(words.mixed).toBe('混在');
    expect(words.rename).toBe('名前');
    expect(words.cancel).toBe('キャンセル');
    expect(words.removeAttribute({ key: '種別' })).toBe('種別 を削除');
    expect(words.saturationValueText({ s: 10, v: 20 })).toBe('彩度 10%、明度 20%');
    applyKataMessages(resolveMessages('en'));
    expect(getMessages().removeAttribute({ key: 'kind' })).toBe('Remove kind');
    expect(inspectorKataMessages(en).addName).toBe('Add a name');
  });

  it('fill the places of a word', () => {
    expect(fillWord('{count} selected', { count: 3 })).toBe('3 selected');
    expect(fillWord('{a} and {b}', { a: 1 })).toBe('1 and {b}');
  });
});
