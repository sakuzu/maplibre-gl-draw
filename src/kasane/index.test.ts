// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="node" />

/**
 * The subpath `@sakuzu/maplibre-gl-draw/kasane`
 *
 * A Worker imports it to build the row blocks, so what it loads at runtime must depend on
 * neither maplibre nor the drawing: every runtime import reachable from its entry is walked, and
 * none may be maplibre, a module that draws, a mode, the dispatch of the input or the
 * implementation of the instance. Its export list is pinned in src/index.test.ts.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DrawError } from '../api/errors.js';
import { createFeatureTables, createRowBlockBuilder, mergeRowBlock } from './index.js';

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

  it('throws only DrawError from the modules behind it, with the code of the cause', () => {
    // Every throw of the tables and of the builders and the merge of their blocks is a DrawError
    const files = [
      ...readdirSync(join(SRC, 'feature-table'))
        .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
        .map((name) => join(SRC, 'feature-table', name)),
      ...[
        'row-group-builder.ts',
        'row-group-merge.ts',
        'row-geometry.ts',
        'row-keys.ts',
        'canonical-value.ts',
        'value-column.ts',
      ].map((name) => join(SRC, 'table', name)),
    ];
    const plain = files.filter((file) => /new Error\(/.test(readFileSync(file, 'utf8')));
    expect(plain.map((file) => relative(SRC, file))).toEqual([]);

    const codeOf = (fn: () => unknown): string | undefined => {
      try {
        fn();
      } catch (error) {
        return error instanceof DrawError ? error.code : 'plain';
      }
      return undefined;
    };
    const builder = createRowBlockBuilder();
    const row = { id: 'a', type: 'Point', geometry: null, order: 'a0' };
    builder.addRow(row);
    expect(codeOf(() => builder.addRow(row))).toBe('invalid-input');
    const { tables, writer } = createFeatureTables();
    expect(codeOf(() => writer.addRowBlocks('l', [{ ...builder.finish()[0], length: 0 }]))).toBe(
      'invalid-input',
    );
    expect(codeOf(() => writer.raiseDimensions('l', 'xy' as never))).toBeUndefined();
    expect(codeOf(() => writer.raiseDimensions('l', 'x' as never))).toBe('invalid-input');
    expect(codeOf(() => writer.apply({ handles: Int32Array.of(99), fields: new Map() }))).toBe(
      'not-found',
    );
    // A handle given to a new id, written without what a new row needs
    const [handle] = writer.allocateHandles({
      offsets: Int32Array.of(0, 1),
      bytes: new TextEncoder().encode('n'),
    });
    expect(
      codeOf(() =>
        writer.apply({ handles: Int32Array.of(handle), fields: new Map([['visible', [true]]]) }),
      ),
    ).toBe('invalid-input');
    expect(codeOf(() => writer.applyOpened('nothing', {} as never))).toBe('invalid-state');
    expect(codeOf(() => mergeRowBlock({ sources: [], rows: Int32Array.of(0, 0) }))).toBeDefined();
    expect(tables.get('l')).toBeUndefined();
  });
});
