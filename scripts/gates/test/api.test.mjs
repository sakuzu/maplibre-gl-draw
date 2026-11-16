// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { check } from '../api.mjs';
import { cleanUp, packageTree, write } from './fixture.mjs';

afterEach(cleanUp);

const thing = (root) => join(root, 'dist/api/thing.d.ts');
const edit = (root, from, to) => {
  const text = readFileSync(thing(root), 'utf8');
  expect(text).toContain(from);
  write(root, { 'dist/api/thing.d.ts': text.replace(from, to) });
};

describe('the gate of the fixed declarations', () => {
  it('passes when the build says what the fixed file says, written another way', () => {
    // The fixed file has other line breaks in the TSDoc, other indentation, a trailing comma,
    // no semicolon after a member, and imports the type of geojson under another name
    const r = check({ root: packageTree() });
    expect(r.errors).toEqual([]);
  });

  it('fails when a member is missing from the build', () => {
    const root = packageTree();
    edit(root, '    /** The shape of the thing. */\n    shape: GeoJSONFeature;\n', '');
    expect(check({ root }).errors.join('\n')).toContain('main:added:Thing.shape');
  });

  it('fails when the type of a parameter changes', () => {
    const root = packageTree();
    edit(root, 'move(by: number,', 'move(by: string,');
    expect(check({ root }).errors.join('\n')).toContain('main:sig:Thing.move');
  });

  it('fails when the return type changes', () => {
    const root = packageTree();
    edit(root, 'makeThing(name: string): Thing;', 'makeThing(name: string): Thing | null;');
    expect(check({ root }).errors.join('\n')).toContain('main:sig:makeThing');
  });

  it('fails when the build exports a name the fixed file does not have', () => {
    const root = packageTree();
    edit(
      root,
      '/** Makes a thing. */',
      '/** Extra. */\nexport declare const EXTRA = 1;\n/** Makes a thing. */',
    );
    write(root, {
      'dist/index.d.ts': readFileSync(join(root, 'dist/index.d.ts'), 'utf8').replace(
        '{ makeThing }',
        '{ makeThing, EXTRA }',
      ),
    });
    expect(check({ root }).errors.join('\n')).toContain('main:removed:EXTRA');
  });

  it('fails when only a word of the TSDoc changes', () => {
    const root = packageTree();
    edit(root, 'The name of the thing.', 'The title of the thing.');
    expect(check({ root }).errors.join('\n')).toContain('main:doc:Thing.name');
  });

  it('does not fail when only the whitespace and line breaks of the TSDoc change', () => {
    const root = packageTree();
    edit(
      root,
      '     * Moves the thing by a distance, and says whether it moved.',
      '     * Moves   the thing\n     *   by a distance,    and says\n     * whether it moved.',
    );
    expect(check({ root }).errors).toEqual([]);
  });

  it('fails when a waiting difference is taken out of the list while it is still there', () => {
    const root = packageTree();
    write(root, {
      'scripts/gates/api-pending.json': {
        entries: ['./store'],
        samples: [],
        declarations: { 1: ['store:added:Keeper'] },
      },
    });
    expect(check({ root }).errors.join('\n')).toContain('store:added:Keeper.keep');
  });

  it('fails when a difference that is not there is listed', () => {
    const root = packageTree();
    write(root, {
      'scripts/gates/api-pending.json': {
        entries: ['./store'],
        samples: [],
        declarations: {
          1: ['store:added:Keeper', 'store:added:Keeper.keep'],
          2: ['main:doc:Thing.name'],
        },
      },
    });
    expect(check({ root }).errors.join('\n')).toContain(
      'main:doc:Thing.name matches the fixed declaration now',
    );
  });

  it('fails when the table or webgl entry differs from its fixed file, and does not let it wait', () => {
    const root = packageTree();
    write(root, {
      'dist/webgl/index.d.ts':
        '/** Computes shade. */\nexport declare function shade(x: number, y?: number): number;\n',
    });
    expect(check({ root }).errors.join('\n')).toContain('webgl:sig:shade');
    write(root, {
      'scripts/gates/api-pending.json': {
        entries: ['./store'],
        samples: [],
        declarations: {
          1: ['store:added:Keeper', 'store:added:Keeper.keep'],
          2: ['webgl:sig:shade'],
        },
      },
    });
    expect(check({ root }).errors.join('\n')).toContain('the webgl entry may not wait');
  });
});
