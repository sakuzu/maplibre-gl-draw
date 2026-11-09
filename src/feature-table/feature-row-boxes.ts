// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The boxes of the rows of features whose boxes come from more than their points
 * (`FeatureRowBoxes`)
 *
 * The tables find a row by the box it covers as it is drawn, the box of its points unless the
 * user of the tables gives another (`rowBoxes`). The library gives the box of an Image, sized at
 * the zoom it was created at and at the tile size of the map, and the box the calculation of the
 * type of an extension gives (`setCalculator`), and tells the tables to read every such box again
 * (`refreshBoxes`) when the tile size or a calculation changes.
 */

import type { BBox } from '../geometry/types.js';
import type { Feature } from '../shared/types/model.js';
import { getBoundingBox } from '../shared/utils/feature-bbox.js';

/**
 * How the box of a row of a type is worked out from its feature
 *
 * @internal
 */
export type RowBoxCalculator = (feature: Feature, tileSize: number) => BBox;

/**
 * The boxes of the rows of features whose boxes come from more than their points, given to the
 * tables
 *
 * @internal
 */
export class FeatureRowBoxes {
  #tileSize = 512;
  readonly #calculators = new Map<string, RowBoxCalculator>();
  #refresh: (() => void) | null = null;

  /**
   * The box of the rows of a type, as the tables take it (`rowBoxes`): the calculation of the
   * type, the box of an Image, or undefined for a type whose rows take the box of their points.
   * The tables ask it once per type until they are told to read the boxes again
   */
  readonly boxesOf = (type: string): ((feature: Feature) => BBox) | undefined => {
    const calculator = this.#calculators.get(type);
    if (calculator) return (feature) => calculator(feature, this.#tileSize);
    if (type === 'Image') return (feature) => getBoundingBox(feature, this.#tileSize);
    return undefined;
  };

  /** Sets what tells the tables to read every box given again (`refreshBoxes`) */
  attach(refresh: () => void): void {
    this.#refresh = refresh;
  }

  /** Sets the size of the tiles the boxes are worked out at (an Image, a calculation) */
  setTileSize(tileSize: number): void {
    if (tileSize === this.#tileSize) return;
    this.#tileSize = tileSize;
    this.#refresh?.();
  }

  /**
   * Sets how the box of the rows of a type is worked out from their features (the type of an
   * extension that covers more than its positions); undefined puts it back
   */
  setCalculator(type: string, calculator: RowBoxCalculator | undefined): void {
    if (calculator) this.#calculators.set(type, calculator);
    else this.#calculators.delete(type);
    this.#refresh?.();
  }
}

/** The boxes given to tables, by the reading side of the tables */
const BOXES = new WeakMap<object, FeatureRowBoxes>();

/**
 * Keeps the boxes given to tables, found by them (`featureRowBoxesOf`)
 *
 * @internal
 */
export function keepFeatureRowBoxes(tables: object, boxes: FeatureRowBoxes): void {
  BOXES.set(tables, boxes);
}

/**
 * The boxes the library gives to tables it made (undefined for tables made elsewhere)
 *
 * @internal
 */
export function featureRowBoxesOf(tables: object | undefined): FeatureRowBoxes | undefined {
  return tables ? BOXES.get(tables) : undefined;
}
