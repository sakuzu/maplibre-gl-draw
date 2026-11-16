// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The gate of the import boundaries, on the sources and on the build output (dist/).
//
// - The layers of scripts/gates/layers.json: a file imports from a lower area or from its own
//   area only. A type-only import that points the wrong way fails like a runtime one (the check
//   of scripts/check-layers.mjs only lists it). The rules of that check stay: nothing imports the
//   webgl entry, dispatcher does not import operations, dataset does not import store, and
//   snapping imports from view only the vertex handles of view/ui/handles.
// - The files of the public types (scripts/gates/layers.json, `publicTypes`) do not import the
//   types of the internal files, not even with a type-only import.
// - `@sakuzu/kasane` is imported only from the folders of scripts/gates/kasane-import-folders.json,
//   and `@sakuzu/tabane` from nowhere.
// - No relative import leaves src/ (or dist/ for the build output).
//
// The imports the gate would fail on that the published version already has wait in
// scripts/gates/layers-pending.json and scripts/gates/public-types-pending.json. A row there
// that no longer matches fails, so the lists only get shorter.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
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
  const layersPending = new Set(readList(root, 'layers-pending.json').imports ?? []);
  const publicPending = new Set(readList(root, 'public-types-pending.json').imports ?? []);
  const publicTypes = layers.publicTypes.map(globToRegExp);
  const isPublicType = (src) => publicTypes.some((re) => re.test(src)) && !isTestFile(src);

  const areaOf = (src) => {
    const parts = src.slice(4).split('/');
    if (parts.length === 1) return layers.rootFiles[parts[0]] ?? null;
    return parts[0] in layers.areas ? parts[0] : null;
  };
  const rank = (area) => layers.areas[area].rank;

  /** The rule an import breaks, or null */
  const brokenRule = (from, to) => {
    const a = areaOf(from);
    const b = areaOf(to);
    if (a === b) return null;
    if (b === 'webgl') return `nothing imports the webgl entry (${a} -> webgl)`;
    if (a === 'dispatcher' && b === 'operations') return 'dispatcher does not import operations';
    if (a === 'dataset' && b === 'store') return 'dataset does not import store';
    if (a === 'snapping' && b === 'view' && !to.startsWith('src/view/ui/handles')) {
      return 'snapping imports only view/ui/handles of view';
    }
    if (rank(a) > rank(b)) return null;
    return `a lower area imports a higher one (${a} -> ${b})`;
  };

  const usedLayers = new Set();
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
      const rule = brokenRule(from, to);
      if (rule) {
        if (layersPending.has(edge)) usedLayers.add(edge);
        else out.errors.push(`${at}: ${rule}: ${edge}${imp.typeOnly ? ' (type only)' : ''}`);
      }
      if (isPublicType(from) && !isPublicType(to) && isTypeImport(root, rel, imp, to)) {
        if (publicPending.has(edge)) usedPublic.add(edge);
        else out.errors.push(`${at}: a file of the public types imports an internal type: ${edge}`);
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
  for (const edge of layersPending) {
    if (!usedLayers.has(edge)) {
      out.errors.push(
        `no longer imported; remove it from scripts/gates/layers-pending.json: ${edge}`,
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
 * Whether an import of a file of the public types brings a type: a type-only import, any import
 * in a declaration file, or an imported name that the target declares as an interface or a type.
 */
function isTypeImport(root, rel, imp, to) {
  if (imp.typeOnly || rel.endsWith('.d.ts')) return true;
  const ts = loadTypeScript();
  const node = imp.node;
  const names =
    ts.isImportDeclaration(node) &&
    node.importClause?.namedBindings &&
    ts.isNamedImports(node.importClause.namedBindings)
      ? node.importClause.namedBindings.elements.map((e) => ({
          name: (e.propertyName ?? e.name).text,
          type: e.isTypeOnly,
        }))
      : ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)
        ? node.exportClause.elements.map((e) => ({
            name: (e.propertyName ?? e.name).text,
            type: e.isTypeOnly,
          }))
        : [];
  return names.some((n) => n.type || declaresType(root, to, n.name, 0));
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
