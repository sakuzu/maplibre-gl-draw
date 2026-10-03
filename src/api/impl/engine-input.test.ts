// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for what the API shares with the input of the user: the position image.requested
 * carries when a click leads to the image mode, and selection.ungroup against the ungroup
 * shortcut
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMapStub, createSyntheticInput } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import type { DrawEvents } from '../events.js';
import type { Feature, Group } from '../model.js';
import { createDrawOnEngine } from './create-draw.js';
import type { Engine } from './engine.js';
import { createEngine } from './engine.js';

let engine: Engine;
let draw: Draw;

beforeEach(() => {
  vi.useFakeTimers();
  engine = createEngine(createMapStub().map, {}, { deferDefaultMode: true });
  draw = createDrawOnEngine(engine);
  engine.enterDefaultMode();
});

afterEach(() => {
  draw.destroy();
  vi.useRealTimers();
});

const point = (lng: number, lat: number, id?: string) =>
  draw.features.create({
    type: 'Point',
    geometry: { type: 'Point', coordinates: [lng, lat] },
    ...(id !== undefined && { id }),
  });

describe('image.requested', () => {
  it('carries the clicked position when a click led to the image mode', () => {
    const requests: DrawEvents['image.requested'][] = [];
    draw.on('image.requested', (request) => requests.push(request));
    const stop = draw.on('map.clicked', () => {
      draw.setMode('draw_image');
    });
    createSyntheticInput(engine).click([0.5, -0.25]);
    stop();
    expect(requests).toHaveLength(1);
    expect(requests[0].lngLat).toEqual([0.5, -0.25]);
    expect(draw.getMode()).toBe('select');
  });

  it('carries the center of the map when the API entered the mode', () => {
    const requests: DrawEvents['image.requested'][] = [];
    draw.on('image.requested', (request) => requests.push(request));
    draw.setMode('draw_image');
    expect(requests.map((request) => request.lngLat)).toEqual([[0, 0]]);
  });
});

describe('selection.ungroup', () => {
  /** The layer of the document, its items, and the members of every group */
  const snapshot = () => ({
    items: draw.layers.list().map((layer) => [...layer.items]),
    groups: draw.groups.list().map((group) => [group.id, [...group.featureIds]]),
    grouped: draw.features.list().map((feature) => [feature.id, feature.groupId]),
  });

  /** Two groups of two features each, the second one with a third feature */
  const build = (): { groups: Group[]; features: Feature[] } => {
    const features = [0, 1, 2, 3, 4].map((i) => point(i / 10, 0, `f${i}`));
    const ids = features.map((feature) => (feature as Feature).id);
    const first = draw.groups.create({ featureIds: [ids[0], ids[1]], id: 'g1' }) as Group;
    const second = draw.groups.create({ featureIds: [ids[2], ids[3], ids[4]], id: 'g2' }) as Group;
    return { groups: [first, second], features: features as Feature[] };
  };

  it('dissolves the selected groups as the shortcut does', () => {
    build();
    draw.selection.set('group', ['g1', 'g2']);
    expect(draw.selection.ungroup()).toBe(true);
    const byApi = snapshot();

    draw.destroy();
    engine = createEngine(createMapStub().map, {}, { deferDefaultMode: true });
    draw = createDrawOnEngine(engine);
    engine.enterDefaultMode();
    build();
    draw.selection.set('group', ['g1', 'g2']);
    createSyntheticInput(engine).key('g', { modifiers: { shift: true, ctrl: true } });
    expect(snapshot()).toEqual(byApi);
    expect(byApi.groups).toEqual([]);
  });

  it('takes the selected features out of their group as the shortcut does', () => {
    const { features } = build();
    draw.selection.set('feature', [features[2].id, features[0].id]);
    expect(draw.selection.ungroup()).toBe(true);
    const byApi = snapshot();

    draw.destroy();
    engine = createEngine(createMapStub().map, {}, { deferDefaultMode: true });
    draw = createDrawOnEngine(engine);
    engine.enterDefaultMode();
    const again = build();
    draw.selection.set('feature', [again.features[2].id, again.features[0].id]);
    createSyntheticInput(engine).key('g', { modifiers: { shift: true, ctrl: true } });
    expect(snapshot()).toEqual(byApi);
    // The groups stay with the members that were not selected
    expect(byApi.groups).toEqual([
      ['g1', [features[1].id]],
      ['g2', [features[3].id, features[4].id]],
    ]);
  });

  it('returns false when nothing selected is a group or in one, and while read-only', () => {
    const { features } = build();
    const loose = point(1, 1) as Feature;
    draw.selection.set('feature', [loose.id]);
    expect(draw.selection.ungroup()).toBe(false);
    draw.selection.set('feature', [features[0].id]);
    draw.setReadOnly(true);
    expect(draw.selection.ungroup()).toBe(false);
    expect(draw.features.get(features[0].id)?.groupId).toBe('g1');
  });
});

describe('the snap of a mode is taken back with the mode', () => {
  /** The results snap.changed carried, as the kind of their target (null without one) */
  const watchSnap = (): Array<string | null> => {
    const kinds: Array<string | null> = [];
    draw.on('snap.changed', ({ result }) => kinds.push(result?.target?.kind ?? null));
    return kinds;
  };

  beforeEach(() => {
    point(0, 0, 'p');
  });

  it('is cleared when the mode is left', () => {
    const kinds = watchSnap();
    draw.setMode('draw_line');
    createSyntheticInput(engine).move([0, 0]);
    expect(kinds).toEqual(['vertex']);

    draw.setMode('select');

    expect(kinds).toEqual(['vertex', null]);
    expect(engine.context.snapService.getResult()).toBeNull();
  });

  it('is cleared when the drawing is cancelled from outside', () => {
    const kinds = watchSnap();
    draw.setMode('draw_line');
    const input = createSyntheticInput(engine);
    input.click([0.5, 0.5]);
    input.move([0, 0]);
    expect(kinds).toEqual(['vertex']);

    expect(draw.drawing.cancel()).toBe(true);

    expect(kinds).toEqual(['vertex', null]);
    expect(draw.getMode()).toBe('draw_line');
  });

  it('is cleared when an Escape the mode does not take interrupts it', () => {
    const onCancel = vi.fn();
    draw.extensions.modes.add('probe', () => ({ onCancel }));
    const kinds = watchSnap();
    draw.setMode('probe');
    const input = createSyntheticInput(engine);
    input.move([0, 0]);
    expect(kinds).toEqual(['vertex']);

    input.key('Escape');

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(kinds).toEqual(['vertex', null]);
    expect(draw.getMode()).toBe('probe');
  });
});
