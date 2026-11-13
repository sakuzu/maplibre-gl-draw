// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="node" />

/**
 * The subpath `@sakuzu/maplibre-gl-draw/table`
 *
 * It is imported by a Worker, so what it loads at runtime must depend on neither maplibre nor
 * WebGL nor the DOM: every runtime import reachable from its entry is walked, and only pure
 * modules of the library may appear. Its export list is pinned, the types included.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as table from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '..');

/** The names the entry exports, values and types */
const EXPORTS = [
  'Column',
  'createPageBuilder',
  'createTableBuilder',
  'DictionaryColumn',
  'GeometryType',
  'Page',
  'PageBuilder',
  'PreparedTable',
  'prepareTable',
  'Table',
  'TableBuilder',
  'tableFromFeatures',
  'TableGeometry',
  'TableMixedGeometry',
  'toPage',
  'ToPageOptions',
  'transferList',
];

/**
 * The packages the entry loads at runtime: Tabane, of Kasane the builder of its pages, the packed
 * R-tree and the readers of the shape columns, and earcut for the triangles of the pages, which a
 * Worker runs too
 */
const PACKAGES: string[] = ['@sakuzu/kasane', '@sakuzu/kasane/render', '@sakuzu/tabane', 'earcut'];

/** The runtime imports of a file (type-only imports are erased) */
function runtimeImports(file: string): string[] {
  const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  const pattern = /^\s*(import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+'([^']+)'/gm;
  for (const match of text.matchAll(pattern)) {
    if (match[2]) continue;
    const clause = match[3].trim();
    if (clause.startsWith('{')) {
      const names = clause
        .slice(1, -1)
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean);
      if (names.length > 0 && names.every((name) => name.startsWith('type '))) continue;
    }
    out.push(match[4]);
  }
  return out;
}

/** Every name the entry exports, read from its export statements */
function exportedNames(): string[] {
  const fileName = join(here, 'index.ts');
  const source = ts.createSourceFile(
    fileName,
    readFileSync(fileName, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const names: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement)) continue;
    const clause = statement.exportClause;
    if (!clause || !ts.isNamedExports(clause)) throw new Error('no export * in the entry');
    for (const element of clause.elements) names.push(element.name.text);
  }
  return names;
}

const byName = (a: string, b: string): number => a.toLowerCase().localeCompare(b.toLowerCase());

describe('the table subpath', () => {
  it('exports exactly the names of the table', () => {
    expect(exportedNames().sort(byName)).toEqual([...EXPORTS].sort(byName));
  });

  it('exports at runtime the building, the preparation, the pages and the transfer list', () => {
    expect(Object.keys(table).sort()).toEqual([
      'createPageBuilder',
      'createTableBuilder',
      'prepareTable',
      'tableFromFeatures',
      'toPage',
      'transferList',
    ]);
  });

  it('loads nothing but pure modules of the library at runtime', () => {
    const seen = new Set<string>();
    const packages: string[] = [];
    const walk = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const specifier of runtimeImports(file)) {
        if (!specifier.startsWith('.')) {
          packages.push(specifier);
          continue;
        }
        walk(resolve(dirname(file), specifier.replace(/\.js$/, '.ts')));
      }
    };
    walk(join(here, 'index.ts'));

    expect([...new Set(packages)].sort()).toEqual(PACKAGES);
    const files = [...seen].map((file) => relative(SRC, file)).sort();
    expect(files).toEqual([
      'geometry/circle.ts',
      'geometry/coords.ts',
      'geometry/distance.ts',
      'geometry/units.ts',
      'shared/draw-error.ts',
      'shared/properties.ts',
      'shared/utils/own-property.ts',
      'table/builder.ts',
      'table/circle-rings.ts',
      'table/draw-error-of.ts',
      'table/feature-row-blocks.ts',
      'table/feature-row-columns.ts',
      'table/fill-triangles.ts',
      'table/index.ts',
      'table/pages.ts',
      'table/partition.ts',
      'table/polygon-rings.ts',
      'table/prepare.ts',
      'table/row-geometry.ts',
      'table/tabane/columns.ts',
      'table/tabane/rows.ts',
      'table/tabane/triangles.ts',
      'table/table.ts',
      'table/tables-values.ts',
    ]);
  });
});
