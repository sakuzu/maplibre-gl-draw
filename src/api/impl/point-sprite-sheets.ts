// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The sheets of pictures of the points a plugin adds (`ctx.addPointSprites`)
 *
 * A sheet is a part of the GPU of its plugin (`gpu-parts.ts`): its share is counted with the other
 * parts, its texture is recorded in the ledger under the name of the plugin, and it ends with the
 * plugin, the instance and a lost context. The library keeps no copy of the pictures: an image is
 * held only until it is written, and a sheet made again (the context came back, `resize`) is
 * empty, so the plugin writes it again once `ctx.webgl.spriteTexture` gives another texture.
 *
 * Everything that touches the context waits for the pass before the main one of the next frame
 * (`beginFrame`), after which the map sets its own state again: a write in a callback of the page
 * leaves the state of the map as it is. What can be refused is refused at once, by the numbers of
 * the ledger, before anything is made. A failure that shows only later (the GPU out of memory,
 * read once the fence after the texture is passed) gives the texture back, draws the points of the
 * sheet with their markers and is told in `status.problems`.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import { limitError } from '../../shared/draw-error.js';
import type { Feature as StoredFeature } from '../../store/types.js';
import type { GpuLedger } from '../../view/gpu-ledger.js';
import type {
  PointSprite,
  PointSpriteSheetSource,
  PointSpriteSheets,
} from '../../view/renderers/point/point-sprites.js';
import type { RowSpriteScaleStop } from '../../view/renderers/rows/rows-format.js';
import { DrawError } from '../errors.js';
import type { Gpu } from '../extension/webgl.js';
import type { FeatureRow } from '../model.js';
import type { RowSprite, RowSpriteSheet, RowSpriteSheetDefinition } from '../plugin/types.js';
import type { FeatureTables, LayerTableView } from '../tables.js';
import { createRowReader, featureRowOf, type RowReader } from './feature-rows.js';
import { featureForExtension } from './feature-shape.js';
import type { GpuPart, GpuParts } from './gpu-parts.js';

/** The bytes of a pixel of a sheet (RGBA8) */
const PIXEL_BYTES = 4;

/** What the sheets of an instance work with */
export interface PointSpriteSheetsDeps {
  readonly gpuParts: GpuParts;
  readonly ledger: GpuLedger;
  /** The sheets the drawing reads */
  readonly sheets: PointSpriteSheets;
  /** Puts a sheet where the map gives it the context; returns what takes it out */
  register(sheet: PointSpriteSheetSource): () => void;
  readonly map: Pick<MapLibreMap, 'triggerRepaint'>;
  /** The rows of the document, which the rows are asked from (none for a Store of objects) */
  tables(): FeatureTables | undefined;
}

/**
 * What a plugin adds a sheet with
 *
 * @internal
 */
export interface PointSpriteSheetsHost {
  /**
   * Adds a sheet of a plugin
   *
   * @param failed - Tells a failure of the sheet in `status.problems`, under the plugin
   * @throws `DrawError` as `PluginContext.addPointSprites` says
   */
  add(
    definition: RowSpriteSheetDefinition,
    owner: string,
    failed: (part: string, error: unknown) => void,
  ): { readonly sheet: RowSpriteSheet; remove(): void };
  /** The texture of a sheet of this instance (`Webgl.spriteTexture`) */
  textureOf(sheet: RowSpriteSheet): WebGLTexture | null;
}

