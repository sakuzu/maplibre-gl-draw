// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A key the engine uses has its default action prevented, and a key it does not use is left
 * alone, so that a page listening to the same keys outside the canvas can tell the two apart
 * with `defaultPrevented` and not handle a key twice
 *
 * The keys are fired on the canvas of an instance as the browser fires them, and go through the
 * normalizer and the input router to the mode, the plugins and the modes of the extensions.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Draw } from '../api/draw.js';
import type { Plugin } from '../api/extension/plugin.js';
import { createDrawOnEngine } from '../api/impl/create-draw.js';
import { createEngine, type Engine } from '../api/impl/engine.js';
import { coordinatesOf } from '../shared/utils/coordinates.js';
import { MemoryStore } from '../store/memory.js';
import type { Feature } from '../store/types.js';
import { createMapStub, createSyntheticInput } from '../test-utils.js';

interface Opened {
  engine: Engine;
  draw: Draw;
  /** Fires a keydown on the canvas; true when its default action was prevented */
  press(key: string, modifiers?: { meta?: boolean; shift?: boolean }): boolean;
}

const opened: Draw[] = [];

afterEach(() => {
  for (const draw of opened.splice(0)) draw.destroy();
  vi.useRealTimers();
});

/** A line `a` of three vertices in a layer `l` */
function line(): Feature {
  return {
    id: 'a',
    type: 'LineString',
    geometry: {
      type: 'LineString',
      coordinates: [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
    },
    layerId: 'l',
    groupId: undefined,
    properties: {},
    style: {},
    visible: true,
    locked: false,
  } as Feature;
}

/** An instance over a Store with the line `a`, its input started */
function open(): Opened {
  vi.useFakeTimers();
  const store = new MemoryStore();
  store.createLayer({
    id: 'l',
    name: 'l',
    visible: true,
    locked: false,
    opacity: 1,
    items: [],
    styleRule: undefined,
    metadata: undefined,
  } as never);
  store.createFeature(line());
  const stub = createMapStub();
  const engine = createEngine(
    stub.map,
    { store, initDefaultLayer: false },
    {
      deferDefaultMode: true,
    },
  );
  const draw = createDrawOnEngine(engine, { store, initDefaultLayer: false });
  engine.enterDefaultMode();
  opened.push(draw);
  const press = (key: string, modifiers: { meta?: boolean; shift?: boolean } = {}): boolean => {
    const event = {
      type: 'keydown',
      key,
      code: key,
      repeat: false,
      isComposing: false,
      shiftKey: modifiers.shift ?? false,
      ctrlKey: false,
      altKey: false,
      metaKey: modifiers.meta ?? false,
      target: stub.canvas,
      defaultPrevented: false,
      preventDefault(): void {
        event.defaultPrevented = true;
      },
      stopPropagation(): void {},
    };
    stub.fireCanvas('keydown', event);
    return event.defaultPrevented;
  };
  return { engine, draw, press };
}

function coordinatesOfA({ engine }: Opened): unknown {
  const feature = engine.context.store.getFeature('a');
  return feature ? coordinatesOf(feature) : undefined;
}

describe('the select mode', () => {
  it('deletes the one vertex selected with Delete, keeps the line and prevents the default', () => {
    const view = open();
    view.draw.selection.set('feature', ['a']);
    expect(view.draw.vertexSelection.set('a', [{ ring: 0, index: 1 }])).toBe(true);

    expect(view.press('Delete')).toBe(true);
    expect(coordinatesOfA(view)).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(view.engine.context.store.getFeature('a')).toBeDefined();
  });

  it('deletes the feature selected with Delete and Backspace, and prevents the default', () => {
    const view = open();
    view.draw.selection.set('feature', ['a']);
    expect(view.press('Backspace')).toBe(true);
    expect(view.engine.context.store.getFeature('a')).toBeUndefined();
  });

  it('leaves Delete and Backspace alone when nothing is selected', () => {
    const view = open();
    expect(view.press('Delete')).toBe(false);
    expect(view.press('Backspace')).toBe(false);
    expect(view.engine.context.store.getFeature('a')).toBeDefined();
  });

  it('leaves Delete alone when everything selected is locked', () => {
    const view = open();
    view.engine.context.store.updateFeature('a', { locked: true });
    view.draw.selection.set('feature', ['a']);
    expect(view.press('Delete')).toBe(false);
    expect(view.engine.context.store.getFeature('a')).toBeDefined();
  });

  it('prevents Escape only when it lets go of a selection', () => {
    const view = open();
    view.draw.selection.set('feature', ['a']);
    view.draw.vertexSelection.set('a', [{ ring: 0, index: 1 }]);
    expect(view.press('Escape')).toBe(true);
    expect(view.draw.vertexSelection.get()).toBeNull();
    expect(view.press('Escape')).toBe(true);
    expect(view.draw.selection.value.ids).toEqual([]);
    expect(view.press('Escape')).toBe(false);
  });

  it('prevents an arrow key only when it moves a selection', () => {
    const view = open();
    expect(view.press('ArrowRight')).toBe(false);
    view.draw.selection.set('feature', ['a']);
    expect(view.press('ArrowRight')).toBe(true);
  });

  it('prevents Cmd+G only when it groups the selection', () => {
    const view = open();
    view.engine.context.store.createFeature({ ...line(), id: 'b' });
    expect(view.press('g', { meta: true })).toBe(false);
    view.draw.selection.set('feature', ['a']);
    expect(view.press('g', { meta: true })).toBe(false);
    view.draw.selection.set('feature', ['a', 'b']);
    expect(view.press('g', { meta: true })).toBe(true);
    expect(view.engine.context.store.getFeature('a')?.groupId).toBeDefined();
  });

  it('leaves a key it has no use for alone', () => {
    const view = open();
    view.draw.selection.set('feature', ['a']);
    expect(view.press('a')).toBe(false);
    expect(view.press('Enter')).toBe(false);
  });
});

describe('the drawing modes', () => {
  it('prevents Backspace only when it removes the last vertex', () => {
    const view = open();
    view.draw.setMode('draw_line');
    expect(view.press('Backspace')).toBe(false);
    const input = createSyntheticInput(view.engine);
    input.click([2, 2]);
    input.click([3, 2]);
    expect(view.press('Backspace')).toBe(true);
    expect(view.press('Backspace')).toBe(true);
    expect(view.press('Backspace')).toBe(false);
    expect(view.draw.getMode()).toBe('draw_line');
  });

  it('prevents Enter only when it finishes the shape', () => {
    const view = open();
    view.draw.setMode('draw_line');
    expect(view.press('Enter')).toBe(false);
    const input = createSyntheticInput(view.engine);
    input.click([2, 2]);
    expect(view.press('Enter')).toBe(false);
    input.click([3, 2]);
    expect(view.press('Enter')).toBe(true);
    expect(view.engine.context.store.listFeatures()).toHaveLength(2);
    expect(view.draw.getMode()).toBe('select');
  });

  it('prevents Escape, which drops the shape or leaves the mode', () => {
    const view = open();
    view.draw.setMode('draw_polygon');
    createSyntheticInput(view.engine).click([2, 2]);
    expect(view.press('Escape')).toBe(true);
    expect(view.draw.getMode()).toBe('draw_polygon');
    expect(view.press('Escape')).toBe(true);
    expect(view.draw.getMode()).toBe('select');
  });

  it('leaves a key the mode has no use for alone', () => {
    const view = open();
    view.draw.setMode('draw_circle');
    expect(view.press('Enter')).toBe(false);
    expect(view.press('Escape')).toBe(true);
  });
});

describe('the extensions', () => {
  const plugin = (name: string, extra: Partial<Plugin> = {}): Plugin => ({
    name,
    onAdd() {},
    ...extra,
  });

  it('prevents a key a plugin consumes, and leaves one it does not consume alone', () => {
    const view = open();
    view.engine.extensions.collections.plugins.add(
      plugin('p', { input: { onKeyDown: (event) => event.key === 'x' } }),
    );
    expect(view.press('x')).toBe(true);
    expect(view.press('y')).toBe(false);
  });

  it('prevents a key a mode of the contract consumes, and an Escape that interrupts it', () => {
    const view = open();
    view.engine.extensions.collections.modes.add('probe', () => ({
      onKeyDown: (event) => event.key === 'x',
      onCancel: () => {},
    }));
    view.engine.modeManager.setMode('probe');
    expect(view.press('x')).toBe(true);
    expect(view.press('y')).toBe(false);
    expect(view.press('Escape')).toBe(true);
  });
});
