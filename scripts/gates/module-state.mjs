// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The gate of the state of the modules: a value at the top level of a file of the library that
// two instances would share. Every top-level `let` and `var`, and every top-level `const` whose
// value is made with `new` (`new Map`, `new Set`, `new WeakMap`, a typed array, an object of a
// class) is a row of scripts/gates/module-state-allowed.json. A row that no longer matches fails,
// so the list only holds what is there. Only the maintainer adds a row.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { libraryFiles, readList, result } from './lib/files.mjs';
import { loadTypeScript } from './lib/ts.mjs';

export const name = 'module-state';

/**
 * The top-level state of the files of the library
 *
 * @returns {{ file: string, name: string, kind: string, line: number }[]}
 */
export function moduleState(root) {
  const ts = loadTypeScript();
  const out = [];
  for (const file of libraryFiles(root)) {
    const text = readFileSync(join(root, file), 'utf8');
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (st) => {
      if (ts.isBlock(st)) {
        st.statements.forEach(visit);
        return;
      }
      if (!ts.isVariableStatement(st)) return;
      const isConst = Boolean(st.declarationList.flags & ts.NodeFlags.Const);
      for (const d of st.declarationList.declarations) {
        let init = d.initializer;
        while (
          init &&
          (ts.isAsExpression(init) ||
            ts.isSatisfiesExpression?.(init) ||
            ts.isParenthesizedExpression(init))
        ) {
          init = init.expression;
        }
        let kind = null;
        if (!isConst) kind = st.declarationList.flags & ts.NodeFlags.Let ? 'let' : 'var';
        else if (init && ts.isNewExpression(init)) kind = `new ${init.expression.getText(sf)}`;
        if (!kind) continue;
        const line = sf.getLineAndCharacterOfPosition(d.getStart(sf)).line + 1;
        out.push({ file, name: d.name.getText(sf), kind, line });
      }
    };
    sf.statements.forEach(visit);
  }
  return out;
}

/** @param {{ root: string }} ctx */
export function check(ctx) {
  const { root } = ctx;
  const out = result(name);
  const lists = [
    ['module-state-allowed.json', readList(root, 'module-state-allowed.json').state ?? []],
  ];
  const used = new Set();
  for (const s of moduleState(root)) {
    let found = false;
    for (const [listName, rows] of lists) {
      const i = rows.findIndex((r) => r.file === s.file && r.name === s.name);
      if (i >= 0) {
        used.add(`${listName}:${i}`);
        found = true;
        break;
      }
    }
    if (!found) out.errors.push(`${s.file}:${s.line}: module state ${s.kind} ${s.name}`);
  }
  for (const [listName, rows] of lists) {
    rows.forEach((r, i) => {
      if (!used.has(`${listName}:${i}`)) {
        out.errors.push(
          `no longer module state; remove it from scripts/gates/${listName}: ${r.file} ${r.name}`,
        );
      }
    });
  }
  return out;
}
