// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the shape check of the extensions: every kind accepts the contract shape and refuses
 * a wrong one with DrawError('invalid-input'), both alone and through draw.extensions
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import { createDraw } from '../draw.js';
import { DrawError } from '../errors.js';
import type { ExtensionKind } from './validate-extension.js';
import { validateExtension } from './validate-extension.js';

const noop = (): void => {};
const renderer = { onAdd: noop, draw: noop, onRemove: noop };

/** A value of the right shape for each kind */
const VALID: Record<ExtensionKind, unknown> = {
  plugin: { name: 'p', onAdd: noop, input: { onClick: noop }, interaction: { isBusy: noop } },
  mode: () => ({}),
  'feature type': { type: 't', geometry: 'Point', renderer, hitPaddingPx: 4 },
  overlay: { name: 'o', onAdd: noop, draw: noop, onRemove: noop, order: -1 },
  'snap provider': { name: 's', candidates: () => [] },
  'handle provider': { name: 'h', handles: () => [], onDrag: () => null },
  'companion provider': { name: 'c', has: () => false, draw: noop, hitTest: () => null },
};

/** Values of a wrong shape for each kind, with the member the error names */
const INVALID: Array<[ExtensionKind, unknown, string | undefined]> = [
  ['plugin', null, undefined],
  ['plugin', 'plugin', undefined],
  ['plugin', { name: 'p' }, 'onAdd'],
  ['plugin', { name: 'p', onAdd: noop, onRemove: 1 }, 'onRemove'],
  ['plugin', { name: 'p', onAdd: noop, input: 1 }, 'input'],
  ['plugin', { name: 'p', onAdd: noop, input: { onClick: 'x' } }, 'input.onClick'],
  ['plugin', { name: 'p', onAdd: noop, interaction: { finish: {} } }, 'interaction.finish'],
  ['mode', {}, undefined],
  ['feature type', { type: 't', renderer }, 'geometry'],
  ['feature type', { type: 't', geometry: 'Circle', renderer }, 'geometry'],
  ['feature type', { type: 't', geometry: 'Point' }, 'renderer'],
  ['feature type', { type: 't', geometry: 'Point', renderer: { draw: noop } }, 'renderer.onAdd'],
  ['feature type', { ...(VALID['feature type'] as object), hitPaddingPx: -1 }, 'hitPaddingPx'],
  ['feature type', { ...(VALID['feature type'] as object), handles: [] }, 'handles'],
  ['overlay', { name: 'o', draw: noop }, 'onAdd'],
  ['overlay', { ...(VALID.overlay as object), order: Number.NaN }, 'order'],
  ['overlay', { ...(VALID.overlay as object), drawVertices: true }, 'drawVertices'],
  ['snap provider', { name: 's' }, 'candidates'],
  ['handle provider', { name: 'h', handles: noop }, 'onDrag'],
  [
    'handle provider',
    { ...(VALID['handle provider'] as object), globalHandles: 1 },
    'globalHandles',
  ],
  ['companion provider', { name: 'c', has: noop, hitTest: noop }, 'draw'],
  ['companion provider', { ...(VALID['companion provider'] as object), onClick: 1 }, 'onClick'],
];

describe('validateExtension', () => {
  it('accepts the shape of the contract for every kind', () => {
    for (const [kind, value] of Object.entries(VALID)) {
      expect(() => validateExtension(kind as ExtensionKind, value)).not.toThrow();
    }
  });

  it.each(INVALID)('refuses a %s of the wrong shape', (kind, value, member) => {
    let thrown: unknown;
    try {
      validateExtension(kind, value);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DrawError);
    expect((thrown as DrawError).code).toBe('invalid-input');
    expect((thrown as DrawError).details).toEqual(
      member === undefined ? { kind } : { kind, member },
    );
  });
});

describe('draw.extensions refuses a wrong shape', () => {
  let draw: Draw;

  beforeEach(() => {
    draw = createDraw(createMapStub().map);
  });

  afterEach(() => draw.destroy());

  it('with invalid-input from every collection, adding nothing', () => {
    const { extensions } = draw;
    const attempts: Array<() => unknown> = [
      () => extensions.plugins.add({ name: 'p' } as never),
      () => extensions.modes.add('m', {} as never),
      () => extensions.featureTypes.add({ type: 't', geometry: 'Point' } as never),
      () => extensions.overlays.add({ name: 'o', draw: noop } as never),
      () => extensions.snapProviders.add({ name: 's' } as never),
      () => extensions.handleProviders.add({ name: 'h', handles: noop } as never),
      () => extensions.companionProviders.add({ name: 'c', has: noop } as never),
    ];
    for (const attempt of attempts) {
      expect(attempt).toThrow(
        expect.objectContaining({ name: 'DrawError', code: 'invalid-input' }),
      );
    }
    expect(extensions.plugins.has('p')).toBe(false);
    expect(extensions.modes.has('m')).toBe(false);
    expect(extensions.featureTypes.has('t')).toBe(false);
    expect(extensions.overlays.has('o')).toBe(false);
    expect(extensions.snapProviders.has('s')).toBe(false);
    expect(extensions.handleProviders.has('h')).toBe(false);
    expect(extensions.companionProviders.has('c')).toBe(false);
  });
});
