// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * TextureCache
 *
 * Manages the images of Image features as cached WebGL textures.
 *
 * Every texture is uploaded while the engine is rendering (inside the custom layer's render),
 * never from a callback such as `img.onload`: the GL context is shared with maplibre, and
 * outside a render call its state belongs to maplibre. An image is decoded asynchronously and
 * kept as a decoded image; the next frame that asks for it uploads it.
 */

import { isEmbeddedImageDataUrl } from '../../shared/utils/embedded-image.js';
import { GpuLedger, giveStorage, mipmappedTextureBytes } from '../gpu-ledger.js';

/** The part the textures of the images are recorded under in the GPU ledger */
const IMAGES_PART = 'images';

/**
 * How long the texture of an image not drawn stays (ms). It is made again from the decoded image
 * when it is drawn
 */
const IMAGE_RETENTION_MS = 30_000;

/** How long an image drawn last counts as on the screen (ms): it is not given up for another */
const IMAGE_DRAWN_MS = 2_000;

/** The side a picture is not made smaller than: under it the image waits for room */
const SMALLEST_SIDE = 16;

/**
 * Cache entry
 */
interface CacheEntry {
  texture: WebGLTexture;
  /** The image decoded, to make the texture again */
  source: HTMLImageElement;
  /** The bytes of the texture */
  bytes: number;
  /** The bytes of the texture of the whole image, more than `bytes` when it had no room */
  wholeBytes: number;
  width: number;
  height: number;
  lastUsed: number;
}

/**
 * Texture information
 *
 * @internal
 */
export interface TextureInfo {
  texture: WebGLTexture;
  width: number;
  height: number;
}

/**
 * TextureCache
 *
 * @internal
 */
export class TextureCache {
  private gl: WebGL2RenderingContext;
  private imageCache = new Map<string, CacheEntry>();
  private maxCacheSize: number;
  /** Images decoded and waiting for their upload, by src */
  private decodedImages = new Map<string, HTMLImageElement>();
  /** Decodes in progress, by src (one decode per src, shared by every caller) */
  private loadingImages = new Map<string, Promise<void>>();
  /**
   * srcs whose decode failed, with the error (not retried every frame; invalidateImage
   * forgets them)
   */
  private failedImages = new Map<string, Error>();
  /** Set by dispose(); a decode that finishes afterwards is dropped */
  private disposed = false;
  /** MAX_TEXTURE_SIZE of the context (read once, 0 = not read yet) */
  private maxTextureSize = 0;
  /** Where the bytes of the textures are recorded */
  private readonly ledger: GpuLedger;

  /**
   * @param ledger Where the bytes of the textures are recorded, under the limit of the instance
   */
  constructor(gl: WebGL2RenderingContext, ledger: GpuLedger = new GpuLedger(), maxCacheSize = 500) {
    this.gl = gl;
    this.maxCacheSize = maxCacheSize;
    this.ledger = ledger;
  }

  /**
   * The texture of an image, uploaded in this call if its decode has finished
   *
   * Call it while rendering. It returns null while the image is not decoded yet; the decode is
   * started once per src (every caller shares it), and `onReady` is called when it finishes so
   * that a frame can be requested. A decode that finishes after dispose() is dropped. It also
   * returns null while a decoded image has no room under the limit; the image is kept decoded and
   * the next call tries again.
   *
   * @param src An embedded PNG/JPEG/WebP/GIF data URL
   * @param onReady Called when the decode has finished (not called on failure)
   * @param onError Called when the decode fails or the src is refused. Only the call that
   *   starts the decode is told; a later caller reads the failure with `getImageError`
   */
  acquireImageTexture(
    src: string,
    onReady?: () => void,
    onError?: (error: Error) => void,
  ): TextureInfo | null {
    const cached = this.getImageTextureSync(src);
    if (cached) return cached;

    const decoded = this.decodedImages.get(src);
    if (decoded) {
      // An image with no room for its texture waits decoded: a later frame tries again with the
      // room it has then, with no decode and no frame asked for
      const info = this.uploadImage(src, decoded);
      if (info) this.decodedImages.delete(src);
      return info;
    }

    if (this.failedImages.has(src) || this.loadingImages.has(src)) return null;
    this.decodeImage(src).then(
      () => onReady?.(),
      (error: Error) => {
        this.failedImages.set(src, error);
        onError?.(error);
      },
    );
    return null;
  }

  /**
   * The error of a src whose decode failed, or null (not failed, or not tried yet)
   */
  getImageError(src: string): Error | null {
    return this.failedImages.get(src) ?? null;
  }

  /**
   * Decodes an image (the shared decode of a src while one is in progress)
   */
  private decodeImage(src: string): Promise<void> {
    const loading = this.loadingImages.get(src);
    if (loading) return loading;

    // Only embedded raster images are decoded. Any other URL would make every viewer of the
    // data send a request to an outside host (the data may come from another participant).
    if (!isEmbeddedImageDataUrl(src)) {
      return Promise.reject(
        new Error('Refused to load an image that is not an embedded PNG/JPEG/WebP/GIF data URL'),
      );
    }

    const promise = new Promise<void>((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        this.loadingImages.delete(src);
        // Only the decoded image is kept here; the upload happens in the next render
        if (!this.disposed) this.decodedImages.set(src, img);
        resolve();
      };
      img.onerror = () => {
        this.loadingImages.delete(src);
        reject(new Error(`Failed to load image: ${src.slice(0, 64)}`));
      };
      img.src = src;
    });
    this.loadingImages.set(src, promise);
    return promise;
  }

  /**
   * Uploads a decoded image and caches its texture
   *
   * An image larger than MAX_TEXTURE_SIZE is scaled down to fit (texImage2D would fail and the
   * image would silently be missing). The info keeps the size of the image itself, which is what
   * its display size is derived from.
   */
  private uploadImage(src: string, img: HTMLImageElement): TextureInfo | null {
    if (this.imageCache.size >= this.maxCacheSize) {
      this.evictOldestImage();
    }

    // Under the limit of the instance: what is not on the screen goes first, and an image with no
    // room left is drawn from a smaller picture
    const whole = this.fitToTextureSize(img);
    const wholeBytes = mipmappedTextureBytes(whole.width, whole.height, 4);
    this.makeRoom(wholeBytes);
    const source = this.ledger.fits(wholeBytes) ? whole : this.fitToRoom(img, wholeBytes);
    if (!source) return null;
    const texture = uploadRgbaTexture(this.gl, source, true, this.ledger);
    if (!texture) return null;
    // RGBA8 with the chain of its mipmaps
    const bytes = mipmappedTextureBytes(source.width, source.height, 4);
    this.ledger.record(texture, IMAGES_PART, 'texture', bytes);

    const entry: CacheEntry = {
      texture,
      source: img,
      bytes,
      wholeBytes,
      width: img.width,
      height: img.height,
      lastUsed: Date.now(),
    };
    this.imageCache.set(src, entry);
    return { texture, width: img.width, height: img.height };
  }

  /** Gives up the textures of the images not on the screen until a size fits, the oldest first */
  private makeRoom(bytes: number): void {
    if (this.ledger.fits(bytes)) return;
    const now = Date.now();
    const oldest = [...this.imageCache].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [src, entry] of oldest) {
      if (this.ledger.fits(bytes) || now - entry.lastUsed < IMAGE_DRAWN_MS) return;
      this.forgetTexture(src, entry);
    }
  }

  /** Deletes the texture of an image, keeping the image decoded to make it again */
  private forgetTexture(src: string, entry: CacheEntry): void {
    this.decodedImages.set(src, entry.source);
    this.deleteTexture(entry.texture);
    this.imageCache.delete(src);
  }

  /**
   * A copy of an image as large as the room of the limit allows, or null when too little is left
   * to make one
   */
  private fitToRoom(img: HTMLImageElement, wholeBytes: number): HTMLCanvasElement | null {
    const scale = Math.sqrt(this.ledger.roomBytes / wholeBytes);
    const width = Math.floor(img.width * scale);
    const height = Math.floor(img.height * scale);
    if (Math.min(width, height) < SMALLEST_SIDE) return null;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d')?.drawImage(img, 0, 0, width, height);
    return canvas;
  }

  /**
   * The image itself, or a copy scaled down to MAX_TEXTURE_SIZE when it is larger
   */
  private fitToTextureSize(img: HTMLImageElement): HTMLImageElement | HTMLCanvasElement {
    if (this.maxTextureSize === 0) {
      const max = Number(this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE));
      this.maxTextureSize = Number.isFinite(max) && max > 0 ? max : 4096;
    }
    const max = this.maxTextureSize;
    if (img.width <= max && img.height <= max) return img;

    const scale = max / Math.max(img.width, img.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(img.width * scale));
    canvas.height = Math.max(1, Math.floor(img.height * scale));
    canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  /**
   * Gets an image texture synchronously (only when it is already cached)
   */
  getImageTextureSync(src: string): TextureInfo | null {
    const cached = this.imageCache.get(src);
    if (cached) {
      cached.lastUsed = Date.now();
      return {
        texture: cached.texture,
        width: cached.width,
        height: cached.height,
      };
    }
    return null;
  }

  /**
   * Deletes the textures of the images not drawn for a while, keeping the images decoded
   *
   * @param now - The time, as `Date.now`
   */
  sweep(now: number): void {
    for (const [src, entry] of this.imageCache) {
      // An image drawn from a smaller picture takes the whole one once there is room
      const room =
        entry.bytes < entry.wholeBytes && this.ledger.fits(entry.wholeBytes - entry.bytes);
      if (room || now - entry.lastUsed >= IMAGE_RETENTION_MS) this.forgetTexture(src, entry);
    }
  }

  /**
   * Deletes the oldest image entry
   */
  private evictOldestImage(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.imageCache) {
      if (entry.lastUsed < oldestTime) {
        oldestTime = entry.lastUsed;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      const entry = this.imageCache.get(oldestKey);
      if (entry) this.deleteTexture(entry.texture);
      this.imageCache.delete(oldestKey);
    }
  }

  /**
   * Invalidates a specific image cache entry
   */
  invalidateImage(src: string): void {
    this.decodedImages.delete(src);
    this.failedImages.delete(src);
    const entry = this.imageCache.get(src);
    if (entry) {
      this.deleteTexture(entry.texture);
      this.imageCache.delete(src);
    }
  }

  /**
   * Clears the whole cache
   */
  clear(): void {
    for (const entry of this.imageCache.values()) this.deleteTexture(entry.texture);
    this.imageCache.clear();
    this.decodedImages.clear();
  }

  /** Deletes the texture of an image */
  private deleteTexture(texture: WebGLTexture): void {
    this.ledger.release(texture);
    this.gl.deleteTexture(texture);
  }

  /**
   * Disposes of the resources
   *
   * A decode still in progress is dropped when it finishes (it never reaches the GL context).
   */
  dispose(): void {
    this.disposed = true;
    this.clear();
  }
}

