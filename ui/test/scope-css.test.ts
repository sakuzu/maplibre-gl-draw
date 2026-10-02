// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import {
  kataSheet,
  scopeComponentSelector,
  scopeCss,
  scopeKata,
  scopeTokenSelector,
} from '../build/scope-css.js';

const require = createRequire(import.meta.url);
const kata = dirname(require.resolve('@sakuzu/kata/package.json'));
const tokensFile = join(kata, 'dist/tokens.css');
const componentsFile = join(kata, 'dist/svelte/styles/components.css');

/** Every selector of a sheet */
function selectors(css: string): string[] {
  const out: string[] = [];
  postcss.parse(css).walkRules((rule) => {
    out.push(...rule.selectors);
  });
  return out;
}

describe('the tokens of kata', () => {
  const css = scopeCss(readFileSync(tokensFile, 'utf8'), 'tokens');

  it('have no :root selector left', () => {
    const all = selectors(css);
    expect(all.length).toBeGreaterThan(0);
    for (const s of all) expect(s).not.toMatch(/:root/);
  });

  it('are on the root element of the interface and the control container of the map, with the language switches', () => {
    const all = selectors(css);
    expect(all).toContain('.mgd-ui');
    expect(all).toContain('.mgd-ui:lang(ja)');
    expect(all).toContain('[data-mgd-ui-controls]');
    expect(all).toContain('[data-mgd-ui-controls]:lang(ja)');
  });

  it('reach no element outside the root element and the control container of the map', () => {
    for (const s of selectors(css)) expect(s).toMatch(/\.mgd-ui|\[data-mgd-ui-controls\]/);
  });

  it('take the light theme from the root element, the control container or from around them', () => {
    expect(scopeTokenSelector('[data-color-mode="light"]')).toEqual([
      '.mgd-ui:is([data-color-mode="light"])',
      '[data-color-mode="light"] .mgd-ui',
      ':where(.mgd-ui) [data-color-mode="light"]',
      '[data-mgd-ui-controls]:is([data-color-mode="light"])',
      '[data-color-mode="light"] [data-mgd-ui-controls]',
      ':where([data-mgd-ui-controls]) [data-color-mode="light"]',
    ]);
  });

  it('turn :root into the root element and the control container wherever it is in a selector', () => {
    expect(scopeTokenSelector(':root:lang(ko)')).toEqual([
      '.mgd-ui:lang(ko)',
      '[data-mgd-ui-controls]:lang(ko)',
    ]);
    expect(scopeTokenSelector(':root')).toEqual(['.mgd-ui', '[data-mgd-ui-controls]']);
  });
});

describe('the shared rules of the components', () => {
  const source = readFileSync(componentsFile, 'utf8');
  const css = scopeCss(source, 'components');

  it('apply inside the root element only', () => {
    const all = selectors(css);
    expect(all.length).toBe(selectors(source).length);
    for (const s of all) expect(s.startsWith(':where(.mgd-ui) ')).toBe(true);
  });

  it('keep their specificity', () => {
    expect(scopeComponentSelector('[data-role="rule"] + :where(p)')).toBe(
      ':where(.mgd-ui) [data-role="rule"] + :where(p)',
    );
  });
});

describe('the PostCSS plugin', () => {
  it('rewrites the sheets of kata and nothing else', async () => {
    const own = '.mgd-ui { color: red; } :root { --x: 1; }';
    const plugin = scopeKata();
    const kept = await postcss([plugin]).process(own, { from: '/app/src/styles/root.css' });
    expect(kept.css).toBe(own);
    const tokens = await postcss([plugin]).process(':root { --x: 1; }', { from: tokensFile });
    expect(tokens.css).toBe('.mgd-ui,\n[data-mgd-ui-controls] { --x: 1; }');
  });

  it('knows the sheets of kata by their paths', () => {
    expect(kataSheet(tokensFile)).toBe('tokens');
    expect(kataSheet(componentsFile)).toBe('components');
    expect(kataSheet(join(kata, 'dist/base.css'))).toBeNull();
    expect(kataSheet('/app/src/tokens.css')).toBeNull();
    expect(kataSheet(undefined)).toBeNull();
  });
});
