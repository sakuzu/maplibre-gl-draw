// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The gate of the state of the modules: a value at the top level of a file of the library that
// two instances would share. Every top-level `let` and `var`, and every top-level `const` that
// makes a container that can be changed (`new Map`, `new Set`, `new WeakMap`, `new WeakSet`, a
// typed array, an array, an object of a class) is a row of
// scripts/gates/module-state-allowed.json, which holds what the published version has. A row that
// no longer matches fails, so the list only gets shorter; no row is added.
//
// A table of constants is not state: a top-level `const` whose type annotation is
// `ReadonlySet<...>`, `ReadonlyMap<...>`, `ReadonlyArray<...>` or `readonly ...[]` (the type keeps
// it from being changed). A new table of constants is written with such an annotation.

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
        else if (isReadonlyType(ts, d.type)) kind = null;
        else if (init && ts.isNewExpression(init)) kind = `new ${init.expression.getText(sf)}`;
        else if (init && ts.isArrayLiteralExpression(init)) kind = 'array';
        if (!kind) continue;
        const line = sf.getLineAndCharacterOfPosition(d.getStart(sf)).line + 1;
        out.push({ file, name: d.name.getText(sf), kind, line });
      }
    };
    sf.statements.forEach(visit);
  }
  return out;
}

const READONLY_CONTAINERS = new Set(['ReadonlySet', 'ReadonlyMap', 'ReadonlyArray']);

/**
 * Whether a type annotation keeps the value from being changed: `ReadonlySet<...>`,
 * `ReadonlyMap<...>`, `ReadonlyArray<...>`, `readonly T[]` (and `readonly [A, B]`)
 */
function isReadonlyType(ts, type) {
  if (!type) return false;
  if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
    return READONLY_CONTAINERS.has(type.typeName.text);
  }
  return (
    ts.isTypeOperatorNode(type) &&
    type.operator === ts.SyntaxKind.ReadonlyKeyword &&
    (ts.isArrayTypeNode(type.type) || ts.isTupleTypeNode(type.type))
  );
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
