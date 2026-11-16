// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { check as checkState } from '../module-state.mjs';
import { check as checkWrites } from '../store-writes.mjs';
import { cleanUp, tree, write } from './fixture.mjs';

afterEach(cleanUp);

describe('the gate of the module state', () => {
  const base = () =>
    tree({
      'scripts/gates/module-state-allowed.json': {
        state: [{ file: 'src/shared/utils/id.ts', name: 'pool', kind: 'let' }],
      },
      'src/shared/utils/id.ts': 'let pool = 0;\nexport const next = () => ++pool;\n',
      'src/view/draw.ts':
        "const KINDS = ['a', 'b'] as const;\nexport function draw() {\n  const cache = new Map();\n  return [KINDS, cache];\n}\n",
      'src/view/draw.test.ts': 'const seen = new Set();\nexport { seen };\n',
    });

  it('passes on the allowed state, the state inside a function, and the tests', () => {
    expect(checkState({ root: base() }).errors).toEqual([]);
  });

  it('fails on a cache at the top level of a module', () => {
    const root = base();
    write(root, {
      'src/geometry/memo.ts':
        'const cache = new Map();\nexport const get = (k: string) => cache.get(k);\n',
    });
    expect(checkState({ root }).errors.join('\n')).toContain(
      'src/geometry/memo.ts:1: module state new Map cache',
    );
  });

  it('fails on a top-level let and on a set of instances', () => {
    const root = base();
    write(root, {
      'src/api/impl/memory.ts':
        'let total = 0;\nconst instances = new Set<object>();\nexport { total, instances };\n',
    });
    const e = checkState({ root }).errors.join('\n');
    expect(e).toContain('module state let total');
    expect(e).toContain('module state new Set instances');
  });

  it('fails on an allowed row that is no longer there', () => {
    const root = base();
    write(root, { 'src/shared/utils/id.ts': 'export const next = () => 1;\n' });
    expect(checkState({ root }).errors.join('\n')).toContain('no longer module state');
  });
});

describe('the gate of the writes to the Store', () => {
  const base = () =>
    tree({
      'scripts/gates/store-write-files.json': {
        methods: ['updateFeature', 'createLayer', 'transact'],
        files: ['src/api/impl/features.ts'],
      },
      'src/api/impl/features.ts':
        'export const write = (store: any) => store.transact(() => store.updateFeature("a", {}));\n',
      'src/store/memory.ts': 'export const self = (store: any) => store.updateFeature("a", {});\n',
      'src/view/tiles.ts': 'export const t = (o: any) => o.tileStore.transact();\n',
    });

  it('passes on the listed files, the Store itself and the stores of other things', () => {
    expect(checkWrites({ root: base() }).errors).toEqual([]);
  });

  it('fails when a file that is not listed writes to the Store', () => {
    const root = base();
    write(root, {
      'src/modes/select/drag.ts':
        'export const drag = (ctx: any) => ctx.store.updateFeature("a", {});\n',
    });
    expect(checkWrites({ root }).errors.join('\n')).toContain(
      'src/modes/select/drag.ts:1: writes to the Store (updateFeature)',
    );
  });

  it('fails on a listed file that no longer writes', () => {
    const root = base();
    write(root, { 'src/api/impl/features.ts': 'export const write = () => 1;\n' });
    expect(checkWrites({ root }).errors.join('\n')).toContain('no longer writes to the Store');
  });
});
