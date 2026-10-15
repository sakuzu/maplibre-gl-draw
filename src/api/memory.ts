// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.memory`: the memory the documents drawn on the page take, and the limit of the device
 */

/**
 * Bytes of memory: of the JavaScript heap, of the GPU, and the two together.
 */
export interface MemoryBytes {
  /**
   * The bytes of the JavaScript heap, estimated from the features and their positions (not
   * measured: a browser does not tell it everywhere)
   */
  readonly jsBytes: number;
  /** The bytes of the GPU */
  readonly gpuBytes: number;
  /** `jsBytes` and `gpuBytes` together */
  readonly bytes: number;
}

/**
 * The memory the documents drawn on the page take now, and the limit of the device.
 *
 * Every draw instance of the page is counted: a second one (a print, a thumbnail drawn apart)
 * and a document shown in place of the document (`draw.document.setShown`) take the same
 * memory of the device. `gpuBytes` is what the drawing allocated on the GPU (the buffers and the
 * textures of `draw.debug.gpu()` of every instance); the base map, the elevation data and the
 * rest of the page are not in it. `jsBytes` is an estimate from the features the documents hold
 * and their positions.
 */
export interface MemoryUsage extends MemoryBytes {
  /** The most bytes the documents may take on this device (`memoryLimitBytes`) */
  readonly limitBytes: number;
}

/**
 * The size of a document, or of features to add to one: the number of features and the number
 * of the positions of their geometries.
 */
export interface DocumentSize {
  /** The number of features */
  readonly features: number;
  /** The number of positions of their geometries (a point has one, a ring each of its corners) */
  readonly positions: number;
}

/**
 * The memory the documents drawn on the page take, against the limit of the device.
 *
 * A host stops what would take more than the limit before it starts: a map to open, a document
 * to show in place of the document, a print. It reads what is taken now and estimates what the
 * new document takes, and decides:
 *
 * ```ts
 * const now = draw.memory.get();
 * const added = draw.memory.estimate({ features: 120_000, positions: 700_000 });
 * if (now.bytes + added.bytes > now.limitBytes) {
 *   // tell the user that the map is too large for this device, and do not open it
 * }
 * ```
 */
export interface MemoryResource {
  /** The memory the documents drawn on the page take now, and the limit of the device. */
  get(): MemoryUsage;
  /**
   * An estimate of the memory a document of this size takes once it is drawn by this instance:
   * held as rows when the Store of the instance holds its features as rows, as features
   * otherwise.
   *
   * @throws `DrawError` with the code `invalid-input` when a number is negative or not finite
   */
  estimate(size: DocumentSize): MemoryBytes;
}
