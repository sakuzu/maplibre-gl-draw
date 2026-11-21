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
 *     [--within <scene>=<levels>:<share>]... [--within-list <file>]
 *
 * It prints, for every scene, the number of pixels that differ, the shares of the pixels drawn
 * (those whose alpha is not 0 in either picture) that differ by more than 2 and by more than 8
 * levels in a channel, and the largest difference of a channel. A scene fails when its pictures
 * differ by any pixel, or when one of the folders has no picture of it, unless it is one of the
 * scenes allowed to change: those given with `--changed`, and those of the file given with
 * `--changed-list` (a name a line). A scene given a bound (`--within`, or a line
 * `<scene> <levels> <share>` of the file given with `--within-list`) fails only when more than
 * `share` of its pixels drawn differ by more than `levels` in a channel (or when a picture of it
 * is missing). The exit code is 1 when a scene fails. No difference is allowed beyond those
 * scenes.
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

/**
 * How two pictures differ: the pixels that differ, the largest difference of a channel, the pixels
 * drawn (whose alpha is not 0 in either picture), and how many pixels differ by each largest
 * difference of their channels (`byLargest[d]`: the pixels whose channels differ by `d` at most,
 * and by `d` in one)
 */
export interface Difference {
  readonly pixels: number;
  readonly largest: number;
  readonly drawn: number;
  readonly byLargest: Uint32Array;
}

/** A bound of the difference of the pictures of a scene */
export interface Bound {
  /** The difference of a channel a pixel may have without counting */
  readonly levels: number;
  /** The share of the pixels drawn that may differ by more */
  readonly share: number;
}

/** The end of the name of a file of a picture */
const SUFFIX = '.rgba.gz';

/** How two pictures differ; pictures of two sizes differ by every pixel, by 255 */
export function difference(a: Picture, b: Picture): Difference {
  const byLargest = new Uint32Array(256);
  if (a.width !== b.width || a.height !== b.height) {
    const pixels = Math.max(a.width * a.height, b.width * b.height);
    byLargest[255] = pixels;
    return { pixels, largest: 255, drawn: pixels, byLargest };
  }
  let pixels = 0;
  let largest = 0;
  let drawn = 0;
  for (let i = 0; i < a.pixels.length; i += 4) {
    let most = 0;
    for (let c = 0; c < 4; c++) {
      const d = Math.abs(a.pixels[i + c] - b.pixels[i + c]);
      if (d > most) most = d;
    }
    if (a.pixels[i + 3] !== 0 || b.pixels[i + 3] !== 0) drawn += 1;
    byLargest[most] += 1;
    if (most > 0) pixels += 1;
    if (most > largest) largest = most;
  }
  return { pixels, largest, drawn, byLargest };
}

/** The share of the pixels drawn that differ by more than `levels` in a channel (0 for none drawn) */
export function shareOver(d: Difference, levels: number): number {
  let over = 0;
  for (let at = Math.max(0, Math.floor(levels) + 1); at < 256; at++) over += d.byLargest[at];
  if (over === 0) return 0;
  return d.drawn === 0 ? 1 : over / d.drawn;
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
  /** The bound the scene is held to (undefined: no pixel may differ) */
  readonly bound?: Bound;
  /** Whether the scene fails: it is not allowed to change, and it changed or is missing */
  readonly failed: boolean;
}

/**
 * Compares two sets of pictures, scene by scene, in the order of the names of the scenes
 *
 * @param changed The scenes allowed to change
 * @param bounds The bounds of the scenes held to one (the others may not differ by a pixel)
 */
export function compareSets(
  before: ReadonlyMap<string, Picture>,
  after: ReadonlyMap<string, Picture>,
  changed: ReadonlySet<string> = new Set(),
  bounds: ReadonlyMap<string, Bound> = new Map(),
): SceneComparison[] {
  const scenes = [...new Set([...before.keys(), ...after.keys()])].sort();
  return scenes.map((scene) => {
    const mayChange = changed.has(scene);
    const bound = bounds.get(scene);
    const a = before.get(scene);
    const b = after.get(scene);
    if (!a || !b) {
      return {
        scene,
        difference: null,
        missingIn: a ? 'after' : 'before',
        mayChange,
        ...(bound && { bound }),
        failed: !mayChange,
      };
    }
    const d = difference(a, b);
    const beyond = bound ? shareOver(d, bound.levels) > bound.share : d.pixels > 0;
    return {
      scene,
      difference: d,
      mayChange,
      ...(bound && { bound }),
      failed: !mayChange && beyond,
    };
  });
}

