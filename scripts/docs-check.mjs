// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The documentation gate (`npm run docs:check`).
//
// Run it at milestones and before a release. It runs these steps in order and exits with 1
// when any step reports an error. Warnings are printed and do not fail the run.
//
//   typedoc       the API reference builds with no warning (skipped when there is no typedoc
//                 configuration)
//   snippets      the ```ts and ```js blocks of the README, getting started and guides
//                 type-check against the built package
//   links         relative links and heading anchors resolve (external URLs are not fetched)
//   markdownlint  markdownlint passes with the repository's configuration
//   terms         the documents name no product that uses the library, and carry no history
//                 of the work or diary-like notes (the library's independence from any
//                 extension is the separate check:terms)
//   translations  a Japanese version has the same headings as its English version (warning)
//   doc-map       a source that changed since the base ref has its documents changed too,
//                 and a changed English document its Japanese version (warnings); the map
//                 itself names existing files (error)
//   e2e           the end-to-end tests that open every example (`npm run test:e2e`)
//
// Usage: node scripts/docs-check.mjs [--base <ref>] [--skip-e2e] [--only <step,...>]
//                                    [--skip <step,...>]
//
//   --base <ref>  the ref the doc-map step compares with (default: main)
//
// The script is the same file in every repository that uses it; what differs lives in
// scripts/docs-check.config.mjs and docs/doc-map.json.
//
// A code block is type-checked as a module of its own. It sees the `globals` of the
// configuration (the map, the instance and the ids a guide takes as given) and the imports of
// the earlier blocks of the same file. Anything else it needs goes in a marker: an HTML
// comment on the line before the fence (blank lines between are allowed), which the rendered
// page does not show.
//
//   <!-- docs-check: skip -->              the block is not type-checked
//   <!-- docs-check: continue -->          the block continues the previous block of the
//                                          same file (its declarations are in scope)
//   <!-- docs-check: with <name> ... -->   prepend the named preludes of the configuration
//   <!-- docs-check:
//   declare const parcels: string;
//   -->                                    lines after the first are prepended as they are
//
// Keywords combine on the first line (`<!-- docs-check: continue with events -->`).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { default: config } = await import('./docs-check.config.mjs');

const STEPS = [
  'typedoc',
  'snippets',
  'links',
  'markdownlint',
  'terms',
  'translations',
  'doc-map',
  'e2e',
];

// ---------------------------------------------------------------------------------------------
// Command line

const argv = process.argv.slice(2);
const opts = { base: 'main', only: null, skip: new Set() };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--base') opts.base = argv[++i];
  else if (a === '--skip-e2e') opts.skip.add('e2e');
  else if (a === '--only') opts.only = new Set(argv[++i].split(','));
  else if (a === '--skip') for (const s of argv[++i].split(',')) opts.skip.add(s);
  else if (a === '--help' || a === '-h') {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n\n')[0]);
    process.exit(0);
  } else {
    console.error(`docs-check: unknown argument ${a}`);
    process.exit(2);
  }
}
for (const s of [...(opts.only ?? []), ...opts.skip]) {
  if (!STEPS.includes(s)) {
    console.error(`docs-check: unknown step ${s} (steps: ${STEPS.join(', ')})`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------------------------
// Files and globs

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20, ...options });
}

/** Tracked and untracked files that git does not ignore, relative to the root with `/` */
const FILES = run('git', ['ls-files', '--cached', '--others', '--exclude-standard'])
  .stdout.split('\n')
  .filter((f) => f !== '' && existsSync(join(ROOT, f)));

function globToRegExp(glob) {
  let re = '';
  let braces = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') {
      re += '(?:';
      braces++;
    } else if (c === '}' && braces > 0) {
      re += ')';
      braces--;
    } else if (c === ',' && braces > 0) re += '|';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function matcher(globs = []) {
  const res = globs.map(globToRegExp);
  return (file) => res.some((r) => r.test(file));
}

/** The files matched by `include` and not by `exclude` */
function select({ include = [], exclude = [] }) {
  const inc = matcher(include);
  const exc = matcher(exclude);
  return FILES.filter((f) => inc(f) && !exc(f)).sort();
}

/** Reads a file relative to the root, or at an absolute path (a page of the fresh API reference) */
const readText = (file) => readFileSync(isAbsolute(file) ? file : join(ROOT, file), 'utf8');
const MARKDOWN = select(config.markdown);

