// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The gate of the places that write to the Store: outside the Store itself (src/store/), a call
// of a writing method of the Store is made only in the files of
// scripts/gates/store-write-files.json, so that no write leaves out the checks of read-only and
// of the locks. A call counts when its method is one of the list and the object it is called on
// is named as the Store (`store`, `this.store`, `ctx.store`, `this.#store`, `getStore()` ...).
// A listed file that no longer writes fails, so the list only holds what is there.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { libraryFiles, readList, result } from './lib/files.mjs';
import { loadTypeScript } from './lib/ts.mjs';

export const name = 'store-writes';

/**
 * Whether an expression names the Store: its last name is `store`, `getStore()`, `engineStore` or
 * `documentStore` (with or without `#`), so that the store of something else (`tileStore`) does not
 * count.
 */
export function isStore(expression) {
  const last = expression.replace(/\(\)$/, '').replace(/\?$/, '').split('.').pop() ?? '';
  const n = last.replace(/^#/, '');
  return /^(store|getStore|engineStore|documentStore)$/i.test(n);
}

/**
 * The calls of the writing methods of the Store, by file
 *
 * @param {string} root
 * @param {string[]} methods
 * @returns {Map<string, { method: string, line: number }[]>}
 */
export function storeWrites(root, methods) {
  const ts = loadTypeScript();
  const wanted = new Set(methods);
  const byFile = new Map();
  for (const file of libraryFiles(root)) {
    if (file.startsWith('src/store/')) continue;
    const text = readFileSync(join(root, file), 'utf8');
    if (!methods.some((m) => text.includes(m))) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (n) => {
      if (ts.isCallExpression(n)) {
        const callee = n.expression;
        const access =
          ts.isPropertyAccessExpression(callee) || ts.isPropertyAccessChain?.(callee)
            ? callee
            : null;
        if (access && wanted.has(access.name.text) && isStore(access.expression.getText(sf))) {
          const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
          if (!byFile.has(file)) byFile.set(file, []);
          byFile.get(file).push({ method: access.name.text, line });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return byFile;
}

/** @param {{ root: string }} ctx */
export function check(ctx) {
  const { root } = ctx;
  const out = result(name);
  const list = readList(root, 'store-write-files.json');
  const files = new Set(list.files);
  const writes = storeWrites(root, list.methods);
  for (const [file, calls] of writes) {
    if (files.has(file)) continue;
    for (const c of calls) {
      out.errors.push(
        `${file}:${c.line}: writes to the Store (${c.method}) from a file that scripts/gates/store-write-files.json does not list`,
      );
    }
  }
  for (const f of files) {
    if (!writes.has(f))
      out.errors.push(
        `${f} no longer writes to the Store; remove it from scripts/gates/store-write-files.json`,
      );
  }
  return out;
}
