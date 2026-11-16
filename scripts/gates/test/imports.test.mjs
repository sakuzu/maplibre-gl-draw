// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { check } from '../imports.mjs';
import { cleanUp, realList, tree, write } from './fixture.mjs';

afterEach(cleanUp);

const ROW_LIBRARY = ['@sakuzu', 'kasane'].join('/');
const PAGE_LIBRARY = ['@sakuzu', 'tabane'].join('/');

/** A src/ and a dist/ that follow the layers */
function layered(lists = {}) {
  return tree({
    'scripts/gates/layers.json': realList('layers.json'),
    'scripts/gates/kasane-import-folders.json': { folders: [] },
    'scripts/gates/layers-pending.json': { imports: [] },
    'scripts/gates/public-types-pending.json': { imports: [] },
    'src/index.ts': "export type { Thing } from './api/thing.js';\n",
    'src/api/thing.ts':
      "import type { Mode } from './state.js';\nexport interface Thing { mode: Mode }\n",
    'src/api/state.ts': "export type Mode = 'select';\n",
    'src/api/impl/thing.ts':
      "import type { Thing } from '../thing.js';\nimport { route } from '../../dispatcher/route.js';\nexport const make = (): Thing => ({ mode: route() });\n",
    'src/dispatcher/route.ts':
      "import { draw } from '../view/draw.js';\nexport const route = () => { draw(); return 'select' as const; };\n",
    'src/view/draw.ts':
      "import { read } from '../store/read.js';\nexport const draw = () => read();\n",
    'src/store/read.ts':
      "import type { Point } from '../shared/types.js';\nexport const read = (): Point | null => null;\n",
    'src/shared/types.ts': 'export interface Point { x: number }\n',
    'dist/view/draw.js':
      "import { read } from '../store/read.js';\nexport const draw = () => read();\n",
    'dist/view/draw.d.ts': 'export declare const draw: () => null;\n',
    'dist/store/read.js': 'export const read = () => null;\n',
    ...lists,
  });
}

describe('the gate of the import boundaries', () => {
  it('passes on imports that follow the layers', () => {
    expect(check({ root: layered() }).errors).toEqual([]);
  });

  it('fails on a runtime import from a lower layer to a higher one', () => {
    const root = layered();
    write(root, {
      'src/store/up.ts': "import { draw } from '../view/draw.js';\nexport const up = draw;\n",
    });
    expect(check({ root }).errors.join('\n')).toContain('src/store/up.ts -> src/view/draw.ts');
  });

  it('fails on a type-only import from a lower layer to a higher one', () => {
    const root = layered();
    write(root, {
      'src/view/mode.ts': "import type { Mode } from '../api/state.js';\nexport type M = Mode;\n",
    });
    const errors = check({ root }).errors.join('\n');
    expect(errors).toContain('src/view/mode.ts -> src/api/state.ts (type only)');
  });

  it('fails on a type written as import() that points the wrong way', () => {
    const root = layered();
    write(root, { 'src/store/mode.ts': "export type M = import('../api/state.js').Mode;\n" });
    expect(check({ root }).errors.join('\n')).toContain('src/store/mode.ts -> src/api/state.ts');
  });

  it('fails when a file of the public types imports an internal type, even type-only', () => {
    const root = layered();
    write(root, {
      'src/api/point.ts':
        "import type { Point } from '../shared/types.js';\nexport interface P { p: Point }\n",
    });
    expect(check({ root }).errors.join('\n')).toContain(
      'a file of the public types imports an internal type: src/api/point.ts -> src/shared/types.ts',
    );
  });

  it('fails when a file of the public types imports an internal type without the type keyword', () => {
    const root = layered();
    write(root, {
      'src/api/extension/point.ts':
        "import { Point } from '../../shared/types.js';\nexport interface P { p: Point }\n",
    });
    expect(check({ root }).errors.join('\n')).toContain(
      'src/api/extension/point.ts -> src/shared/types.ts',
    );
  });

  it('fails when the row library is imported from a folder that is not listed, the drawing included', () => {
    const root = layered();
    write(root, {
      'src/view/rows.ts': `import { createTable } from '${ROW_LIBRARY}';\nexport const t = createTable;\n`,
    });
    expect(check({ root }).errors.join('\n')).toContain(
      `src/view/rows.ts:1: imports ${ROW_LIBRARY}`,
    );
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
    expect(check({ root }).errors.join('\n')).toContain(`imports ${PAGE_LIBRARY}`);
  });

  it('fails on a relative import out of src/, in a test file too', () => {
    const root = layered();
    write(root, { 'src/shared/out.test.ts': "import { x } from '../../scripts/x.js';\nx();\n" });
    expect(check({ root }).errors.join('\n')).toContain('a relative import out of src/');
  });

  it('looks at the build output as well', () => {
    const root = layered();
    write(root, {
      'dist/store/up.js': "import { draw } from '../view/draw.js';\nexport const up = draw;\n",
    });
    expect(check({ root }).errors.join('\n')).toContain('dist/store/up.js:1');
  });

  it('fails on a listed import that is no longer there, so that the list gets shorter', () => {
    const root = layered({
      'scripts/gates/layers-pending.json': { imports: ['src/view/gone.ts -> src/api/state.ts'] },
    });
    expect(check({ root }).errors.join('\n')).toContain('no longer imported');
  });
});
