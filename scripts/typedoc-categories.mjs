// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// A TypeDoc plugin that sorts the API reference by task instead of by kind.
//
// The sources already group the public symbols: the section comments of each entry point
// (src/index.ts, src/geometry/index.ts, src/webgl/index.ts) and of the MapLibreGLDraw interface (src/api/api.ts).
// This plugin reads those comments and gives every symbol a category, and every member of
// MapLibreGLDraw a group, so that the grouping lives in one place, next to the code. A symbol
// outside any section, or a section this file does not know, fails the build, so that the
// reference cannot fall out of step with the sources.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Comment, CommentTag, Converter, ReflectionKind } from 'typedoc';

const ROOT = new URL('..', import.meta.url).pathname;

/** The sections of src/index.ts, merged into the categories of the reference (in this order) */
const MAIN_CATEGORIES = [
  ['Instance', ['The factory and the instance']],
  ['Options', ['Options']],
  ['Data model', ['The data model', 'The Store and its predicates']],
  ['Events', ['Events']],
  ['Operations', ['The operation groups of the instance']],
  ['Datasets', ['Datasets']],
  ['Snapping and tracing', ['Snapping', 'Tracing']],
  ['Styles', ['Style rules (pure functions)', 'Property accessors']],
  ['Extension points', ['Extension points']],
];

/** Section comments that head a layer rather than a topic */
const LAYER_HEADINGS = new Set(['Layer 1: the public API']);

/** The sections of src/webgl/index.ts, which are its categories (in this order) */
const WEBGL_CATEGORIES = [
  'Shaders and projection',
  'Blending and billboards',
  'Quads',
  'Lines',
  'Terrain',
  'Hit testing',
];

/** The sections of the MapLibreGLDraw interface, merged into groups (in this order) */
const MEMBER_GROUPS = [
  ['Features', ['Feature API']],
  ['Layers', ['Layer API']],
  ['Groups', ['Group API']],
  ['Selection', ['Selection API']],
  ['Vertices', ['Vertex API']],
  ['Modes', ['Mode API']],
  ['Geometry', ['Geometry API']],
  ['Snapping and tracing', ['Snapping API', 'Tracing API', 'Topology API']],
  ['Input', ['Input API']],
  ['Datasets', ['Dataset API']],
  ['Events', ['Event API']],
  ['Saving and loading', ['Import/Export API', 'Metadata API']],
  ['Read-only and interaction lock', ['ReadOnly API', 'InteractionLock API', 'LocallyHidden API']],
  ['Map and store', ['Map / Store API']],
  ['Rendering', ['RenderSlot API', 'RenderScale API', 'Diagnostics API', 'Pending work API']],
  ['Extending', ['Extension API (plugins / custom extensions)']],
  ['Lifecycle', ['Lifecycle']],
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

/** Maps a line of src/api/api.ts to the section comment above it, inside MapLibreGLDraw */
function memberSections() {
  const lines = readFileSync(join(ROOT, 'src/api/api.ts'), 'utf8').split('\n');
  const byLine = [];
  let section = null;
  let previousComment = false;
  let inside = false;
  lines.forEach((line, i) => {
    if (/^export interface MapLibreGLDraw\b/.test(line)) inside = true;
    if (inside && /^ {2}\/\/ /.test(line)) {
      if (!previousComment)
        section = titleOf(line)
          .replace(/ \(.*$/, '')
          .trim();
      if (section === 'Extension API') section = 'Extension API (plugins / custom extensions)';
      previousComment = true;
    } else {
      previousComment = false;
    }
    byLine[i + 1] = inside ? section : null;
    if (inside && /^}/.test(line)) inside = false;
  });
  return byLine;
}

function lookup(table) {
  const map = new Map();
  for (const [name, sections] of table) for (const s of sections) map.set(s, name);
  return map;
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
    const categoryOf = lookup(MAIN_CATEGORIES);
    const groupOf = lookup(MEMBER_GROUPS);
    const entries = [
      { module: 'maplibre-gl-draw', file: 'src/index.ts', rename: (s) => categoryOf.get(s) },
      { module: 'geometry', file: 'src/geometry/index.ts', rename: (s) => s },
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
        if (section === undefined || section === null || LAYER_HEADINGS.has(section)) {
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
    const api = project.getChildByName(['maplibre-gl-draw', 'MapLibreGLDraw']);
    const lines = memberSections();
    for (const member of api?.children ?? []) {
      const line = member.sources?.[0]?.line;
      const section = line === undefined ? null : lines[line];
      const group = section ? groupOf.get(section) : undefined;
      if (!group) {
        problems.push(`MapLibreGLDraw.${member.name}: the section "${section}" has no group`);
        continue;
      }
      addTag(member.kind === ReflectionKind.Method ? member : member, '@group', group);
    }
    if (problems.length > 0) {
      for (const p of problems) app.logger.error(`typedoc-categories: ${p}`);
    }
  });
}

export const CATEGORY_ORDER = MAIN_CATEGORIES.map(([name]) => name);
export const GROUP_ORDER = MEMBER_GROUPS.map(([name]) => name);
