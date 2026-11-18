// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// Reads the text of a source file the way the gate of the forbidden terms looks at it: every
// identifier, every string value, the text of every part of a template literal and every comment,
// by line. The file is parsed into its syntax tree first; a scan of the raw tokens loses track of
// the tokens after a template literal with a `${...}`, and reads the rest of such a file as
// something else.
//
// The reader checks itself: it counts the identifiers it gave, and the identifiers of the tree
// counted on their own. The two numbers must be the same, or the gate fails on the file.

import { loadTypeScript } from './ts.mjs';

/**
 * @param {string} text
 * @param {string} file The path, which chooses between TypeScript and JavaScript
 * @returns {{ lines: Map<number, string>, identifiers: number, inTree: number, comments: number }}
 */
export function readCode(text, file) {
  const ts = loadTypeScript();
  const kind = /\.(js|mjs|cjs)$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const lines = new Map();
  const add = (pos, s) => {
    // A comment or a string over several lines is cut at its line breaks
    let line = sf.getLineAndCharacterOfPosition(pos).line + 1;
    for (const part of s.split('\n')) {
      lines.set(line, `${lines.get(line) ?? ''} ${part}`);
      line += 1;
    }
  };
  const seen = new Set();
  const comment = (r) => {
    if (seen.has(r.pos)) return;
    seen.add(r.pos);
    add(r.pos, text.slice(r.pos, r.end));
  };
  let identifiers = 0;
  // Every node and token of the tree, the comments around each of them included. A comment is the
  // leading comment of the token after it, or the trailing one of the token before it on its line.
  const visit = (n) => {
    for (const r of ts.getLeadingCommentRanges(text, n.pos) ?? []) comment(r);
    for (const r of ts.getTrailingCommentRanges(text, n.end) ?? []) comment(r);
    if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) {
      identifiers += 1;
      add(n.getStart(sf), n.getText(sf));
      return;
    }
    if (
      ts.isStringLiteral(n) ||
      ts.isNoSubstitutionTemplateLiteral(n) ||
      ts.isTemplateHead(n) ||
      ts.isTemplateMiddle(n) ||
      ts.isTemplateTail(n) ||
      ts.isJsxText(n)
    ) {
      add(n.getStart(sf), n.getText(sf));
      return;
    }
    // The TSDoc is read as the comment it is
    for (const c of n.getChildren(sf)) if (!ts.isJSDoc(c)) visit(c);
  };
  visit(sf);

  // The identifiers of the tree, counted on their own
  let inTree = 0;
  const count = (n) => {
    if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) inTree += 1;
    ts.forEachChild(n, count);
  };
  count(sf);
  return { lines, identifiers, inTree, comments: seen.size };
}
