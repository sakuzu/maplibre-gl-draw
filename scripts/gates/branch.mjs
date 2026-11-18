// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The gate of the branch.
//
// - The work is on a branch whose name starts with `redesign/`.
// - No merge commit since `main` has a parent from an old branch (`rebuild/`, `design/`,
//   `proto/`): a parent that such a branch holds and `main` does not, or a merge whose message
//   names such a branch.
// - A file of the working tree with the same content as a file brought in by an old branch is
//   a row of scripts/gates/provenance.json (the old branch, the commit, the old path, the new
//   path). The content of every commit of the old branches that `main` does not have counts. The
//   contents are compared without their whitespace and line breaks, so a space or a line break
//   added to a copy does not hide where it came from; a content that differs from one of `main`
//   only in its whitespace does not count.

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readList, result } from './lib/files.mjs';
import { firstRef, git } from './lib/git.mjs';

export const name = 'branch';

export const OLD_PREFIXES = ['rebuild/', 'design/', 'proto/'];
const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';

/** The refs of the old branches, local and remote */
function oldRefs(root) {
  const refs = git(root, [
    'for-each-ref',
    '--format=%(refname)',
    'refs/heads',
    'refs/remotes',
  ]).trim();
  return (refs ? refs.split('\n') : []).filter((r) => {
    const short = r.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\/[^/]+\//, '');
    return OLD_PREFIXES.some((p) => short.startsWith(p));
  });
}

/** @param {{ root: string, mainRefs?: string[], branch?: string }} ctx */
export function check(ctx) {
  const { root } = ctx;
  const out = result(name);
  const branch = ctx.branch ?? git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  if (!branch.startsWith('redesign/')) {
    out.errors.push(
      `the branch is ${branch}; the work is on a branch whose name starts with redesign/`,
    );
  }
  const main = firstRef(root, ctx.mainRefs ?? ['main', 'origin/main']);
  if (!main) {
    out.errors.push('no main branch to start from');
    return out;
  }
  const olds = oldRefs(root);

  // Merge commits since main
  const merges = git(root, [
    'rev-list',
    '--merges',
    '--format=%P%x09%s',
    'HEAD',
    '--not',
    main,
  ]).trim();
  for (const block of merges ? merges.split(/^commit /m).filter(Boolean) : []) {
    const [header, info = ''] = block.split('\n');
    const commit = header.trim();
    const [parents, subject = ''] = info.split('\t');
    if (OLD_PREFIXES.some((p) => subject.includes(p))) {
      out.errors.push(`${commit.slice(0, 12)} merges an old branch: ${subject}`);
      continue;
    }
    for (const parent of parents.split(' ').slice(1)) {
      if (olds.length === 0) break;
      const on = git(root, [
        'for-each-ref',
        '--contains',
        parent,
        '--format=%(refname)',
        ...olds,
      ]).trim();
      if (on && !isAncestor(root, parent, main)) {
        out.errors.push(
          `${commit.slice(0, 12)} has a parent from an old branch (${on.split('\n')[0]}): ${subject}`,
        );
      }
    }
  }

  // Files with the content of a file of an old branch
  const provenance = readList(root, 'provenance.json').files ?? [];
  const listed = new Set(provenance.map((p) => p.to));
  for (const p of provenance) {
    if (!p.branch || !p.commit || !p.from || !p.to) {
      out.errors.push(
        `a row of provenance.json without its branch, commit, old path and new path: ${JSON.stringify(p)}`,
      );
    }
  }
  if (olds.length === 0) return out;
  const objects = git(root, [
    'rev-list',
    '--objects',
    '--no-object-names',
    ...olds,
    '--not',
    main,
  ]).trim();
  const ids = objects ? objects.split('\n') : [];
  const types = ids.length
    ? git(root, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
        input: `${ids.join('\n')}\n`,
      })
    : '';
  const oldBlobs = new Set(
    types
      .split('\n')
      .filter((l) => l.endsWith(' blob'))
      .map((l) => l.split(' ')[0])
      .filter((id) => id !== EMPTY_BLOB),
  );
  // The same contents without their whitespace, but those `main` has
  const oldSqueezed = new Set();
  for (const content of blobContents(root, [...oldBlobs])) {
    const d = squeezedDigest(content);
    if (d) oldSqueezed.add(d);
  }
  const mainBlobs = git(root, ['ls-tree', '-r', '--format=%(objecttype) %(objectname)', main])
    .split('\n')
    .filter((l) => l.startsWith('blob '))
    .map((l) => l.slice(5));
  for (const content of blobContents(root, mainBlobs)) {
    const d = squeezedDigest(content);
    if (d) oldSqueezed.delete(d);
  }
  const files = git(root, ['ls-files', '-co', '--exclude-standard']).split('\n').filter(Boolean);
  const regular = files.filter((f) => {
    try {
      return lstatSync(join(root, f)).isFile();
    } catch {
      return false;
    }
  });
  const hashes = regular.length
    ? git(root, ['hash-object', '--no-filters', '--stdin-paths'], {
        input: `${regular.join('\n')}\n`,
      })
        .trim()
        .split('\n')
    : [];
  regular.forEach((f, i) => {
    if (listed.has(f)) return;
    if (oldBlobs.has(hashes[i])) {
      out.errors.push(
        `${f} has the content of a file of an old branch; write where it came from in scripts/gates/provenance.json`,
      );
      return;
    }
    const d = oldSqueezed.size ? squeezedDigest(readFileSync(join(root, f))) : null;
    if (d && oldSqueezed.has(d)) {
      out.errors.push(
        `${f} has the content of a file of an old branch but for its whitespace; write where it came from in scripts/gates/provenance.json`,
      );
    }
  });
  return out;
}

/**
 * The digest of a content without its whitespace and line breaks, or null for a content that is
 * not text (it holds a zero byte) or that is only whitespace
 *
 * @param {Buffer} content
 */
function squeezedDigest(content) {
  if (content.includes(0)) return null;
  const text = content.toString('utf8').replace(/\s+/g, '');
  return text ? createHash('sha1').update(text).digest('hex') : null;
}

/**
 * The contents of blobs, read in batches
 *
 * @param {string} root
 * @param {string[]} ids
 * @returns {Buffer[]}
 */
function blobContents(root, ids) {
  const out = [];
  for (let start = 0; start < ids.length; start += 1000) {
    const batch = ids.slice(start, start + 1000);
    const data = git(root, ['cat-file', '--batch'], {
      input: `${batch.join('\n')}\n`,
      buffer: true,
    });
    let at = 0;
    while (at < data.length) {
      const eol = data.indexOf(10, at);
      const header = data.subarray(at, eol).toString('utf8').split(' ');
      const size = Number(header[2]);
      at = eol + 1;
      if (header[1] === 'blob') out.push(data.subarray(at, at + size));
      at += Number.isFinite(size) ? size + 1 : 0;
    }
  }
  return out;
}

function isAncestor(root, a, b) {
  try {
    git(root, ['merge-base', '--is-ancestor', a, b]);
    return true;
  } catch {
    return false;
  }
}
