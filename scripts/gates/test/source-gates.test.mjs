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
        "const KINDS: readonly string[] = ['a', 'b'];\nexport function draw() {\n  const cache = new Map();\n  return [KINDS, cache];\n}\n",
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

  it('fails on a top-level array, also one written as const, but not on an object or a string', () => {
    const root = base();
    write(root, {
      'src/modes/order.ts':
        "const order: string[] = [];\nconst NAMES = ['a', 'b'] as const;\nconst LOOK = { width: 1 };\nconst NAME = 'a';\nexport { order, NAMES, LOOK, NAME };\n",
    });
    const e = checkState({ root }).errors.join('\n');
    expect(e).toContain('src/modes/order.ts:1: module state array order');
    expect(e).toContain('src/modes/order.ts:2: module state array NAMES');
    expect(e).not.toContain('LOOK');
    expect(e).not.toMatch(/ NAME$/m);
  });

  it('passes on tables of constants whose type annotation is read-only', () => {
    const root = base();
    write(root, {
      'src/shared/tables.ts': [
        "const KINDS: ReadonlySet<string> = new Set(['a', 'b']);",
        "const SIZES: ReadonlyMap<string, number> = new Map([['a', 1]]);",
        "const ORDER: ReadonlyArray<string> = ['a', 'b'];",
        "const EDGES: readonly string[] = ['top', 'left'];",
        'export { KINDS, SIZES, ORDER, EDGES };',
        '',
      ].join('\n'),
    });
    expect(checkState({ root }).errors).toEqual([]);
  });

  it('still fails on a read-only annotation over a let, and on a mutable annotation over a const', () => {
    const root = base();
    write(root, {
      'src/shared/tables.ts':
        "let KINDS: ReadonlySet<string> = new Set(['a']);\nconst SIZES: Map<string, number> = new Map();\nconst SEEN = new Set<string>() as ReadonlySet<string>;\nexport { KINDS, SIZES, SEEN };\n",
    });
    const e = checkState({ root }).errors.join('\n');
    expect(e).toContain('module state let KINDS');
    expect(e).toContain('module state new Map SIZES');
    expect(e).toContain('module state new Set SEEN');
  });

  it('fails on an allowed row that is no longer there', () => {
    const root = base();
    write(root, { 'src/shared/utils/id.ts': 'export const next = () => 1;\n' });
    expect(checkState({ root }).errors.join('\n')).toContain('no longer module state');
  });
});

