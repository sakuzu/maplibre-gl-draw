// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// Small trees for the tests of the gates: a package with a build output, fixed declarations,
// sources and the lists of the gates, written into a temporary folder.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATES = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(GATES, '..', '..');

const roots = [];

/**
 * Writes a tree of files into a new temporary folder
 *
 * @param {Record<string, string | object>} files Paths relative to the root; an object is written as JSON
 * @returns {string} The root
 */
export function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'gates-'));
  roots.push(root);
  write(root, files);
  return root;
}

/** Writes (or replaces) files of a tree */
export function write(root, files) {
  for (const [path, content] of Object.entries(files)) {
    const abs = join(root, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(
      abs,
      typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`,
    );
  }
}

/** Removes every tree made so far */
export function cleanUp() {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
}

/** A list of the gates as the repository has it */
export function realList(name) {
  return JSON.parse(readFileSync(join(GATES, name), 'utf8'));
}

/** Links the types of geojson from the repository, for the declarations of a tree */
export function linkModules(root) {
  mkdirSync(join(root, 'node_modules', '@types'), { recursive: true });
  symlinkSync(
    join(REPO, 'node_modules', '@types', 'geojson'),
    join(root, 'node_modules', '@types', 'geojson'),
    'dir',
  );
}

/** Runs git in a tree, as a user of the test */
export function git(root, ...args) {
  return execFileSync(
    'git',
    ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args],
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
}

const ENTRY_DOC = `/**
 * The entry of the fixture.
 *
 * @module fixture
 */`;

/** The declarations the build of the fixture emits for the main entry */
export const BUILT_MAIN = {
  'dist/index.d.ts': `${ENTRY_DOC}
export type { Thing, Options } from './api/thing.js';
export { makeThing } from './api/thing.js';
`,
  'dist/index.js': `export { makeThing } from './api/thing.js';\n`,
  'dist/api/thing.d.ts': `import type { Feature as GeoJSONFeature } from 'geojson';
/** A thing on the map. */
export interface Thing {
    /** The name of the thing. */
    readonly name: string;
    /**
     * Moves the thing by a distance, and says whether it moved.
     *
     * @param by How far to move it
     */
    move(by: number, options?: Options): boolean;
    /** The shape of the thing. */
    shape: GeoJSONFeature;
}
/** The options of a move. */
export type Options = {
    fast?: boolean;
};
/** Makes a thing. */
export declare function makeThing(name: string): Thing;
`,
  'dist/api/thing.js': `export function makeThing(name) { return { name }; }\n`,
};

/** The fixed declarations of the main entry: the same, written by hand */
export const FIXED_MAIN = `import type { Feature } from 'geojson';

${ENTRY_DOC}

/** A thing on the map. */
export interface Thing {
  /** The name of the thing. */
  readonly name: string;
  /**
   * Moves the thing by a distance,
   * and says whether it moved.
   *
   * @param by How far to move it
   */
  move(by: number, options?: Options,): boolean
  /** The shape of the thing. */
  shape: Feature;
}

/** The options of a move. */
export type Options = { fast?: boolean };

/** Makes a thing. */
export declare function makeThing(name: string): Thing;
`;

const SMALL = (fn) => `/** Computes ${fn}. */\nexport declare function ${fn}(x: number): number;\n`;

/**
 * A package with a build of four entries, the fixed files of the five and the lists of the gates.
 * The store entry is not built yet and waits in api-pending.json.
 */
export function packageTree(extra = {}) {
  const root = tree({
    'package.json': {
      name: '@sakuzu/maplibre-gl-draw',
      type: 'module',
      exports: {
        '.': { types: './dist/index.d.ts', import: './dist/index.js' },
        './geometry': { types: './dist/geometry/index.d.ts', import: './dist/geometry/index.js' },
        './table': { types: './dist/table/index.d.ts', import: './dist/table/index.js' },
        './webgl': { types: './dist/webgl/index.d.ts', import: './dist/webgl/index.js' },
        './package.json': './package.json',
      },
      dependencies: { earcut: '^3.0.2' },
      peerDependencies: { 'maplibre-gl': '~6.11.1' },
    },
    ...BUILT_MAIN,
    'dist/geometry/index.d.ts': SMALL('area'),
    'dist/geometry/index.js': 'export function area(x) { return x; }\n',
    'dist/table/index.d.ts': SMALL('rows'),
    'dist/table/index.js': 'export function rows(x) { return x; }\n',
    'dist/webgl/index.d.ts': SMALL('shade'),
    'dist/webgl/index.js': 'export function shade(x) { return x; }\n',
    'api/core.main.d.ts': FIXED_MAIN,
    'api/core.geometry.d.ts': SMALL('area'),
    'api/core.table.d.ts': SMALL('rows'),
    'api/core.webgl.d.ts': SMALL('shade'),
    'api/core.store.d.ts': `/** Where the things are kept. */\nexport interface Keeper {\n  /** Keeps a thing. */\n  keep(name: string): void;\n}\n`,
    'scripts/gates/api-pending.json': {
      entries: ['./store'],
      samples: [],
      declarations: { 1: ['store:added:Keeper', 'store:added:Keeper.keep'] },
    },
    ...extra,
  });
  linkModules(root);
  return root;
}
