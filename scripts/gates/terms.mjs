// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The gate of the forbidden terms.
//
// Looks in the declarations the build emits (names, string values, TSDoc), the identifiers and
// comments of src/, the documents, the examples and the names of the tests. Every text is cut into
// lower-case words first (scripts/gates/lib/words.mjs), so case, camelCase, snake_case,
// kebab-case and quotes make no difference, and `pro` is found as a word of its own but not in
// `provider` or `property`.
//
// The terms come from two lists: scripts/gates/terms.json, kept in git, and the local lists of
// the names of products and extensions under scripts/terms.local/, which git does not keep. Without
// the local lists the gate fails; only the CI of the public repository (GITHUB_ACTIONS=true) passes
// with a notice.
//
// An exception is a row of scripts/gates/terms-allowed.json with its reason. A row that no longer
// matches anything fails, so the list only holds what is there. A declaration that differs from
// the fixed one and waits in scripts/gates/api-pending.json is not looked at here: it becomes the
// text of api/, and the fixed text is what is checked when it is reached.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordsOfBuild } from './lib/declarations.mjs';
import { isTestFile, readList, result, walk } from './lib/files.mjs';
import { loadTypeScript } from './lib/ts.mjs';
import { compileTerms, wordsOf } from './lib/words.mjs';

export const name = 'terms';

const TEXT = /\.(md|ts|mts|js|mjs|html|css|json|svelte)$/;
/** The documents made from the declarations, which git does not keep */
const GENERATED = ['docs/api/', 'docs/reference/api/'];

/**
 * The local lists: every `extension` and `documents` term of the JSON files of the folder
 *
 * @returns {{ source: string, flags?: string }[] | null} Null when there is no list
 */
export function readLocalTerms(root) {
  const dir = join(root, 'scripts', 'terms.local');
  if (!existsSync(dir)) return null;
  const terms = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.json')) continue;
    let data;
    try {
      data = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    } catch {
      continue;
    }
    for (const key of ['extension', 'documents']) {
      for (const t of data[key] ?? []) if (t?.source) terms.push(t);
    }
  }
  return terms.length > 0 ? terms : null;
}

/** The local terms in both forms: on the text as written, and on its words */
function compileLocal(terms) {
  return [
    ...compileTerms(terms.map((t) => ({ source: t.source, flags: t.flags ?? '', raw: true }))),
    ...compileTerms(terms.map((t) => ({ source: t.source }))),
  ].map((t) => ({ ...t, local: true }));
}

/** The name of a term in a hit and in an exception: a local term is not written in git */
const LOCAL = '(local)';

/** The identifiers and comments of a TypeScript file, by line */
function codeTextByLine(text) {
  const ts = loadTypeScript();
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    text,
  );
  const lines = new Map();
  const lineStarts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (pos) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const add = (pos, s) => {
    // A comment over several lines is cut at its line breaks
    let line = lineOf(pos);
    for (const part of s.split('\n')) {
      lines.set(line, `${lines.get(line) ?? ''} ${part}`);
      line += 1;
    }
  };
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (
      kind === ts.SyntaxKind.Identifier ||
      kind === ts.SyntaxKind.PrivateIdentifier ||
      kind === ts.SyntaxKind.SingleLineCommentTrivia ||
      kind === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      add(scanner.getTokenStart(), scanner.getTokenText());
    }
  }
  return lines;
}

/** The names of the tests of a file (`it`, `test`, `describe` and their variants), by line */
function testNamesByLine(text) {
  const lines = new Map();
  const re =
    /(?<![.\w$])(?:it|test|describe|bench|suite)(?:\.\w+)*\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;
  for (const m of text.matchAll(re)) {
    const line = text.slice(0, m.index).split('\n').length;
    lines.set(line, `${lines.get(line) ?? ''} ${m[2]}`);
  }
  return lines;
}

/**
 * @param {{ root: string, env?: Record<string, string | undefined>, built?: ReturnType<typeof recordsOfBuild> }} ctx
 */
