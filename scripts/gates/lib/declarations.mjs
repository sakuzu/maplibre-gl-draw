// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// Reads the public declarations of the package in a form that can be compared: one record per
// declaration and per member, each with its signature and its TSDoc.
//
// The two sides are written differently. The build emits one declaration file per source file,
// with `import("...")` types and the aliases the source chose; the fixed declarations are one
// hand-kept file per entry. Both are reduced to the same normal form before they are compared:
//
// - a name that refers to a declaration of the package becomes the name it is declared with, and a
//   name that refers to another package becomes `<package>.<name>` (so `import("geojson").Feature`,
//   `GeoJSONFeature` imported as an alias and `Feature` imported from `geojson` are the same);
// - the signature is cut into tokens without comments and whitespace, a separator before a closing
//   bracket is dropped, and string literals are written with one kind of quote;
// - the TSDoc is compared as text with its whitespace and line breaks collapsed.
//
// The build side is read with the type checker: every export of the entry, and every declaration
// of the package an export refers to that no other entry exports, as the fixed file holds them.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadTypeScript } from './ts.mjs';

/** The entries of the package: the id used in the names of the fixed files, and the subpath */
export const ENTRIES = [
  { id: 'main', subpath: '.' },
  { id: 'geometry', subpath: './geometry' },
  { id: 'store', subpath: './store' },
  { id: 'table', subpath: './table' },
  { id: 'webgl', subpath: './webgl' },
];

/** @param {string} id */
export const fixedFileOf = (id) => `api/core.${id}.d.ts`;

const OWN_PACKAGE = /^@sakuzu\/maplibre-gl-draw(\/|$)/;

/** The names a fixed file imports from the other entries of the package */
export const OWN_IMPORTS = Symbol('own imports');

/** Words after which `[` and `<` start something new rather than index or instantiate */
const KEYWORDS = new Set(['readonly', 'keyof', 'typeof', 'unique', 'infer', 'extends', 'in', 'is']);

/**
 * The normal form of a piece of declaration text: its tokens without comments and whitespace.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeSignature(text) {
  const ts = loadTypeScript();
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const tokens = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind === ts.SyntaxKind.GreaterThanToken) {
      // `>>` and `>=` are scanned as one `>` here, which is what a type wants
      tokens.push('>');
      continue;
    }
    if (kind === ts.SyntaxKind.StringLiteral) {
      tokens.push(`'${scanner.getTokenValue().replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`);
      continue;
    }
    tokens.push(scanner.getTokenText());
  }
  const out = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    const next = tokens[i + 1];
    if ((t === ';' || t === ',') && (next === undefined || /^[}\])>]$/.test(next))) continue;
    out.push(t);
  }
  while (out[0] === 'export' || out[0] === 'declare') out.shift();
  let s = '';
  for (let i = 0; i < out.length; i += 1) {
    const t = out[i];
    const prev = out[i - 1];
    const afterName = /^[A-Za-z_$][\w$]*$/.test(prev ?? '') && !KEYWORDS.has(prev);
    const tight =
      i === 0 ||
      /^[,;:)\].>?]$/.test(t) ||
      /^[([<.]$/.test(prev) ||
      (t === '(' && !/^[=|&:,]$|=>/.test(prev)) ||
      ((t === '<' || t === '[') && (afterName || /^[\])>]$/.test(prev)));
    s += (tight ? '' : ' ') + t;
  }
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * The TSDoc of a node, without the entry description, with whitespace collapsed
 *
 * @param {import('typescript').Node} node
 * @param {import('typescript').SourceFile} sf
 */
function docOf(node, sf) {
  // The TSDoc of a declaration is the last one in front of it; an earlier one describes the file
  const docs = (node.jsDoc ?? []).filter((d) => !isEntryDoc(d, sf));
  return docs.length ? normalizeDoc(docs[docs.length - 1].getText(sf)) : '';
}

