// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The gate of the state of the modules: a value at the top level of a file of the library that
// two instances would share. What is counted, at the top level of a file (also inside a block, an
// `if`, a `try` or a `for` there):
//
// - every `let` and `var`
// - every `const` whose value (with `as`, `satisfies` and parentheses taken off) is an object
//   literal, an array literal, a `new` expression, a regular expression literal or the result of a
//   call
// - every `static` field of a class that is not a function
//
// What is not counted, as the reader and the gate can both tell it is not changed:
//
// - a `const` whose value is `Object.freeze(...)` or `deepFreeze(...)`
//   (src/shared/utils/deep-freeze.ts, which freezes every level)
// - an object or array literal written `as const`
// - a `const` whose type annotation is read-only: `ReadonlySet<...>`, `ReadonlyMap<...>`,
//   `ReadonlyArray<...>`, `readonly T[]` or a `readonly` tuple. `Readonly<...>` is not one of
//   them: it makes only the first level read-only
// - a regular expression without the flags `g` and `y` (which keep `lastIndex` across uses)
// - the result of a call whose value is not an object: a string, a number, a boolean, a bigint, a
//   symbol or a function, told by the type annotation of the `const` or, without one, by the type
//   the compiler gives the call
//
// Every counted value is a row of scripts/gates/module-state-allowed.json with the reason it may
// be there, one of REASONS. A counted value without a row, a row without one of the reasons and a
// row that no longer matches fail. What none of the reasons fits is not added to the list: it is
// taken out of the top level. The notes `shared` and `fixed` ask for are read by the reviewer,
// not by the gate.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { libraryFiles, readList, result } from './lib/files.mjs';
import { loadTypeScript } from './lib/ts.mjs';

export const name = 'module-state';

/**
 * The reasons a row of the list may give
 *
 * - `scratch`: written and read only inside one synchronous call
 * - `pure-cache`: a cache whose values follow from the key and the input alone
 * - `instance-key`: a `WeakMap` keyed by objects each instance makes, so that no instance sees
 *   another's entries
 * - `shared`: shared on purpose; the head of the file or a note above the declaration says so and
 *   why
 * - `fixed`: a typed array nothing writes, which cannot be frozen; a note above the declaration
 *   says nothing writes it
 */
export const REASONS = ['scratch', 'pure-cache', 'instance-key', 'shared', 'fixed'];

/** The functions whose result is frozen at every level (or at the first, for Object.freeze) */
const FREEZERS = new Set(['Object.freeze', 'deepFreeze']);

/**
 * The top-level state of the files of the library
 *
 * @returns {{ file: string, name: string, kind: string, line: number }[]}
 */
export function moduleState(root) {
  const ts = loadTypeScript();
  const files = libraryFiles(root);
  const found = [];
  const calls = [];
  const sources = new Map();
  for (const file of files) {
    const text = readFileSync(join(root, file), 'utf8');
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    sources.set(file, sf);
    const add = (node, nodeName, kind) => {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      found.push({ file, name: nodeName, kind, line });
    };
    const declarations = (list) => {
      const isConst = Boolean(list.flags & ts.NodeFlags.Const);
      for (const d of list.declarations) {
        const declaredName = d.name.getText(sf);
        if (!isConst) {
          add(d, declaredName, list.flags & ts.NodeFlags.Let ? 'let' : 'var');
          continue;
        }
        const kind = constKind(ts, sf, d);
        if (kind === 'call') calls.push({ file, d, declaredName });
        else if (kind) add(d, declaredName, kind);
      }
    };
    const visit = (st) => {
      if (!st) return;
      if (ts.isBlock(st)) st.statements.forEach(visit);
      else if (ts.isVariableStatement(st)) declarations(st.declarationList);
      else if (ts.isIfStatement(st)) {
        visit(st.thenStatement);
        visit(st.elseStatement);
      } else if (ts.isTryStatement(st)) {
        visit(st.tryBlock);
        visit(st.catchClause?.block);
        visit(st.finallyBlock);
      } else if (ts.isForStatement(st) || ts.isForInStatement(st) || ts.isForOfStatement(st)) {
        if (st.initializer && ts.isVariableDeclarationList(st.initializer)) {
          declarations(st.initializer);
        }
        visit(st.statement);
      } else if (ts.isClassDeclaration(st)) {
        for (const member of st.members) {
          if (!ts.isPropertyDeclaration(member)) continue;
          if (!member.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword)) continue;
          const init = member.initializer && strip(ts, member.initializer);
          if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) continue;
          add(member, `${st.name?.getText(sf) ?? 'default'}.${member.name.getText(sf)}`, 'static');
        }
      }
    };
    sf.statements.forEach(visit);
  }
  // A call whose type annotation does not tell that the value is not an object needs the type the
  // compiler gives it
  const pending = calls.filter((c) => !(c.d.type && isPlainTypeNode(ts, c.d.type)));
  if (pending.length > 0) {
    const program = ts.createProgram(
      files.map((f) => join(root, f)),
      compilerOptions(ts, root),
    );
    const checker = program.getTypeChecker();
    for (const { file, d, declaredName } of pending) {
      const sf = program.getSourceFile(join(root, file));
      const at = d.name.getStart(sources.get(file));
      const node = nodeAt(ts, sf, at, d.name.kind);
      if (node && isPlainType(ts, checker.getTypeAtLocation(node))) continue;
      const line = sf.getLineAndCharacterOfPosition(at).line + 1;
      found.push({ file, name: declaredName, kind: 'call', line });
    }
  }
  return found.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
}

