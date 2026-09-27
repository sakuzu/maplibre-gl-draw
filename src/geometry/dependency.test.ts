// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="node" />

/**
 * Static dependency check
 *
 * Confirms mechanically, from the import statements in the sources, that
 * src/geometry/ does not depend on maplibre, the DOM, wasm, the Store or events.
 * Only polygon-clipping and relative imports within geometry are allowed at runtime, plus
 * the GeoJSON type definitions, which are erased at compile time.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const GEOMETRY_DIR = dirname(fileURLToPath(import.meta.url));

/** Packages allowed as runtime dependencies */
const ALLOWED_PACKAGES = ['polygon-clipping'];

/** Packages allowed in `import type` statements only */
const ALLOWED_TYPE_PACKAGES = ['geojson'];

/** Regular expression that removes an `import type` statement from a package allowed for types */
const TYPE_IMPORT_PATTERN = /\bimport\s+type\s+\{[^}]*\}\s+from\s+'([^']+)';?/g;

/** Regular expression that picks up the from clause of an import / export statement */
const MODULE_SPECIFIER_PATTERN = /\bfrom\s+'([^']+)'/g;

/** Regular expression that picks up a dynamic import */
const DYNAMIC_IMPORT_PATTERN = /\bimport\s*\(\s*'([^']+)'/g;

/**
 * Lists the names of the geometry source files, excluding tests
 */
function listSourceFiles(): string[] {
  return readdirSync(GEOMETRY_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .sort();
}

/** Regular expression that picks up a block comment (the TSDoc examples contain imports) */
const BLOCK_COMMENT_PATTERN = /\/\*[\s\S]*?\*\//g;

/**
 * Lists the module specifiers referenced by a file, ignoring the block comments
 */
function listModuleSpecifiers(fileName: string): string[] {
  const source = readFileSync(join(GEOMETRY_DIR, fileName), 'utf8')
    .replace(BLOCK_COMMENT_PATTERN, '')
    .replace(TYPE_IMPORT_PATTERN, (statement, specifier: string) =>
      ALLOWED_TYPE_PACKAGES.includes(specifier) ? '' : statement,
    );
  const specifiers: string[] = [];
  for (const pattern of [MODULE_SPECIFIER_PATTERN, DYNAMIC_IMPORT_PATTERN]) {
    pattern.lastIndex = 0;
    let match = pattern.exec(source);
    while (match !== null) {
      specifiers.push(match[1]);
      match = pattern.exec(source);
    }
  }
  return specifiers;
}

describe('dependencies of geometry', () => {
  const files = listSourceFiles();

  it('has sources to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('references nothing but polygon-clipping and relative imports within geometry', () => {
    const violations: string[] = [];

    for (const file of files) {
      for (const specifier of listModuleSpecifiers(file)) {
        if (ALLOWED_PACKAGES.includes(specifier)) {
          continue;
        }
        // Allow only relative imports at the same level within geometry
        if (specifier.startsWith('./') && !specifier.slice(2).includes('/')) {
          continue;
        }
        violations.push(`${file}: ${specifier}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('has no reference to maplibre, the DOM or Node built-ins', () => {
    const forbidden = ['maplibre', 'node:', 'gl-matrix', 'earcut', 'rbush', 'ulid'];
    const violations: string[] = [];

    for (const file of files) {
      for (const specifier of listModuleSpecifiers(file)) {
        if (forbidden.some((name) => specifier.includes(name))) {
          violations.push(`${file}: ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
