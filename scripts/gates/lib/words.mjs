// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// Cuts text into lower-case words, so that a term is found whatever its case, inside an
// identifier written in camelCase, snake_case or kebab-case, and with or without quotes.

/**
 * The words of one identifier: `remoteClient`, `remote_client`, `remote-client` and
 * `REMOTE_CLIENT` all give `['remote', 'client']`; `XMLHttpRequest` gives `xml http request`.
 *
 * @param {string} identifier
 * @returns {string[]}
 */
export function splitIdentifier(identifier) {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([A-Za-z])/g, '$1 $2')
    .split(/[\s_\-$]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/**
 * The words of a piece of text, one space between two words. Everything that is not a letter
 * or a digit of the Latin script separates words; each run of them is then cut as an identifier.
 *
 * @param {string} text
 * @returns {string}
 */
export function wordsOf(text) {
  const out = [];
  for (const run of text.split(/[^A-Za-z0-9]+/)) {
    if (run) out.push(...splitIdentifier(run));
  }
  return out.join(' ');
}

/**
 * Compiles the terms of a list. A term is matched against the words of a text (see `wordsOf`),
 * so it is written in lower case with one space between words. A term with `"raw": true` is
 * matched against the text itself instead (for the words of other scripts, and for terms that
 * need the punctuation).
 *
 * @param {{ source: string, flags?: string, raw?: boolean }[]} terms
 */
export function compileTerms(terms) {
  return terms.map((t) => ({
    ...t,
    re: new RegExp(t.source, t.raw ? (t.flags ?? 'i') : `${(t.flags ?? '').replace('i', '')}i`),
  }));
}

/**
 * The terms of a compiled list found in a text
 *
 * @param {string} text
 * @param {ReturnType<typeof compileTerms>} terms
 * @param {string} [words] The words of the text, when they are already cut
 * @returns {string[]} The sources of the terms found
 */
export function findTerms(text, terms, words = wordsOf(text)) {
  const found = [];
  for (const t of terms) {
    if (t.re.test(t.raw ? text : words)) found.push(t.source);
  }
  return found;
}
