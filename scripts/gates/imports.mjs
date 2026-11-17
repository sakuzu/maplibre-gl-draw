// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The gate of the import boundaries, on the sources and on the build output (dist/).
//
// - The layers of scripts/gates/layers.json: a file imports from a lower area or from its own
//   area only. The rules of scripts/check-layers.mjs stay for the runtime imports: nothing imports
//   the webgl entry, dispatcher does not import operations, dataset does not import store, and
//   snapping imports from view only the vertex handles of view/ui/handles.
// - A type-only import that points the wrong way fails like a runtime one (the check of
//   scripts/check-layers.mjs only lists it), but three kinds of type-only import do not point the
//   wrong way: one into a file of the public types (the public types are the words every layer
//   uses), one between two areas of the same layer (the areas of the instance), and one from
//   extension/ into an area that uses it (rule 9 of scripts/check-layers.mjs). The webgl entry is
//   imported by nothing, not even a type.
// - The files of the public types (scripts/gates/layers.json, `publicTypes`) import a type only
//   when a fixed declaration file (api/core.*.d.ts, the five entries) declares a type of the same
//   name, wherever the imported file is. This holds between two files of the public types too. An
//   import that does not name what it brings (`import type * as`, `export * from`, `import("...")`
//   without a name) fails.
// - `@sakuzu/kasane` is imported only from the folders of scripts/gates/kasane-import-folders.json,
//   and `@sakuzu/tabane` from nowhere.
// - No relative import leaves src/ (or dist/ for the build output).
//
// The type-only imports against the layers that the published version already has are the rows of
// scripts/gates/layers-allowed.json, and the types the files of the public types import that the
// fixed declarations do not have wait in scripts/gates/public-types-pending.json. A row there that
// no longer matches fails, so the lists only get shorter.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { ENTRIES, fixedFileOf } from './lib/declarations.mjs';
import { isTestFile, readList, result, walk } from './lib/files.mjs';
import { importsOf } from './lib/imports.mjs';
import { loadTypeScript } from './lib/ts.mjs';

export const name = 'imports';

const KASANE = /^@sakuzu\/kasane(\/|$)/;
const TABANE = /^@sakuzu\/tabane(\/|$)/;

/** `src/a/b.ts` for `src/a/b.ts`, `dist/a/b.js` and `dist/a/b.d.ts` */
export function sourcePathOf(rel) {
  if (!rel.startsWith('dist/')) return rel;
  return `src/${rel
    .slice(5)
    .replace(/\.d\.ts$/, '.ts')
    .replace(/\.js$/, '.ts')}`;
}

function globToRegExp(glob) {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\0')
    .replace(/\*/g, '[^/]*')
    .replace(/\0/g, '.*');
  return new RegExp(`^${re}$`);
}

/**
 * @param {{ root: string }} ctx
 */
