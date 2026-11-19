// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { check, digestOfKey } from '../api.mjs';
import { recordsOfBuild } from '../lib/declarations.mjs';
import { ABSENT, cleanUp, packageTree, write } from './fixture.mjs';

afterEach(cleanUp);

const edit = (root, from, to, file = 'dist/api/thing.d.ts') => {
  const text = readFileSync(join(root, file), 'utf8');
  expect(text).toContain(from);
  write(root, { [file]: text.replace(from, to) });
};

/** The rows of the store entry of the fixture, and more rows with the digests the build gives now */
const pendingNow = (root, more) => {
  const built = recordsOfBuild(root);
  return {
    'scripts/gates/api-pending.json': {
      entries: ['./store'],
      samples: {},
      declarations: {
        1: { 'store:added:Keeper': ABSENT, 'store:added:Keeper.keep': ABSENT },
        2: Object.fromEntries(more.map((k) => [k, digestOfKey(built, k)])),
      },
    },
  };
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
        samples: {},
        declarations: { 1: { 'store:added:Keeper': ABSENT } },
      },
    });
    expect(check({ root }).errors.join('\n')).toContain('store:added:Keeper.keep');
  });

  it('fails when a difference that is not there is listed', () => {
    const root = packageTree();
    write(root, {
      'scripts/gates/api-pending.json': {
        entries: ['./store'],
        samples: {},
        declarations: {
          1: { 'store:added:Keeper': ABSENT, 'store:added:Keeper.keep': ABSENT },
          2: { 'main:doc:Thing.name': ABSENT },
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
        samples: {},
        declarations: {
          1: { 'store:added:Keeper': ABSENT, 'store:added:Keeper.keep': ABSENT },
          2: { 'webgl:sig:shade': ABSENT },
        },
      },
    });
    expect(check({ root }).errors.join('\n')).toContain('the webgl entry may not wait');
  });

  it('lets a waiting declaration keep the form its row holds', () => {
    const root = packageTree();
    edit(root, 'fast?: boolean;', "fast?: boolean;\n    mode?: 'quick' | 'slow';");
    edit(root, 'The name of the thing.', 'The title of the thing.');
    write(root, pendingNow(root, ['main:removed:Options.mode', 'main:doc:Thing.name']));
    expect(check({ root }).errors).toEqual([]);
  });

  it('fails when a waiting declaration gets a string value of a third form', () => {
    const root = packageTree();
    edit(root, 'fast?: boolean;', "fast?: boolean;\n    mode?: 'quick' | 'slow';");
    write(root, pendingNow(root, ['main:removed:Options.mode']));
    edit(root, "'quick' | 'slow'", "'quick' | 'slow' | 'send_to_backend_storage'");
    const e = check({ root }).errors.join('\n');
    expect(e).toContain('main:removed:Options.mode waits in change 2');
    expect(e).toContain('it has neither the form its row holds nor the fixed form');
  });

  it('fails when the TSDoc of a waiting declaration changes again', () => {
    const root = packageTree();
    edit(root, '/** Makes a thing. */', '/** Makes a new thing. */');
    write(root, pendingNow(root, ['main:doc:makeThing']));
    expect(check({ root }).errors).toEqual([]);
    edit(
      root,
      '/** Makes a new thing. */',
      '/** Makes a new thing, and keeps it in step with every copy. */',
    );
    expect(check({ root }).errors.join('\n')).toContain('main:doc:makeThing waits in change 2');
  });
});

describe('the declarations an entry reaches that another entry exports', () => {
  /** The geometry entry exports a point and an area at a point; Thing of the main entry has an area */
  function reachingTree() {
    const geometry = `/** A point of the plane. */
export interface Point {
    /** The first coordinate. */
    x: number;
}
/** An area at a point. */
export interface Area {
    /** Where it is. */
    at: Point;
}
/** Computes area. */
export declare function area(x: number): number;
`;
    const root = packageTree({
      'dist/geometry/index.d.ts': geometry,
      'api/core.geometry.d.ts': geometry,
    });
    edit(
      root,
      "import type { Feature as GeoJSONFeature } from 'geojson';",
      "import type { Feature as GeoJSONFeature } from 'geojson';\nimport type { Area } from '../geometry/index.js';",
    );
    edit(
      root,
      '    shape: GeoJSONFeature;\n',
      '    shape: GeoJSONFeature;\n    /** Where the thing is. */\n    place: Area;\n',
    );
    const fixed = join(root, 'api/core.main.d.ts');
    write(root, {
      'api/core.main.d.ts': readFileSync(fixed, 'utf8')
        .replace(
          "import type { Feature } from 'geojson';",
          "import type { Feature } from 'geojson';\nimport type { Area } from '@sakuzu/maplibre-gl-draw/geometry';",
        )
        .replace(
          '  shape: Feature;\n',
          '  shape: Feature;\n  /** Where the thing is. */\n  place: Area;\n',
        ),
    });
    return root;
  }

  it('passes the entry that only reaches a type another entry exports', () => {
    expect(check({ root: reachingTree() }).errors).toEqual([]);
  });

  it('fails the entry that exports the type when a word of its TSDoc changes', () => {
    const root = reachingTree();
    edit(root, 'The first coordinate.', 'The second coordinate.', 'dist/geometry/index.d.ts');
    const e = check({ root }).errors.join('\n');
    expect(e).toContain('geometry:doc:Point.x');
    expect(e).not.toContain('main:');
  });

  /** The area of the geometry entry carries a brand the entry keeps to itself */
  function brandedTree() {
    const root = reachingTree();
    for (const file of ['dist/geometry/index.d.ts', 'api/core.geometry.d.ts']) {
      edit(
        root,
        '/** An area at a point. */',
        '/** What marks an area. */\ndeclare const areaBrand: unique symbol;\n/** An area at a point. */',
        file,
      );
      edit(
        root,
        '    at: Point;\n',
        '    at: Point;\n    /** Its mark. */\n    readonly [areaBrand]: true;\n',
        file,
      );
    }
    // As the compiler writes a file that keeps a declaration to itself
    edit(
      root,
      'export declare function area(x: number): number;\n',
      'export declare function area(x: number): number;\nexport {};\n',
      'dist/geometry/index.d.ts',
    );
    return root;
  }

  it('passes the entry that reaches a declaration another entry keeps to itself', () => {
    expect(check({ root: brandedTree() }).errors).toEqual([]);
  });

  it('fails the entry that keeps the declaration when a word of its TSDoc changes', () => {
    const root = brandedTree();
    edit(root, 'What marks an area.', 'What names an area.', 'dist/geometry/index.d.ts');
    const e = check({ root }).errors.join('\n');
    expect(e).toContain('geometry:doc:areaBrand');
    expect(e).not.toContain('main:');
  });
});
