#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Checks the layer rules of docs/internals/architecture.md ("Dependency rules") against the
 * import statements of src/.
 *
 * - A runtime import that breaks a rule is an error (exit code 1)
 * - A runtime import cycle between files is an error (exit code 1)
 * - A type-only import that points the wrong way (`import type`, `export type`, or an
 *   import whose specifiers are all `type X`, and `import('...')` in a type position) is
 *   listed but does not fail the check. Those are the known deviations of the document
 *
 * Test files (*.test.ts), src/e2e/ and src/test-utils.ts are not checked.
 * Only Node's standard modules are used.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/**
 * The height of each area. A runtime import may only point to a lower area (rule 1),
 * or stay inside its own area. The exceptions are in `isAllowed`.
 */
const RANK = {
  geometry: 0,
  shared: 1,
  table: 1.2,
  extension: 1.5,
  store: 2,
  view: 3,
  dataset: 3.5,
  operations: 4,
  snapping: 4,
  modes: 5,
  dispatcher: 6,
  plugins: 7,
  api: 8,
  entry: 9,
};

/** Files at the root of src/ belong to the area given here */
const ROOT_FILES = {
  'index.ts': 'entry',
  'maplibre-gl-draw.ts': 'entry',
  'messages.ts': 'shared',
};

/**
 * @param {string} file Path relative to src/
 * @returns {string} The area of the file
 */
function areaOf(file) {
  const parts = file.split(sep);
  if (parts.length === 1) {
    const area = ROOT_FILES[parts[0]];
    if (!area) throw new Error(`check-layers: no area for src/${file}. Add it to ROOT_FILES`);
    return area;
  }
  if (!(parts[0] in RANK)) {
    throw new Error(`check-layers: unknown area src/${parts[0]}/. Add it to RANK`);
  }
  return parts[0];
}

/**
 * Whether an import from one file to another follows the rules
 *
 * @param {string} from Importing file, relative to src/
 * @param {string} to Imported file, relative to src/
 * @param {boolean} typeOnly Whether the import is erased at runtime
 * @returns {string | null} The broken rule, or null when the import is allowed
 */
function brokenRule(from, to, typeOnly) {
  const a = areaOf(from);
  const b = areaOf(to);
  if (a === b) return null;
  // Rule 9: extension/ may refer to the types of the areas that consume it, never to api/
  if (a === 'extension' && typeOnly && b !== 'api' && b !== 'entry') return null;
  // Rule 4: dispatcher/ does not call operations/
  if (a === 'dispatcher' && b === 'operations') return 'rule 4 (dispatcher -> operations)';
  // Rule 6: dataset/ does not depend on store/
  if (a === 'dataset' && b === 'store') return 'rule 6 (dataset -> store)';
  // Rule 5: snapping/ refers to view/ only for the vertex handle computation of view/ui
  if (a === 'snapping' && b === 'view' && !to.startsWith(join('view', 'ui', 'handles'))) {
    return 'rule 5 (snapping -> view other than view/ui/handles)';
  }
  if (RANK[a] > RANK[b]) return null;
  if (a === 'shared') return `rule 2 (shared -> ${b})`;
  if (b === 'api' || b === 'entry') return `rule 1 (${a} -> ${b})`;
  if (a === 'store') return `rule 8 (store -> ${b})`;
  return `rule 1 (${a} -> ${b})`;
}

/** @returns {string[]} The checked files, relative to src/ */
function listFiles(dir = SRC, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const rel = relative(SRC, path);
    if (statSync(path).isDirectory()) {
      if (rel !== 'e2e') listFiles(path, out);
    } else if (
      name.endsWith('.ts') &&
      !name.endsWith('.test.ts') &&
      !name.endsWith('.d.ts') &&
      rel !== 'test-utils.ts'
    ) {
      out.push(rel);
    }
  }
  return out;
}

const STATIC_IMPORT =
  /^[ \t]*(import|export)[ \t]+(type[ \t]+)?((?:\{[^}]*\}|\*(?:[ \t]+as[ \t]+\w+)?|[\w$]+(?:[ \t]*,[ \t]*(?:\{[^}]*\}|\*[ \t]+as[ \t]+\w+))?)[ \t\n]*)from[ \t]*['"]([^'"]+)['"]/gm;
