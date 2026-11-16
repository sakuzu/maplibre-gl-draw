// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The sources of quads of the custom types, as the drawing of the rows holds them (a prototype)
 *
 * A source an extension gives (`RowQuadSource`) is wrapped once per instance of the library in a
 * `RowQuadType`: the renderer of the rows compiles the function of the source into its program of
 * the quads, and the classification of the rows reads whether it can draw the rows of the type in
 * one draw (`state`). Until the program links, and for good when the function does not compile,
 * the rows of the type are drawn one by one by their renderer. Every change of the state changes
 * `revision`, and the rows of the type are classified again.
 */

import type { RowQuadOut, RowQuadSource } from './rows-format.js';

/**
 * Whether the rows of a source of quads are drawn in one draw: not yet (`pending`: the program
 * compiles), yes (`ready`), or never (`failed`: its function does not compile, or there is no
 * room for it)
 *
 * @internal
 */
export type RowQuadState = 'pending' | 'ready' | 'failed';

/**
 * A source of quads of a custom type, in one instance of the library
 *
 * @internal
 */
export class RowQuadType {
  /** Whether its rows are drawn in one draw */
  state: RowQuadState = 'pending';
  /** Changes with every change of `state` (the rows of its type are classified again) */
  revision = 0;
  /** The renderer of the rows it is registered with (null for none) */
  owner: object | null = null;
  /** Its slot in the programs of the quads of that renderer, from 1 (0: none) */
  slot = 0;
  /** The object the quad of a row is written into */
  readonly out: RowQuadOut = {
    halfWidth: 0,
    halfHeight: 0,
    meters: false,
    angleDegrees: 0,
    values: new Float32Array(4),
  };

  constructor(readonly source: RowQuadSource) {}

  /** Sets the state (and changes the revision when it changes) */
  setState(state: RowQuadState): void {
    if (this.state === state) return;
    this.state = state;
    this.revision++;
  }

  /** Whether a write of these keys changes what its rows draw (null: any key) */
  readsKeys(keys: ReadonlySet<string> | null): boolean {
    const read = this.source.keys;
    if (!read || !keys) return true;
    for (const key of read) if (keys.has(key)) return true;
    return false;
  }
}

/** The wrappers of the sources of quads, by instance (its custom layer) */
const wrappers = new WeakMap<object, WeakMap<RowQuadSource, RowQuadType>>();

/**
 * The wrapper of a source of quads in an instance of the library: one per source, whatever draws
 * the rows of its type one by one (the renderer of the definition, or the one of `webgl`)
 *
 * @param instance - What tells the instance apart (its custom layer)
 * @internal
 */
export function rowQuadTypeOf(instance: object, source: RowQuadSource): RowQuadType {
  let bySource = wrappers.get(instance);
  if (!bySource) {
    bySource = new WeakMap();
    wrappers.set(instance, bySource);
  }
  let type = bySource.get(source);
  if (!type) {
    type = new RowQuadType(source);
    bySource.set(source, type);
  }
  return type;
}