// ---------------------------------------------------------------------------------------------
// Markdown

const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)(.*)$/;

/**
 * Splits a Markdown file into its lines, marking the lines inside fenced code blocks, and
 * collects the code blocks with the marker comment in front of each.
 */
function parseMarkdown(text) {
  const lines = text.split('\n');
  const inFence = new Array(lines.length).fill(false);
  const blocks = [];
  let open = null;
  let directive = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (open) {
      inFence[i] = true;
      const close = line.match(/^\s*(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === open.char && close[1].length >= open.len) {
        open.block.end = i;
        open = null;
      } else {
        open.block.code.push(
          line.startsWith(open.indent) ? line.slice(open.indent.length) : line.trimStart(),
        );
      }
      continue;
    }
    const m = line.match(FENCE_OPEN);
    if (m) {
      inFence[i] = true;
      const block = {
        lang: m[3].toLowerCase(),
        start: i,
        end: lines.length - 1,
        code: [],
        directive,
      };
      blocks.push(block);
      open = { char: m[2][0], len: m[2].length, indent: m[1], block };
      directive = null;
      continue;
    }
    const d = line.match(/^\s*<!--\s*docs-check:(.*)$/);
    if (d) {
      const body = [d[1]];
      let j = i;
      while (!lines[j].includes('-->') && j + 1 < lines.length) body.push(lines[++j]);
      const joined = body.join('\n').replace(/-->\s*$/, '');
      const [first, ...rest] = joined.split('\n');
      const words = first.trim().split(/\s+/).filter(Boolean);
      directive = {
        line: i,
        skip: words.includes('skip'),
        continue: words.includes('continue'),
        with: words.includes('with') ? words.slice(words.indexOf('with') + 1) : [],
        code: rest,
      };
      for (let k = i; k <= j; k++) inFence[k] = true; // not prose: no links or terms
      i = j;
      continue;
    }
    if (line.trim() !== '') directive = null;
  }
  return { lines, inFence, blocks };
}

const parsed = new Map();
function markdown(file) {
  if (!parsed.has(file)) parsed.set(file, parseMarkdown(readText(file)));
  return parsed.get(file);
}

/** Removes inline code spans, keeping the columns of the rest */
const stripCode = (line) => line.replace(/(`+)[^`]*?\1/g, (s) => ' '.repeat(s.length));