/** An expression with `as`, `satisfies` and parentheses taken off */
function strip(ts, expression) {
  let e = expression;
  while (
    e &&
    (ts.isAsExpression(e) || ts.isSatisfiesExpression?.(e) || ts.isParenthesizedExpression(e))
  ) {
    e = e.expression;
  }
  return e;
}

/** Whether `as const` is among the casts over the value */
function hasAsConst(ts, expression) {
  let e = expression;
  while (
    e &&
    (ts.isAsExpression(e) || ts.isSatisfiesExpression?.(e) || ts.isParenthesizedExpression(e))
  ) {
    if (
      ts.isAsExpression(e) &&
      ts.isTypeReferenceNode(e.type) &&
      ts.isIdentifier(e.type.typeName) &&
      e.type.typeName.text === 'const'
    ) {
      return true;
    }
    e = e.expression;
  }
  return false;
}

/**
 * What a top-level `const` is counted as: a kind, `'call'` for a call whose value is still to be
 * told, or null when it is not counted
 */
function constKind(ts, sf, d) {
  if (isReadonlyType(ts, d.type)) return null;
  const init = strip(ts, d.initializer);
  if (!init) return null;
  if (ts.isObjectLiteralExpression(init) || ts.isArrayLiteralExpression(init)) {
    if (hasAsConst(ts, d.initializer)) return null;
    return ts.isObjectLiteralExpression(init) ? 'object' : 'array';
  }
  if (ts.isNewExpression(init)) return `new ${init.expression.getText(sf)}`;
  if (ts.isRegularExpressionLiteral(init)) {
    const flags = init.text.slice(init.text.lastIndexOf('/') + 1);
    return /[gy]/.test(flags) ? 'regex' : null;
  }
  if (ts.isCallExpression(init)) {
    if (FREEZERS.has(init.expression.getText(sf))) return null;
    return 'call';
  }
  return null;
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

/** Whether a type annotation says the value is not an object: a primitive, a literal or a function */
function isPlainTypeNode(ts, type) {
  if (ts.isParenthesizedTypeNode(type)) return isPlainTypeNode(ts, type.type);
  if (ts.isUnionTypeNode(type)) return type.types.every((t) => isPlainTypeNode(ts, t));
  if (ts.isFunctionTypeNode(type) || ts.isLiteralTypeNode(type)) return true;
  if (ts.isTypeOperatorNode(type) && type.operator === ts.SyntaxKind.UniqueKeyword) return true;
  return [
    ts.SyntaxKind.StringKeyword,
    ts.SyntaxKind.NumberKeyword,
    ts.SyntaxKind.BooleanKeyword,
    ts.SyntaxKind.BigIntKeyword,
    ts.SyntaxKind.SymbolKeyword,
    ts.SyntaxKind.UndefinedKeyword,
  ].includes(type.kind);
}

/** Whether a type of the compiler is not an object: a primitive, a literal or a function */
function isPlainType(ts, type) {
  if (type.isUnion()) return type.types.every((t) => isPlainType(ts, t));
  const plain =
    ts.TypeFlags.StringLike |
    ts.TypeFlags.NumberLike |
    ts.TypeFlags.BooleanLike |
    ts.TypeFlags.BigIntLike |
    ts.TypeFlags.ESSymbolLike |
    ts.TypeFlags.Undefined |
    ts.TypeFlags.Null;
  if (type.flags & plain) return true;
  // A function: what has call signatures and no members of its own
  return type.getCallSignatures().length > 0 && type.getProperties().length === 0;
}

/** The compiler options of the repository (those of tsconfig.json), or strict defaults */
function compilerOptions(ts, root) {
  const file = join(root, 'tsconfig.json');
  const defaults = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    skipLibCheck: true,
  };
  if (!existsSync(file)) return defaults;
  const read = ts.readConfigFile(file, (p) => readFileSync(p, 'utf8'));
  if (read.error) return defaults;
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(file));
  return { ...parsed.options, noEmit: true, composite: false, declaration: false };
}

/** The node of a kind that starts at a position of a source file */
function nodeAt(ts, sf, at, kind) {
  const find = (node) => {
    if (node.getStart(sf) === at && node.kind === kind) return node;
    if (node.pos > at || node.end <= at) return undefined;
    return ts.forEachChild(node, find);
  };
  return ts.forEachChild(sf, find);
}

/** @param {{ root: string }} ctx */
export function check(ctx) {
  const { root } = ctx;
  const out = result(name);
  const listName = 'module-state-allowed.json';
  const rows = readList(root, listName).state ?? [];
  rows.forEach((r) => {
    if (!REASONS.includes(r.reason)) {
      out.errors.push(
        `a row of scripts/gates/${listName} without one of the reasons (${REASONS.join(', ')}): ${r.file} ${r.name} ${JSON.stringify(r.reason ?? null)}`,
      );
    }
  });
  const used = new Set();
  for (const s of moduleState(root)) {
    const i = rows.findIndex((r) => r.file === s.file && r.name === s.name);
    if (i >= 0) used.add(i);
    else out.errors.push(`${s.file}:${s.line}: module state ${s.kind} ${s.name}`);
  }
  rows.forEach((r, i) => {
    if (!used.has(i)) {
      out.errors.push(
        `no longer module state; remove it from scripts/gates/${listName}: ${r.file} ${r.name}`,
      );
    }
  });
  return out;
}
