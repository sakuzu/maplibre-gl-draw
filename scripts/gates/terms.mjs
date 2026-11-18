// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The gate of the forbidden terms.
//
// Looks in the declarations the build emits (names, string values, TSDoc), those that wait in
// scripts/gates/api-pending.json included; the identifiers, string values, template literals and
// comments of the sources of src/, bench/, playground/ and ui/; the documents (CHANGELOG.md among
// them), the examples and the names of the tests. Every text is cut into lower-case words first
// (scripts/gates/lib/words.mjs), so case, camelCase, snake_case, kebab-case and quotes make no
// difference, and `pro` is found as a word of its own but not in `provider` or `property`.
//
// A source file is read from its syntax tree (scripts/gates/lib/code-text.mjs), and the gate fails
// on a file whose identifiers it did not all read. A Svelte, HTML or CSS file of those folders is
// read line by line, as the documents are. The samples of api/ are not read: they are part of the
// fixed declarations, which are kept by their digests.
//
// The terms come from two lists: scripts/gates/terms.json, kept in git, and the local lists of
// the names of products and extensions under scripts/terms.local/, which git does not keep. Without
// the local lists the gate fails; only the CI of the public repository (GITHUB_ACTIONS=true) passes
// with a notice.
//
// A hit is one term found on one line (or in one declaration). An exception is a row of
// scripts/gates/terms-allowed.json with its reason and the number of hits it allows (`hits`) of
// its term in its place. The gate fails when a place has more hits of the term than its row
// allows (one was added), and when it has fewer (lower the row, or remove it when there is none
// left), so the list holds exactly what is there.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readCode } from './lib/code-text.mjs';
import { recordsOfBuild } from './lib/declarations.mjs';
import { isTestFile, readList, result, walk } from './lib/files.mjs';
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

/** The folders of the other packages of the repository, whose sources are read too */
const OTHER_SOURCES = ['bench', 'playground', 'ui'];
const CODE = /\.(ts|mts|js|mjs)$/;
const LINES = /\.(svelte|html|css)$/;

/**
 * @param {{ root: string, env?: Record<string, string | undefined>, built?: ReturnType<typeof recordsOfBuild> }} ctx
 */
export function check(ctx) {
  const { root } = ctx;
  const env = ctx.env ?? process.env;
  const out = { ...result(name), hits: [], found: [] };
  const list = readList(root, 'terms.json');
  const allowed = readList(root, 'terms-allowed.json').allowed ?? [];

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

  /** @type {{ where: string, term: string, shown: string, text: string }[]} */
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

  // The declarations of the build, those that wait for their fixed form included
  const built = ctx.built ?? recordsOfBuild(root);
  for (const [entry, records] of Object.entries(built.entries)) {
    for (const [key, rec] of Object.entries(records)) {
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

  // The sources: every identifier, string value, template literal and comment, from the tree
  let files = 0;
  let identifiers = 0;
  const readSource = (file, terms) => {
    const text = readFileSync(join(root, file), 'utf8');
    const code = readCode(text, file);
    files += 1;
    identifiers += code.identifiers;
    if (code.identifiers !== code.inTree) {
      out.errors.push(
        `${file}: the gate read ${code.identifiers} of the ${code.inTree} identifiers of its syntax tree`,
      );
    }
    for (const [line, t] of code.lines) look(`${file}:${line}`, t, terms);
    return text;
  };
  const readLines = (file, terms) => {
    const lines = readFileSync(join(root, file), 'utf8').split('\n');
    lines.forEach((t, i) => {
      look(`${file}:${i + 1}`, t, terms);
    });
  };

  // src/: the code may name the row library; the names of the tests may not
  for (const file of walk(root, 'src', (f) => /\.(ts|mts)$/.test(f))) {
    const text = readSource(file, everywhere);
    if (isTestFile(file)) {
      for (const [line, t] of testNamesByLine(text)) look(`${file}:${line}`, t, rowLibrary);
    }
  }
  // The other packages of the repository
  for (const folder of OTHER_SOURCES) {
    for (const file of walk(root, folder, (f) => CODE.test(f) || LINES.test(f))) {
      if (CODE.test(file)) readSource(file, [...everywhere, ...rowLibrary]);
      else readLines(file, [...everywhere, ...rowLibrary]);
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
    ...[
      'README.md',
      'README.ja.md',
      'CONTRIBUTING.md',
      'CONTRIBUTING.ja.md',
      'SECURITY.md',
      'CHANGELOG.md',
    ].filter((f) => existsSync(join(root, f))),
    ...walk(root, 'docs', (f) => f.endsWith('.md') && !GENERATED.some((g) => f.startsWith(g))),
    ...walk(root, 'examples', (f) => TEXT.test(f) && !f.includes('/public/')),
  ];
  for (const file of docs) readLines(file, [...everywhere, ...rowLibrary]);

  // The exceptions: a row allows a number of hits of one term in one place (and in one line of
  // it, by its text)
  const place = (where) => where.replace(/:\d+$/, '');
  /** @type {Map<number, typeof hits>} */
  const byRow = new Map();
  for (const h of hits) {
    const i = allowed.findIndex(
      (a) =>
        a.where === place(h.where) &&
        a.term === h.term &&
        (a.text === undefined || a.text === h.text),
    );
    if (i >= 0) {
      if (!byRow.has(i)) byRow.set(i, []);
      byRow.get(i).push(h);
      continue;
    }
    out.errors.push(`${h.where}: [${h.shown}] ${h.text.slice(0, 160)}`);
    out.hits.push(h);
  }
  allowed.forEach((a, i) => {
    const found = byRow.get(i) ?? [];
    const row = `${a.where} [${a.term}]`;
    if (!a.reason) out.errors.push(`an exception without a reason: ${row}`);
    if (!Number.isInteger(a.hits) || a.hits < 1) {
      out.errors.push(`an exception without the number of its hits: ${row}`);
    } else if (found.length === 0) {
      out.errors.push(
        `an exception of scripts/gates/terms-allowed.json matches nothing; remove it: ${row}`,
      );
    } else if (found.length > a.hits) {
      out.errors.push(
        `${row}: ${found.length} hits, the exception allows ${a.hits}; new ones were added (the hits: ${found
          .map((h) => h.where.slice(place(h.where).length + 1) || h.where)
          .join(', ')})`,
      );
      for (const h of found) out.hits.push(h);
    } else if (found.length < a.hits) {
      out.errors.push(
        `${row}: ${found.length} hits, the exception allows ${a.hits}; lower its hits to ${found.length}`,
      );
    }
  });
  out.notes.push(`${files} source files read from their syntax trees, ${identifiers} identifiers`);
  // Every hit, the allowed ones included, for the tools that write the rows
  out.found = hits;
  return out;
}