/** The heading anchors of a file, as GitHub makes them */
function anchors(file) {
  const { lines, inFence } = markdown(file);
  const seen = new Map();
  const out = new Set();
  lines.forEach((line, i) => {
    if (inFence[i]) return;
    for (const m of line.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) out.add(m[1]);
    const h = line.match(/^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/);
    if (!h) return;
    const text = h[1]
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/`/g, '')
      .replace(/\*/g, '');
    const base = text
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
      .replace(/ /g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  });
  return out;
}

function headings(file) {
  const { lines, inFence } = markdown(file);
  return lines
    .map((line, i) => (inFence[i] ? null : line.match(/^ {0,3}(#{1,6})\s/)?.[1].length))
    .filter((l) => l != null);
}

// ---------------------------------------------------------------------------------------------
// Steps

const report = { errors: [], warnings: [], notes: [] };

/**
 * Where the typedoc step built the API reference: `from` is the output directory of the typedoc
 * configuration (not tracked by git), `to` the fresh build. The links step checks links into
 * the reference against the fresh build, so that it does not depend on an old local build.
 */
let apiReference = null;

function stepTypedoc() {
  const cfg = config.typedoc;
  const bin = join(ROOT, 'node_modules/.bin/typedoc');
  if (!cfg || !existsSync(join(ROOT, cfg.config)) || !existsSync(bin)) {
    report.notes.push('no typedoc configuration or typedoc is not installed: skipped');
    return;
  }
  const out = join(ROOT, 'node_modules/.cache/docs-check/api');
  rmSync(out, { recursive: true, force: true });
  const r = run(bin, ['--options', cfg.config, '--out', out, '--logLevel', 'Warn']);
  const configuredOut = JSON.parse(readText(cfg.config)).out;
  if (typeof configuredOut === 'string' && existsSync(out))
    apiReference = { from: posix.normalize(configuredOut).replace(/\/$/, ''), to: out };
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
  const text = `${r.stdout}${r.stderr}`.replace(ansi, '');
  const issues = text.split('\n').filter((l) => /\[(warning|error)\]/.test(l));
  for (const l of issues) report.errors.push(l.trim());
  if (r.status !== 0 && issues.length === 0)
    report.errors.push(`typedoc exited with ${r.status}\n${text}`);
}

function newestMtime(files) {
  let t = 0;
  for (const f of files) t = Math.max(t, statSync(join(ROOT, f)).mtimeMs);
  return t;
}

/** Maps the package's own name and subpaths to the built types, building them when stale */
function packagePaths() {
  const pkg = JSON.parse(readText('package.json'));
  const paths = {};
  const typeFiles = [];
  for (const [key, value] of Object.entries(pkg.exports ?? {})) {
    const types = typeof value === 'object' ? value.types : null;
    if (!types) continue;
    paths[pkg.name + key.slice(1)] = [join(ROOT, types)];
    typeFiles.push(types);
  }
  const sources = FILES.filter((f) => f.startsWith('src/') && !/\.test\.ts$|\/e2e\//.test(f));
  const stale = typeFiles.some(
    (t) => !existsSync(join(ROOT, t)) || statSync(join(ROOT, t)).mtimeMs < newestMtime(sources),
  );
  if (stale) {
    console.log('  the built types are older than src: npm run build');
    const r = run('npm', ['run', 'build'], { stdio: 'inherit' });
    if (r.status !== 0) report.errors.push('npm run build failed');
  }
  return paths;
}

/** The bindings of the import statements of a block, each as a statement of its own */
function importBindings(code) {
  const out = [];
  const re = /^import\s+(type\s+)?([^'";]*?)\s+from\s*(['"][^'"]+['"])/gm;
  for (const m of code.matchAll(re)) {
    const typeOnly = Boolean(m[1]);
    const mod = m[3];
    const t = typeOnly ? 'type ' : '';
    let clause = m[2].trim();
    const named = clause.match(/\{([\s\S]*)\}/);
    if (named) {
      clause = clause.replace(named[0], '').replace(/,\s*$/, '').trim();
      for (const item of named[1].split(',')) {
        const it = item.trim();
        if (it === '') continue;
        const isType = typeOnly || it.startsWith('type ');
        const spec = it.replace(/^type\s+/, '');
        const name = spec
          .split(/\s+as\s+/)
          .pop()
          .trim();
        out.push({ name, statement: `import ${isType ? 'type ' : ''}{ ${spec} } from ${mod};` });
      }
    }
    for (const part of clause
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)) {
      const ns = part.match(/^\*\s+as\s+([\w$]+)$/);
      if (ns) out.push({ name: ns[1], statement: `import ${t}* as ${ns[1]} from ${mod};` });
      else if (/^[\w$]+$/.test(part))
        out.push({ name: part, statement: `import ${t}${part} from ${mod};` });
    }
  }
  return out;
}

/** The names a block binds at its top level: its imports and its declarations */
function boundNames(lines) {
  const names = importBindings(lines.join('\n')).map((b) => b.name);
  for (const line of lines) {
    const m = line.match(
      /^(?:export\s+)?(?:declare\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|type|interface|enum)\s+([\w$]+)/,
    );
    if (m) names.push(m[1]);
  }
  return names;
}

function stepSnippets() {
  const cfg = config.snippets;
  const files = select(cfg);
  const work = join(ROOT, 'node_modules/.cache/docs-check/snippets');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  const units = [];
  for (const file of files) {
    const { blocks } = markdown(file);
    const fileUnits = [];
    let previous = null;
    for (const block of blocks) {
      if (!['ts', 'typescript', 'js', 'javascript'].includes(block.lang)) continue;
      const d = block.directive ?? { skip: false, continue: false, with: [], code: [] };
      if (d.skip) continue;
      for (const name of d.with) {
        if (!(name in (cfg.preludes ?? {}))) {
          report.errors.push(`${file}:${d.line + 1}: unknown prelude "${name}"`);
        }
      }
      const unit = {
        file,
        block,
        directive: d,
        chain: d.continue && previous ? [...previous.chain, previous] : [],
        earlier: [...fileUnits],
      };
      units.push(unit);
      fileUnits.push(unit);
      previous = unit;
    }
  }

  // Each block becomes one module: preludes, then the blocks it continues, then itself.
  // `owner` maps each generated line back to a Markdown line, or to nothing (not reported).
  const byFile = new Map();
  units.forEach((unit, n) => {
    const js = ['js', 'javascript'].includes(unit.block.lang);
    const name = `${String(n + 1).padStart(3, '0')}-${unit.file.replace(/[^a-z0-9]+/gi, '-')}-L${unit.block.start + 1}.${js ? 'js' : 'ts'}`;
    const out = [];
    const owner = [];
    const push = (lines, map) => {
      for (let k = 0; k < lines.length; k++) {
        out.push(lines[k]);
        owner.push(map(k));
      }
    };
    const members = [...unit.chain, unit];
    const preludeNames = [...new Set(members.flatMap((m) => m.directive.with))];
    for (const p of preludeNames) {
      push((cfg.preludes?.[p] ?? '').split('\n'), () => ({ prelude: p }));
    }
    // The imports of the earlier blocks of the file, one binding per statement, minus the
    // names this block binds itself
    const bound = new Set(
      members.flatMap((m) => boundNames([...m.directive.code, ...m.block.code])),
    );
    const carried = new Map();
    for (const e of unit.earlier) {
      for (const b of importBindings(e.block.code.join('\n'))) carried.set(b.name, b.statement);
    }
    const carriedLines = [...carried].filter(([n]) => !bound.has(n)).map(([, st]) => st);
    push(carriedLines, () => null);
    for (const m of members) {
      const own = m === unit;
      push(m.directive.code, () => (own ? { md: m.directive.line } : null));
      push(m.block.code, (k) => (own ? { md: m.block.start + 1 + k } : null));
    }
    writeFileSync(join(work, name), `${out.join('\n')}\n`);
    byFile.set(name, { unit, owner });
  });

  if (units.length === 0) {
    report.notes.push('no code blocks to check');
    return;
  }

  const paths = { ...packagePaths(), ...(cfg.paths ?? {}) };
  writeFileSync(join(work, 'globals.d.ts'), `${cfg.globals ?? ''}\n`);
  writeFileSync(join(work, 'package.json'), '{ "private": true, "type": "module" }\n');
  const tsconfig = {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      lib: ['ES2022', 'DOM', 'DOM.Iterable'],
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      allowJs: true,
      checkJs: true,
      moduleDetection: 'force',
      resolveJsonModule: true,
      noUncheckedSideEffectImports: false,
      types: [],
      paths,
      ...(cfg.compilerOptions ?? {}),
    },
    files: ['globals.d.ts', ...byFile.keys()],
  };
  writeFileSync(join(work, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));

  const tsc = join(ROOT, 'node_modules/.bin/tsc');
  const r = run(tsc, ['-p', join(work, 'tsconfig.json'), '--pretty', 'false']);
  const text = `${r.stdout}${r.stderr}`;
  const reportedPrelude = new Set();
  let current = null;
  for (const line of text.split('\n')) {
    const m = line.match(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/);
    if (!m) {
      if (current && line.startsWith(' ')) current.push(line);
      continue;
    }
    current = null;
    const [, path, ln, col, code, msg] = m;
    const base = path.split(/[\\/]/).pop();
    const entry = byFile.get(base);
    if (!entry) {
      const bucket = [`${relative(ROOT, resolve(work, path))}:${ln}:${col}: ${code} ${msg}`];
      report.errors.push(bucket);
      current = bucket;
      continue;
    }
    const where = entry.owner[Number(ln) - 1];
    if (where == null) continue; // a line of a block this one continues: reported there
    if (where.prelude) {
      const key = `${where.prelude}:${code}:${msg}`;
      if (reportedPrelude.has(key)) continue;
      reportedPrelude.add(key);
      const bucket = [`prelude "${where.prelude}": ${code} ${msg}`];
      report.errors.push(bucket);
      current = bucket;
      continue;
    }
    const bucket = [`${entry.unit.file}:${where.md + 1}: ${code} ${msg}`];
    report.errors.push(bucket);
    current = bucket;
  }
  if (r.status !== 0 && report.errors.length === 0)
    report.errors.push(`tsc exited with ${r.status}\n${text}`);
  report.notes.push(`${units.length} code blocks in ${files.length} files`);
}

function stepLinks() {
  const anchorCache = new Map();
  const anchorsOf = (file) => {
    if (!anchorCache.has(file)) anchorCache.set(file, anchors(file));
    return anchorCache.get(file);
  };
  for (const file of MARKDOWN) {
    const { lines, inFence } = markdown(file);
    lines.forEach((raw, i) => {
      if (inFence[i]) return;
      const line = stripCode(raw);
      const targets = [];
      for (const m of line.matchAll(
        /!?\[(?:[^\]]|\\\])*\]\(\s*<?([^)\s>]+)>?(?:\s+["'(][^)]*)?\)/g,
      ))
        targets.push(m[1]);
      const ref = line.match(/^ {0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/);
      if (ref) targets.push(ref[1]);
      for (const m of line.matchAll(/\b(?:href|src)="([^"]+)"/g)) targets.push(m[1]);
      for (const target of targets) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) continue;
        const hash = target.indexOf('#');
        const pathPart = decodeURI(hash === -1 ? target : target.slice(0, hash));
        const anchor = hash === -1 ? null : decodeURIComponent(target.slice(hash + 1));
        const dest =
          pathPart === ''
            ? file
            : pathPart.startsWith('/')
              ? pathPart.slice(1)
              : posix.normalize(posix.join(posix.dirname(file), pathPart));
        const inReference =
          apiReference !== null &&
          (dest === apiReference.from || dest.startsWith(`${apiReference.from}/`));
        const onDisk = inReference
          ? join(apiReference.to, dest.slice(apiReference.from.length))
          : join(ROOT, dest);
        if (dest.startsWith('..') || !existsSync(onDisk)) {
          report.errors.push(`${file}:${i + 1}: broken link ${target}`);
          continue;
        }
        if (anchor && dest.endsWith('.md') && !anchorsOf(inReference ? onDisk : dest).has(anchor)) {
          report.errors.push(`${file}:${i + 1}: no heading for #${anchor} in ${dest}`);
        }
      }
    });
  }
  report.notes.push(`${MARKDOWN.length} Markdown files`);
}

