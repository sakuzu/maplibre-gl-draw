// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="node" />

/**
 * The retired names of the string values
 *
 * scripts/check-terms.mjs (run by `npm run lint`) fails on the retired names of
 * scripts/term-map.json. These tests copy the script and the map into a folder of their own,
 * write a file with one old name into it, and run the script there: it fails for an old mode
 * name, error code, dataset order, option or event in the code, the guides, the UI package and
 * the examples, and passes for the names that replaced them.
 *
 * The old names are put together from their parts, so that this file holds none of them.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Joins the parts of an old name */
const old = (...parts: string[]) => parts.join('');

/** Each old name, with the name that replaced it */
const RENAMED: ReadonlyArray<readonly [string, string]> = [
  [old('draw', '_point'), 'drawPoint'],
  [old('draw', '_line'), 'drawLine'],
  [old('draw', '_polygon'), 'drawPolygon'],
  [old('draw', '_image'), 'drawImage'],
  [old('draw', '_circle'), 'drawCircle'],
  [old('draw', '_freehand'), 'drawFreehand'],
  [old('not', '-found'), 'notFound'],
  [old('already', '-exists'), 'alreadyExists'],
  [old('invalid', '-input'), 'invalidInput'],
  [old('unsupported', '-format'), 'unsupportedFormat'],
  [old('invalid', '-state'), 'invalidState'],
  [old('engine', '-failure'), 'engineFailure'],
  [old('below', '-store'), 'belowLayers'],
  [old('above', '-store'), 'aboveLayers'],
  [old('layer', '-order'), 'layerOrder'],
];

const OLD_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  [old('click', 'Tolerance'), 'clickTolerancePx'],
  [old('drag', 'Threshold'), 'dragThresholdPx'],
];

/** The places a file is written to, with the line that uses a value there */
const PLACES: ReadonlyArray<readonly [string, (value: string) => string]> = [
  ['src/values.ts', (value) => `export const value = '${value}';`],
  ['ui/src/values.ts', (value) => `export const value = "${value}";`],
  ['examples/values/main.ts', (value) => `draw.setMode('${value}');`],
  ['docs/guides/values.md', (value) => `The value ${value} is used here.`],
  ['docs/guides/values.ja.md', (value) => `値 ${value} をここで使います。`],
];

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'retired-names-'));
  mkdirSync(join(root, 'scripts'));
  for (const name of ['check-terms.mjs', 'term-map.json']) {
    copyFileSync(join(REPO, 'scripts', name), join(root, 'scripts', name));
  }
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Writes a file into the copy and runs the script there */
function checkWith(path: string, text: string): { status: number | null; output: string } {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), `${text}\n`);
  const run = spawnSync(process.execPath, [join(root, 'scripts', 'check-terms.mjs')], {
    encoding: 'utf8',
  });
  rmSync(join(root, path));
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

describe('the retired names of the string values', () => {
  it('pass when no file holds them', () => {
    expect(checkWith('src/values.ts', 'export const value = 1;').status).toBe(0);
  });

  it.each(RENAMED)('fail for %s in every place, and pass for %s', (before, after) => {
    for (const [path, line] of PLACES) {
      const failed = checkWith(path, line(before));
      expect(failed.status, `${before} in ${path}`).toBe(1);
      expect(failed.output).toContain(`${path}:1:`);
      expect(checkWith(path, line(after)).status, `${after} in ${path}`).toBe(0);
    }
  });

  it.each(OLD_OPTIONS)('fail for the option %s, and pass for %s', (before, after) => {
    for (const path of ['src/values.ts', 'ui/src/values.ts', 'examples/values/main.ts']) {
      expect(checkWith(path, `draw.options.update({ ${before}: 4 });`).status).toBe(1);
      expect(checkWith(path, `draw.options.update({ ${after}: 4 });`).status).toBe(0);
    }
    expect(checkWith('docs/guides/values.md', `Set ${before} to 4.`).status).toBe(1);
    expect(checkWith('docs/guides/values.md', `Set ${after} to 4.`).status).toBe(0);
  });

  it('fail for the old event of a failed image, and pass for image.failed', () => {
    const q = "'";
    for (const path of ['src/values.ts', 'ui/src/values.ts', 'examples/values/main.ts']) {
      expect(checkWith(path, `draw.on(${q}error${q}, () => {});`).status).toBe(1);
      expect(checkWith(path, `draw.on(${q}image.failed${q}, () => {});`).status).toBe(0);
    }
  });

  it('leave a changelog its names of past versions between backticks', () => {
    const recorded = `- a dataset of \`${old('below', '-store')}\` and the \`${old('click', 'Tolerance')}\` option`;
    expect(checkWith('CHANGELOG.md', recorded).status).toBe(0);
    expect(checkWith('ui/CHANGELOG.md', recorded).status).toBe(0);
  });
});
