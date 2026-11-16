// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The gate of the samples of the fixed declarations (api/samples/).
//
// Type-checks every sample against the package as the build left it: the samples import the
// package by its name, which resolves through the `exports` of package.json to dist/. A sample
// that does not pass yet waits in the `samples` of scripts/gates/api-pending.json; a waiting
// sample that passes fails the gate, so that the unit that made it pass removes its row.

import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readList, result } from './lib/files.mjs';
import { loadTypeScript } from './lib/ts.mjs';

export const name = 'samples';

/**
 * The type errors of each sample
 *
 * @param {string} root
 * @returns {Map<string, string[]>} By the file name of the sample
 */
export function typeCheckSamples(root) {
  const ts = loadTypeScript();
  const dir = join(root, 'api', 'samples');
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.ts'))
        .sort()
    : [];
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
    isolatedModules: true,
  };
  const program = ts.createProgram({ rootNames: files.map((f) => join(dir, f)), options });
  const byFile = new Map(files.map((f) => [f, []]));
  const diagnostics = [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()];
  for (const f of files) {
    const sf = program.getSourceFile(join(dir, f));
    diagnostics.push(...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf));
  }
  for (const d of diagnostics) {
    const text = ts.flattenDiagnosticMessageText(d.messageText, ' ');
    if (!d.file) {
      for (const list of byFile.values()) list.push(text);
      continue;
    }
    const f = relative(dir, d.file.fileName);
    const line = d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1;
    if (byFile.has(f)) byFile.get(f).push(`${f}:${line}: ${text}`);
  }
  return byFile;
}

/** @param {{ root: string }} ctx */
export function check(ctx) {
  const { root } = ctx;
  const out = result(name);
  if (!existsSync(join(root, 'dist'))) {
    out.errors.push('dist/ is missing: run the build first');
    return out;
  }
  const waiting = new Set(readList(root, 'api-pending.json').samples ?? []);
  const byFile = typeCheckSamples(root);
  for (const [file, errors] of byFile) {
    if (waiting.has(file)) {
      if (errors.length === 0) {
        out.errors.push(
          `${file} type-checks now; remove it from the samples of scripts/gates/api-pending.json`,
        );
      } else {
        out.notes.push(`${file} waits (${errors.length} type errors)`);
      }
      continue;
    }
    for (const e of errors) out.errors.push(`api/samples/${e}`);
  }
  for (const file of waiting) {
    if (!byFile.has(file))
      out.errors.push(`${file} of api-pending.json is not a sample of api/samples/`);
  }
  return out;
}