/** A line of the comparison of a scene */
export function describeComparison(c: SceneComparison): string {
  const percent = (share: number): string => `${(share * 100).toFixed(3)}%`;
  const d = c.difference;
  const what = d
    ? `${d.pixels} pixels differ, by ${d.largest} at most; of ${d.drawn} drawn, ` +
      `${percent(shareOver(d, 2))} by more than 2, ${percent(shareOver(d, 8))} by more than 8`
    : `no picture ${c.missingIn}`;
  const held = c.bound ? ` (within ${percent(c.bound.share)} by more than ${c.bound.levels})` : '';
  const mark = c.failed ? 'FAIL' : c.mayChange ? 'allowed' : 'ok';
  return `${mark.padEnd(7)} ${c.scene}: ${what}${held}`;
}

/** The arguments of the script */
interface Arguments {
  before: string;
  after: string;
  changed: string[];
  changedLists: string[];
  within: string[];
  withinLists: string[];
}

/** A bound read from its text: `<levels>:<share>` */
function boundOf(text: string, where: string): Bound {
  const match = /^(\d+):(\d+(?:\.\d+)?)$/.exec(text.trim());
  if (!match) throw new Error(`${where}: a bound is <levels>:<share>, not ${text}`);
  return { levels: Number(match[1]), share: Number(match[2]) };
}

function parseArguments(argv: readonly string[]): Arguments {
  const folders: string[] = [];
  const changed: string[] = [];
  const changedLists: string[] = [];
  const within: string[] = [];
  const withinLists: string[] = [];
  const lists: Record<string, string[]> = {
    '--changed': changed,
    '--changed-list': changedLists,
    '--within': within,
    '--within-list': withinLists,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const list = lists[arg];
    if (list) {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} takes a value`);
      list.push(value);
      i += 1;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option ${arg}`);
    } else {
      folders.push(arg);
    }
  }
  if (folders.length !== 2) {
    throw new Error(
      'usage: compare-pictures <before> <after> [--changed <scene>]... [--changed-list <file>] ' +
        '[--within <scene>=<levels>:<share>]... [--within-list <file>]',
    );
  }
  return { before: folders[0], after: folders[1], changed, changedLists, within, withinLists };
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
  const bounds = new Map<string, Bound>();
  for (const given of args.within) {
    const at = given.lastIndexOf('=');
    if (at <= 0) throw new Error(`--within takes <scene>=<levels>:<share>, not ${given}`);
    bounds.set(given.slice(0, at), boundOf(given.slice(at + 1), '--within'));
  }
  for (const list of args.withinLists) {
    for (const line of (await readFile(list, 'utf8')).split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length === 1 && parts[0] === '') continue;
      if (parts.length !== 3)
        throw new Error(`${list}: a line is <scene> <levels> <share>: ${line}`);
      bounds.set(parts[0], boundOf(`${parts[1]}:${parts[2]}`, list));
    }
  }
  const [before, after] = await Promise.all([readPictures(args.before), readPictures(args.after)]);
  if (before.size === 0 || after.size === 0) {
    console.error(`no pictures in ${before.size === 0 ? args.before : args.after}`);
    return 1;
  }
  const comparisons = compareSets(before, after, changed, bounds);
  for (const c of comparisons) console.log(describeComparison(c));
  const unknown = [...changed].filter((scene) => !comparisons.some((c) => c.scene === scene));
  for (const scene of unknown) console.error(`--changed names no scene: ${scene}`);
  const unbound = [...bounds.keys()].filter((scene) => !comparisons.some((c) => c.scene === scene));
  for (const scene of unbound) console.error(`--within names no scene: ${scene}`);
  const failed = comparisons.filter((c) => c.failed).length;
  console.log(
    `${comparisons.length} scenes: ${failed} failed, ` +
      `${comparisons.filter((c) => c.mayChange).length} allowed to change`,
  );
  return failed > 0 || unknown.length > 0 || unbound.length > 0 ? 1 : 0;
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
