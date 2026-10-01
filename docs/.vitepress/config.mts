// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The configuration of the documentation site (VitePress)
 *
 * The site reads the documents in docs/ where they are, so that they stay readable on GitHub
 * and the documentation gate (`npm run docs:check`) keeps checking the same files. A Japanese
 * document `X.ja.md` is served under /ja/. A link to a file that the site does not serve (the
 * internals, the sources, the examples, the generated API reference) is rewritten to the page
 * that shows it: GitHub, the live example, or the API reference.
 *
 * The pages of the examples (docs/examples-pages/) show each example live, in a frame: a fence
 * of the language `example` names it, and the theme's ExampleFrame renders it. The build puts
 * the built examples under /examples/ of the site, where the frames find them.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import type MarkdownIt from 'markdown-it';
import { type DefaultTheme, defineConfig } from 'vitepress';

const REPO = 'https://github.com/sakuzu/maplibre-gl-draw';
const LIVE = 'https://sakuzu.github.io/maplibre-gl-draw';
const BASE = '/maplibre-gl-draw/';
/** The root of the repository */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** The documents the site serves, relative to docs/ */
const SITE_PAGE =
  /^(index|getting-started|guides\/[a-z-]+|examples-pages\/[a-z-]+|reference\/(README|data-format|events)|api\/.+)(\.ja)?\.md$/;

/** The source path (relative to docs/) of a page, from the path VitePress gives the renderer */
function sourceOf(relativePath: string): string {
  const ja = relativePath.match(/^ja\/(.+)\.md$/);
  return ja ? `${ja[1]}.ja.md` : relativePath;
}

/** Rewrites the target of a relative link written for GitHub into its place on the site */
function siteHref(href: string, sourcePath: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#') || href.startsWith('//')) {
    return href;
  }
  const hashAt = href.indexOf('#');
  const path = hashAt === -1 ? href : href.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : href.slice(hashAt);
  if (path === '') return href;
  // The path relative to the repository root
  let target = posix.normalize(posix.join('docs', posix.dirname(sourcePath), path));
  // TypeDoc copies a document that the API index links to into _media/; link the page instead
  const media = target.match(/^docs\/api\/_media\/(.+)$/);
  if (media) target = `docs/${media[1]}`;

  const example = target.match(/^examples\/([a-z-]+)\/?$/);
  if (example) return `${LIVE}/examples/${example[1]}/${hash}`;
  if (target === 'examples' || target === 'examples/README.md') return `${LIVE}/examples/`;

  if (target.startsWith('docs/')) {
    const doc = target.slice('docs/'.length);
    if (SITE_PAGE.test(doc)) {
      const ja = doc.endsWith('.ja.md');
      const page = doc.replace(/\.ja\.md$/, '.md').replace(/README\.md$/, 'index.md');
      return `/${ja ? 'ja/' : ''}${page}${hash}`;
    }
  }
  const isDir = path.endsWith('/') || !posix.extname(target);
  return `${REPO}/${isDir ? 'tree' : 'blob'}/main/${target}${hash}`;
}

/** Characters of Japanese (and Chinese) text, between which a line break is not a space */
const CJK = /[\u3000-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/;

/**
 * Drops the line breaks of the source between two Japanese characters
 *
 * The documents wrap lines for the diff, and a browser shows a line break in the source as a
 * space, which Japanese text does not have.
 */
function cjkBreaks(md: MarkdownIt): void {
  md.core.ruler.push('cjk-breaks', (state) => {
    for (const block of state.tokens) {
      const children = block.children ?? [];
      children.forEach((token, i) => {
        if (token.type !== 'softbreak') return;
        const before = children[i - 1]?.content ?? '';
        const after = children[i + 1]?.content ?? '';
        if (CJK.test(before.slice(-1)) && CJK.test(after.slice(0, 1))) {
          token.type = 'text';
          token.content = '';
        }
      });
    }
  });
}

/**
 * Renders a fence of the language `example` as the live example it names, in a frame:
 *
 *     ```example
 *     get-started
 *     ```
 *
 * A fence, not an HTML tag, so that the page stays plain Markdown for markdownlint and GitHub.
 * A name that is not a folder of examples/ with a page fails the build.
 */
function exampleFrames(md: MarkdownIt): void {
  const fence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    if (token.info.trim() !== 'example') {
      if (fence) return fence(tokens, idx, options, env, self);
      return self.renderToken(tokens, idx, options);
    }
    const name = token.content.trim();
    if (!/^[a-z-]+$/.test(name) || !existsSync(join(ROOT, 'examples', name, 'index.html'))) {
      throw new Error(`No example named "${name}" in examples/`);
    }
    return `<ExampleFrame name="${name}" />\n`;
  };
}

