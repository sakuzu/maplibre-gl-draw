#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Checks that what draws and what picks reads the shapes where they are made, and picks no place
 * an edit under way is kept in.
 *
 * The shape of a feature on the screen is made in one place (`src/sketches/rendered-shapes.ts`):
 * the code that draws, that hits and that snaps reads it there (`RenderedShapes`, and `DrawnShapes`
 * in front of it for the drawing). Reading the value of the Store, the shape being drawn, the
 * sketches or the state of the rows directly in that code is an error (exit code 1).
 *
 * `KNOWN` lists the reads that stay, each with its reason and its number of places: one more is an
 * error, and one less is an error too, so that the list stays what the code does.
 *
 * Test files (*.test.ts), src/e2e/ and src/test-support/ are not checked. Comments are not read.
 * Only Node's standard modules are used.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** The code that draws, that hits and that snaps: folders and files, relative to src/ */
const CHECKED = [
  'view',
  'dispatcher',
  'snapping',
  'modes/select/box-selection.ts',
  'modes/select/click-handler.ts',
  'modes/select/cursor-handler.ts',
  'modes/select/hit-helpers.ts',
  'modes/select/mode.ts',
  'modes/draw/trace-support.ts',
];

/** The direct reads of the places an edit under way is kept in */
const READS = {
  'getFeature(': /\.getFeature\(/g,
  'listFeatures(': /\.listFeatures\(/g,
  'listFeaturesInOrder(': /\.listFeaturesInOrder\(/g,
  'getTentative(': /\.getTentative\(/g,
  'getDisplayFeatures(': /\bgetDisplayFeatures\(/g,
  'listShownFeatures(': /\blistShownFeatures\(/g,
  'getSelectedFeatures(': /\bgetSelectedFeatures\(/g,
  'forEachSnapRow(': /(?<![.\w])forEachSnapRow\(/g,
  'states.translation(': /\bstates\.translation\(/g,
  'states.transform(': /\bstates\.transform\(/g,
  BULK_MOVE_SET: /\bBULK_MOVE_SET\b/g,
  HELD_MOVE_SET: /\bHELD_MOVE_SET\b/g,
  'draggedRowsOf(': /\bdraggedRowsOf\(/g,
  'appliedFeature(': /\.appliedFeature\(/g,
  'drawnFeature(': /\.drawnFeature\(/g,
  'liveFeatures(': /\.liveFeatures\(/g,
  movingFeatureIds: /\.movingFeatureIds\b/g,
};

/** The reads that stay: `file`, the read, how many places, and why */
const KNOWN = [
  {
    file: 'view/layer/shown-store.ts',
    read: 'getFeature(',
    count: 1,
    why: 'the document shown in place of the document has no edit under way',
  },
  {
    file: 'view/layer/shown-store.ts',
    read: 'getDisplayFeatures(',
    count: 1,
    why: 'the features shown, read through the view of the Store in front of the shapes',
  },
  {
    file: 'view/layer/custom-layer.ts',
    read: 'getFeature(',
    count: 1,
    why: 'the checks of the state compare what is drawn with the Store',
  },
  {
    file: 'view/layer/custom-layer.ts',
    read: 'listFeaturesInOrder(',
    count: 2,
    why: 'the checks of the state compare what is drawn with the Store',
  },
  {
    file: 'view/ui/helper.ts',
    read: 'getFeature(',
    count: 1,
    why: 'tells a feature from a group among the items of a layer, not a shape',
  },
  {
    file: 'modes/select/mode.ts',
    read: 'getFeature(',
    count: 3,
    why: 'what is locked and what was created are values of the document, not shapes',
  },
  {
    file: 'modes/draw/trace-support.ts',
    read: 'forEachSnapRow(',
    count: 1,
    why: 'a trace runs on the context a mode of an extension has, which reads the rows of the Store',
  },
];

/** @returns {string[]} The files of an entry of `CHECKED`, relative to src/ */
function filesOf(entry, out = []) {
  const path = join(SRC, entry);
  if (statSync(path).isFile()) {
    out.push(relative(SRC, path));
    return out;
  }
  for (const name of readdirSync(path)) {
    const child = join(entry, name);
    if (statSync(join(SRC, child)).isDirectory()) filesOf(child, out);
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) {
      out.push(relative(SRC, join(SRC, child)));
    }
  }
  return out;
}

/** The text of a file without its comments */
function codeOf(file) {
  return readFileSync(join(SRC, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

const known = new Map(KNOWN.map((entry) => [`${entry.file}|${entry.read}`, entry]));
const counted = new Map();
const problems = [];
const files = CHECKED.flatMap((entry) => filesOf(entry)).sort();

for (const file of files) {
  const code = codeOf(file);
  const name = file.split(sep).join('/');
  for (const [read, pattern] of Object.entries(READS)) {
    const places = [...code.matchAll(pattern)].length;
    if (places === 0) continue;
    const key = `${name}|${read}`;
    counted.set(key, places);
    const entry = known.get(key);
    if (!entry) {
      problems.push(`src/${name} reads ${read} directly (${places}): read it from the shapes`);
    } else if (places > entry.count) {
      problems.push(`src/${name} reads ${read} in ${places} places, ${entry.count} known`);
    }
  }
}
for (const [key, entry] of known) {
  const places = counted.get(key) ?? 0;
  if (places < entry.count) {
    problems.push(
      `src/${entry.file} reads ${entry.read} in ${places} places, ${entry.count} known`,
    );
  }
}

for (const line of problems) console.log(`  ${line}`);
console.log(
  `check-reads: ${files.length} files, ${problems.length} problems, ` +
    `${KNOWN.reduce((sum, entry) => sum + entry.count, 0)} known reads`,
);
process.exit(problems.length > 0 ? 1 : 0);