describe('the gate of the uses of the Store', () => {
  /** The Store, the layer over it and the parts of a small library */
  const STORE = `export interface StoreView {
  getFeature(id: string): string | undefined;
  subscribe(listener: () => void): () => void;
}
export interface Store extends StoreView {
  updateFeature(id: string, name: string): boolean;
  transact<T>(fn: () => T): T;
}
`;
  const ACCESS = `export interface DocumentAccess {
  getFeature(id: string): string | undefined;
  updateFeature(id: string, name: string): boolean;
  subscribe(listener: () => void): () => void;
  transact<T>(fn: () => T): T;
}
`;
  const base = () =>
    tree({
      'scripts/gates/store-write-files.json': {
        types: { 'src/store/store.ts': ['Store', 'StoreView'] },
        files: ['src/api/impl/document-access.ts'],
        folders: ['src/store/', 'src/store/memory/'],
      },
      'src/store/store.ts': STORE,
      'src/store/document-access.ts': ACCESS,
      'src/store/memory.ts': `import type { Store } from './store.js';
export const self = (store: Store) => store.updateFeature('a', 'b');
`,
      'src/store/memory/bus.ts': `import type { Store } from '../store.js';
export const listen = (store: Store) => store.subscribe(() => {});
`,
      'src/api/impl/document-access.ts': `import type { DocumentAccess } from '../../store/document-access.js';
import type { Store } from '../../store/store.js';
export function createDocumentAccess(store: Store): DocumentAccess {
  return {
    getFeature: (id) => store.getFeature(id),
    updateFeature: (id, name) => store.updateFeature(id, name),
    subscribe: (listener) => store.subscribe(listener),
    transact: (fn) => store.transact(fn),
  };
}
`,
      // A part that goes through the layer, under the name the Store had
      'src/modes/select/drag.ts': `import type { DocumentAccess } from '../../store/document-access.js';
export class Drag {
  constructor(private readonly store: DocumentAccess) {}
  run(deps: { store: DocumentAccess }): void {
    this.store.transact(() => deps.store.updateFeature('a', this.store.getFeature('a') ?? ''));
    deps.store.subscribe(() => {});
  }
}
`,
      // The store of something else, whatever its name
      'src/view/tiles.ts': `interface Store { transact(): void }
export const t = (o: { tileStore: Store; store: Store }) => { o.tileStore.transact(); o.store.transact(); };
`,
    });

  /** A part that holds the Store itself (a type of the Store), passes it on and calls nothing */
  const passes = `import type { Store } from '../../store/store.js';
export const hold = (store: Store): { store: Store } => ({ store });
`;

  it('passes on the layer, the Store itself, the parts that go through the layer and the stores of other things', () => {
    const root = base();
    write(root, { 'src/modes/select/hold.ts': passes });
    expect(checkWrites({ root }).errors).toEqual([]);
  });

  it('fails when a part reads a member of a value of a type of the Store', () => {
    const root = base();
    write(root, {
      'src/modes/select/read.ts': `import type { Store } from '../../store/store.js';
export const read = (ctx: { store: Store }) => ctx.store.getFeature('a');
`,
    });
    expect(checkWrites({ root }).errors.join('\n')).toContain(
      'src/modes/select/read.ts:2: uses getFeature of a value of a type of the Store (src/store/store.ts:Store)',
    );
  });

  it('fails when a part writes through a value of a type of the Store, whatever it is named', () => {
    const root = base();
    write(root, {
      'src/operations/write.ts': `import type { Store } from '../store/store.js';
export function write(target: Store): boolean {
  const other = target;
  return other.transact(() => other.updateFeature('a', 'b'));
}
`,
    });
    const errors = checkWrites({ root }).errors.join('\n');
    expect(errors).toContain('src/operations/write.ts:4: uses transact of a value');
    expect(errors).toContain('src/operations/write.ts:4: uses updateFeature of a value');
  });

  it('fails when a part subscribes to a value of a type of the Store', () => {
    const root = base();
    write(root, {
      'src/view/coordinator.ts': `import type { StoreView } from '../store/store.js';
export const watch = (view: StoreView) => view.subscribe(() => {});
`,
    });
    expect(checkWrites({ root }).errors.join('\n')).toContain(
      'src/view/coordinator.ts:2: uses subscribe of a value of a type of the Store (src/store/store.ts:StoreView)',
    );
  });

  it('fails on a type that extends a type of the Store, picks its members or takes it apart', () => {
    const root = base();
    write(root, {
      'src/snapping/own.ts': `import type { Store } from '../store/store.js';
interface Own extends Store { extra(): void }
export const a = (s: Own) => s.getFeature('a');
export const b = (s: Pick<Store, 'getFeature'>) => s.getFeature('a');
export const c = (s: Store) => { const { getFeature } = s; return getFeature; };
`,
    });
    const errors = checkWrites({ root }).errors.join('\n');
    expect(errors).toContain('src/snapping/own.ts:3: uses getFeature');
    expect(errors).toContain('src/snapping/own.ts:4: uses getFeature');
    expect(errors).toContain('src/snapping/own.ts:5: uses getFeature');
  });

  it('fails in a folder under the Store that is not listed', () => {
    const root = base();
    write(root, {
      'src/store/spatial/index.ts': `import type { Store } from '../store.js';
export const read = (store: Store) => store.getFeature('a');
`,
    });
    expect(checkWrites({ root }).errors.join('\n')).toContain(
      'src/store/spatial/index.ts:2: uses getFeature',
    );
  });

  it('fails on a listed file that no longer uses the Store', () => {
    const root = base();
    write(root, { 'src/api/impl/document-access.ts': 'export const access = () => 1;\n' });
    expect(checkWrites({ root }).errors.join('\n')).toContain('no longer uses the Store');
  });
});
