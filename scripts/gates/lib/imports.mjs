// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// Reads the imports of a TypeScript or JavaScript file with the parser of TypeScript.

import { loadTypeScript } from './ts.mjs';

/**
 * Every import of a file: `import`, `import type`, `export ... from`, `import('...')` in a type
 * and in an expression, and `require('...')`.
 *
 * @param {string} fileName
 * @param {string} text
 * @returns {{ spec: string, typeOnly: boolean, names: string[], line: number, node: any }[]}
 *   `typeOnly` is true when the import is erased at runtime (`import type`, `export type`, an
 *   import whose names are all `type X`, and `import('...')` in a type position)
 */
export function importsOf(fileName, text) {
  const ts = loadTypeScript();
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const out = [];
  const lineOf = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const named =
        clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
          ? clause.namedBindings.elements
          : [];
      const names = [
        ...(clause?.name ? [clause.name.text] : []),
        ...named.map((e) => e.name.text),
        ...(clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)
          ? [`* as ${clause.namedBindings.name.text}`]
          : []),
      ];
      const typeOnly = Boolean(
        clause &&
          (clause.isTypeOnly ||
            (!clause.name &&
              named.length > 0 &&
              named.every((e) => e.isTypeOnly) &&
              !(clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)))),
      );
      out.push({ spec: node.moduleSpecifier.text, typeOnly, names, line: lineOf(node), node });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const named =
        node.exportClause && ts.isNamedExports(node.exportClause) ? node.exportClause.elements : [];
      const typeOnly = node.isTypeOnly || (named.length > 0 && named.every((e) => e.isTypeOnly));
      out.push({
        spec: node.moduleSpecifier.text,
        typeOnly,
        names: named.map((e) => e.name.text),
        line: lineOf(node),
        node,
      });
    } else if (ts.isImportTypeNode(node)) {
      const arg = node.argument;
      if (ts.isLiteralTypeNode(arg) && ts.isStringLiteral(arg.literal)) {
        out.push({
          spec: arg.literal.text,
          typeOnly: true,
          names: node.qualifier ? [node.qualifier.getText(sf)] : [],
          line: lineOf(node),
          node,
        });
      }
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      out.push({
        spec: node.arguments[0].text,
        typeOnly: false,
        names: [],
        line: lineOf(node),
        node,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}
