// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the image textures of TextureCache
 *
 * The GL context is shared with maplibre, so an image is uploaded only while rendering (in the
 * call that asks for it), with the unpack state set explicitly and given back afterwards.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TextureCache } from './texture.js';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

/** Images created by the cache, so a test can finish their decode */
let images: FakeImage[] = [];

class FakeImage {
  width = 64;
  height = 32;
  crossOrigin = '';
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = '';
  constructor() {
    images.push(this);
  }
}

/** A GL that records the calls that matter here */
function createGl(maxTextureSize = 4096) {
  const calls: string[] = [];
  const pixelStore = new Map<string, boolean>([
    ['UNPACK_FLIP_Y_WEBGL', true],
    ['UNPACK_PREMULTIPLY_ALPHA_WEBGL', true],
  ]);
  const uploads: Array<{ width: number; height: number }> = [];
  let bound: unknown = 'maplibre-texture';
  let textures = 0;

  const gl = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== 'string') return undefined;
        if (/^[A-Z0-9_]+$/.test(prop)) return prop;
        switch (prop) {
          case 'createTexture':
            return () => {
              calls.push('createTexture');
              textures++;
              return { id: textures };
            };
          case 'getParameter':
            return (name: string) => {
              if (name === 'MAX_TEXTURE_SIZE') return maxTextureSize;
              if (name === 'TEXTURE_BINDING_2D') return bound;
              return pixelStore.get(name);
            };
          case 'pixelStorei':
            return (name: string, value: boolean) => {
              calls.push(`pixelStorei ${name}=${value}`);
              pixelStore.set(name, value);
            };
          case 'bindTexture':
            return (_target: unknown, texture: unknown) => {
              bound = texture;
            };
          case 'texImage2D':
            return (...args: unknown[]) => {
              calls.push(
                `texImage2D flipY=${pixelStore.get('UNPACK_FLIP_Y_WEBGL')} premultiply=${pixelStore.get('UNPACK_PREMULTIPLY_ALPHA_WEBGL')}`,
              );
              const source = args[5] as { width: number; height: number };
              uploads.push({ width: source.width, height: source.height });
            };
          case 'generateMipmap':
            return () => calls.push('generateMipmap');
          default:
            return () => undefined;
        }
      },
    },
  ) as unknown as WebGL2RenderingContext;

  return {
    gl,
    calls,
    uploads,
    pixelStore,
    bound: () => bound,
    textures: () => textures,
  };
}

describe('TextureCache', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is created without touching the DOM', () => {
    vi.stubGlobal('document', undefined);
    expect(() => new TextureCache(createGl().gl)).not.toThrow();
  });
});

describe('TextureCache images', () => {
  beforeEach(() => {
    images = [];
    vi.stubGlobal('Image', FakeImage);
    vi.stubGlobal('document', {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: () => undefined }),
      }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('decodes once per src and touches no GL until a render asks again', async () => {
    const g = createGl();
    const cache = new TextureCache(g.gl);
    const ready = vi.fn();

    expect(cache.acquireImageTexture(PNG, ready)).toBeNull();
    expect(cache.acquireImageTexture(PNG, ready)).toBeNull();
    expect(images).toHaveLength(1);

    images[0].onload?.();
    await Promise.resolve();
    expect(ready).toHaveBeenCalledTimes(1);
    expect(g.calls).toEqual([]);

    const info = cache.acquireImageTexture(PNG, ready);
    expect(info).toMatchObject({ width: 64, height: 32 });
    expect(g.textures()).toBe(1);
    // Cached from then on
    expect(cache.acquireImageTexture(PNG, ready)?.texture).toBe(info?.texture);
    expect(g.textures()).toBe(1);
  });

  it('uploads straight and not premultiplied, and gives the pixel store and binding back', () => {
    const g = createGl();
    const cache = new TextureCache(g.gl);
    cache.acquireImageTexture(PNG);
    images[0].onload?.();
    cache.acquireImageTexture(PNG);

    expect(g.calls).toContain('texImage2D flipY=false premultiply=false');
    expect(g.pixelStore.get('UNPACK_FLIP_Y_WEBGL')).toBe(true);
    expect(g.pixelStore.get('UNPACK_PREMULTIPLY_ALPHA_WEBGL')).toBe(true);
    expect(g.bound()).toBe('maplibre-texture');
    expect(g.calls).toContain('generateMipmap');
  });

  it('drops a decode that finishes after dispose', () => {
    const g = createGl();
    const cache = new TextureCache(g.gl);
    cache.acquireImageTexture(PNG);
    cache.dispose();
    images[0].onload?.();

    expect(cache.acquireImageTexture(PNG)).toBeNull();
    expect(g.textures()).toBe(0);
  });

  it('scales an image larger than MAX_TEXTURE_SIZE down to fit', () => {
    const g = createGl(1024);
    const cache = new TextureCache(g.gl);
    cache.acquireImageTexture(PNG);
    images[0].width = 4000;
    images[0].height = 2000;
    images[0].onload?.();

    const info = cache.acquireImageTexture(PNG);

    expect(g.uploads).toEqual([{ width: 1024, height: 512 }]);
    // The info keeps the size of the image itself (its display size is derived from it)
    expect(info).toMatchObject({ width: 4000, height: 2000 });
  });

  it('does not decode a failed src again every frame', async () => {
    const g = createGl();
    const cache = new TextureCache(g.gl);
    const failed = vi.fn();
    cache.acquireImageTexture(PNG, undefined, failed);
    images[0].onerror?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(cache.acquireImageTexture(PNG, undefined, failed)).toBeNull();
    expect(images).toHaveLength(1);
    expect(failed).toHaveBeenCalledTimes(1);

    // Forgetting the src allows a new attempt
    cache.invalidateImage(PNG);
    cache.acquireImageTexture(PNG);
    expect(images).toHaveLength(2);
  });

  it('refuses a src that is not an embedded image', async () => {
    const g = createGl();
    const cache = new TextureCache(g.gl);
    const failed = vi.fn();
    cache.acquireImageTexture('https://example.com/a.png', undefined, failed);
    await Promise.resolve();
    await Promise.resolve();

    expect(images).toHaveLength(0);
    expect(failed).toHaveBeenCalledTimes(1);
  });
});
