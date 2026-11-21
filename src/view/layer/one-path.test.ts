// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The layers are drawn one way, from their rows, on every surface: the drawing that kept the
 * features of the layers on the GPU feature by feature (the modules `store-retained*`) is not in
 * the sources, and no source imports it.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../..', import.meta.url));

/** The TypeScript files under a folder */
async function sources(folder: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) out.push(...(await sources(path)));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}

describe('the drawing of the layers', () => {
  it('has no module that keeps the features of the layers feature by feature, and no import of one', async () => {
    const files = await sources(SRC);
    expect(files.length).toBeGreaterThan(100);
    const modules = files
      .filter((file) => /(^|\/)store-retained[^/]*\.ts$/.test(file))
      .map((file) => relative(SRC, file));
    expect(modules).toEqual([]);
    const imports: string[] = [];
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      if (
        /from\s+['"][^'"]*store-retained[^'"]*['"]|import\(\s*['"][^'"]*store-retained/.test(text)
      ) {
        imports.push(relative(SRC, file));
      }
    }
    expect(imports).toEqual([]);
  });
});
