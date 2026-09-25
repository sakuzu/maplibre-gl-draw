// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * BufferCache
 *
 * A class for caching and reusing WebGL VAOs and buffers.
 * It improves performance by eliminating per-frame VAO/buffer creation and deletion.
 */

/**
 * Cached geometry
 */
export interface CachedGeometry {
  vao: WebGLVertexArrayObject;
  buffer: WebGLBuffer;
  vertexCount: number;
  drawMode: number;
  /** Hash of the geometry (for detecting coordinate changes) */
  geometryHash: string;
  /** Time of last use (for LRU) */
  lastUsed: number;
}

/**
 * BufferCache
 *
 * Caches VAOs and buffers keyed by feature ID.
 * They are recreated only when the geometry has changed.
 *
 * @internal
 */
export class BufferCache {
  private gl: WebGL2RenderingContext;
  private cache: Map<string, CachedGeometry> = new Map();
  private maxCacheSize: number;

  constructor(gl: WebGL2RenderingContext, maxCacheSize = 2000) {
    this.gl = gl;
    this.maxCacheSize = maxCacheSize;
  }

  /**
   * Gets the geometry from the cache, creating it if it is not present
   *
   * @param key Cache key (for example "feature_1:fill")
   * @param geometryHash Hash of the geometry (regenerated when the coordinates change)
   * @param createFn Function that creates the geometry
   */
  getOrCreate(
    key: string,
    geometryHash: string,
    createFn: () => {
      vertices: Float32Array;
      vertexCount: number;
      drawMode: number;
      stride: number;
      attributes: Array<{ index: number; size: number; offset: number }>;
    },
  ): CachedGeometry {
    const cached = this.cache.get(key);

    // If an entry is cached and its hash matches, reuse it
    if (cached && cached.geometryHash === geometryHash) {
      cached.lastUsed = Date.now();
      return cached;
    }

    // Delete the stale cache entry if there is one
    if (cached) {
      this.gl.deleteVertexArray(cached.vao);
      this.gl.deleteBuffer(cached.buffer);
    }

    // Check the cache size
    if (this.cache.size >= this.maxCacheSize) {
      this.evictOldest();
    }

    // Create the new geometry
    const { vertices, vertexCount, drawMode, stride, attributes } = createFn();

    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);

    const buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    for (const attr of attributes) {
      gl.enableVertexAttribArray(attr.index);
      gl.vertexAttribPointer(attr.index, attr.size, gl.FLOAT, false, stride, attr.offset);
    }

    gl.bindVertexArray(null);

    const geometry: CachedGeometry = {
      vao,
      buffer,
      vertexCount,
      drawMode,
      geometryHash,
      lastUsed: Date.now(),
    };

    this.cache.set(key, geometry);
    return geometry;
  }

  /**
   * Deletes the oldest entry (LRU)
   */
  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache) {
      if (entry.lastUsed < oldestTime) {
        oldestTime = entry.lastUsed;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.invalidate(oldestKey);
    }
  }

  /**
   * Invalidates the cache entry for a specific key
   */
  invalidate(key: string): void {
    const cached = this.cache.get(key);
    if (cached) {
      this.gl.deleteVertexArray(cached.vao);
      this.gl.deleteBuffer(cached.buffer);
      this.cache.delete(key);
    }
  }

  /**
   * Invalidates the cache entries whose keys start with a specific prefix
   * Used when deleting cache entries based on a feature ID
   */
  invalidateByPrefix(prefix: string): void {
    const keysToDelete: string[] = [];
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      this.invalidate(key);
    }
  }

  /**
   * Clears the whole cache
   */
  clear(): void {
    for (const cached of this.cache.values()) {
      this.gl.deleteVertexArray(cached.vao);
      this.gl.deleteBuffer(cached.buffer);
    }
    this.cache.clear();
  }

  /**
   * Gets the cache size
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Releases the resources
   */
  dispose(): void {
    this.clear();
  }
}

/**
 * Generates a hash from an array of coordinates
 * Uses a fast hash function
 */
export function hashCoordinates(coords: Array<[number, number]>): string {
  // Stringify the coordinates and hash them
  // Round to 6 decimal places to keep the hash stable
  let hash = 0;
  for (const [x, y] of coords) {
    const xInt = Math.round(x * 1000000);
    const yInt = Math.round(y * 1000000);
    hash = ((hash << 5) - hash + xInt) | 0;
    hash = ((hash << 5) - hash + yInt) | 0;
  }
  return hash.toString(36);
}

/**
 * Generates a hash from a two-dimensional array of coordinates (the rings of a Polygon)
 */
export function hashRings(rings: Array<Array<[number, number]>>): string {
  let hash = 0;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      const xInt = Math.round(x * 1000000);
      const yInt = Math.round(y * 1000000);
      hash = ((hash << 5) - hash + xInt) | 0;
      hash = ((hash << 5) - hash + yInt) | 0;
    }
  }
  return hash.toString(36);
}
