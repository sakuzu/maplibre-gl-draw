// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// Runs git in a working tree and returns its output.

import { execFileSync } from 'node:child_process';

/**
 * @param {string} root
 * @param {string[]} args
 * @param {{ input?: string, buffer?: boolean }} [options] `buffer`: the output as bytes
 * @returns {any} A string, or a Buffer with `buffer`
 */
export function git(root, args, options = {}) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: options.buffer ? undefined : 'utf8',
    input: options.input,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** @returns {string | null} The commit a ref names, or null when there is no such ref */
export function revParse(root, ref) {
  try {
    return git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim() || null;
  } catch {
    return null;
  }
}

/** The first of the refs that exists */
export function firstRef(root, refs) {
  for (const r of refs) if (revParse(root, r)) return r;
  return null;
}
