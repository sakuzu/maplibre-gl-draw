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
import { TabaneError } from '@sakuzu/tabane';
import { describe, expect, it } from 'vitest';
import { DrawError } from '../api/errors.js';
import { KasaneError } from '../table/kasane-error.js';
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
        'tabane/blocks.ts',
        'tabane/columns.ts',
        'tabane/rows.ts',
        'tabane/triangles.ts',
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
    const row = { id: 'a', type: 'Point', geometry: null, key: 'a0' };
    builder.addRow(row);
    expect(codeOf(() => builder.addRow(row))).toBe('invalid-input');
    const { tables, writer } = createFeatureTables();
    expect(codeOf(() => writer.addRowBlocks('l', [{ ...builder.finish()[0], length: 0 }]))).toBe(
      'invalid-input',
    );
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
        writer.apply({ handles: Int32Array.of(handle), fields: new Map([['hidden', [false]]]) }),
      ),
    ).toBe('invalid-input');
    expect(codeOf(() => mergeRowBlock({ sources: [], rows: Int32Array.of(0, 0) }))).toBeDefined();
    expect(tables.get('l')).toBeUndefined();
  });

  it('throws an error of the tables as a DrawError of its code and message, held as the cause', () => {
    const thrown = (fn: () => unknown): unknown => {
      try {
        fn();
      } catch (error) {
        return error;
      }
      throw new Error('nothing was thrown');
    };
    /** The error a call threw, a DrawError, and the error of the tables it holds */
    const wrapped = (fn: () => unknown): { error: DrawError; cause: KasaneError } => {
      const error = thrown(fn);
      expect(error).toBeInstanceOf(DrawError);
      const cause = ((error as DrawError).details as { cause?: unknown } | undefined)?.cause;
      expect(cause).toBeInstanceOf(KasaneError);
      expect((error as DrawError).code).toBe((cause as KasaneError).code);
      expect((error as DrawError).message).toBe((cause as KasaneError).message);
      return { error: error as DrawError, cause: cause as KasaneError };
    };
    const row = { id: 'a', type: 'Point', geometry: null, key: 'a0' };

    // The builder: a row added twice, a value it cannot hold, a group the options do not give
    const builder = createRowBlockBuilder();
    builder.addRow(row);
    const twice = wrapped(() => builder.addRow(row));
    expect(twice.error.code).toBe('invalid-input');
    expect(twice.error.message).toBe('RowBlockBuilder: the id "a" is added twice');
    const withFunction = createRowBlockBuilder();
    withFunction.addRow({ ...row, properties: { f: () => 1 } });
    const value = wrapped(() => withFunction.finish());
    expect(value.error.code).toBe('invalid-input');
    // An error of Tabane is held by the error of the tables
    expect(value.cause.cause).toBeInstanceOf(TabaneError);
    const grouped = createRowBlockBuilder();
    grouped.addRow({ ...row, group: 7 });
    grouped.addRow({ ...row, id: 'b', group: 7 });
    expect(wrapped(() => grouped.finish()).error.code).toBe('not-found');

    // The merge: a source whose styles are not numbered
    const blocks = builder.finish();
    expect(
      wrapped(() => mergeRowBlock({ sources: blocks, rows: Int32Array.of(0, 0) })).error.code,
    ).toBe('invalid-input');

    // The writer: values of a row it cannot hold
    const { tables, writer } = createFeatureTables();
    const one = createRowBlockBuilder();
    one.addRow({ ...row, geometry: { type: 'Point', coordinates: [1, 2] } });
    writer.addRowBlocks('l', one.finish());
    const handles = Int32Array.of(tables.findRow('a') as number);
    const surrogate = wrapped(() =>
      writer.apply({ handles, fields: new Map([['properties:x', ['\ud800']]]) }),
    );
    expect(surrogate.error.code).toBe('invalid-input');
    expect(surrogate.error.message).toBe('ValueOverrides: a string with a lone surrogate');
    const notValue = wrapped(() =>
      writer.apply({ handles, fields: new Map([['properties:x', [() => 1]]]) }),
    );
    expect(notValue.error.code).toBe('invalid-input');
    expect(notValue.cause.cause).toBeInstanceOf(TabaneError);
  });

  it('lets through as it is what a function given to the tables throws', () => {
    const own = new TabaneError('invalid-input', 'an error of the caller');
    const point = { type: 'Point' as const, coordinates: [1, 2] };
    const builder = createRowBlockBuilder({
      coordinateSystem: {
        rowBox: () => {
          throw own;
        },
      },
    });
    builder.addRow({ id: 'a', type: 'Point', geometry: point, key: 'a0' });
    let error: unknown;
    try {
      builder.finish();
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBe(own);

    const blocks = createRowBlockBuilder();
    blocks.addRow({ id: 'a', type: 'Point', geometry: point, key: 'a0' });
    const { tables, writer } = createFeatureTables({
      onRelease: () => {
        throw own;
      },
    });
    writer.addRowBlocks('l', blocks.finish());
    const token = writer.createRestoreToken();
    writer.apply(
      {
        handles: Int32Array.of(tables.findRow('a') as number),
        fields: new Map(),
        deleted: Uint8Array.of(1),
      },
      { restoreToken: token },
    );
    error = undefined;
    try {
      tables.release(token);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBe(own);
  });
});
