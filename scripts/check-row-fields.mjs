#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Checks that no code names a field of the values of rows (`RowField`) by a name it no longer
 * has.
 *
 * A field of a row is a string (`RowField` is `string`), so the type checker lets a name that is
 * gone through: the tables would refuse it when it is written, and read nothing when it is read. This
 * reads the code with the type checker and looks at the names where a field of a row goes:
 *
 * - the first argument of `get`, `has`, `set` and `delete` of a Map or a Set of fields of rows:
 *   one whose declared type names `RowField` (the `fields` of `RowValues`, `CreatedRows` and
 *   `LayerRowsChange` among them), or one made by `new Map<RowField, ...>` or
 *   `new Set<RowField>`, or returned by a function whose declared type names `RowField`
 * - the keys of the entries of such a Map made from an array of entries, and the entries of an
 *   array of fields declared as `RowField[]`
 * - an argument given where a parameter is declared as a `RowField`, and the value of a variable
 *   or a property declared as one
 *
 * A name is read from a string literal, or from the type of what is given (a union of string
 * literals, as `['a', 'b'] as const` gives). A string literal or a template that starts with the
 * old start of the fields of the attributes (`property:`) is an error wherever it is.
 *
 * The names of the features, the layers, the groups and the records (`Feature.layerId`,
 * `Feature.visible`, the fields of a record of the sync) are not fields of rows, so they are not
 * read. Any name found is an error (exit code 1).
 */
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The names of the fields of rows that are gone, and what they are now */
const GONE = new Map([
  ['visible', "'hidden' (of the opposite value)"],
  ['layerId', "'parent' (the layer, or the group in it)"],
  ['groupId', "'parent' (the group, in its layer)"],
  ['order', "'key' (the key in the layer, or in the group of a member)"],
  ['member', "'key' (the key in the group of a member)"],
]);

/** The start of the fields of the attributes that is gone, and what it is now */
const GONE_PREFIX = ['property:', "'properties:<key>'"];

/** The folders whose TypeScript is read besides the files of tsconfig.json */
const EXTRA = ['examples', 'bench', 'playground'];

/**
 * The files not read: the comparison with the record written before the fields were renamed
 * reads the record by the names it was written with
 */
const LEFT_OUT = new Set(['src/store/table-parity.test.ts']);

/** The methods of a Map or a Set whose first argument is a field */
const METHODS = new Set(['get', 'has', 'set', 'delete']);

