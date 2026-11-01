// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The messages of an extension, in the one table of the library
 *
 * - An extension declares its keys in `Messages` by declaration merging and gives their English
 *   defaults to `defineMessages`
 * - The `messages` option of `createDraw` and of `options.update` then takes those keys too, and
 *   refuses, as before, a key nothing defines and a value of the wrong type
 * - The table of an instance (`ctx.messages` of an extension) has the defaults, the option over
 *   them, and a key defined after the instance was made
 * - A key of the library cannot be defined, and a key defined again takes the same value only
 */

import { afterEach, describe, expect, it } from 'vitest';
import { defineMessages } from '../../messages.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import { createDraw } from '../draw.js';
import type { PluginContext } from '../extension/context.js';

declare module '../../messages.js' {
  interface Messages {
    testPinLabel?: string;
    testPinCount?: (count: string) => string;
    testLateLabel?: string;
    testTwiceLabel?: string;
  }
}

let draw: Draw | undefined;

afterEach(() => {
  draw?.destroy();
  draw = undefined;
});

/** The context of a plugin of the instance */
function contextOf(instance: Draw): PluginContext {
  let captured: PluginContext | undefined;
  instance.extensions.plugins.add({
    name: 'probe',
    onAdd(ctx) {
      captured = ctx;
    },
  });
  if (!captured) throw new Error('not added');
  return captured;
}

const refused = (code: string) => expect.objectContaining({ code });

describe('the messages of an extension', () => {
  it('are taken by the messages option and read from the table of the instance', () => {
    defineMessages({ testPinLabel: 'Pin', testPinCount: (count) => `${count} pins` });
    draw = createDraw(createMapStub().map, { messages: { testPinLabel: 'Épingle' } });
    const ctx = contextOf(draw);
    expect(ctx.messages.testPinLabel).toBe('Épingle');
    expect(ctx.messages.testPinCount?.('3')).toBe('3 pins');
    expect(ctx.messages.legendOther).toBe('Other');
    draw.options.update({ messages: { testPinCount: (count) => `${count} épingles` } });
    expect(ctx.messages.testPinCount?.('3')).toBe('3 épingles');
  });

  it('refuse a key nothing defines and a value of the wrong type, as before', () => {
    expect(() =>
      createDraw(createMapStub().map, { messages: { testUnknown: 'x' } as never }),
    ).toThrow(refused('invalid-input'));
    defineMessages({ testPinLabel: 'Pin' });
    expect(() =>
      createDraw(createMapStub().map, { messages: { testPinLabel: () => 'x' } as never }),
    ).toThrow(refused('invalid-input'));
  });

  it('are read by an instance made before they are defined', () => {
    draw = createDraw(createMapStub().map);
    const ctx = contextOf(draw);
    expect(ctx.messages.testLateLabel).toBeUndefined();
    defineMessages({ testLateLabel: 'Late' });
    expect(ctx.messages.testLateLabel).toBe('Late');
  });

  it('cannot take a key of the library, nor a key defined with another value', () => {
    expect(() => defineMessages({ legendOther: 'Others' })).toThrow(refused('invalid-input'));
    expect(() => defineMessages({ testTwiceLabel: 1 } as never)).toThrow(refused('invalid-input'));
    defineMessages({ testTwiceLabel: 'Twice' });
    expect(() => defineMessages({ testTwiceLabel: 'Twice' })).not.toThrow();
    expect(() => defineMessages({ testTwiceLabel: 'Again' })).toThrow(refused('already-exists'));
  });
});