function stepMarkdownlint() {
  const local = join(ROOT, 'node_modules/.bin/markdownlint');
  const which = run('sh', ['-c', 'command -v markdownlint']).stdout.trim();
  const bin = existsSync(local) ? local : which;
  if (!bin) {
    report.errors.push('markdownlint (markdownlint-cli) is not installed');
    return;
  }
  const r = run(bin, MARKDOWN);
  const text = `${r.stdout}${r.stderr}`.trim();
  if (text !== '') for (const l of text.split('\n')) report.errors.push(l);
  else if (r.status !== 0) report.errors.push(`markdownlint exited with ${r.status}`);
}

function stepTerms() {
  const allow = config.termAllow ?? [];
  let count = 0;
  for (const rule of config.terms ?? []) {
    const files = select({ include: rule.include, exclude: rule.exclude });
    for (const file of files) {
      count++;
      const isMd = file.endsWith('.md');
      const lines = isMd ? markdown(file).lines : readText(file).split('\n');
      lines.forEach((line, i) => {
        if (!rule.pattern.test(line)) return;
        if (allow.some((a) => a.file === file && a.pattern.test(line))) return;
        report.errors.push(`${file}:${i + 1}: ${rule.name}: ${line.trim().slice(0, 110)}`);
      });
    }
  }
  report.notes.push(`${(config.terms ?? []).length} rules, ${count} file scans`);
}

