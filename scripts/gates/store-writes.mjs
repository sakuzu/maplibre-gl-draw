// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The gate of the places that use the Store: a member of a value whose type is a type of the
// Store (the `types` of scripts/gates/store-write-files.json, by the file that declares them, or a
// type that extends or implements one of them) is read, written, called or subscribed to only in
// the `files` and the `folders` of that list (a folder holds the files directly in it). Every other part of the
// library goes through the layer over the Store, whose type is not a type of the Store, so the
// reads, the writes and the subscriptions keep to one rule. The values are told apart by their
// type, as the type checker of TypeScript gives it, and not by their names. A listed file that no
// longer uses the Store fails, so the list only holds what is there.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { libraryFiles, readList, result } from './lib/files.mjs';
import { loadTypeScript } from './lib/ts.mjs';

export const name = 'store-writes';

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

/** Whether a file may use the Store: one of the files, or a file directly in one of the folders */
function mayUse(file, list) {
  if ((list.files ?? []).includes(file)) return true;
  const folder = file.slice(0, file.lastIndexOf('/') + 1);
  return (list.folders ?? []).some((f) => (f.endsWith('/') ? f : `${f}/`) === folder);
}

/**
 * The uses of the members of the Store outside the files and folders that may use it, and the
 * uses in the listed files, by file
 *
 * @param {string} root
 * @param {{ types: Record<string, string[]>, files?: string[], folders?: string[] }} list
 * @returns {Map<string, { member: string, type: string, line: number }[]>}
 */
export function storeUses(root, list) {
  const ts = loadTypeScript();
  const files = libraryFiles(root);
  const program = ts.createProgram(
    files.map((f) => join(root, f)),
    compilerOptions(ts, root),
  );
  const checker = program.getTypeChecker();
  // The types of the Store, as `<file>:<name>` with the file relative to the root
  const types = new Set(
    Object.entries(list.types ?? {}).flatMap(([file, names]) => names.map((n) => `${file}:${n}`)),
  );
  const declaredAs = (declaration, name) =>
    `${relative(root, declaration.getSourceFile().fileName).split(sep).join('/')}:${name}`;
  const known = new Map();

  /**
   * The type of the Store a type is, extends or implements, or picks its members from (`Pick`,
   * `Partial` and the other mapped types of a type), as `<file>:<name>`, or null
   */
  const storeTypeOf = (type, seen = new Set()) => {
    if (!type || seen.has(type)) return null;
    seen.add(type);
    if (known.has(type)) return known.get(type);
    let found = null;
    if (type.isUnion() || type.isIntersection()) {
      for (const t of type.types) {
        found = storeTypeOf(t, seen);
        if (found) break;
      }
      known.set(type, found);
      return found;
    }
    const symbol = type.getSymbol();
    const declarations = symbol?.getDeclarations() ?? [];
    for (const named of [type.aliasSymbol, symbol]) {
      if (found || !named) continue;
      found =
        (named.getDeclarations() ?? [])
          .map((d) => declaredAs(d, named.getName()))
          .find((t) => types.has(t)) ?? null;
    }
    // A mapped type of a type of the Store (`Pick<Store, ...>`)
    if (!found && type.objectFlags & ts.ObjectFlags.Mapped) {
      for (const argument of type.aliasTypeArguments ?? []) {
        found = storeTypeOf(argument, seen);
        if (found) break;
      }
    }
    if (!found && symbol) {
      const target = type.target ?? type;
      for (const base of target.isClassOrInterface?.() ? checker.getBaseTypes(target) : []) {
        found = storeTypeOf(base, seen);
        if (found) break;
      }
    }
    if (!found) {
      for (const d of declarations) {
        for (const clause of d.heritageClauses ?? []) {
          for (const t of clause.types) {
            found = storeTypeOf(checker.getTypeAtLocation(t), seen);
            if (found) break;
          }
          if (found) break;
        }
        if (found) break;
      }
    }
    // What a const of a class expression makes (`const MemoryStore = class extends ...`)
    if (!found) {
      for (const signature of type.getConstructSignatures?.() ?? []) {
        found = storeTypeOf(signature.getReturnType(), seen);
        if (found) break;
      }
    }
    known.set(type, found);
    return found;
  };

  /** The type of the Store of an expression (`<file>:<name>`), or null */
  const storeTypeAt = (expression) => {
    const type = checker.getTypeAtLocation(expression);
    return storeTypeOf(checker.getNonNullableType(type));
  };

  const byFile = new Map();
  for (const file of files) {
    const listed = (list.files ?? []).includes(file);
    if (!listed && mayUse(file, list)) continue;
    const sf = program.getSourceFile(join(root, file));
    if (!sf) continue;
    const found = [];
    const add = (node, member, type) => {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      found.push({ member, type, line });
    };
    const visit = (node) => {
      if (ts.isPropertyAccessExpression(node)) {
        const type = storeTypeAt(node.expression);
        if (type) add(node, node.name.text, type);
      } else if (
        ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression)
      ) {
        const type = storeTypeAt(node.expression);
        if (type) add(node, node.argumentExpression.text, type);
      } else if (ts.isObjectBindingPattern(node)) {
        // The value taken apart (`const { getFeature } = store`)
        const type = storeTypeAt(node);
        if (type) {
          for (const element of node.elements) {
            const key = element.propertyName ?? element.name;
            add(element, key.getText(sf), type);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    if (found.length > 0) byFile.set(relative(root, sf.fileName).split(sep).join('/'), found);
  }
  return byFile;
}

/** @param {{ root: string }} ctx */
export function check(ctx) {
  const { root } = ctx;
  const out = result(name);
  const list = readList(root, 'store-write-files.json');
  const uses = storeUses(root, list);
  const files = new Set(list.files ?? []);
  for (const [file, found] of uses) {
    if (files.has(file)) continue;
    for (const u of found) {
      out.errors.push(
        `${file}:${u.line}: uses ${u.member} of a value of a type of the Store (${u.type}) outside the files and folders of scripts/gates/store-write-files.json; go through the layer over the Store`,
      );
    }
  }
  for (const f of files) {
    if (!uses.has(f))
      out.errors.push(
        `${f} no longer uses the Store; remove it from scripts/gates/store-write-files.json`,
      );
  }
  return out;
}