/** @param {string} text The text of one or more `/** ... *\/` comments */
export function normalizeDoc(text) {
  return text
    .replace(/\/\*\*|\*\//g, '')
    .replace(/^\s*\*\s?/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isEntryDoc(jsDoc, sf) {
  return /@module\b|@packageDocumentation\b/.test(jsDoc.getText(sf));
}

/** The entry description: the first TSDoc of the file that carries `@module` */
function entryDocOf(sf) {
  const ts = loadTypeScript();
  for (const st of sf.statements) {
    for (const d of st.jsDoc ?? []) if (isEntryDoc(d, sf)) return normalizeDoc(d.getText(sf));
  }
  // A file of only comments: look at the leading comments of the end of the file
  const ranges = ts.getLeadingCommentRanges(sf.text, 0) ?? [];
  for (const r of ranges) {
    const t = sf.text.slice(r.pos, r.end);
    if (t.startsWith('/**') && /@module\b/.test(t)) return normalizeDoc(t);
  }
  return null;
}

/** Whether an identifier stands where a name refers to a declaration */
function isReference(ts, id) {
  const p = id.parent;
  if (!p) return false;
  if (ts.isTypeReferenceNode(p)) return p.typeName === id;
  if (ts.isQualifiedName(p)) return p.left === id;
  if (ts.isExpressionWithTypeArguments(p)) return p.expression === id;
  if (ts.isTypeQueryNode(p)) return p.exprName === id;
  if (ts.isPropertyAccessExpression(p)) return p.expression === id;
  if (ts.isComputedPropertyName(p)) return true;
  return false;
}

function isDroppedMember(ts, node) {
  if (!(ts.isClassElement(node) || ts.isTypeElement(node))) return false;
  const mods = ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [];
  if (mods.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword)) return true;
  if (node.name && ts.isPrivateIdentifier(node.name)) return true;
  return ts.getJSDocTags(node).some((t) => t.tagName.text === 'internal');
}

/**
 * The normal text of a node, with its references written in the normal form
 *
 * @param {import('typescript').Node} node
 * @param {import('typescript').SourceFile} sf
 * @param {(id: import('typescript').Node) => string | null} refName The normal name of a reference
 */
function signatureOf(node, sf, refName) {
  const ts = loadTypeScript();
  const start = node.getStart(sf, false);
  // Leave out the TSDoc in front of the node
  const bodyStart = node.jsDoc?.length ? node.jsDoc[node.jsDoc.length - 1].getEnd() : start;
  const end = node.getEnd();
  const edits = [];
  const visit = (n) => {
    if (n !== node && isDroppedMember(ts, n)) {
      edits.push({ start: n.getFullStart(), end: n.getEnd(), text: '' });
      return;
    }
    if (ts.isImportTypeNode(n)) {
      const name = refName(n);
      if (name !== null) {
        const q = n.qualifier;
        edits.push({ start: n.getStart(sf), end: q ? q.getEnd() : n.getEnd(), text: name });
        for (const a of n.typeArguments ?? []) visit(a);
        return;
      }
    }
    if (ts.isIdentifier(n) && isReference(ts, n)) {
      const name = refName(n);
      if (name !== null && name !== n.text) {
        edits.push({ start: n.getStart(sf), end: n.getEnd(), text: name });
      }
      return;
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(node, visit);
  let text = sf.text.slice(bodyStart, end);
  for (const e of edits.sort((a, b) => b.start - a.start)) {
    const s = Math.max(e.start, bodyStart) - bodyStart;
    text = text.slice(0, s) + e.text + text.slice(e.end - bodyStart);
  }
  return normalizeSignature(text);
}

function memberName(ts, m, sf) {
  if (m.name) return m.name.getText(sf).replace(/^['"]|['"]$/g, '');
  if (ts.isCallSignatureDeclaration(m)) return '()';
  if (ts.isIndexSignatureDeclaration(m)) return '[index]';
  if (ts.isConstructSignatureDeclaration(m)) return 'new()';
  if (ts.isConstructorDeclaration(m)) return 'constructor';
  return '?';
}

function lineOf(sf, node) {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function walkMembers(prefix, members, sf, refName, out, file) {
  const ts = loadTypeScript();
  const counts = {};
  for (const m of members) {
    if (isDroppedMember(ts, m)) continue;
    let n = memberName(ts, m, sf);
    counts[n] = (counts[n] ?? 0) + 1;
    if (counts[n] > 1) n = `${n}#${counts[n]}`;
    const key = `${prefix}.${n}`;
    const base = { doc: docOf(m, sf), file, line: lineOf(sf, m) };
    if (m.type && ts.isTypeLiteralNode(m.type)) {
      const mods = ts.canHaveModifiers(m) ? (ts.getModifiers(m) ?? []) : [];
      const ro = mods.some((x) => x.kind === ts.SyntaxKind.ReadonlyKeyword) ? 'readonly ' : '';
      out[key] = { ...base, sig: `${ro}${m.questionToken ? '?' : ''}: {…}` };
      walkMembers(key, m.type.members, sf, refName, out, file);
      continue;
    }
    out[key] = { ...base, sig: signatureOf(m, sf, refName) };
  }
}

/**
 * Adds the records of one top-level declaration
 *
 * @param {import('typescript').Statement} st
 * @param {string} name The name the record is kept under
 * @param {boolean} exported
 */
function addStatement(st, name, exported, sf, refName, out, file) {
  const ts = loadTypeScript();
  let key = name;
  for (let i = 2; out[key]; i += 1) key = `${name}#overload${i}`;
  const base = { exported, doc: docOf(st, sf), file, line: lineOf(sf, st) };
  const tp = (decl) =>
    decl.typeParameters
      ? `<${decl.typeParameters.map((t) => signatureOf(t, sf, refName)).join(', ')}>`
      : '';
  if (ts.isInterfaceDeclaration(st) || ts.isClassDeclaration(st)) {
    const kind = ts.isInterfaceDeclaration(st) ? 'interface' : 'class';
    const heritage = (st.heritageClauses ?? []).map((h) => signatureOf(h, sf, refName)).join(' ');
    out[key] = { ...base, sig: `${kind}${tp(st)}${heritage ? ` ${heritage}` : ''}` };
    walkMembers(key, st.members, sf, refName, out, file);
    return;
  }
  if (ts.isTypeAliasDeclaration(st)) {
    if (ts.isTypeLiteralNode(st.type)) {
      out[key] = { ...base, sig: `type${tp(st)} {…}` };
      walkMembers(key, st.type.members, sf, refName, out, file);
      return;
    }
    out[key] = { ...base, sig: `type${tp(st)} = ${signatureOf(st.type, sf, refName)}` };
    const literals = [];
    const find = (n) => {
      if (ts.isTypeLiteralNode(n)) {
        literals.push(n);
        return;
      }
      ts.forEachChild(n, find);
    };
    find(st.type);
    literals.forEach((l, i) => {
      walkMembers(`${key}{${i}}`, l.members, sf, refName, out, file);
    });
    return;
  }
  out[key] = { ...base, sig: signatureOf(st, sf, refName) };
}

/** @returns {string | null} The declared name of a top-level statement */
function statementName(ts, st) {
  if (ts.isVariableStatement(st)) {
    return st.declarationList.declarations.map((d) => d.name.getText()).join(',');
  }
  if (ts.isModuleDeclaration(st)) return `module:${st.name.getText()}`;
  if (
    ts.isInterfaceDeclaration(st) ||
    ts.isTypeAliasDeclaration(st) ||
    ts.isFunctionDeclaration(st) ||
    ts.isClassDeclaration(st) ||
    ts.isEnumDeclaration(st)
  ) {
    return st.name?.text ?? null;
  }
  return null;
}

function hasExportModifier(ts, st) {
  const mods = ts.canHaveModifiers(st) ? (ts.getModifiers(st) ?? []) : [];
  return mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

/**
 * The records of a hand-kept declaration file (one entry in one file)
 *
 * @param {string} file
 * @param {string} [text] The text, when it is not read from the file
 * @returns {Record<string, {sig: string, doc: string, exported?: boolean, file: string, line: number}>}
 */
export function recordsOfFixedFile(file, text = readFileSync(file, 'utf8')) {
  const ts = loadTypeScript();
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const imported = new Map();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause) continue;
    const spec = st.moduleSpecifier.text;
    const own = OWN_PACKAGE.test(spec);
    const bindings = st.importClause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) {
        const name = (el.propertyName ?? el.name).text;
        imported.set(el.name.text, own ? name : `${spec}.${name}`);
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      imported.set(bindings.name.text, own ? '' : spec);
    }
  }
  const refName = (n) => {
    if (ts.isImportTypeNode(n)) {
      const spec = n.argument.literal.text;
      const q = n.qualifier ? n.qualifier.getText(sf) : '';
      return OWN_PACKAGE.test(spec) || spec.startsWith('.') ? q : `${spec}.${q}`;
    }
    return imported.get(n.text) ?? null;
  };
  const out = {};
  // The names the file takes from another entry of the package: the build side holds them as
  // declarations of its own, and they are left out of the comparison there
  Object.defineProperty(out, OWN_IMPORTS, {
    value: new Set([...imported].filter(([, v]) => !v.includes('.')).map(([, v]) => v)),
  });
  const entryDoc = entryDocOf(sf);
  if (entryDoc !== null) out['(entry)'] = { sig: '', doc: entryDoc, file, line: 1 };
  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
      const spec = st.moduleSpecifier?.text;
      for (const el of st.exportClause.elements) {
        const local = (el.propertyName ?? el.name).text;
        const sig = spec && !OWN_PACKAGE.test(spec) ? `${spec}.${local}` : local;
        out[`export:${el.name.text}`] = { sig, doc: '', file, line: lineOf(sf, st) };
      }
      continue;
    }
    const name = statementName(ts, st);
    if (name === null) continue;
    addStatement(st, name, hasExportModifier(ts, st), sf, refName, out, file);
  }
  return out;
}

function packageOfFile(f) {
  const m = f.match(/node_modules\/((?:@types\/)?(?:@[^/]+\/)?[^/]+)\//);
  if (!m) return null;
  return m[1].startsWith('@types/') ? m[1].slice(7) : m[1];
}

/**
 * Reads the declarations the build emitted for every entry the package lists
 *
 * @param {string} root The root of the package
 * @returns {{ entries: Record<string, Record<string, any>>, missing: string[], problems: string[] }}
 */
export function recordsOfBuild(root) {
  const ts = loadTypeScript();
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const distDir = resolve(root, 'dist');
  const files = {};
  const missing = [];
  for (const { id, subpath } of ENTRIES) {
    const target = pkg.exports?.[subpath];
    const types = typeof target === 'object' && target ? target.types : null;
    const file = types ? resolve(root, types) : null;
    if (!file || !existsSync(file)) missing.push(id);
    else files[id] = file;
  }
  const options = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    types: [],
  };
  const program = ts.createProgram({ rootNames: Object.values(files), options });
  const checker = program.getTypeChecker();
  const isLocal = (f) => f.startsWith(`${distDir}/`);
  const problems = [];

  const finalSymbol = (sym) =>
    sym && sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
  const topStatement = (decl) => {
    if (ts.isVariableDeclaration(decl)) {
      const st = decl.parent?.parent;
      return st && ts.isVariableStatement(st) && ts.isSourceFile(st.parent) ? st : undefined;
    }
    return decl.parent && ts.isSourceFile(decl.parent) ? decl : undefined;
  };
  /** The local top-level statements a symbol is declared by */
  const statementsOf = (sym) => {
    const s = finalSymbol(sym);
    if (!s?.declarations) return [];
    return [
      ...new Set(
        s.declarations
          .map((d) => topStatement(d))
          .filter((st) => st && isLocal(st.getSourceFile().fileName)),
      ),
    ];
  };

  // What each entry exports, by the first statement of the declaration
  const exportsOf = {};
  const external = [];
  for (const [id, file] of Object.entries(files)) {
    const sf = program.getSourceFile(file);
    const moduleSym = sf && checker.getSymbolAtLocation(sf);
    const map = new Map();
    for (const e of moduleSym ? checker.getExportsOfModule(moduleSym) : []) {
      const sts = statementsOf(e);
      if (sts.length === 0) {
        const decl = finalSymbol(e)?.declarations?.[0];
        const p = decl ? packageOfFile(decl.getSourceFile().fileName) : null;
        if (p)
          external.push({ id, name: e.name, sig: `${p}.${String(finalSymbol(e).escapedName)}` });
        else problems.push(`${id}: the export ${e.name} is not declared in the package`);
        continue;
      }
      const key = sts[0];
      if (!map.has(key)) map.set(key, { statements: sts, names: [] });
      map.get(key).names.push(e.name);
    }
    exportsOf[id] = map;
  }

  const declaredName = (st) => statementName(ts, st);
  const entries = {};
  for (const [id, file] of Object.entries(files)) {
    const own = exportsOf[id];
    const queue = [...own.keys()];
    const statements = new Map([...own].map(([k, v]) => [k, v.statements]));
    const refName = (n) => {
      if (ts.isImportTypeNode(n)) {
        const spec = n.argument.literal.text;
        const q = n.qualifier;
        if (!q) return null;
        const right = ts.isQualifiedName(q) ? q.right : q;
        if (!spec.startsWith('.') && !OWN_PACKAGE.test(spec)) return `${spec}.${q.getText()}`;
        const sts = statementsOf(checker.getSymbolAtLocation(right));
        if (sts.length === 0) return null;
        reach(sts);
        return declaredName(sts[0]);
      }
      const sym = checker.getSymbolAtLocation(n);
      if (!sym) return null;
      if (sym.flags & ts.SymbolFlags.Alias) {
        const d = sym.declarations?.[0];
        let spec = null;
        let importedName = null;
        if (d && ts.isImportSpecifier(d)) {
          spec = d.parent.parent.parent.moduleSpecifier.text;
          importedName = (d.propertyName ?? d.name).text;
        } else if (d && ts.isImportClause(d)) {
          spec = d.parent.moduleSpecifier.text;
          importedName = 'default';
        } else if (d && ts.isNamespaceImport(d)) {
          spec = d.parent.parent.moduleSpecifier.text;
          if (!spec.startsWith('.') && !OWN_PACKAGE.test(spec)) return spec;
        }
        if (spec && !spec.startsWith('.') && !OWN_PACKAGE.test(spec)) {
          return `${spec}.${importedName}`;
        }
      }
      const sts = statementsOf(sym);
      if (sts.length > 0) {
        reach(sts);
        return declaredName(sts[0]);
      }
      const f = finalSymbol(sym)?.declarations?.[0]?.getSourceFile().fileName;
      const p = f && !f.includes('/typescript/lib/') ? packageOfFile(f) : null;
      if (p && !(sym.flags & ts.SymbolFlags.TypeParameter)) {
        return `${p}.${String(finalSymbol(sym).escapedName)}`;
      }
      return null;
    };
    function reach(sts) {
      const key = sts[0];
      if (statements.has(key)) return;
      statements.set(key, sts);
      queue.push(key);
    }
    const out = {};
    const sf = program.getSourceFile(file);
    const entryDoc = sf ? entryDocOf(sf) : null;
    if (entryDoc !== null) out['(entry)'] = { sig: '', doc: entryDoc, file, line: 1 };
    for (const x of external) {
      if (x.id === id) out[`export:${x.name}`] = { sig: x.sig, doc: '', file, line: 1 };
    }
    for (let i = 0; i < queue.length; i += 1) {
      const key = queue[i];
      const sts = statements.get(key);
      const name = declaredName(key);
      const exp = own.get(key);
      const exported = Boolean(exp?.names.includes(name));
      for (const st of sts) {
        const stSf = st.getSourceFile();
        addStatement(st, name, exported, stSf, refName, out, stSf.fileName);
      }
      for (const alias of exp?.names ?? []) {
        if (alias !== name) out[`export:${alias}`] = { sig: name, doc: '', file, line: 1 };
      }
    }
    // Two declarations of the same name would hide each other in the records
    const seen = new Map();
    for (const key of queue) {
      const name = declaredName(key);
      const f = key.getSourceFile().fileName;
      if (seen.has(name) && seen.get(name) !== f) {
        problems.push(`${id}: two declarations named ${name} (${seen.get(name)}, ${f})`);
      }
      seen.set(name, f);
    }
    entries[id] = out;
  }
  return { entries, missing, problems };
}

function isExportedTop(records, key) {
  const t = records[key.split(/[.{#]/)[0]];
  return Boolean(t?.exported);
}

/**
 * The differences between the records of the build and of the fixed file of one entry
 *
 * @param {string} id The entry
 * @param {Record<string, any> | null} built Null when the build has no such entry
 * @param {Record<string, any>} fixed
 * @returns {{ key: string, text: string }[]} One item per difference; `key` names it
 */
export function diffRecords(id, built, fixed) {
  const out = [];
  const taken = fixed[OWN_IMPORTS] ?? new Set();
  const top = (k) => k.split(/[.{#]/)[0];
  const b = Object.fromEntries(
    Object.entries(built ?? {}).filter(([k]) => !(taken.has(top(k)) && !isExportedTop(built, k))),
  );
  const short = (s) => (s.length > 200 ? `${s.slice(0, 200)}…` : s);
  for (const k of Object.keys(b)) {
    if (!(k in fixed))
      out.push({ key: `${id}:removed:${k}`, text: `built has ${k}: ${short(b[k].sig)}` });
  }
  for (const k of Object.keys(fixed)) {
    if (!(k in b)) {
      out.push({ key: `${id}:added:${k}`, text: `built lacks ${k}: ${short(fixed[k].sig)}` });
      continue;
    }
    if (b[k].sig !== fixed[k].sig) {
      out.push({
        key: `${id}:sig:${k}`,
        text: `${k}\n      built: ${short(b[k].sig)}\n      fixed: ${short(fixed[k].sig)}`,
      });
    } else if (b[k].doc !== fixed[k].doc) {
      out.push({ key: `${id}:doc:${k}`, text: `${k}: the TSDoc differs` });
    }
    if (fixed[k].exported !== undefined && b[k].exported !== fixed[k].exported) {
      out.push({
        key: `${id}:export:${k}`,
        text: `${k}: exported ${b[k].exported} in the build, ${fixed[k].exported} fixed`,
      });
    }
  }
  return out;
}