export function check(ctx) {
  const { root } = ctx;
  const env = ctx.env ?? process.env;
  const out = { ...result(name), hits: [] };
  const list = readList(root, 'terms.json');
  const allowed = readList(root, 'terms-allowed.json').allowed ?? [];
  const pending = new Set(
    Object.values(readList(root, 'api-pending.json').declarations ?? {}).flat(),
  );

  const local = readLocalTerms(root);
  if (local === null) {
    if (env.GITHUB_ACTIONS === 'true') {
      out.notes.push(
        'the local lists of product and extension names are not present: only the terms of scripts/gates/terms.json are checked',
      );
    } else {
      out.errors.push(
        'the local lists of product and extension names are not present (scripts/terms.local/*.json)',
      );
    }
  }
  const localTerms = local ? compileLocal(local) : [];
  const everywhere = [...compileTerms(list.everywhere), ...localTerms];
  const rowLibrary = compileTerms(list.rowLibrary);
  const declarations = [...compileTerms(list.declarations), ...everywhere];
  const mainEntry = compileTerms(list.mainEntry);

  /** @type {{ where: string, term: string, text: string }[]} */
  const hits = [];
  const look = (where, text, terms) => {
    const words = wordsOf(text);
    const found = new Set();
    for (const t of terms) {
      if (!t.re.test(t.raw ? text : words)) continue;
      const term = t.local ? LOCAL : t.source;
      if (found.has(term)) continue;
      found.add(term);
      hits.push({
        where,
        term,
        shown: t.local ? `${LOCAL} ${t.source}` : t.source,
        text: text.trim().replace(/\s+/g, ' '),
      });
    }
  };

  // The declarations of the build
  const built = ctx.built ?? recordsOfBuild(root);
  for (const [entry, records] of Object.entries(built.entries)) {
    for (const [key, rec] of Object.entries(records)) {
      const diffs = ['doc', 'sig', 'removed', 'export'].map((t) => `${entry}:${t}:${key}`);
      if (diffs.some((d) => pending.has(d))) continue;
      const top = key.split(/[.{#]/)[0];
      const text = `${key} ${rec.sig} ${rec.doc}`;
      const terms = [...declarations];
      const kasaneAllowed =
        entry === 'store' &&
        (key === '(entry)' || key === 'createStore' || key === 'createStore#overload2');
      if (!kasaneAllowed) terms.push(...rowLibrary);
      // As the check of the fixed declarations did: the words of rows and columns are those of the
      // datasets and of the table, and of the declarations the entry does not export
      const exported = records[top]?.exported !== false;
      if (entry === 'main' && exported && !/dataset|table/i.test(text)) terms.push(...mainEntry);
      look(`declarations/${entry}/${key}`, text, terms);
    }
  }

  // The identifiers and comments of src/, and the names of the tests
  for (const file of walk(root, 'src', (f) => /\.(ts|mts)$/.test(f))) {
    const text = readFileSync(join(root, file), 'utf8');
    for (const [line, t] of codeTextByLine(text)) look(`${file}:${line}`, t, everywhere);
    if (isTestFile(file)) {
      for (const [line, t] of testNamesByLine(text)) {
        look(`${file}:${line}`, t, [...everywhere, ...rowLibrary]);
      }
    }
  }
  for (const file of walk(root, 'scripts/gates', (f) => /\.test\.(ts|mjs)$/.test(f))) {
    const text = readFileSync(join(root, file), 'utf8');
    for (const [line, t] of testNamesByLine(text)) {
      look(`${file}:${line}`, t, [...everywhere, ...rowLibrary]);
    }
  }

  // The documents and the examples, every line
  const docs = [
    ...['README.md', 'README.ja.md', 'CONTRIBUTING.md', 'CONTRIBUTING.ja.md', 'SECURITY.md'].filter(
      (f) => existsSync(join(root, f)),
    ),
    ...walk(root, 'docs', (f) => f.endsWith('.md') && !GENERATED.some((g) => f.startsWith(g))),
    ...walk(root, 'examples', (f) => TEXT.test(f) && !f.includes('/public/')),
  ];
  for (const file of docs) {
    const lines = readFileSync(join(root, file), 'utf8').split('\n');
    lines.forEach((t, i) => {
      look(`${file}:${i + 1}`, t, [...everywhere, ...rowLibrary]);
    });
  }

  // The exceptions: a row allows one term in one place (and in one line of it, by its text)
  const used = new Set();
  const place = (where) => where.replace(/:\d+$/, '');
  for (const h of hits) {
    const i = allowed.findIndex(
      (a) =>
        a.where === place(h.where) &&
        a.term === h.term &&
        (a.text === undefined || a.text === h.text),
    );
    if (i >= 0) {
      used.add(i);
      continue;
    }
    out.errors.push(`${h.where}: [${h.shown}] ${h.text.slice(0, 160)}`);
    out.hits.push(h);
  }
  allowed.forEach((a, i) => {
    if (!used.has(i)) {
      out.errors.push(
        `an exception of scripts/gates/terms-allowed.json matches nothing; remove it: ${a.where} [${a.term}]`,
      );
    }
    if (!a.reason) out.errors.push(`an exception without a reason: ${a.where} [${a.term}]`);
  });
  return out;
}
