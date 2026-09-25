// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// Renames public terms across a repository, following scripts/term-map.json.
//
// The map lists rules (regular expressions applied in order), grouped in stages, the files
// to move, and the words to leave alone. A repository that only calls the API takes the `api`
// stage; a repository that also describes the term in its own documents and code takes `term`
// as well. The script is idempotent: a second run finds nothing to change.
//
// Usage: node scripts/rename-terms.mjs --root <dir> [--stages api,term] [--paths src,docs]
//        [--map <file>] [--dry]
//
// --paths limits the walk to some directories of the root (records of past work, for example,
// keep the names they were written with).

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const HERE = new URL('.', import.meta.url).pathname;
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};

const root = resolve(option('root', join(HERE, '..')));
const mapPath = resolve(option('map', join(HERE, 'term-map.json')));
const stages = option('stages', 'api,term').split(',');
const paths = option('paths', '.').split(',');
const dry = args.includes('--dry');

const map = JSON.parse(readFileSync(mapPath, 'utf8'));
const rules = stages.flatMap((stage) => {
  const list = map.stages[stage];
  if (!list) throw new Error(`unknown stage: ${stage}`);
  return list.map(({ from, to }) => ({ pattern: new RegExp(from, 'g'), to }));
});

const SKIP_DIRS = new Set(['node_modules', 'dist', 'site-dist', '.git', '.pack', '.svelte-kit']);
const SKIP_PATHS = new Set(['docs/reference/api', 'package-lock.json']);
const SELF = new Set([mapPath, resolve(HERE, 'rename-terms.mjs')]);
const EXT = /\.(md|ts|mts|mjs|js|svelte|html|css|scss|json)$/;

// A protected word is swapped for a placeholder before the rules and restored after them
const protect = map.protect.map((word, i) => ({ word, mark: `\u0000${i}\u0000` }));

function rewrite(text) {
  let out = text;
  for (const { word, mark } of protect) out = out.split(word).join(mark);
  for (const { pattern, to } of rules) out = out.replace(pattern, to);
  for (const { word, mark } of protect) out = out.split(mark).join(word);
  return out;
}

function* walk(path) {
  const rel = relative(root, path);
  if (SKIP_PATHS.has(rel) || SELF.has(path)) return;
  const st = statSync(path);
  if (st.isDirectory()) {
    for (const name of readdirSync(path)) {
      if (!SKIP_DIRS.has(name)) yield* walk(join(path, name));
    }
  } else if (EXT.test(path)) {
    yield path;
  }
}

const tracked = new Set(
  execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean),
);

let changed = 0;
for (const path of paths.flatMap((p) => [...walk(resolve(root, p))])) {
  if (!tracked.has(relative(root, path))) continue;
  const before = readFileSync(path, 'utf8');
  const after = rewrite(before);
  if (after === before) continue;
  changed += 1;
  console.log(relative(root, path));
  if (!dry) writeFileSync(path, after);
}

for (const { from, to } of map.files ?? []) {
  if (!existsSync(join(root, from))) continue;
  console.log(`${from} -> ${to}`);
  if (!dry) execFileSync('git', ['mv', from, to], { cwd: root });
}

console.log(`${changed} files ${dry ? 'would change' : 'changed'} in ${root}`);
