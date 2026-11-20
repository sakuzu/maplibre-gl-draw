// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The files of the pictures of what is drawn, and the comparison of two sets of them
 *
 * `pictures.e2e.test.ts` takes a picture of every scene and, with `DRAW_PICTURES_OUT` set to a
 * folder, writes them there: one file a scene, the size of the drawing buffer as a line of JSON
 * and its pixels (RGBA, from the bottom row), compressed with gzip. The pictures are not kept in
 * the repository.
 *
 * Run as a script, it compares two folders of pictures taken on the same machine, the one taken
 * before a change and the one taken after it:
 *
 *   npm run pictures:compare -- <before> <after> [--changed <scene>]... [--changed-list <file>]
 *
 * It prints, for every scene, the number of pixels that differ and the largest difference of a
 * channel. A scene fails when its pictures differ by any pixel, or when one of the folders has no
 * picture of it, unless it is one of the scenes allowed to change: those given with `--changed`,
 * and those of the file given with `--changed-list` (a name a line). The exit code is 1 when a
 * scene fails. No difference is allowed beyond those scenes.
 *
 * It imports nothing but the modules of Node, so that Node runs it from its source.
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';

/** A picture: the size of the drawing buffer and its pixels (RGBA, from the bottom row) */
export interface Picture {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

/** How two pictures differ: the pixels that differ and the largest difference of a channel */
export interface Difference {
  readonly pixels: number;
  readonly largest: number;
}

/** The end of the name of a file of a picture */
const SUFFIX = '.rgba.gz';

/** How two pictures differ; pictures of two sizes differ by every pixel, by 255 */
export function difference(a: Picture, b: Picture): Difference {
  if (a.width !== b.width || a.height !== b.height) {
    return { pixels: Math.max(a.width * a.height, b.width * b.height), largest: 255 };
  }
  let pixels = 0;
  let largest = 0;
  for (let i = 0; i < a.pixels.length; i += 4) {
    let differs = false;
    for (let c = 0; c < 4; c++) {
      const d = Math.abs(a.pixels[i + c] - b.pixels[i + c]);
      if (d > 0) differs = true;
      if (d > largest) largest = d;
    }
    if (differs) pixels += 1;
  }
  return { pixels, largest };
}

/** The name of the file of a scene: the name of the scene with `/` written as `~` */
export function fileNameOf(scene: string): string {
  if (!/^[a-z0-9/-]+$/.test(scene)) throw new Error(`a scene is named in [a-z0-9/-]: ${scene}`);
  return `${scene.replace(/\//g, '~')}${SUFFIX}`;
}

/** The name of the scene of a file */
function sceneOfFile(file: string): string {
  return file.slice(0, -SUFFIX.length).replace(/~/g, '/');
}

/** Writes the picture of a scene into a folder */
export async function writePicture(folder: string, scene: string, picture: Picture): Promise<void> {
  const header = Buffer.from(
    `${JSON.stringify({ width: picture.width, height: picture.height })}\n`,
  );
  await mkdir(folder, { recursive: true });
  const data = await promisify(gzip)(Buffer.concat([header, picture.pixels]));
  await writeFile(join(folder, fileNameOf(scene)), data);
}

/** Reads the picture of a file */
async function readPictureFile(path: string): Promise<Picture> {
  const data = await promisify(gunzip)(await readFile(path));
  const end = data.indexOf(0x0a);
  const { width, height } = JSON.parse(data.subarray(0, end).toString()) as {
    width: number;
    height: number;
  };
  const pixels = data.subarray(end + 1);
  if (pixels.length !== width * height * 4) {
    throw new Error(`${path} holds ${pixels.length} bytes, not those of ${width} x ${height}`);
  }
  return { width, height, pixels };
}

/** The pictures of a folder, by the name of their scene */
export async function readPictures(folder: string): Promise<Map<string, Picture>> {
  const out = new Map<string, Picture>();
  const files = (await readdir(folder)).filter((file) => file.endsWith(SUFFIX)).sort();
  for (const file of files) out.set(sceneOfFile(file), await readPictureFile(join(folder, file)));
  return out;
}

/** The comparison of a scene in two sets of pictures */
export interface SceneComparison {
  readonly scene: string;
  /** How the two pictures differ; null when one of the sets has no picture of the scene */
  readonly difference: Difference | null;
  /** The set that has no picture of the scene */
  readonly missingIn?: 'before' | 'after';
  /** Whether the scene is one of those allowed to change */
  readonly mayChange: boolean;
  /** Whether the scene fails: it is not allowed to change, and it changed or is missing */
  readonly failed: boolean;
}

/**
 * Compares two sets of pictures, scene by scene, in the order of the names of the scenes
 *
 * @param changed The scenes allowed to change
 */
export function compareSets(
  before: ReadonlyMap<string, Picture>,
  after: ReadonlyMap<string, Picture>,
  changed: ReadonlySet<string> = new Set(),
): SceneComparison[] {
  const scenes = [...new Set([...before.keys(), ...after.keys()])].sort();
  return scenes.map((scene) => {
    const mayChange = changed.has(scene);
    const a = before.get(scene);
    const b = after.get(scene);
    if (!a || !b) {
      return {
        scene,
        difference: null,
        missingIn: a ? 'after' : 'before',
        mayChange,
        failed: !mayChange,
      };
    }
    const d = difference(a, b);
    return { scene, difference: d, mayChange, failed: !mayChange && d.pixels > 0 };
  });
}

/** A line of the comparison of a scene */
export function describeComparison(c: SceneComparison): string {
  const what = c.difference
    ? `${c.difference.pixels} pixels differ, by ${c.difference.largest} at most`
    : `no picture ${c.missingIn}`;
  const mark = c.failed ? 'FAIL' : c.mayChange ? 'allowed' : 'ok';
  return `${mark.padEnd(7)} ${c.scene}: ${what}`;
}

/** The arguments of the script */
interface Arguments {
  before: string;
  after: string;
  changed: string[];
  changedLists: string[];
}

function parseArguments(argv: readonly string[]): Arguments {
  const folders: string[] = [];
  const changed: string[] = [];
  const changedLists: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--changed' || arg === '--changed-list') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} takes a value`);
      (arg === '--changed' ? changed : changedLists).push(value);
      i += 1;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option ${arg}`);
    } else {
      folders.push(arg);
    }
  }
  if (folders.length !== 2) {
    throw new Error(
      'usage: compare-pictures <before> <after> [--changed <scene>]... [--changed-list <file>]',
    );
  }
  return { before: folders[0], after: folders[1], changed, changedLists };
}

/** Compares the two folders of the arguments; returns the exit code */
export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArguments(argv);
  const changed = new Set(args.changed);
  for (const list of args.changedLists) {
    for (const line of (await readFile(list, 'utf8')).split('\n')) {
      if (line.trim()) changed.add(line.trim());
    }
  }
  const [before, after] = await Promise.all([readPictures(args.before), readPictures(args.after)]);
  if (before.size === 0 || after.size === 0) {
    console.error(`no pictures in ${before.size === 0 ? args.before : args.after}`);
    return 1;
  }
  const comparisons = compareSets(before, after, changed);
  for (const c of comparisons) console.log(describeComparison(c));
  const unknown = [...changed].filter((scene) => !comparisons.some((c) => c.scene === scene));
  for (const scene of unknown) console.error(`--changed names no scene: ${scene}`);
  const failed = comparisons.filter((c) => c.failed).length;
  console.log(
    `${comparisons.length} scenes: ${failed} failed, ` +
      `${comparisons.filter((c) => c.mayChange).length} allowed to change`,
  );
  return failed > 0 || unknown.length > 0 ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
