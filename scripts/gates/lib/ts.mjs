// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// Loads the TypeScript compiler of the repository's devDependencies.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** @type {typeof import('typescript') | null} */
let cached = null;

/** @returns {typeof import('typescript')} */
export function loadTypeScript() {
  cached ??= require('typescript');
  return cached;
}
