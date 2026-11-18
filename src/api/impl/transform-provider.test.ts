// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the computations of moves, rotations and scalings set on `draw.extensions`
 *
 * - None is set at first
 * - They are kept in the order they were set, and the one used is the last one still there
 * - The function returned takes out that one only, wherever it stands; the built-in computation
 *   is used again when none is left
 * - One set through the context of a plugin is taken out when the plugin is removed, and only it
 * - A value of the wrong shape is refused with `invalidInput`, and nothing is set
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TransformProvider } from '../../shared/types/model.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import { createDraw } from '../draw.js';
import { DrawError } from '../errors.js';
import type { PluginContext } from '../extension/context.js';
import { createTransformProviderStack } from './extensions.js';

function provider(name: string): TransformProvider {
  return { name, accepts: () => true, apply() {} };
}

/** The error a call throws */
function errorOf(fn: () => unknown): DrawError {
  try {
    fn();
  } catch (error) {
    return error as DrawError;
  }
  throw new Error('it did not throw');
}

let draw: Draw;

beforeEach(() => {
  draw = createDraw(createMapStub().map);
});

afterEach(() => {
  draw.destroy();
});

describe('the computation of moves, rotations and scalings', () => {
  it('is not set at first', () => {
    expect(draw.extensions.getTransformProvider()).toBeUndefined();
  });

  it('uses the last one set', () => {
    const first = provider('first');
    const second = provider('second');
    draw.extensions.setTransformProvider(first);
    expect(draw.extensions.getTransformProvider()).toBe(first);
    draw.extensions.setTransformProvider(second);
    expect(draw.extensions.getTransformProvider()).toBe(second);
  });

  it('keeps the one used when one set earlier is taken out', () => {
    const first = provider('first');
    const second = provider('second');
    const removeFirst = draw.extensions.setTransformProvider(first);
    draw.extensions.setTransformProvider(second);
    removeFirst();
    expect(draw.extensions.getTransformProvider()).toBe(second);
  });

  it('goes back to the one set earlier when the last one is taken out', () => {
    const first = provider('first');
    const second = provider('second');
    draw.extensions.setTransformProvider(first);
    const removeSecond = draw.extensions.setTransformProvider(second);
    removeSecond();
    expect(draw.extensions.getTransformProvider()).toBe(first);
  });

  it('goes back to the built-in computation when every one is taken out', () => {
    const removes = ['a', 'b', 'c'].map((name) =>
      draw.extensions.setTransformProvider(provider(name)),
    );
    removes[1]?.();
    removes[2]?.();
    removes[0]?.();
    expect(draw.extensions.getTransformProvider()).toBeUndefined();
  });

  it('takes out one entry per call, even of the same computation set twice, and only once', () => {
    const shared = provider('shared');
    const other = provider('other');
    const removeOnce = draw.extensions.setTransformProvider(shared);
    draw.extensions.setTransformProvider(other);
    const removeTwice = draw.extensions.setTransformProvider(shared);
    removeTwice();
    expect(draw.extensions.getTransformProvider()).toBe(other);
    // Calling it again takes out nothing more
    removeTwice();
    expect(draw.extensions.getTransformProvider()).toBe(other);
    removeOnce();
    expect(draw.extensions.getTransformProvider()).toBe(other);
  });

  it('takes out the ones a plugin set, and only them, when the plugin is removed', () => {
    const before = provider('before');
    const ofPlugin = provider('of the plugin');
    const after = provider('after');
    draw.extensions.setTransformProvider(before);
    draw.extensions.plugins.add({
      name: 'p',
      onAdd(ctx: PluginContext) {
        ctx.extensions.setTransformProvider(ofPlugin);
      },
    });
    expect(draw.extensions.getTransformProvider()).toBe(ofPlugin);
    draw.extensions.setTransformProvider(after);
    draw.extensions.plugins.remove('p');
    expect(draw.extensions.getTransformProvider()).toBe(after);
    draw.extensions.plugins.add({
      name: 'q',
      onAdd(ctx: PluginContext) {
        ctx.extensions.setTransformProvider(ofPlugin);
      },
    });
    draw.extensions.plugins.remove('q');
    expect(draw.extensions.getTransformProvider()).toBe(after);
  });

  it('goes back to the one set before a plugin when the plugin is removed', () => {
    const before = provider('before');
    draw.extensions.setTransformProvider(before);
    draw.extensions.plugins.add({
      name: 'p',
      onAdd(ctx: PluginContext) {
        ctx.extensions.setTransformProvider(provider('of the plugin'));
      },
    });
    draw.extensions.plugins.remove('p');
    expect(draw.extensions.getTransformProvider()).toBe(before);
  });

  it('refuses a value of the wrong shape with invalidInput, and sets nothing', () => {
    const noop = (): void => {};
    const wrong: unknown[] = [
      null,
      undefined,
      'provider',
      [],
      () => {},
      {},
      { name: 't', accepts: noop },
      { name: 't', apply: noop },
      { name: 't', accepts: true, apply: noop },
      { name: 't', accepts: noop, apply: {} },
      { accepts: noop, apply: noop },
      { name: '', accepts: noop, apply: noop },
      { name: 1, accepts: noop, apply: noop },
    ];
    for (const value of wrong) {
      const error = errorOf(() => draw.extensions.setTransformProvider(value as TransformProvider));
      expect(error, JSON.stringify(value)).toBeInstanceOf(DrawError);
      expect(error.code).toBe('invalidInput');
      expect(draw.extensions.getTransformProvider()).toBeUndefined();
    }
  });
});

describe('the stack of the computations', () => {
  it('is empty after it is cleared, and a function returned before does nothing then', () => {
    const stack = createTransformProviderStack();
    const first = provider('first');
    const remove = stack.push(first);
    stack.push(provider('second'));
    stack.clear();
    expect(stack.current()).toBeUndefined();
    remove();
    stack.push(first);
    expect(stack.current()).toBe(first);
  });
});
