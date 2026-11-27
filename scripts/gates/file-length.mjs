// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The gate of the length of the source files of the library (src/ without the tests, the
// end-to-end tests and the test helpers, as the other gates choose them). A file holds at most
// LIMIT lines of code. A line of code is a line with a character that is not white space in a
// token of the file: the file is parsed into its syntax tree, and the blank lines and the lines
// that hold only comments do not count. A `//` or `/*` in a string, a template literal or a
// regular expression is a part of that token, not a comment.
//
// The files longer than that now are in scripts/gates/file-length-baseline.json, with their
// lengths. The gate fails when a file of the list is longer than the list gives, when a file of
// the list is no longer than LIMIT or is gone, and when a file the list does not have is longer
// than LIMIT. So the list only gets shorter. Only the maintainer adds to the list.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { libraryFiles, readList, result } from './lib/files.mjs';
import { loadTypeScript } from './lib/ts.mjs';

export const name = 'file-length';

/** The most lines of code a source file holds */
export const LIMIT = 800;

/**
 * The number of the lines of code of a file
 *
 * @param {string} text
 * @param {string} file The path, which chooses between TypeScript and JavaScript
 * @returns {number}
 */
export function codeLines(text, file) {
  const ts = loadTypeScript();
  const kind = /\.(js|mjs|cjs)$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const lines = new Set();
  const mark = (start, end) => {
    let line = sf.getLineAndCharacterOfPosition(start).line;
    for (let i = start; i < end; i += 1) {
      const c = text.charCodeAt(i);
      if (c === 10) line += 1;
      else if (!/\s/.test(text[i])) lines.add(line);
    }
  };
  // The leaves of the tree are its tokens; the comments are the trivia between them. The TSDoc
  // is a node of the tree of its own, and is left out as the comment it is.
  const visit = (n) => {
    const children = n.getChildren(sf).filter((c) => !ts.isJSDoc(c));
    if (children.length === 0) {
      mark(n.getStart(sf), n.end);
      return;
    }
    for (const c of children) visit(c);
  };
  visit(sf);
  return lines.size;
}

/**
 * The number of the lines of code of every source file of a tree
 *
 * @param {string} root
 * @returns {Map<string, number>}
 */
export function lengthsOf(root) {
  const out = new Map();
  for (const file of libraryFiles(root)) {
    out.set(file, codeLines(readFileSync(join(root, file), 'utf8'), file));
  }
  return out;
}

/** @param {{ root: string }} ctx */
export function check(ctx) {
  const { root } = ctx;
  const out = result(name);
  const base = readList(root, 'file-length-baseline.json').files ?? {};
  const now = lengthsOf(root);
  for (const [file, n] of now) {
    const was = base[file];
    if (was === undefined) {
      if (n > LIMIT) {
        out.errors.push(`${file}: ${n} lines of code, more than ${LIMIT}`);
      }
    } else if (n > was) {
      out.errors.push(`${file}: ${n} lines of code, the baseline is ${was}`);
    } else if (n <= LIMIT) {
      out.errors.push(
        `${file}: ${n} lines of code, no more than ${LIMIT}; remove it from scripts/gates/file-length-baseline.json`,
      );
    } else if (n < was) {
      out.notes.push(`${file} is ${n} lines of code, ${was} in the baseline`);
    }
  }
  for (const file of Object.keys(base)) {
    if (!now.has(file)) {
      out.errors.push(
        `${file}: not a source file of the library; remove it from scripts/gates/file-length-baseline.json`,
      );
    }
  }
  return out;
}