const SIDE_EFFECT_IMPORT = /^[ \t]*import[ \t]*['"]([^'"]+)['"]/gm;
const IMPORT_CALL = /\bimport\(\s*['"]([^'"]+)['"]\s*\)(\s*\.)?/g;

/**
 * @param {string} file Path relative to src/
 * @returns {{ to: string, typeOnly: boolean, names: string }[]} The relative imports
 */
function importsOf(file) {
  const text = readFileSync(join(SRC, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  const target = (spec) => {
    const abs = resolve(SRC, dirname(file), spec.replace(/\.js$/, '.ts'));
    return relative(SRC, abs);
  };
  const out = [];
  for (const m of text.matchAll(STATIC_IMPORT)) {
    if (!m[4].startsWith('.')) continue;
    const clause = m[3].trim();
    let typeOnly = Boolean(m[2]);
    if (!typeOnly && clause.startsWith('{')) {
      const items = clause
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      typeOnly = items.length > 0 && items.every((s) => s.startsWith('type '));
    }
    out.push({ to: target(m[4]), typeOnly, names: clause.replace(/\s+/g, ' ') });
  }
  for (const m of text.matchAll(SIDE_EFFECT_IMPORT)) {
    if (m[1].startsWith('.')) out.push({ to: target(m[1]), typeOnly: false, names: '' });
  }
  for (const m of text.matchAll(IMPORT_CALL)) {
    // `import('x').Name` is a type reference; a bare `import('x')` loads a module
    if (m[1].startsWith('.')) out.push({ to: target(m[1]), typeOnly: Boolean(m[2]), names: '' });
  }
  return out;
}

/** Runtime cycles between files (strongly connected components of more than one file) */
function findCycles(graph) {
  let index = 0;
  const stack = [];
  const onStack = new Set();
  const idx = new Map();
  const low = new Map();
  const cycles = [];
  const visit = (v) => {
    idx.set(v, index);
    low.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), idx.get(w)));
      }
    }
    if (low.get(v) === idx.get(v)) {
      const component = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      if (component.length > 1 || (graph.get(v) ?? new Set()).has(v)) {
        cycles.push(component.sort());
      }
    }
  };
  for (const v of graph.keys()) if (!idx.has(v)) visit(v);
  return cycles;
}

const files = listFiles().sort();
const fileSet = new Set(files);
const violations = [];
const typeDeviations = [];
const graph = new Map();

for (const file of files) {
  const edges = new Set();
  graph.set(file, edges);
  for (const imp of importsOf(file)) {
    if (!fileSet.has(imp.to)) {
      const asIndex = join(imp.to.replace(/\.ts$/, ''), 'index.ts');
      if (fileSet.has(asIndex)) imp.to = asIndex;
      else continue;
    }
    if (!imp.typeOnly) edges.add(imp.to);
    const rule = brokenRule(file, imp.to, imp.typeOnly);
    if (!rule) continue;
    const line = `${rule}: src/${file} -> src/${imp.to}${imp.names ? `  ${imp.names}` : ''}`;
    (imp.typeOnly ? typeDeviations : violations).push(line);
  }
}

const cycles = findCycles(graph);

if (typeDeviations.length > 0) {
  console.log(`Type-only imports against the layer rules (allowed, ${typeDeviations.length}):`);
  for (const line of typeDeviations.sort()) console.log(`  ${line}`);
}
if (violations.length > 0) {
  console.log(`Runtime imports against the layer rules (${violations.length}):`);
  for (const line of violations.sort()) console.log(`  ${line}`);
}
if (cycles.length > 0) {
  console.log(`Runtime import cycles (${cycles.length}):`);
  for (const cycle of cycles) console.log(`  ${cycle.map((f) => `src/${f}`).join(' <-> ')}`);
}
console.log(
  `check-layers: ${files.length} files, ${violations.length} runtime violations, ` +
    `${cycles.length} runtime cycles, ${typeDeviations.length} type-only deviations`,
);
process.exit(violations.length > 0 || cycles.length > 0 ? 1 : 0);