export function check(ctx) {
  const { root } = ctx;
  const out = result(name);
  const layers = readList(root, 'layers.json');
  const kasaneFolders = readList(root, 'kasane-import-folders.json').folders ?? [];
  const layersAllowed = new Set(readList(root, 'layers-allowed.json').imports ?? []);
  const publicPending = new Set(readList(root, 'public-types-pending.json').imports ?? []);
  const publicTypes = layers.publicTypes.map(globToRegExp);
  const publicNames = fixedTypeNames(root, out);
  const isPublicType = (src) => publicTypes.some((re) => re.test(src)) && !isTestFile(src);
  const layerOf = (area) => layers.areas[area]?.layer ?? null;

  const areaOf = (src) => {
    const parts = src.slice(4).split('/');
    if (parts.length === 1) return layers.rootFiles[parts[0]] ?? null;
    return parts[0] in layers.areas ? parts[0] : null;
  };
  const rank = (area) => layers.areas[area].rank;

  /** The rule an import breaks, or null */
  const brokenRule = (from, to, typeOnly) => {
    const a = areaOf(from);
    const b = areaOf(to);
    if (a === b) return null;
    if (b === 'webgl') return `nothing imports the webgl entry (${a} -> webgl)`;
    if (typeOnly) {
      // The three kinds of type-only import that do not point the wrong way
      if (isPublicType(to)) return null;
      if (layerOf(a) === 'instance' && layerOf(b) === 'instance') return null;
      if (a === 'extension' && b !== 'api' && b !== 'entry') return null;
    }
    if (a === 'dispatcher' && b === 'operations') return 'dispatcher does not import operations';
    if (a === 'dataset' && b === 'store') return 'dataset does not import store';
    if (a === 'snapping' && b === 'view' && !to.startsWith('src/view/ui/handles')) {
      return 'snapping imports only view/ui/handles of view';
    }
    if (rank(a) > rank(b)) return null;
    return `a lower area imports a higher one (${a} -> ${b})`;
  };

  const usedAllowed = new Set();
  const usedPublic = new Set();
  const seenUnknown = new Set();

  /** Checks the imports of one file of src/ or dist/ */
  const checkFile = (rel, base) => {
    const text = readFileSync(join(root, rel), 'utf8');
    const from = sourcePathOf(rel);
    const fromIsTest = isTestFile(from);
    for (const imp of importsOf(rel, text)) {
      const at = `${rel}:${imp.line}`;
      if (KASANE.test(imp.spec)) {
        const ok = kasaneFolders.some((f) => from.startsWith(`${f.replace(/\/$/, '')}/`));
        if (!ok) out.errors.push(`${at}: imports ${imp.spec} outside the folders allowed to`);
      }
      if (TABANE.test(imp.spec))
        out.errors.push(`${at}: imports ${imp.spec}; nothing in core does`);
      if (!imp.spec.startsWith('.')) continue;
      const target = normalize(join(dirname(rel), imp.spec))
        .split('\\')
        .join('/');
      if (target === '..' || target.startsWith('../') || !target.startsWith(`${base}/`)) {
        out.errors.push(`${at}: a relative import out of ${base}/: ${imp.spec}`);
        continue;
      }
      if (fromIsTest) continue;
      let to =
        base === 'src'
          ? target.replace(/\.js$/, '.ts')
          : sourcePathOf(target.replace(/\.js$/, rel.endsWith('.d.ts') ? '.d.ts' : '.js'));
      if (!existsSync(join(root, to)) && existsSync(join(root, to.replace(/\.ts$/, '/index.ts')))) {
        to = to.replace(/\.ts$/, '/index.ts');
      }
      for (const p of [from, to]) {
        if (areaOf(p) === null && !seenUnknown.has(p.split('/').slice(0, 2).join('/'))) {
          seenUnknown.add(p.split('/').slice(0, 2).join('/'));
          out.errors.push(`${p}: no area in scripts/gates/layers.json`);
        }
      }
      if (areaOf(from) === null || areaOf(to) === null) continue;
      const edge = `${from} -> ${to}`;
      // Every import of a declaration file is erased at runtime
      const typeOnly = imp.typeOnly || rel.endsWith('.d.ts');
      const rule = brokenRule(from, to, typeOnly);
      if (rule) {
        // Only a type-only import of the published version is allowed by the list
        if (typeOnly && layersAllowed.has(edge)) usedAllowed.add(edge);
        else out.errors.push(`${at}: ${rule}: ${edge}${typeOnly ? ' (type only)' : ''}`);
      }
      if (isPublicType(from)) {
        const names = typeNamesOf(root, rel, imp, to);
        if (names === null) {
          out.errors.push(
            `${at}: a file of the public types imports without naming the types: ${edge}`,
          );
          continue;
        }
        for (const n of names) {
          if (publicNames.has(n)) continue;
          const named = `${edge} (${n})`;
          if (publicPending.has(named)) usedPublic.add(named);
          else {
            out.errors.push(
              `${at}: a file of the public types imports a type the fixed declarations do not have: ${named}`,
            );
          }
        }
      }
    }
  };

  for (const rel of walk(root, 'src', (f) => /\.(ts|mts)$/.test(f) && !f.endsWith('.d.ts'))) {
    checkFile(rel, 'src');
  }
  if (!existsSync(join(root, 'dist'))) {
    out.errors.push('dist/ is missing: run the build first');
  } else {
    for (const rel of walk(root, 'dist', () => true)) {
      if (rel.endsWith('.js') || rel.endsWith('.d.ts')) checkFile(rel, 'dist');
    }
  }
  // walk() skips folders named dist; the build output is walked from its own root
  for (const edge of layersAllowed) {
    if (!usedAllowed.has(edge)) {
      out.errors.push(
        `no longer imported; remove it from scripts/gates/layers-allowed.json: ${edge}`,
      );
    }
  }
  for (const edge of publicPending) {
    if (!usedPublic.has(edge)) {
      out.errors.push(
        `no longer imported; remove it from scripts/gates/public-types-pending.json: ${edge}`,
      );
    }
  }
  return out;
}

/**
 * The names of the types declared in the fixed declaration files of the five entries: every
 * interface, type alias, class and enum, and every name a file re-exports from another module.
 * A missing file is an error of the gate.
 */
function fixedTypeNames(root, out) {
  const ts = loadTypeScript();
  const names = new Set();
  for (const { id } of ENTRIES) {
    const file = join(root, fixedFileOf(id));
    if (!existsSync(file)) {
      out.errors.push(`${fixedFileOf(id)} is missing: the fixed declarations of the entries`);
      continue;
    }
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    for (const st of sf.statements) {
      if (
        (ts.isInterfaceDeclaration(st) ||
          ts.isTypeAliasDeclaration(st) ||
          ts.isClassDeclaration(st) ||
          ts.isEnumDeclaration(st)) &&
        st.name
      ) {
        names.add(st.name.text);
      } else if (
        ts.isExportDeclaration(st) &&
        st.moduleSpecifier &&
        st.exportClause &&
        ts.isNamedExports(st.exportClause)
      ) {
        for (const el of st.exportClause.elements) names.add(el.name.text);
      }
    }
  }
  return names;
}

