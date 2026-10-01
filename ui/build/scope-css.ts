// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// Keeps the style sheets of kata inside the root element of the interface, so that nothing of
// them reaches the page around it.
//
// kata puts its tokens on :root and a few rules of the components on every element, because a
// kata application owns the whole page. This interface lives inside a page it does not own, so
// the build rewrites those two sheets:
//
// - the tokens: :root becomes the root element (`:root:lang(ja)` becomes `.mgd-ui:lang(ja)`),
//   and a rule that applies to any element (the light theme, the language switches) applies to
//   the root element, to the elements inside it, and to the root element under an ancestor that
//   matches (a page that sets `data-color-mode="light"` on its body)
// - the shared rules of the components: each selector is limited to the elements inside the
//   root element, without changing its specificity
//
// The styles of the components themselves are scoped by Svelte already and are left as they are.
// The base sheet of kata (a reset of the page) is not part of the build at all.

import type { Plugin, Root, Rule } from 'postcss';
import postcss from 'postcss';

/** The class of the root element of the interface */
export const SCOPE = '.mgd-ui';

/** The kind of a style sheet of kata, from its path */
export type KataSheet = 'tokens' | 'components';

/** Which sheet of kata a file is, or null for any other file */
export function kataSheet(file: string | undefined): KataSheet | null {
  if (!file) return null;
  const path = file.replaceAll('\\', '/');
  if (!path.includes('/@sakuzu/kata/')) return null;
  if (/\/dist\/(tokens|kata)\.css$/.test(path)) return 'tokens';
  if (path.endsWith('/svelte/styles/components.css')) return 'components';
  return null;
}

/** Splits a selector list at its top-level commas */
function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (quote) {
      if (c === quote && list[i - 1] !== '\\') quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '(' || c === '[') {
      depth += 1;
    } else if (c === ')' || c === ']') {
      depth -= 1;
    } else if (c === ',' && depth === 0) {
      out.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(list.slice(start).trim());
  return out.filter(Boolean);
}

/** The selectors of a rule of the tokens, moved from the page to the root element */
export function scopeTokenSelector(selector: string, scope = SCOPE): string[] {
  if (selector.includes(':root')) return [selector.replaceAll(':root', scope)];
  return [`${scope}:is(${selector})`, `${selector} ${scope}`, `:where(${scope}) ${selector}`];
}

/** A selector of the shared rules of the components, limited to the inside of the root element */
export function scopeComponentSelector(selector: string, scope = SCOPE): string {
  return `:where(${scope}) ${selector}`;
}

function rewrite(rule: Rule, sheet: KataSheet, scope: string): void {
  // The steps of a @keyframes rule are not selectors
  const parent = rule.parent;
  if (parent?.type === 'atrule' && /keyframes$/i.test((parent as { name: string }).name)) return;
  const selectors = splitSelectors(rule.selector);
  const next =
    sheet === 'tokens'
      ? selectors.flatMap((s) => scopeTokenSelector(s, scope))
      : selectors.map((s) => scopeComponentSelector(s, scope));
  rule.selector = next.join(',\n');
}

/** Rewrites one sheet of kata, given as a parsed root */
export function scopeRoot(root: Root, sheet: KataSheet, scope = SCOPE): void {
  root.walkRules((rule) => rewrite(rule, sheet, scope));
}

/** Rewrites one sheet of kata, given as text */
export function scopeCss(css: string, sheet: KataSheet, scope = SCOPE): string {
  const root = postcss.parse(css);
  scopeRoot(root, sheet, scope);
  return root.toString();
}

/**
 * The PostCSS plugin of the build: it rewrites the tokens and the shared rules of kata where
 * they come in, and leaves every other file alone
 */
export function scopeKata(scope = SCOPE): Plugin {
  return {
    postcssPlugin: 'scope-kata',
    Once(root) {
      const sheet = kataSheet(root.source?.input.file);
      if (sheet) scopeRoot(root, sheet, scope);
    },
  };
}
