// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { check } from '../imports.mjs';
import { cleanUp, realList, tree, write } from './fixture.mjs';

afterEach(cleanUp);

const ROW_LIBRARY = ['@sakuzu', 'kasane'].join('/');
const PAGE_LIBRARY = ['@sakuzu', 'tabane'].join('/');

/** The fixed declarations of the five entries: the main entry has Thing and Mode, geometry has Spot */
const FIXED = {
  'api/core.main.d.ts': "export interface Thing { mode: Mode }\nexport type Mode = 'select';\n",
  'api/core.geometry.d.ts': 'export interface Spot { x: number }\n',
  'api/core.store.d.ts': 'export interface Keeper { keep(): void }\n',
  'api/core.table.d.ts': 'export interface Rows { size: number }\n',
  'api/core.webgl.d.ts': 'export interface Shader { source: string }\n',
};

/** A src/ and a dist/ that follow the layers */
function layered(lists = {}) {
  return tree({
    'scripts/gates/layers.json': realList('layers.json'),
    'scripts/gates/kasane-import-folders.json': { folders: [] },
    'scripts/gates/layers-allowed.json': { imports: [] },
    'scripts/gates/public-types-pending.json': { imports: [] },
    ...FIXED,
    'src/index.ts': "export type { Thing } from './api/thing.js';\n",
    'src/api/thing.ts':
      "import type { Mode } from './state.js';\nexport interface Thing { mode: Mode }\n",
    'src/api/state.ts': "export type Mode = 'select';\n",
    'src/api/impl/thing.ts':
      "import type { Thing } from '../thing.js';\nimport { route } from '../../dispatcher/route.js';\nexport const make = (): Thing => ({ mode: route() });\n",
    'src/dispatcher/route.ts':
      "import { draw } from '../view/draw.js';\nexport type Route = 'select';\nexport const route = () => { draw(); return 'select' as const; };\n",
    'src/modes/pick.ts': "export type Pick = 'one';\nexport const pick = (): Pick => 'one';\n",
    'src/view/draw.ts':
      "import { read } from '../store/read.js';\nexport type Look = 'plain';\nexport const draw = () => read();\n",
    'src/store/read.ts':
      "import type { Point } from '../shared/types.js';\nexport const read = (): Point | null => null;\n",
    'src/shared/types.ts':
      "export interface Point { x: number }\nexport interface Spot { x: number }\nexport const PREFIX = 'p:';\n",
    'dist/view/draw.js':
      "import { read } from '../store/read.js';\nexport const draw = () => read();\n",
    'dist/view/draw.d.ts': 'export declare const draw: () => null;\n',
    'dist/store/read.js': 'export const read = () => null;\n',
    ...lists,
  });
}

const errorsOf = (root) => check({ root }).errors.join('\n');