/**
 * The names of the types an import brings, by the names the target declares them with. A type-only
 * import and any import of a declaration file brings every name it lists but the names the target
 * declares as a value only (a constant or a function, which a declaration file re-exports as it
 * is); another import brings the names listed as `type X` and the names the target declares as an
 * interface or a type alias.
 *
 * @returns {string[] | null} null for an import that does not list its names (`* as`,
 *   `export *`, `import("...")` without a name) and brings a type
 */
function typeNamesOf(root, rel, imp, to) {
  const ts = loadTypeScript();
  const node = imp.node;
  const whole = imp.typeOnly || rel.endsWith('.d.ts');
  if (ts.isImportTypeNode(node)) {
    const q = node.qualifier;
    return q ? [(ts.isQualifiedName(q) ? leftmost(ts, q) : q).text] : null;
  }
  if (ts.isCallExpression(node)) return [];
  const bindings = ts.isImportDeclaration(node) ? node.importClause?.namedBindings : null;
  if (bindings && ts.isNamespaceImport(bindings)) return null;
  if (
    ts.isExportDeclaration(node) &&
    (!node.exportClause || ts.isNamespaceExport(node.exportClause))
  ) {
    return null;
  }
  const elements =
    bindings && ts.isNamedImports(bindings)
      ? bindings.elements
      : ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)
        ? node.exportClause.elements
        : [];
  const names = elements.map((e) => ({
    name: (e.propertyName ?? e.name).text,
    type: whole || e.isTypeOnly,
  }));
  const clause = ts.isImportDeclaration(node) ? node.importClause : null;
  if (clause?.name) names.push({ name: 'default', type: whole });
  return names
    .filter((e) =>
      e.type ? !declaresValueOnly(root, to, e.name, 0) : declaresType(root, to, e.name, 0),
    )
    .map((e) => e.name);
}

function leftmost(ts, q) {
  let n = q;
  while (ts.isQualifiedName(n)) n = n.left;
  return n;
}

/** Whether a source file declares (or re-exports) a name as an interface or a type alias only */
function declaresType(root, file, wanted, depth) {
  if (depth > 5 || !existsSync(join(root, file))) return false;
  const ts = loadTypeScript();
  const sf = ts.createSourceFile(
    file,
    readFileSync(join(root, file), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  for (const st of sf.statements) {
    if (
      (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) &&
      st.name.text === wanted
    ) {
      return true;
    }
    if (
      ts.isExportDeclaration(st) &&
      st.moduleSpecifier &&
      ts.isStringLiteral(st.moduleSpecifier)
    ) {
      const els =
        st.exportClause && ts.isNamedExports(st.exportClause) ? st.exportClause.elements : null;
      const el = els?.find((e) => e.name.text === wanted);
      if (els && !el) continue;
      const next = normalize(join(dirname(file), st.moduleSpecifier.text.replace(/\.js$/, '.ts')))
        .split('\\')
        .join('/');
      if (st.isTypeOnly || el?.isTypeOnly) return true;
      if (declaresType(root, next, el ? (el.propertyName ?? el.name).text : wanted, depth + 1))
        return true;
    }
  }
  return false;
}

/**
 * Whether a source file declares (or re-exports) a name as a value only: a constant, a variable or
 * a function, with no interface, type alias, class or enum of the same name
 */
function declaresValueOnly(root, file, wanted, depth) {
  if (depth > 5 || !existsSync(join(root, file))) return false;
  const ts = loadTypeScript();
  const sf = ts.createSourceFile(
    file,
    readFileSync(join(root, file), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  let value = false;
  for (const st of sf.statements) {
    if (
      (ts.isInterfaceDeclaration(st) ||
        ts.isTypeAliasDeclaration(st) ||
        ts.isClassDeclaration(st) ||
        ts.isEnumDeclaration(st)) &&
      st.name?.text === wanted
    ) {
      return false;
    }
    if (ts.isFunctionDeclaration(st) && st.name?.text === wanted) value = true;
    if (
      ts.isVariableStatement(st) &&
      st.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === wanted)
    ) {
      value = true;
    }
    if (
      ts.isExportDeclaration(st) &&
      st.moduleSpecifier &&
      ts.isStringLiteral(st.moduleSpecifier) &&
      st.exportClause &&
      ts.isNamedExports(st.exportClause)
    ) {
      const el = st.exportClause.elements.find((e) => e.name.text === wanted);
      if (!el) continue;
      if (st.isTypeOnly || el.isTypeOnly) return false;
      const next = normalize(join(dirname(file), st.moduleSpecifier.text.replace(/\.js$/, '.ts')))
        .split('\\')
        .join('/');
      return declaresValueOnly(root, next, (el.propertyName ?? el.name).text, depth + 1);
    }
  }
  return value;
}
