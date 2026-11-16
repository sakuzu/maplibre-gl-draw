// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// Small helpers shared by the gates: walking folders, reading the lists, and the shape of a result.

import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Folders never walked */
const SKIP = new Set(['node_modules', 'dist', '.git', '.pack', 'site-dist', '.vitepress']);

/**
 * Every file under a folder, as paths relative to the root with `/` between parts
 *
 * @param {string} root
 * @param {string} dir Relative to the root
 * @param {(rel: string) => boolean} [keep]
 * @returns {string[]}
 */
export function walk(root, dir, keep = () => true) {
  const out = [];
  const start = join(root, dir);
  if (!existsSync(start)) return out;
  const visit = (abs) => {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      for (const name of readdirSync(abs).sort()) {
        if (!SKIP.has(name)) visit(join(abs, name));
      }
      return;
    }
    const rel = relative(root, abs).split(sep).join('/');
    if (keep(rel)) out.push(rel);
  };
  visit(start);
  return out;
}

/** The source files of the library: src/ without the tests, the end-to-end tests and test helpers */
export function libraryFiles(root) {
  return walk(
    root,
    'src',
    (f) =>
      f.endsWith('.ts') &&
      !f.endsWith('.test.ts') &&
      !f.endsWith('.d.ts') &&
      !f.startsWith('src/e2e/') &&
      !f.startsWith('src/test-support/') &&
      f !== 'src/test-utils.ts',
  );
}

/** Whether a path is a test file (unit tests and the end-to-end tests with their helpers) */
export function isTestFile(rel) {
  return (
    /\.test\.(ts|mts|js|mjs)$/.test(rel) ||
    /(^|\/)e2e\//.test(rel) ||
    rel === 'src/test-utils.ts' ||
    rel.startsWith('src/test-support/')
  );
}

/**
 * Reads a list of the gates
 *
 * @param {string} root
 * @param {string} name The file name under scripts/gates/
 */
export function readList(root, name) {
  return JSON.parse(readFileSync(join(root, 'scripts', 'gates', name), 'utf8'));
}

/** A gate result */
export function result(name) {
  return { name, errors: [], notes: [] };
}