/**
 * Uploads an image to a new RGBA texture with the unpack state the engine's shaders expect
 *
 * The shaders output colors that are not premultiplied and read the image with its first row at
 * the top, so the upload sets `UNPACK_PREMULTIPLY_ALPHA_WEBGL` and `UNPACK_FLIP_Y_WEBGL` to
 * false explicitly instead of inheriting whatever maplibre left in the context. The pixel store
 * and the texture binding are borrowed and given back (maplibre-coupling.md): the values found
 * are restored after the upload.
 *
 * @param mipmap Whether to build mipmaps (for images, which are often drawn smaller than their
 *   size)
 * @param ledger Where the texture is recorded when it is made (its bytes are recorded by the
 *   caller, which knows the levels it holds)
 * @returns The texture, or null when it cannot be created (a lost context)
 */
export function uploadRgbaTexture(
  gl: WebGL2RenderingContext,
  source: TexImageSource,
  mipmap: boolean,
  ledger: GpuLedger,
): WebGLTexture | null {
  const texture = gl.createTexture();
  if (!texture) return null;
  ledger.record(texture, IMAGES_PART, 'texture');

  const previousTexture = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
  const previousFlipY = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL) === true;
  const previousPremultiply = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL) === true;

  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  giveStorage(gl, ledger, texture, () =>
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source),
  );

  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  if (mipmap) {
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  } else {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  }

  gl.bindTexture(gl.TEXTURE_2D, previousTexture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, previousFlipY);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, previousPremultiply);
  return texture;
}