function stepTranslations() {
  const required = matcher(config.translations?.required);
  for (const en of MARKDOWN) {
    if (en.endsWith('.ja.md')) continue;
    const ja = en.replace(/\.md$/, '.ja.md');
    if (!existsSync(join(ROOT, ja))) {
      if (required(en)) report.warnings.push(`${en}: no Japanese version ${ja}`);
      continue;
    }
    const a = headings(en);
    const b = headings(ja);
    if (a.join() !== b.join()) {
      report.warnings.push(
        `${ja}: ${b.length} headings, ${en} has ${a.length} (levels ${b.join('')} vs ${a.join('')}); the Japanese version is behind`,
      );
    }
  }
}

function stepDocMap() {
  const cfg = config.docMap;
  if (!cfg || !existsSync(join(ROOT, cfg.file))) {
    report.errors.push(`no ${cfg?.file ?? 'doc map'}`);
    return;
  }
  const map = JSON.parse(readText(cfg.file));
  const ignore = matcher(map.ignore);
  const entries = Object.entries(map.docs ?? {});

  // The map itself: every document exists and every pattern matches a file.
  for (const [doc, globs] of entries) {
    if (!existsSync(join(ROOT, doc))) report.errors.push(`${cfg.file}: ${doc} does not exist`);
    for (const g of globs) {
      const re = globToRegExp(g);
      if (!FILES.some((f) => re.test(f)))
        report.errors.push(`${cfg.file}: ${doc}: "${g}" matches no file`);
    }
  }
  const mustList = matcher(cfg.mustList);
  for (const f of MARKDOWN) {
    if (mustList(f) && !f.endsWith('.ja.md') && !map.docs?.[f])
      report.warnings.push(`${cfg.file}: ${f} is not in the map`);
  }

  // What changed since the base: committed on this branch, uncommitted, and untracked.
  const mb = run('git', ['merge-base', opts.base, 'HEAD']);
  if (mb.status !== 0) {
    report.warnings.push(`cannot compare with ${opts.base}: ${mb.stderr.trim()}`);
    return;
  }
  const baseRev = mb.stdout.trim();
  const changed = new Set(
    [
      ...run('git', ['diff', '--name-only', baseRev]).stdout.split('\n'),
      ...run('git', ['ls-files', '--others', '--exclude-standard']).stdout.split('\n'),
    ].filter(Boolean),
  );
  const changedSources = [...changed].filter((f) => !ignore(f));
  for (const [doc, globs] of entries) {
    if (changed.has(doc) || !existsSync(join(ROOT, doc))) continue;
    const m = matcher(globs);
    const hits = changedSources.filter((f) => m(f) && f !== doc);
    if (hits.length > 0) {
      const more = hits.length > 3 ? ` and ${hits.length - 3} more` : '';
      report.warnings.push(
        `${doc} is unchanged, but ${hits.slice(0, 3).join(', ')}${more} changed`,
      );
    }
  }
  for (const f of changed) {
    if (!f.endsWith('.md') || f.endsWith('.ja.md')) continue;
    const ja = f.replace(/\.md$/, '.ja.md');
    if (existsSync(join(ROOT, ja)) && !changed.has(ja)) {
      report.warnings.push(`${f} changed, but ${ja} did not`);
    }
  }
  report.notes.push(
    `compared with ${opts.base} (${baseRev.slice(0, 8)}): ${changed.size} files changed`,
  );
}