function filesUnder(dir) {
  const out = [];
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else if (path.endsWith('.ts') && !path.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

const configPath = ts.findConfigFile(ROOT, ts.sys.fileExists, 'tsconfig.json');
const config = ts.getParsedCommandLineOfConfigFile(
  configPath,
  {},
  { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
);
const roots = [...config.fileNames, ...EXTRA.flatMap((dir) => filesUnder(join(ROOT, dir)))].filter(
  (file) => !LEFT_OUT.has(relative(ROOT, file)),
);
const program = ts.createProgram(roots, { ...config.options, noEmit: true });
const checker = program.getTypeChecker();

/** Whether a type node names `RowField` */
function namesRowField(node) {
  if (!node) return false;
  let found = false;
  const visit = (n) => {
    if (found) return;
    if (
      ts.isTypeReferenceNode(n) &&
      ts.isIdentifier(n.typeName) &&
      n.typeName.text === 'RowField'
    ) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** Whether an expression made a Map or a Set of fields: `new Map<RowField, ...>` */
function madeOfFields(node) {
  if (!node) return false;
  const inner = skipOuter(node);
  return ts.isNewExpression(inner) && (inner.typeArguments ?? []).some((arg) => namesRowField(arg));
}

function skipOuter(node) {
  let n = node;
  while (
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isSatisfiesExpression?.(n) ||
    ts.isNonNullExpression(n)
  ) {
    n = n.expression;
  }
  return n;
}

/** Whether a declaration declares a value that holds fields of rows */
function declaresFields(decl) {
  if (!decl) return false;
  if ('type' in decl && decl.type && namesRowField(decl.type)) return true;
  if (ts.isVariableDeclaration(decl) && madeOfFields(decl.initializer)) return true;
  if (ts.isPropertyDeclaration(decl) && madeOfFields(decl.initializer)) return true;
  return false;
}

/** Whether an expression is a Map or a Set of fields of rows */
function holdsFields(expr) {
  const node = skipOuter(expr);
  if (madeOfFields(node)) return true;
  if (ts.isCallExpression(node)) {
    const signature = checker.getResolvedSignature(node);
    const decl = signature?.getDeclaration();
    return !!decl && 'type' in decl && namesRowField(decl.type);
  }
  const symbol = checker.getSymbolAtLocation(
    ts.isPropertyAccessExpression(node) ? node.name : node,
  );
  if (!symbol) return false;
  const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  return (target.declarations ?? []).some((decl) => declaresFields(decl));
}

/**
 * Whether an identifier names a field of a row: a variable or a parameter declared as a
 * `RowField`, or the field of a loop over a Map or a Set of fields (`for (const field of fields)`,
 * `for (const [field, values] of fields)`)
 */
function isField(expr) {
  const node = skipOuter(expr);
  if (!ts.isIdentifier(node)) return false;
  const symbol = checker.getSymbolAtLocation(node);
  const decl = symbol?.valueDeclaration;
  if (!decl) return false;
  if ('type' in decl && decl.type && ts.isTypeReferenceNode(decl.type)) {
    return decl.type.typeName.getText() === 'RowField';
  }
  // The field of a loop over fields: the variable itself, or the first of an array pattern
  let binding = decl;
  if (ts.isBindingElement(binding)) {
    const pattern = binding.parent;
    if (!ts.isArrayBindingPattern(pattern) || pattern.elements[0] !== binding) return false;
    binding = pattern.parent;
  }
  if (!ts.isVariableDeclaration(binding)) return false;
  const list = binding.parent;
  const loop = list?.parent;
  return (
    !!loop && ts.isForOfStatement(loop) && loop.initializer === list && holdsFields(loop.expression)
  );
}

const problems = [];

function report(node, name) {
  const file = node.getSourceFile();
  const { line } = file.getLineAndCharacterOfPosition(node.getStart());
  const now = GONE.get(name) ?? GONE_PREFIX[1];
  problems.push(
    `${relative(ROOT, file.fileName)}:${line + 1}: '${name}' is not a field of a row; it is ${now}`,
  );
}

/** The names a value given as a field may be */
function namesOf(node) {
  const n = skipOuter(node);
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return [n.text];
  if (ts.isTemplateExpression(n)) return [];
  const type = checker.getTypeAtLocation(n);
  const types = type.isUnion() ? type.types : [type];
  return types.filter((t) => t.isStringLiteral()).map((t) => t.value);
}

/** Checks a value given as a field */
function checkName(node) {
  for (const name of namesOf(node)) if (GONE.has(name)) report(node, name);
}

/** Checks the entries of an array of fields, or of entries of fields */
function checkEntries(node, entries) {
  const n = skipOuter(node);
  if (!ts.isArrayLiteralExpression(n)) return;
  for (const element of n.elements) {
    if (ts.isSpreadElement(element)) continue;
    const e = skipOuter(element);
    if (entries) {
      if (ts.isArrayLiteralExpression(e) && e.elements.length > 0) checkName(e.elements[0]);
    } else {
      checkName(e);
    }
  }
}

function visit(node) {
  // The old start of the fields of the attributes, wherever it is
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    if (node.text.startsWith(GONE_PREFIX[0])) report(node, node.text);
  } else if (ts.isTemplateExpression(node) && node.head.text.startsWith(GONE_PREFIX[0])) {
    report(node, node.head.text);
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    // A method of a Map or a Set of fields
    if (
      ts.isPropertyAccessExpression(callee) &&
      METHODS.has(callee.name.text) &&
      node.arguments.length > 0 &&
      holdsFields(callee.expression)
    ) {
      checkName(node.arguments[0]);
    }
    // An argument where a parameter is a field
    const signature = checker.getResolvedSignature(node);
    const params = signature?.getDeclaration()?.parameters ?? [];
    node.arguments.forEach((arg, i) => {
      const param = params[Math.min(i, params.length - 1)];
      if (!param || !param.type) return;
      if (param.dotDotDotToken) {
        if (namesRowField(param.type)) checkName(arg);
      } else if (
        ts.isTypeReferenceNode(param.type) &&
        param.type.typeName.getText() === 'RowField'
      ) {
        checkName(arg);
      }
    });
  }
  // A field compared with a name
  if (
    ts.isBinaryExpression(node) &&
    [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(
      node.operatorToken.kind,
    )
  ) {
    if (isField(node.left)) checkName(node.right);
    else if (isField(node.right)) checkName(node.left);
  }
  if (ts.isSwitchStatement(node) && isField(node.expression)) {
    for (const clause of node.caseBlock.clauses) {
      if (ts.isCaseClause(clause)) checkName(clause.expression);
    }
  }
  // A Map or a Set of fields made of entries
  if (ts.isNewExpression(node) && madeOfFields(node) && node.arguments?.length) {
    const isMap = node.expression.getText() === 'Map';
    checkEntries(node.arguments[0], isMap);
  }
  // A variable or a property declared as fields
  if (
    (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) &&
    node.initializer &&
    node.type
  ) {
    if (ts.isTypeReferenceNode(node.type) && node.type.typeName.getText() === 'RowField') {
      checkName(node.initializer);
    } else if (namesRowField(node.type)) {
      checkEntries(node.initializer, false);
    }
  }
  // An object property given where fields of rows go (`fields: new Map([...])`)
  if (ts.isPropertyAssignment(node) && ts.isObjectLiteralExpression(node.parent)) {
    const contextual = checker.getContextualType(node.parent);
    const property = contextual?.getProperty?.(node.name.getText());
    const decl = property?.declarations?.[0];
    if (decl && 'type' in decl && namesRowField(decl.type)) {
      const value = skipOuter(node.initializer);
      if (ts.isNewExpression(value) && value.arguments?.length) {
        checkEntries(value.arguments[0], value.expression.getText() === 'Map');
      } else {
        checkEntries(value, false);
      }
    }
  }
  ts.forEachChild(node, visit);
}

for (const file of program.getSourceFiles()) {
  if (file.isDeclarationFile || file.fileName.includes('/node_modules/')) continue;
  if (!file.fileName.startsWith(ROOT)) continue;
  visit(file);
}

if (problems.length > 0) {
  console.log(`check-row-fields: ${problems.length} names that are not fields of rows`);
  for (const line of problems) console.log(`  ${line}`);
  process.exit(1);
}
console.log('check-row-fields: ok');