function linkRewrite(md: MarkdownIt): void {
  md.core.ruler.push('site-links', (state) => {
    const source = sourceOf((state.env as { relativePath?: string }).relativePath ?? '');
    for (const block of state.tokens) {
      for (const token of block.children ?? []) {
        if (token.type !== 'link_open') continue;
        const href = token.attrGet('href');
        if (href !== null) token.attrSet('href', siteHref(href, source));
      }
    }
  });
}

/** The entry points in the order a reader needs them, with the name they are imported by */
const ENTRY_POINTS = [
  ['maplibre-gl-draw', '@sakuzu/maplibre-gl-draw'],
  ['geometry', '@sakuzu/maplibre-gl-draw/geometry'],
  ['table', '@sakuzu/maplibre-gl-draw/table'],
  ['webgl', '@sakuzu/maplibre-gl-draw/webgl'],
];

/**
 * The sidebar of the API reference, from the one TypeDoc writes next to the pages
 * (`npm run docs:api`, which `npm run site:build` runs first)
 */
function apiSidebar(): DefaultTheme.SidebarItem[] {
  const file = new URL('../api/typedoc-sidebar.json', import.meta.url);
  if (!existsSync(file)) return [];
  const modules = JSON.parse(readFileSync(file, 'utf8')) as DefaultTheme.SidebarItem[];
  const entries = ENTRY_POINTS.flatMap(([name, importName]) => {
    const module = modules.find((m) => m.text === name);
    return module ? [{ ...module, text: importName, collapsed: name !== 'maplibre-gl-draw' }] : [];
  });
  return [{ text: 'API reference', link: '/api/' }, ...entries];
}

const guides = (lang: 'en' | 'ja'): DefaultTheme.SidebarItem[] => {
  const p = lang === 'ja' ? '/ja' : '';
  const t = (en: string, ja: string) => (lang === 'ja' ? ja : en);
  return [
    {
      text: t('Introduction', 'はじめに'),
      items: [{ text: t('Getting started', 'はじめかた'), link: `${p}/getting-started` }],
    },
    {
      text: t('Drawing', '描く'),
      items: [
        { text: t('Drawing and editing', '描画と編集'), link: `${p}/guides/drawing` },
        { text: t('Layers and groups', 'レイヤーとグループ'), link: `${p}/guides/layers` },
        { text: t('Styles', 'スタイル'), link: `${p}/guides/styles` },
        { text: t('Snapping and geometry', '吸着と幾何演算'), link: `${p}/guides/snapping-geometry` },
        { text: t('Saving and loading', '保存と読み込み'), link: `${p}/guides/save-load` },
        { text: t('Read-only', '読み取り専用'), link: `${p}/guides/read-only` },
      ],
    },
    {
      text: t('Maps and data', '地図とデータ'),
      items: [
        { text: t('Terrain', '地形'), link: `${p}/guides/terrain` },
        { text: t('Showing large data', '大量のデータを表示する'), link: `${p}/guides/large-data` },
        { text: t('Performance', '性能'), link: `${p}/guides/performance` },
      ],
    },
    {
      text: t('Extending', '拡張する'),
      items: [
        { text: t('Plugins', 'プラグイン'), link: `${p}/guides/plugins` },
        { text: t('Custom feature types', '独自の地物の型'), link: `${p}/guides/custom-types` },
      ],
    },
    {
      text: t('Integrating', '組み込む'),
      items: [
        { text: t('Using it with a framework', 'フレームワークで使う'), link: `${p}/guides/frameworks` },
        { text: t('Migrating', '移行する'), link: `${p}/guides/migrating` },
      ],
    },
    {
      text: t('Reference', 'リファレンス (英語)'),
      items: [
        { text: t('API reference', 'API リファレンス'), link: '/api/' },
        { text: t('Public API and versions', '公開 API と版'), link: '/reference/' },
        { text: t('Data format', 'データ形式'), link: '/reference/data-format' },
        { text: t('Events', 'イベント'), link: '/reference/events' },
      ],
    },
  ];
};