/** A write waiting for the frame: the image, where it goes */
interface PendingWrite {
  readonly image: ImageBitmap;
  readonly x: number;
  readonly y: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a number is a size of a sheet: a whole number above 0 */
function isSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/** The size of an image, checked */
function imageSize(image: unknown): { width: number; height: number } {
  if (!isObject(image) || !isSize(image.width) || !isSize(image.height)) {
    throw new DrawError('invalidInput', 'The image of a sheet must be an ImageBitmap with a size');
  }
  return { width: image.width, height: image.height };
}

/** A picture given by `sprite`, read as the drawing reads it (null for what is not one) */
function readSprite(given: unknown): PointSprite | null | undefined {
  if (given === null || given === undefined) return null;
  if (!isObject(given)) return undefined;
  const uv = given.uv;
  const halfWidth = given.halfWidthPixels;
  const halfHeight = given.halfHeightPixels;
  if (
    !Array.isArray(uv) ||
    uv.length !== 4 ||
    !uv.every((value) => typeof value === 'number' && Number.isFinite(value)) ||
    typeof halfWidth !== 'number' ||
    !(halfWidth > 0 && Number.isFinite(halfWidth)) ||
    typeof halfHeight !== 'number' ||
    !(halfHeight > 0 && Number.isFinite(halfHeight))
  ) {
    return undefined;
  }
  return {
    uv: uv as unknown as readonly [number, number, number, number],
    halfWidth,
    halfHeight,
    rotates: given.rotates === true,
  };
}

/**
 * One sheet: the texture, its size, and the writes waiting for the frame
 *
 * @internal
 */
export class SpriteSheet implements PointSpriteSheetSource {
  readonly #definition: RowSpriteSheetDefinition;
  readonly #deps: PointSpriteSheetsDeps;
  readonly #failed: (part: string, error: unknown) => void;
  readonly #part: GpuPart<object>;
  /** The size the sheet has, or will have once the frame makes it */
  #width: number;
  #height: number;
  #gpu: Gpu | null = null;
  #gl: WebGL2RenderingContext | null = null;
  #attached = 0;
  #texture: WebGLTexture | null = null;
  /** Whether the texture is to be made (again) in the next frame */
  #make = true;
  /** The writes waiting for the frame, in their order */
  #writes: PendingWrite[] = [];
  /** The fence after the texture made last, read for a failure that shows later */
  #fence: WebGLSync | null = null;
  /** Whether `sprite` is to be asked again in the next frame */
  #ask = false;
  /** Given back after a failure: its points keep their markers until it is made again */
  #broken = false;
  /** The context was lost: the sheet comes back empty, and nothing is kept to write into it */
  #lost = false;
  #removed = false;
  /** The pictures given, kept by what `sprite` returned (most give the same object again) */
  #read = new WeakMap<object, PointSprite | null>();
  #reader: RowReader | null = null;
  readonly distanceScale: readonly RowSpriteScaleStop[] | undefined;
  readonly premultipliedAlpha: boolean | undefined;
  /** What the plugin holds */
  readonly handle: RowSpriteSheet;

  constructor(
    definition: RowSpriteSheetDefinition,
    owner: string,
    deps: PointSpriteSheetsDeps,
    failed: (part: string, error: unknown) => void,
  ) {
    this.#definition = definition;
    this.#deps = deps;
    this.#failed = failed;
    const { width, height } = imageSize(definition.image);
    this.#width = width;
    this.#height = height;
    this.distanceScale = definition.distanceScale;
    this.premultipliedAlpha = definition.premultipliedAlpha;
    this.#refuse(width, height);
    this.#part = deps.gpuParts.add(
      { gpuShare: definition.gpuShare, prepare: (gpu) => this.#prepare(gpu) },
      owner,
    );
    this.#writes.push({ image: definition.image, x: 0, y: 0 });
    this.handle = {
      update: (image, x, y) => this.update(image, x, y),
      resize: (w, h) => this.resize(w, h),
    };
  }

  get texture(): WebGLTexture | null {
    return this.#broken ? null : this.#texture;
  }

  get active(): boolean {
    return !this.#broken && !this.#removed;
  }

  /** The size the sheet has, or will have once the next frame makes it */
  get size(): { readonly width: number; readonly height: number } {
    return { width: this.#width, height: this.#height };
  }

  spriteOfRow(view: LayerTableView, row: number): PointSprite | null {
    const tables = this.#deps.tables();
    if (!tables) return null;
    // The feature of a row is made only when the plugin asks for it
    this.#reader ??= createRowReader(tables, (at, layer) => {
      const stored = layer.getRow(at);
      return stored ? featureForExtension(stored) : undefined;
    });
    return this.#question(this.#reader.at(row, view));
  }

  spriteOfFeature(feature: StoredFeature): PointSprite | null {
    return this.#question(featureRowOf(featureForExtension(feature), () => null));
  }

  onAdd(gl: WebGL2RenderingContext): void {
    this.#attached++;
    this.#gl = gl;
    this.#part.attach(gl);
  }