function stepE2e() {
  const script = config.e2e ?? 'test:e2e';
  const pkg = JSON.parse(readText('package.json'));
  if (!pkg.scripts?.[script]) {
    report.notes.push(`no "${script}" script: skipped`);
    return;
  }
  const r = run('npm', ['run', script], { stdio: 'inherit' });
  if (r.status !== 0) report.errors.push(`npm run ${script} failed`);
}

const IMPL = {
  typedoc: stepTypedoc,
  snippets: stepSnippets,
  links: stepLinks,
  markdownlint: stepMarkdownlint,
  terms: stepTerms,
  translations: stepTranslations,
  'doc-map': stepDocMap,
  e2e: stepE2e,
};

// ---------------------------------------------------------------------------------------------
// Run

let errors = 0;
let warnings = 0;
const selected = STEPS.filter((s) => (!opts.only || opts.only.has(s)) && !opts.skip.has(s));
for (const [n, step] of selected.entries()) {
  report.errors = [];
  report.warnings = [];
  report.notes = [];
  const t0 = performance.now();
  console.log(`[${n + 1}/${selected.length}] ${step}`);
  IMPL[step]();
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  for (const e of report.errors) console.log(`  error: ${Array.isArray(e) ? e.join('\n') : e}`);
  for (const w of report.warnings) console.log(`  warning: ${w}`);
  const state = report.errors.length > 0 ? `${report.errors.length} error(s)` : 'ok';
  const warn = report.warnings.length > 0 ? `, ${report.warnings.length} warning(s)` : '';
  const note = report.notes.length > 0 ? ` - ${report.notes.join('; ')}` : '';
  console.log(`  ${state}${warn} (${secs} s)${note}`);
  errors += report.errors.length;
  warnings += report.warnings.length;
}
const skipped = STEPS.filter((s) => !selected.includes(s));
console.log(
  `docs-check: ${errors} error(s), ${warnings} warning(s)${skipped.length ? `; skipped ${skipped.join(', ')}` : ''}`,
);
process.exit(errors > 0 ? 1 : 0);
