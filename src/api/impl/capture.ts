// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.captureImage`: an image of the map as it is drawn now
 *
 * The canvas of a WebGL map keeps its pixels only until the frame is shown, so the image is taken
 * in the frame itself: the next frame is asked for with the state of this client left out of it
 * (the selection, the shape being drawn), which also draws the shapes as they are written (no
 * sketch, no row moved by its moving set; `RenderedShapes.setWritten`), and when the map tells it
 * drew it (`render`), its canvas is copied at once onto a canvas of the size asked for, which is
 * then encoded.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import type { CaptureImageOptions } from '../draw.js';
import { DrawError } from '../errors.js';
import { invalidInput, isRecord } from './shared.js';

/** A canvas to copy the map onto, and encode */
export interface CaptureCanvas {
  /** Draws the canvas of the map onto it, from the part of the map (sx, sy, sw, sh) */
  draw(source: CanvasImageSource, sx: number, sy: number, sw: number, sh: number): void;
  /** Encodes it (null when the type cannot be made) */
  encode(type: string, quality: number | undefined): Promise<Blob | null>;
}

/** Makes a canvas of a size: in the page, or offscreen where there is no page (a Worker) */
function pageCanvas(width: number, height: number): CaptureCanvas {
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new DrawError('invalid-state', 'A canvas of 2D cannot be made here');
    return {
      draw: (source, sx, sy, sw, sh) =>
        context.drawImage(source, sx, sy, sw, sh, 0, 0, width, height),
      encode: (type, quality) =>
        new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), type, quality)),
    };
  }
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) throw new DrawError('invalid-state', 'A canvas of 2D cannot be made here');
    return {
      draw: (source, sx, sy, sw, sh) =>
        context.drawImage(source, sx, sy, sw, sh, 0, 0, width, height),
      encode: (type, quality) =>
        canvas.convertToBlob({ type, ...(quality !== undefined && { quality }) }),
    };
  }
  throw new DrawError('invalid-state', 'There is no canvas to copy the map onto here');
}

/** The options checked */
function checkOptions(options: unknown): CaptureImageOptions {
  if (options === undefined) return {};
  if (!isRecord(options)) throw invalidInput('The options must be an object');
  const { width, height, type, quality } = options as CaptureImageOptions;
  for (const [name, value] of [
    ['width', width],
    ['height', height],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || (value as number) < 1)) {
      throw invalidInput(`options.${name} must be a whole number of 1 or more`);
    }
  }
  if (type !== undefined && typeof type !== 'string') {
    throw invalidInput('options.type must be a string');
  }
  if (quality !== undefined && (typeof quality !== 'number' || !(quality >= 0 && quality <= 1))) {
    throw invalidInput('options.quality must be a number from 0 to 1');
  }
  return options as CaptureImageOptions;
}

/**
 * Takes an image of the map in the next frame it draws
 *
 * @param map - The map
 * @param setEditingHidden - Leaves the state of this client out of the frames drawn (or draws it
 *   again)
 * @param options - The size, the type and the quality of the image
 * @param makeCanvas - Makes the canvas the map is copied onto (the page's when omitted)
 * @internal
 */
export function captureImage(
  map: MapLibreMap,
  setEditingHidden: (hidden: boolean) => void,
  options?: CaptureImageOptions,
  makeCanvas: (width: number, height: number) => CaptureCanvas = pageCanvas,
): Promise<Blob> {
  let checked: CaptureImageOptions;
  try {
    checked = checkOptions(options);
  } catch (error) {
    return Promise.reject(error);
  }
  const type = checked.type ?? 'image/png';
  return new Promise<Blob>((resolve, reject) => {
    setEditingHidden(true);
    const onRender = (): void => {
      map.off('render', onRender);
      let canvas: CaptureCanvas;
      try {
        const source = map.getCanvas();
        const fullWidth = source.width;
        const fullHeight = source.height;
        // The size asked for; one side alone keeps the shape of the map
        const width =
          checked.width ??
          (checked.height !== undefined
            ? Math.max(1, Math.round((checked.height * fullWidth) / fullHeight))
            : fullWidth);
        const height = checked.height ?? Math.max(1, Math.round((width * fullHeight) / fullWidth));
        // The map covers the image, cut at its middle where the shapes differ
        const scale = Math.max(width / fullWidth, height / fullHeight);
        const sw = width / scale;
        const sh = height / scale;
        canvas = makeCanvas(width, height);
        canvas.draw(source, (fullWidth - sw) / 2, (fullHeight - sh) / 2, sw, sh);
      } catch (error) {
        setEditingHidden(false);
        reject(error instanceof DrawError ? error : new DrawError('invalid-state', String(error)));
        return;
      }
      // The pixels are copied: the next frames draw the state of this client again
      setEditingHidden(false);
      canvas.encode(type, checked.quality).then(
        (blob) => {
          if (blob) resolve(blob);
          else
            reject(new DrawError('invalid-state', `An image of the type ${type} cannot be made`));
        },
        (error) =>
          reject(
            error instanceof DrawError ? error : new DrawError('invalid-state', String(error)),
          ),
      );
    };
    map.on('render', onRender);
    map.triggerRepaint();
  });
}
