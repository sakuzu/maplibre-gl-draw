// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="node" />

/**
 * The subpath `@sakuzu/maplibre-gl-draw/kasane`
 *
 * A Worker imports it to build the blocks of rows, so what it loads at runtime must depend on
 * neither maplibre nor the drawing: every runtime import reachable from its entry is walked, and
 * none may be maplibre, a module that draws, a mode, the dispatch of the input or the
 * implementation of the instance. Its export list is pinned in src/index.test.ts.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '..');

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

describe('the kasane subpath', () => {
  it('loads neither maplibre nor the drawing at runtime', () => {
    const seen = new Set<string>();
    const packages = new Set<string>();
    const walk = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const specifier of runtimeImports(file)) {
        if (!specifier.startsWith('.')) {
          packages.add(specifier);
          continue;
        }
        walk(resolve(dirname(file), specifier.replace(/\.js$/, '.ts')));
      }
    };
    walk(join(here, 'index.ts'));

    expect([...packages].filter((name) => name.startsWith('maplibre'))).toEqual([]);
    const files = [...seen].map((file) => relative(SRC, file));
    const drawing = /^(view|modes|dispatcher|snapping|operations|webgl|api\/impl)\//;
    expect(files.filter((file) => drawing.test(file))).toEqual([]);
  });
});
