// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="node" />

/**
 * The subpath `@sakuzu/maplibre-gl-draw/columnar`
 *
 * It is imported by a Worker, so what it loads at runtime must depend on neither maplibre nor
 * WebGL nor the DOM: every runtime import reachable from its entry is walked, and only pure
 * modules of the library may appear.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as columnar from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '../..');

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

describe('the columnar subpath', () => {
  it('exports the preparation and the transfer list', () => {
    expect(Object.keys(columnar).sort()).toEqual([
      'columnarTransferables',
      'prepareDatasetColumnar',
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

    expect(packages).toEqual([]);
    const files = [...seen].map((file) => relative(SRC, file)).sort();
    expect(files).toEqual([
      'display/columnar/index.ts',
      'display/columnar/prepare.ts',
      'display/columnar/table.ts',
      'display/packed-rtree.ts',
      'display/partition.ts',
    ]);
  });
});
