// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The values the features had before a change (`FeatureValues`), as a subscriber of
 * `draw.document.subscribe` that asked for them receives them
 *
 * The values are those the Store gave with its change: the values the rows had before it, by
 * layer, read once. Every subscriber that asks gets an object of its own over the same arrays,
 * which are not copied: the arrays are held once, and counted by the objects that hold them, so
 * that they go once every object has let go of them.
 */

import type { RowValues } from '../../store/built-in/types.js';
import type { FeatureValues } from '../model.js';

/**
 * The values before of one change, held once for every subscriber that asked for them
 *
 * @internal
 */
export class SharedValues {
  /** The values the rows had before the change, by the id of their layer */
  readonly byLayer: ReadonlyMap<string, RowValues>;
  /** The memory the arrays take, in bytes (an estimate) */
  readonly byteLength: number;
  /** The number of rows they hold values of */
  readonly rowCount: number;
  /** How many objects of the subscribers hold them */
  #holders = 0;

  constructor(byLayer: ReadonlyMap<string, RowValues>) {
    this.byLayer = byLayer;
    let bytes = 0;
    let rows = 0;
    for (const values of byLayer.values()) {
      rows += values.rows.length;
      bytes += values.rows.byteLength;
      if (values.deleted) bytes += values.deleted.byteLength;
      for (const column of values.fields.values()) bytes += 8 * column.length;
      const geometry = values.geometry;
      if (geometry) {
        bytes +=
          geometry.types.byteLength +
          geometry.coordinates.byteLength +
          geometry.partStarts.byteLength +
          geometry.ringStarts.byteLength +
          geometry.positionStarts.byteLength;
      }
    }
    this.byteLength = bytes;
    this.rowCount = rows;
  }

  /** The number of the objects that hold them */
  get holders(): number {
    return this.#holders;
  }

  /** An object of a subscriber of its own over the same arrays */
  hold(): FeatureValues {
    this.#holders += 1;
    return new HeldValues(this) as unknown as FeatureValues;
  }
}

/** The values of one subscriber, over the arrays held once */
class HeldValues {
  readonly #shared: SharedValues;

  constructor(shared: SharedValues) {
    this.#shared = shared;
    Object.freeze(this);
  }

  get byteLength(): number {
    return this.#shared.byteLength;
  }

  get featureCount(): number {
    return this.#shared.rowCount;
  }

  /** The values held once that an object of a subscriber is over (undefined for another object) */
  static sharedOf(values: unknown): SharedValues | undefined {
    return typeof values === 'object' && values !== null && #shared in values
      ? (values as HeldValues).#shared
      : undefined;
  }
}

/**
 * The values held once that the values of a subscriber are over: what `features.restore` reads
 * (undefined for an object that is not values of features)
 *
 * @internal
 */
export function sharedValuesOf(values: unknown): SharedValues | undefined {
  return HeldValues.sharedOf(values);
}