describe('the gate of the import boundaries', () => {
  it('passes on imports that follow the layers', () => {
    expect(check({ root: layered() }).errors).toEqual([]);
  });

  it('fails on a runtime import from a lower layer to a higher one', () => {
    const root = layered();
    write(root, {
      'src/store/up.ts': "import { draw } from '../view/draw.js';\nexport const up = draw;\n",
    });
    expect(errorsOf(root)).toContain('src/store/up.ts -> src/view/draw.ts');
  });

  it('fails on a type-only import from a lower layer to a higher one that is not a public type', () => {
    const root = layered();
    write(root, {
      'src/view/route.ts':
        "import type { Route } from '../dispatcher/route.js';\nexport type R = Route;\n",
    });
    expect(errorsOf(root)).toContain('src/view/route.ts -> src/dispatcher/route.ts (type only)');
  });

  it('fails on a type written as import() that points the wrong way', () => {
    const root = layered();
    write(root, { 'src/store/look.ts': "export type L = import('../view/draw.js').Look;\n" });
    expect(errorsOf(root)).toContain('src/store/look.ts -> src/view/draw.ts');
  });

  it('fails on a type-only import in a declaration file of the build that points the wrong way', () => {
    const root = layered();
    write(root, {
      'dist/store/look.d.ts': "import { Look } from '../view/draw.js';\nexport type L = Look;\n",
    });
    expect(errorsOf(root)).toContain('dist/store/look.d.ts:1');
  });

  it('lets a type-only import into a file of the public types through, from any layer', () => {
    const root = layered();
    write(root, {
      'src/store/mode.ts': "import type { Mode } from '../api/state.js';\nexport type M = Mode;\n",
      'src/view/mode.ts': "export type M = import('../api/state.js').Mode;\n",
    });
    expect(check({ root }).errors).toEqual([]);
  });

  it('still fails on a runtime import into a file of the public types from a lower layer', () => {
    const root = layered();
    write(root, {
      'src/api/value.ts': 'export const ONE = 1;\n',
      'src/store/one.ts': "import { ONE } from '../api/value.js';\nexport const one = ONE;\n",
    });
    expect(errorsOf(root)).toContain('src/store/one.ts -> src/api/value.ts');
  });

  it('fails on a type-only import of the implementation of the resources from a lower layer', () => {
    const root = layered();
    write(root, {
      'src/api/impl/kind.ts': "export type Kind = 'k';\n",
      'src/view/kind.ts':
        "import type { Kind } from '../api/impl/kind.js';\nexport type K = Kind;\n",
    });
    expect(errorsOf(root)).toContain('src/view/kind.ts -> src/api/impl/kind.ts (type only)');
  });

  it('lets a type-only import between two areas of the instance through', () => {
    const root = layered();
    write(root, {
      'src/modes/route.ts':
        "import type { Route } from '../dispatcher/route.js';\nexport type R = Route;\n",
      'src/operations/pick.ts':
        "import type { Pick } from '../modes/pick.js';\nexport type P = Pick;\n",
    });
    expect(check({ root }).errors).toEqual([]);
  });

  it('still fails on a runtime import between two areas of the instance that points the wrong way', () => {
    const root = layered();
    write(root, {
      'src/modes/route.ts':
        "import { route } from '../dispatcher/route.js';\nexport const r = route;\n",
    });
    expect(errorsOf(root)).toContain('src/modes/route.ts -> src/dispatcher/route.ts');
  });

  it('lets extension/ import the types of an area that uses it (rule 9), but not at runtime', () => {
    const root = layered();
    write(root, {
      'src/extension/look.ts':
        "import type { Look } from '../view/draw.js';\nexport type L = Look;\n",
    });
    expect(check({ root }).errors).toEqual([]);
    write(root, {
      'src/extension/draw.ts': "import { draw } from '../view/draw.js';\nexport const d = draw;\n",
    });
    expect(errorsOf(root)).toContain('src/extension/draw.ts -> src/view/draw.ts');
  });

  it('fails on a type of the implementation of the resources imported by extension/', () => {
    const root = layered();
    write(root, {
      'src/api/impl/kind.ts': "export type Kind = 'k';\n",
      'src/extension/kind.ts':
        "import type { Kind } from '../api/impl/kind.js';\nexport type K = Kind;\n",
    });
    expect(errorsOf(root)).toContain('src/extension/kind.ts -> src/api/impl/kind.ts (type only)');
  });

  it('fails on a type of the webgl entry, from any area', () => {
    const root = layered();
    write(root, {
      'src/webgl/index.ts': "export type Shader = 's';\n",
      'src/extension/shader.ts':
        "import type { Shader } from '../webgl/index.js';\nexport type S = Shader;\n",
    });
    expect(errorsOf(root)).toContain('nothing imports the webgl entry');
  });

  it('lets a type-only import of the published version through when the list has it', () => {
    const edge = 'src/view/route.ts -> src/dispatcher/route.ts';
    const root = layered({ 'scripts/gates/layers-allowed.json': { imports: [edge] } });
    write(root, {
      'src/view/route.ts':
        "import type { Route } from '../dispatcher/route.js';\nexport type R = Route;\n",
    });
    expect(check({ root }).errors).toEqual([]);
  });

  it('does not let a runtime import through when the list has its edge', () => {
    const edge = 'src/view/route.ts -> src/dispatcher/route.ts';
    const root = layered({ 'scripts/gates/layers-allowed.json': { imports: [edge] } });
    write(root, {
      'src/view/route.ts':
        "import { route } from '../dispatcher/route.js';\nexport const r = route;\n",
    });
    const errors = errorsOf(root);
    expect(errors).toContain(`a lower area imports a higher one (view -> dispatcher): ${edge}`);
    expect(errors).toContain('remove it from scripts/gates/layers-allowed.json');
  });

  it('fails on a row of the allowed imports that is no longer there, so that the list gets shorter', () => {
    const root = layered({
      'scripts/gates/layers-allowed.json': {
        imports: ['src/view/gone.ts -> src/dispatcher/route.ts'],
      },
    });
    expect(errorsOf(root)).toContain(
      'no longer imported; remove it from scripts/gates/layers-allowed.json',
    );
  });

  it('fails when a file of the public types imports a type the fixed declarations do not have, even type-only', () => {
    const root = layered();
    write(root, {
      'src/api/point.ts':
        "import type { Point } from '../shared/types.js';\nexport interface P { p: Point }\n",
    });
    expect(errorsOf(root)).toContain(
      'a file of the public types imports a type the fixed declarations do not have: src/api/point.ts -> src/shared/types.ts (Point)',
    );
  });

  it('fails when a file of the public types imports such a type without the type keyword', () => {
    const root = layered();
    write(root, {
      'src/api/extension/point.ts':
        "import { Point } from '../../shared/types.js';\nexport interface P { p: Point }\n",
    });
    expect(errorsOf(root)).toContain('src/api/extension/point.ts -> src/shared/types.ts (Point)');
  });

  it('lets a file of the public types import a type of a fixed declaration from an internal file', () => {
    const root = layered();
    write(root, {
      'src/api/spot.ts':
        "import type { Spot } from '../shared/types.js';\nexport interface S { s: Spot }\n",
      'dist/api/spot.d.ts':
        "import type { Spot } from '../shared/types.js';\nexport interface S { s: Spot }\n",
    });
    expect(check({ root }).errors).toEqual([]);
  });

  it('does not count a constant that a file of the public types re-exports as a type', () => {
    const root = layered();
    write(root, {
      'src/api/prefix.ts': "export { PREFIX } from '../shared/types.js';\n",
      'dist/api/prefix.d.ts': "export { PREFIX } from '../shared/types.js';\n",
    });
    expect(check({ root }).errors).toEqual([]);
  });

  it('holds the imports between two files of the public types to the fixed declarations too', () => {
    const root = layered();
    write(root, {
      'src/api/tables.ts': 'export interface LayerView { size: number }\n',
      'src/api/extension/kind.ts':
        "import type { LayerView } from '../tables.js';\nimport type { Mode } from '../state.js';\nexport interface Kind { view: LayerView; mode: Mode }\n",
    });
    const errors = errorsOf(root);
    expect(errors).toContain('src/api/extension/kind.ts -> src/api/tables.ts (LayerView)');
    expect(errors).not.toContain('(Mode)');
  });

  it('takes the names of every fixed declaration file, not only of the main entry', () => {
    const root = layered();
    write(root, {
      'src/api/keeper.ts': 'export interface Keeper { keep(): void }\n',
      'src/api/extension/keep.ts':
        "import type { Keeper } from '../keeper.js';\nexport interface K { keeper: Keeper }\n",
    });
    expect(check({ root }).errors).toEqual([]);
  });

  it('fails when a file of the public types imports without naming the types', () => {
    const root = layered();
    write(root, {
      'src/api/all.ts':
        "import type * as types from '../shared/types.js';\nexport interface A { p: types.Spot }\n",
      'src/api/extension/all.ts': "export * from '../state.js';\n",
      'src/api/extension/some.ts': "export type S = import('../state.js');\n",
    });
    const errors = errorsOf(root);
    expect(errors).toContain('without naming the types: src/api/all.ts -> src/shared/types.ts');
    expect(errors).toContain(
      'without naming the types: src/api/extension/all.ts -> src/api/state.ts',
    );
    expect(errors).toContain(
      'without naming the types: src/api/extension/some.ts -> src/api/state.ts',
    );
  });

  it('lets a type wait in the pending list, and fails on a row that no longer matches', () => {
    const named = 'src/api/point.ts -> src/shared/types.ts (Point)';
    const root = layered({ 'scripts/gates/public-types-pending.json': { imports: [named] } });
    write(root, {
      'src/api/point.ts':
        "import type { Point } from '../shared/types.js';\nexport interface P { p: Point }\n",
    });
    expect(check({ root }).errors).toEqual([]);
    write(root, { 'src/api/point.ts': 'export interface P { p: number }\n' });
    expect(errorsOf(root)).toContain(
      `no longer imported; remove it from scripts/gates/public-types-pending.json: ${named}`,
    );
  });

  it('fails when a fixed declaration file is missing', () => {
    const bare = tree({
      'scripts/gates/layers.json': realList('layers.json'),
      'scripts/gates/kasane-import-folders.json': { folders: [] },
      'scripts/gates/layers-allowed.json': { imports: [] },
      'scripts/gates/public-types-pending.json': { imports: [] },
      'src/index.ts': 'export const one = 1;\n',
      'dist/index.js': 'export const one = 1;\n',
    });
    expect(errorsOf(bare)).toContain('api/core.main.d.ts is missing');
  });

  it('fails when the row library is imported from a folder that is not listed, the drawing included', () => {
    const root = layered();
    write(root, {
      'src/view/rows.ts': `import { createTable } from '${ROW_LIBRARY}';\nexport const t = createTable;\n`,
    });
    expect(errorsOf(root)).toContain(`src/view/rows.ts:1: imports ${ROW_LIBRARY}`);
  });

  it('lets the row library be imported from a listed folder', () => {
    const root = layered({
      'scripts/gates/kasane-import-folders.json': { folders: ['src/store/rows'] },
    });
    write(root, {
      'src/store/rows/table.ts': `import { createTable } from '${ROW_LIBRARY}';\nexport const t = createTable;\n`,
    });
    expect(check({ root }).errors).toEqual([]);
  });

  it('fails on an import of the page library from anywhere', () => {
    const root = layered({
      'scripts/gates/kasane-import-folders.json': { folders: ['src/store'] },
    });
    write(root, {
      'src/store/pages.ts': `import type { Page } from '${PAGE_LIBRARY}';\nexport type P = Page;\n`,
    });
    expect(errorsOf(root)).toContain(`imports ${PAGE_LIBRARY}`);
  });

  it('fails on a relative import out of src/, in a test file too', () => {
    const root = layered();
    write(root, { 'src/shared/out.test.ts': "import { x } from '../../scripts/x.js';\nx();\n" });
    expect(errorsOf(root)).toContain('a relative import out of src/');
  });

  it('looks at the build output as well', () => {
    const root = layered();
    write(root, {
      'dist/store/up.js': "import { draw } from '../view/draw.js';\nexport const up = draw;\n",
    });
    expect(errorsOf(root)).toContain('dist/store/up.js:1');
  });
});