  onRemove(): void {
    if (this.#attached === 0) return;
    this.#attached--;
    if (this.#gl) this.#part.detach(this.#gl);
    if (this.#attached === 0) this.#gl = null;
  }

  beginFrame(): void {
    const gpu = this.#gpu;
    if (gpu && !this.#removed) {
      this.#checkFence(gpu);
      if (this.#make) this.#makeTexture(gpu);
      if (this.#texture) this.#writePending(gpu, this.#texture);
    }
    if (this.#ask) {
      this.#ask = false;
      this.#read = new WeakMap();
      this.#deps.sheets.changed();
    }
  }

  update(image?: ImageBitmap, x?: number, y?: number): void {
    this.#open();
    if (image === undefined) {
      if (x !== undefined || y !== undefined) {
        throw new DrawError('invalidInput', 'A place is given with an image');
      }
      this.#askAgain();
      return;
    }
    const { width, height } = imageSize(image);
    if (x === undefined && y === undefined) {
      // The image replaces the sheet, which takes its size
      this.#refuse(width, height);
      if (width !== this.#width || height !== this.#height || this.#broken) {
        this.#width = width;
        this.#height = height;
        this.#make = true;
        this.#broken = false;
      }
      // What was waiting is under the image
      this.#writes = this.#lost ? [] : [{ image, x: 0, y: 0 }];
      this.#askAgain();
      return;
    }
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      throw new DrawError('invalidInput', 'The place of an image in a sheet is two whole numbers');
    }
    const at = { x: x as number, y: y as number };
    if (at.x < 0 || at.y < 0 || at.x + width > this.#width || at.y + height > this.#height) {
      throw new DrawError(
        'invalidInput',
        `An image of ${width} × ${height} at ${at.x}, ${at.y} is out of the sheet of ${this.#width} × ${this.#height}`,
      );
    }
    // A sheet given back after a failure is not written: it is made again by a size first
    if (!this.#broken && !this.#lost) this.#writes.push({ image, x: at.x, y: at.y });
    this.#askAgain();
  }

  resize(width: number, height: number): void {
    this.#open();
    if (!isSize(width) || !isSize(height)) {
      throw new DrawError('invalidInput', 'The size of a sheet is two whole numbers above 0');
    }
    this.#refuse(width, height);
    this.#width = width;
    this.#height = height;
    this.#make = true;
    this.#broken = false;
    // The sheet is made again empty: what was waiting goes with what it was written to
    this.#writes = [];
    this.#askAgain();
  }

  /** The plugin is removed: the texture goes, and the points keep their markers */
  remove(): void {
    if (this.#removed) return;
    this.#removed = true;
    this.#writes = [];
    this.#part.release();
    this.#gpu = null;
    this.#texture = null;
    this.#fence = null;
  }

  #open(): void {
    if (this.#removed) throw new DrawError('invalidState', 'The sheet of pictures is removed');
  }

  #askAgain(): void {
    this.#ask = true;
    this.#deps.map.triggerRepaint();
  }

  /**
   * Refuses a size the sheet cannot have, before anything is made: more than its part of the
   * limit, or more than the instance has room for (then the refusal may be tried again)
   */
  #refuse(width: number, height: number): void {
    const bytes = width * height * PIXEL_BYTES;
    const ledger = this.#deps.ledger;
    const share = this.#definition.gpuShare;
    if (typeof share === 'number' && bytes > share * ledger.limitBytes) {
      throw limitError(
        `A sheet of ${width} × ${height} takes ${bytes} bytes, more than its part of the GPU limit`,
        false,
      );
    }
    const held = this.#texture ? this.#width * this.#height * PIXEL_BYTES : 0;
    if (bytes > ledger.roomBytes + held) {
      throw limitError(
        `A sheet of ${width} × ${height} takes ${bytes} bytes, more than is left`,
        true,
      );
    }
  }

  /** The map gave a context: the texture is made in the next frame */
  #prepare(gpu: Gpu): object {
    this.#gpu = gpu;
    this.#make = true;
    if (this.#broken) {
      // A context that came back is a second chance of what failed
      this.#broken = false;
      this.#ask = true;
    }
    gpu.signal.addEventListener(
      'abort',
      () => {
        if (this.#gpu !== gpu) return;
        // Everything the gpu made is gone with it (a lost context, the plugin removed). The sheet
        // comes back empty: what was waiting is not written, the plugin writes it again
        this.#gpu = null;
        this.#texture = null;
        this.#fence = null;
        this.#writes = [];
        this.#lost = !this.#removed;
      },
      { once: true },
    );
    this.#deps.map.triggerRepaint();
    return {};
  }

  #makeTexture(gpu: Gpu): void {
    this.#make = false;
    this.#lost = false;
    const gl = gpu.gl;
    if (this.#texture) {
      // The old one goes first: only one is held at a time
      gpu.release(this.#texture);
      this.#texture = null;
    }
    if (this.#fence) {
      gpu.release(this.#fence);
      this.#fence = null;
    }
    try {
      const texture = gpu.texture(this.#width, this.#height, gl.RGBA8);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.#texture = texture;
      this.#fence = gpu.fence();
    } catch (error) {
      this.#fail(error);
    }
    // What is drawn reads the new texture; the points ask again for its pictures
    this.#ask = true;
  }

  #writePending(gpu: Gpu, texture: WebGLTexture): void {
    if (this.#writes.length === 0) return;
    const gl = gpu.gl;
    const writes = this.#writes;
    // Nothing is held once it is written
    this.#writes = [];
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    for (const { image, x, y } of writes) {
      // A write that no longer fits (an image of the definition past a smaller size) is left out
      if (x + image.width > this.#width || y + image.height > this.#height) continue;
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, gl.RGBA, gl.UNSIGNED_BYTE, image);
    }
  }

  /** A failure that shows after the texture was made: the GPU out of memory */
  #checkFence(gpu: Gpu): void {
    const fence = this.#fence;
    if (!fence) return;
    const gl = gpu.gl;
    if (gl.getSyncParameter(fence, gl.SYNC_STATUS) !== gl.SIGNALED) return;
    gpu.release(fence);
    this.#fence = null;
    if (gl.getError() !== gl.OUT_OF_MEMORY) return;
    this.#fail(new Error('The GPU ran out of memory (OUT_OF_MEMORY) for the sheet of pictures'));
  }

  /** Gives the texture back: the points keep their markers, and the failure is told */
  #fail(error: unknown): void {
    const gpu = this.#gpu;
    if (gpu && this.#texture) gpu.release(this.#texture);
    if (gpu && this.#fence) gpu.release(this.#fence);
    this.#texture = null;
    this.#fence = null;
    this.#writes = [];
    this.#broken = true;
    this.#ask = true;
    this.#failed('the sheet of pictures', error);
  }

  /** Asks `sprite` for a row, its answer read and checked once per object */
  #question(row: FeatureRow): PointSprite | null {
    let given: RowSprite | null;
    try {
      given = this.#definition.sprite(row);
    } catch (error) {
      this.#failed('sprite of the sheet of pictures', error);
      return null;
    }
    if (given === null || given === undefined) return null;
    if (!isObject(given)) {
      this.#failed(
        'sprite of the sheet of pictures',
        new TypeError('It gave a picture that is not one'),
      );
      return null;
    }
    const kept = this.#read.get(given);
    if (kept !== undefined) return kept;
    const read = readSprite(given);
    if (read === undefined) {
      this.#failed(
        'sprite of the sheet of pictures',
        new TypeError('It gave a picture that is not one'),
      );
      this.#read.set(given, null);
      return null;
    }
    this.#read.set(given, read);
    return read;
  }
}

/**
 * Creates the sheets of an instance
 *
 * @internal
 */
export function createPointSpriteSheets(deps: PointSpriteSheetsDeps): PointSpriteSheetsHost {
  const byHandle = new WeakMap<RowSpriteSheet, SpriteSheet>();
  return {
    add(definition, owner, failed) {
      if (!isObject(definition)) {
        throw new DrawError('invalidInput', 'The sheet of pictures must be an object');
      }
      const share = definition.gpuShare;
      if (typeof share !== 'number' || !(share > 0) || share > 1) {
        throw new DrawError('invalidInput', 'gpuShare must be above 0 and at most 1');
      }
      if (typeof definition.sprite !== 'function') {
        throw new DrawError('invalidInput', 'The sheet of pictures must have the function sprite');
      }
      if (
        definition.premultipliedAlpha !== undefined &&
        typeof definition.premultipliedAlpha !== 'boolean'
      ) {
        throw new DrawError('invalidInput', 'premultipliedAlpha of a sheet must be a boolean');
      }
      if (definition.distanceScale !== undefined && !Array.isArray(definition.distanceScale)) {
        throw new DrawError('invalidInput', 'distanceScale of a sheet must be an array of stops');
      }
      const sheet = new SpriteSheet(definition, owner, deps, failed);
      let unregister: () => void;
      try {
        unregister = deps.register(sheet);
      } catch (error) {
        sheet.remove();
        throw error;
      }
      byHandle.set(sheet.handle, sheet);
      deps.map.triggerRepaint();
      return {
        sheet: sheet.handle,
        remove() {
          byHandle.delete(sheet.handle);
          unregister();
          sheet.remove();
        },
      };
    },
    textureOf: (handle) => byHandle.get(handle)?.texture ?? null,
  };
}