const nav = (lang: 'en' | 'ja'): DefaultTheme.NavItem[] => {
  const t = (en: string, ja: string) => (lang === 'ja' ? ja : en);
  return [
    { text: t('Guides', 'ガイド'), link: lang === 'ja' ? '/ja/getting-started' : '/getting-started', activeMatch: '/(ja/)?(getting-started|guides/)' },
    { text: t('Examples', '例'), link: `${LIVE}/examples/`, target: '_self' },
    { text: 'API', link: '/api/', activeMatch: '/api/' },
    { text: 'Playground', link: `${LIVE}/`, target: '_self' },
  ];
};

export default defineConfig({
  title: 'maplibre-gl-draw',
  description:
    'Draw and edit shapes on a MapLibre GL JS map, with its own WebGL2 renderer, on terrain and on the globe.',
  base: BASE,
  outDir: '../site-dist/docs',
  cleanUrls: false,
  lastUpdated: false,
  srcExclude: ['README.md', 'README.ja.md', 'api-index.md', 'internals/**', 'reference/api/**', 'api/_media/**'],
  rewrites: {
    'index.ja.md': 'ja/index.md',
    'getting-started.ja.md': 'ja/getting-started.md',
    'guides/:page.ja.md': 'ja/guides/:page.md',
    'reference/README.md': 'reference/index.md',
    'examples-pages/:page.ja.md': 'ja/examples-pages/:page.md',
  },
  markdown: {
    config: (md) => {
      linkRewrite(md);
      cjkBreaks(md);
      exampleFrames(md);
    },
  },
  head: [['meta', { name: 'theme-color', content: '#3451b2' }]],
  // The examples the pages show in a frame, built under /examples/ of the site. They take the
  // standard UI from its build (npm run ui:build, which `npm run site:build` checks for)
  buildEnd: ({ outDir }) => {
    execFileSync(
      join(ROOT, 'node_modules/.bin/vite'),
      ['build', '--outDir', join(outDir, 'examples'), '--emptyOutDir', '--logLevel', 'warn'],
      { cwd: join(ROOT, 'examples'), stdio: 'inherit' },
    );
  },
  themeConfig: {
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: REPO }],
    editLink: { pattern: `${REPO}/edit/main/docs/:path`, text: 'Edit this page on GitHub' },
    footer: {
      message: 'Released under AGPL-3.0-only. A commercial license is available from Kasika, Inc.',
      copyright: 'Copyright (C) 2026 SAKAIDA Atsushi',
    },
  },
  locales: {
    root: {
      label: 'English',
      lang: 'en',
      themeConfig: { nav: nav('en'), sidebar: { '/api/': apiSidebar(), '/': guides('en') } },
    },
    ja: {
      label: '日本語',
      lang: 'ja',
      link: '/ja/',
      themeConfig: {
        nav: nav('ja'),
        sidebar: { '/api/': apiSidebar(), '/ja/': guides('ja') },
        outline: { label: 'このページの内容' },
        docFooter: { prev: '前のページ', next: '次のページ' },
        editLink: { pattern: `${REPO}/edit/main/docs/:path`, text: 'GitHub でこのページを直す' },
      },
    },
  },
});
