// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The configuration of scripts/docs-check.mjs for this repository.
//
// Globs are matched against paths relative to the repository root, with `/` as the separator.

import { existsSync, readFileSync } from 'node:fs';

/**
 * Terms kept outside the repository: the names of the products that use the library. A
 * maintainer links them to scripts/terms.local.json, which git ignores:
 * `{ "documents": [{ "name": "...", "source": "<regular expression>", "flags": "i" }, ...] }`.
 */
const localTermsFile = new URL('./terms.local.json', import.meta.url);
const localTerms = existsSync(localTermsFile)
  ? JSON.parse(readFileSync(localTermsFile, 'utf8'))
  : null;

/** The Markdown files that are documents: linted, link-checked and checked for terms */
const markdown = {
  include: ['*.md', 'docs/**/*.md', 'examples/**/*.md', 'playground/**/*.md', 'bench/**/*.md'],
  exclude: ['docs/reference/api/**', '**/node_modules/**', '**/dist/**'],
};

/** Text written by hand where the product name and work history must not appear */
const everywhere = {
  include: [
    ...markdown.include,
    'src/**/*.ts',
    'examples/**/*.{ts,html,css}',
    'playground/**/*.{ts,html,css}',
    'bench/**/*.{ts,html,css}',
  ],
  exclude: markdown.exclude,
};

/** The documents a reader reads, as opposed to the change log, the notices and the rules */
const prose = {
  include: markdown.include,
  exclude: [
    ...markdown.exclude,
    'CHANGELOG.md',
    'CONTRIBUTING.md',
    'CONTRIBUTING.ja.md',
    'THIRD_PARTY_NOTICES.md',
    'THIRD_PARTY_NOTICES.ja.md',
  ],
};

export default {
  markdown,

  typedoc: { config: 'typedoc.json' },

  snippets: {
    include: ['README.md', 'README.ja.md', 'docs/getting-started*.md', 'docs/guides/**/*.md'],
    exclude: [],
    // Declared for every block: the map, the instance and the ids a guide takes as given.
    // A block that declares the same name shadows it.
    globals: `
declare const map: import('maplibre-gl').Map;
declare const draw: import('@sakuzu/maplibre-gl-draw').MapLibreGLDraw;
declare const feature: import('@sakuzu/maplibre-gl-draw').Feature;
declare const featureId: string;
declare const layerId: string;
declare const groupId: string;
declare module '*.css';
declare module '*?worker&url' {
  const url: string;
  export default url;
}
declare module '*?url' {
  const url: string;
  export default url;
}
declare module 'svelte' {
  export function onMount(fn: () => unknown): void;
  export function onDestroy(fn: () => unknown): void;
}
`,
    // Prepended to a block with `<!-- docs-check: with <name> -->`
    preludes: {
      // The datasets of the large data guide
      datasets: `
declare const parcels: import('@sakuzu/maplibre-gl-draw').Dataset;
declare const places: import('@sakuzu/maplibre-gl-draw').Dataset;
declare const features: import('@sakuzu/maplibre-gl-draw').DatasetFeatureInput[];
declare const nextFeatures: import('@sakuzu/maplibre-gl-draw').DatasetFeatureInput[];
`,
    },
  },

  terms: [
    ...(localTerms?.documents ?? []).map((t) => ({
      name: t.name,
      pattern: new RegExp(t.source, t.flags ?? ''),
      ...everywhere,
    })),
    { name: 'sprint number', pattern: /\bS\d{2,3}[a-z]?\b/, ...everywhere },
    {
      name: 'history of the work',
      pattern:
        /以前は|かつて|当初は|旧(実装|版|仕様|形式|方式|設計|名前|API)|改訂 ?\d|\bformerly\b|\bformer (name|version|implementation|design|API|behavior)\b|\bused to be\b|\bthe (old|previous) (version|implementation|design|name)\b|\brevision \d/i,
      ...prose,
    },
    {
      name: 'diary',
      pattern:
        /\b(today|yesterday|this (week|sprint))\b|\bwe (decided|measured|tried)\b|\b20\d\d-\d\d-\d\d\b|今日|昨日|先日|本日|とりあえず|ひとまず|暫定|実測/i,
      ...prose,
    },
    { name: 'work note', pattern: /\b(TODO|FIXME|XXX)\b/, ...prose },
  ],

  termAllow: [
    // maplibre's own rename, which the coupling record needs to name
    { file: 'docs/internals/maplibre-coupling.md', pattern: /formerly `SourceCache`/ },
  ],

  translations: {
    // Documents that have a Japanese version
    required: ['README.md', 'docs/README.md', 'docs/getting-started.md', 'docs/guides/*.md'],
  },

  docMap: {
    file: 'docs/doc-map.json',
    // Documents that must be in the map
    mustList: ['docs/guides/*.md', 'docs/getting-started.md', 'docs/reference/*.md'],
  },

  e2e: 'test:e2e',
};
