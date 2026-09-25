// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Builds the GitHub Pages site and pushes it to the gh-pages branch
 *
 * Runs `npm run build:site`, adds `.nojekyll` (so that GitHub Pages serves the files as
 * they are), and commits the contents of site-dist/ on top of the remote's gh-pages
 * with a temporary index file, then pushes that commit to the branch. The working tree,
 * the index and the local branches of the repository are not touched. Each deploy is one
 * commit on top of the previous one; the first creates the branch without a parent.
 *
 * Publishing is done from a local clone; GitHub Actions is not used. Set the repository's
 * Pages source to the gh-pages branch, root directory, once.
 *
 * Usage:
 *   npm run deploy:pages                       # push to origin
 *   npm run deploy:pages -- --remote upstream  # push to another remote
 *   npm run deploy:pages -- --dry-run          # everything but the push
 *   npm run deploy:pages -- --skip-build       # use the site-dist/ already built
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BRANCH = 'gh-pages';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const siteDir = join(root, 'site-dist');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const skipBuild = args.includes('--skip-build');
const remoteIndex = args.indexOf('--remote');
const remote = remoteIndex >= 0 ? args[remoteIndex + 1] : 'origin';
if (!remote || remote.startsWith('--')) throw new Error('--remote needs the name of a remote');

/** Runs git in the repository and returns its output */
function git(argv, env = {}) {
  return execFileSync('git', argv, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** The commit a ref points at, or null */
function resolveRef(ref) {
  try {
    return git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  } catch {
    return null;
  }
}

git(['remote', 'get-url', remote]); // fails early for an unknown remote
const gitDir = git(['rev-parse', '--absolute-git-dir']);

if (!skipBuild) {
  execFileSync('npm', ['run', 'build:site'], { cwd: root, stdio: 'inherit' });
}
if (!existsSync(join(siteDir, 'index.html'))) {
  throw new Error('site-dist/index.html is missing: run npm run build:site first');
}
writeFileSync(join(siteDir, '.nojekyll'), '');

// Start from the remote's gh-pages if it has one, so that the push is a fast-forward
try {
  git(['fetch', '--quiet', remote, BRANCH]);
} catch {
  console.log(`${remote} has no ${BRANCH} branch yet: the first deploy creates it`);
}
const parent = resolveRef(`refs/remotes/${remote}/${BRANCH}`);

// Stage site-dist/ in a temporary index, with site-dist/ as the work tree
const tmp = mkdtempSync(join(tmpdir(), 'deploy-pages-'));
try {
  const env = { GIT_INDEX_FILE: join(tmp, 'index') };
  execFileSync(
    'git',
    ['--git-dir', gitDir, '--work-tree', siteDir, 'add', '--all', '--force', '.'],
    {
      cwd: siteDir,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'ignore', 'inherit'],
    },
  );
  const tree = git(['write-tree'], env);
  const files = git(['ls-files'], env).split('\n').length;

  if (parent && git(['rev-parse', `${parent}^{tree}`]) === tree) {
    console.log(`${remote} ${BRANCH} already has this site: nothing to deploy`);
  } else {
    const source = git(['rev-parse', '--short', 'HEAD']);
    const dirty = git(['status', '--porcelain']) !== '' ? ' (with uncommitted changes)' : '';
    const commit = git([
      'commit-tree',
      tree,
      ...(parent ? ['-p', parent] : []),
      '-m',
      `Deploy the site from ${source}${dirty}`,
    ]);
    console.log(`Made ${commit.slice(0, 7)} with ${files} files for ${BRANCH}`);
    if (dryRun) {
      console.log(
        `--dry-run: not pushed (would push ${commit.slice(0, 7)} to ${remote} ${BRANCH})`,
      );
    } else {
      git(['push', remote, `${commit}:refs/heads/${BRANCH}`]);
      console.log(`Pushed to ${remote} ${BRANCH}`);
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
