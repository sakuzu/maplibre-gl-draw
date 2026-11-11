// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The parts of the extensions of an instance that hold GPU resources: one for each definition added
 * (`ctx.webgl`), however many types and overlays were given it
 *
 * A part runs `prepare` when the map gives a WebGL context, holds what it returned while the context
 * lasts, and ends with everything it made: when the last use of it goes, when the context is lost,
 * and when its drawing fails. A lost context comes back with `prepare`, on a new `Gpu`. A map that
 * only swaps its style keeps the context, and the part keeps what it holds.
 */

import type { GpuRowsSource } from '../../extension/renderers.js';
import { limitError } from '../../shared/draw-error.js';
import { GpuResources } from '../../view/gpu.js';
import type { GpuLedger } from '../../view/gpu-ledger.js';
import { DrawError } from '../errors.js';
import type { GpuDefinition } from '../extension/webgl.js';

/** The part of the limit of an instance the extensions may take: the rest stays with the library */
const EXTENSIONS_SHARE = 0.9;

/** What rounds a sum of shares, which does not add up exactly in floating point */
const SHARE_EPSILON = 1e-9;

/** What the parts of an instance work with */
export interface GpuPartsDeps {
  readonly ledger: GpuLedger;
  /** The most bytes the rows of the instance may hold on this device, the rest of the page apart */
  readonly rowLimitBytes: () => number;
}

/**
 * A definition added
 *
 * @internal
 */
export class GpuPart<R> {
  readonly #definition: GpuDefinition<R>;
  readonly #owner: string;
  readonly #deps: GpuPartsDeps;
  readonly #ended: () => void;
  #uses = 0;
  #attached = 0;
  #gpu: GpuResources | null = null;
  #drawing: R | null = null;
  #stopped = false;
  #rows: GpuRowsSource | undefined;

  constructor(definition: GpuDefinition<R>, owner: string, deps: GpuPartsDeps, ended: () => void) {
    this.#definition = definition;
    this.#owner = owner;
    this.#deps = deps;
    this.#ended = ended;
  }

  /** What `prepare` returned; null before it and after the part stopped */
  get drawing(): R | null {
    return this.#drawing;
  }

  /** What holds the rows, when what draws holds them */
  get gpuRows(): GpuRowsSource | undefined {
    return this.#rows;
  }

  /** One more type or overlay uses the part */
  use(): void {
    this.#uses++;
  }

  /** A type or an overlay stops using the part; the last one ends it */
  release(): void {
    if (--this.#uses > 0) return;
    this.#end();
    this.#ended();
  }

  /** The map gave a context: what draws is made, once however many use the part */
  attach(gl: WebGL2RenderingContext): void {
    this.#attached++;
    if (this.#gpu && this.#gpu.gl !== gl) this.#end();
    if (this.#gpu || this.#stopped) return;
    const gpu = new GpuResources({
      gl,
      ledger: this.#deps.ledger,
      owner: this.#owner,
      share: this.#definition.gpuShare,
      rowsLimitBytes: this.#deps.rowLimitBytes,
    });
    this.#gpu = gpu;
    try {
      this.#drawing = this.#definition.prepare(gpu);
    } catch (error) {
      this.#stop(error);
      return;
    }
    this.#rows = this.#rowsOf(gpu);
  }

  /** The map took the context away. What was made stays while the context lasts (a new style) */
  detach(gl: WebGL2RenderingContext): void {
    this.#attached--;
    if (this.#attached > 0 || !gl.isContextLost?.()) return;
    this.#end();
    // The context that comes back is the second chance of what stopped
    this.#stopped = false;
  }

  /**
   * Runs what draws. One that throws stops: everything it made goes and it is not asked again until
   * a lost context is back or the plugin is added again. The rest of the drawing goes on
   */
  draw(run: (drawing: R) => void): void {
    const drawing = this.#drawing;
    if (drawing === null) return;
    try {
      run(drawing);
    } catch (error) {
      this.#stop(error);
    }
  }

  #rowsOf(gpu: GpuResources): GpuRowsSource | undefined {
    const factory = (this.#drawing as { rows?: unknown } | null)?.rows;
    if (typeof factory !== 'function') return undefined;
    return {
      create: (view) => {
        const rows = gpu.openRows(this.#deps.rowLimitBytes);
        try {
          return { buffer: factory(view, rows), release: () => rows.close() };
        } catch (error) {
          rows.close();
          throw error;
        }
      },
    };
  }

  #stop(error: unknown): void {
    this.#end();
    this.#stopped = true;
    console.error(`Error in plugin "${this.#owner}":`, error);
  }

  #end(): void {
    this.#gpu?.close();
    this.#gpu = null;
    this.#drawing = null;
    this.#rows = undefined;
  }
}

/**
 * The parts of an instance
 *
 * @internal
 */
export interface GpuParts {
  /**
   * The part of a definition, made when it is new.
   *
   * @param owner - The name its resources are recorded under
   * @throws `DrawError` with the code `invalid-input` for a share out of range, and `too-large` when
   *   the shares come to more than the extensions may take
   */
  add<R>(definition: GpuDefinition<R>, owner: string): GpuPart<R>;
}

/**
 * Creates the parts of an instance
 *
 * @internal
 */
export function createGpuParts(deps: GpuPartsDeps): GpuParts {
  const parts = new Map<object, GpuPart<unknown>>();
  let shares = 0;
  return {
    add<R>(definition: GpuDefinition<R>, owner: string): GpuPart<R> {
      const known = parts.get(definition) as GpuPart<R> | undefined;
      if (known) {
        known.use();
        return known;
      }
      const share = definition.gpuShare;
      if (typeof share !== 'number' || !(share > 0) || share > 1) {
        throw new DrawError('invalid-input', 'gpuShare must be above 0 and at most 1');
      }
      if (shares + share > EXTENSIONS_SHARE + SHARE_EPSILON) {
        throw limitError(
          `The extensions may take ${EXTENSIONS_SHARE} of the GPU limit, ${shares} is taken`,
          false,
        );
      }
      shares += share;
      const part: GpuPart<R> = new GpuPart(definition, owner, deps, () => {
        parts.delete(definition);
        shares -= share;
      });
      parts.set(definition, part as GpuPart<unknown>);
      part.use();
      return part;
    },
  };
}
