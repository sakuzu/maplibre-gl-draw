// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// A TypeDoc plugin that sorts the API reference by task instead of by kind.
//
// The sources already group the public symbols: the section comments of each entry point
// (src/index.ts, src/geometry/index.ts, src/table/index.ts, src/webgl/index.ts) and of the
// Draw interface (src/api/draw.ts). This plugin reads those comments and gives every symbol a
// category, and every member of Draw a group, so that the grouping lives in one place, next to
// the code. A symbol outside any section, or a section this file does not
// know, fails the build, so that the reference cannot fall out of step with the sources.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Comment, CommentTag, Converter } from 'typedoc';

const ROOT = new URL('..', import.meta.url).pathname;

/** The sections of src/index.ts, which are its categories (in this order) */
const MAIN_CATEGORIES = [
  'Entry and options',
  'Document model',
  'Inputs, patches and filters',
  'State',
  'Events',
  'Errors',
  'Datasets',
  'Store',
  'Extensions',
  'Style rule functions',
  'GeoJSON functions',
];

/** The sections of src/webgl/index.ts, which are its categories (in this order) */
const WEBGL_CATEGORIES = [
  'Shaders and projection',
  'Blending and billboards',
  'Quads',
  'Lines',
  'Terrain',
  'Hit testing',
  'Supporting types',
];

/** The sections of the Draw interface, which are the groups of its members (in this order) */
const MEMBER_GROUPS = [
  'Resources',
  'The map and the Store',
  'Mode',
  'Read-only and interaction lock',
  'Transactions and events',
  'Drawing',
  'Lifecycle',
];

/** The title of a section comment: its first line, without a trailing parenthesis */
function titleOf(line) {
  return line.replace(/^\s*\/\/\s*/, '').trim();
}

/** Maps every exported name of an entry point to the section comment above it */
function exportSections(file) {
  const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
  const sections = new Map();
  let section = null;
  let previousComment = false;
  for (const line of lines) {
    if (/^\/\/ /.test(line) && !/^\/\/ (=|SPDX|biome-ignore)/.test(line)) {
      // A comment that continues the previous comment line is not a new section
      if (!previousComment) section = titleOf(line);
      previousComment = true;
      continue;
    }
    previousComment = false;
    const names = [];
    const single = line.match(/^export (?:type )?\{([^}]*)\} from/);
    if (single) names.push(...single[1].split(','));
    const declaration = line.match(/^export (?:const|function|class) ([\w$]+)/);
    if (declaration) names.push(declaration[1]);
    const member = line.match(/^\s+(?:type\s+)?[\w$]+(?:\s+as\s+[\w$]+)?,?$/);
    if (member) names.push(line);
    for (const raw of names) {
      const m = raw.trim().match(/^(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?,?$/);
      if (m) sections.set(m[2] ?? m[1], section);
    }
  }
  return sections;
}

/** Maps a line of src/api/draw.ts to the section comment above it, inside Draw */
function memberSections() {
  const lines = readFileSync(join(ROOT, 'src/api/draw.ts'), 'utf8').split('\n');
  const byLine = [];
  let section = null;
  let previousComment = false;
  let inside = false;
  lines.forEach((line, i) => {
    if (/^export interface Draw\b/.test(line)) inside = true;
    if (inside && /^ {2}\/\/ /.test(line)) {
      if (!previousComment) section = titleOf(line);
      previousComment = true;
    } else {
      previousComment = false;
    }
    byLine[i + 1] = inside ? section : null;
    if (inside && /^}/.test(line)) inside = false;
  });
  return byLine;
}

function addTag(reflection, tag, text) {
  reflection.comment ??= new Comment();
  reflection.comment.blockTags = reflection.comment.blockTags.filter((t) => t.tag !== tag);
  reflection.comment.blockTags.push(new CommentTag(tag, [{ kind: 'text', text }]));
}

/** @param {import('typedoc').Application} app */
export function load(app) {
  app.converter.on(Converter.EVENT_RESOLVE_BEGIN, (context) => {
    const project = context.project;
    const problems = [];
    const entries = [
      {
        module: 'maplibre-gl-draw',
        file: 'src/index.ts',
        rename: (s) => (MAIN_CATEGORIES.includes(s) ? s : undefined),
      },
      { module: 'geometry', file: 'src/geometry/index.ts', rename: (s) => s },
      { module: 'table', file: 'src/table/index.ts', rename: (s) => s },
      {
        module: 'webgl',
        file: 'src/webgl/index.ts',
        rename: (s) => (WEBGL_CATEGORIES.includes(s) ? s : undefined),
      },
    ];
    for (const { module, file, rename } of entries) {
      const mod = project.children?.find((c) => c.name === module);
      if (!mod) {
        problems.push(`no module named ${module}`);
        continue;
      }
      const sections = exportSections(file);
      for (const child of mod.children ?? []) {
        const section = sections.get(child.name);
        if (section === undefined || section === null) {
          problems.push(`${file}: ${child.name} is not under a section comment`);
          continue;
        }
        const category = rename(section);
        if (!category) {
          problems.push(`${file}: the section "${section}" has no category`);
          continue;
        }
        addTag(child, '@category', category);
      }
    }
    const draw = project.getChildByName(['maplibre-gl-draw', 'Draw']);
    if (!draw) problems.push('no interface named Draw');
    const lines = memberSections();
    for (const member of draw?.children ?? []) {
      const line = member.sources?.[0]?.line;
      const section = line === undefined ? null : lines[line];
      if (!section || !MEMBER_GROUPS.includes(section)) {
        problems.push(`Draw.${member.name}: the section "${section}" has no group`);
        continue;
      }
      addTag(member, '@group', section);
    }
    if (problems.length > 0) {
      for (const p of problems) app.logger.error(`typedoc-categories: ${p}`);
    }
  });
}

export const CATEGORY_ORDER = MAIN_CATEGORIES;
export const GROUP_ORDER = MEMBER_GROUPS;
