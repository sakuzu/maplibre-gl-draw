// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Features of GeoJSON read as the values of rows of a layer, by the rules of a load
 */

import { type CoordinateDimensions, unionDims, type Value } from '@sakuzu/tabane';
import type { Feature as GeoJSONFeature, Geometry } from 'geojson';
import { readGeoJSONFeature } from '../feature-table/geojson-read.js';
import type { FeatureStyle, SkippedFeature } from './model.js';

/**
 * A row read from a feature of GeoJSON: the values of a row of a layer, without its id
 *
 * @experimental
 */
export interface GeoJSONRow {
  /** The position in the input of the feature the row is read from */
  readonly index: number;
  /**
   * The ID the input gives the feature (`maplibre-gl-draw:id`, else the `id` of the Feature, a
   * number as its text), on the first row read from it; a reference to it names that row
   */
  readonly inputId?: string;
  /** The type of the feature (`'Polygon'`, `'Circle'`, the type of an extension) */
  readonly type: string;
  /**
   * The geometry, every value of its positions kept: `x` and `y`, and the `z` (the third value)
   * and the `m` (the fourth) the input gives
   */
  readonly geometry: Geometry;
  /**
   * The dimensions of the positions of the feature the row is read from: `xy`, `xyz` when a
   * position has three values, `xyzm` when one has four. A position of fewer has NaN for the
   * values it does not have, as a row of the layer holds it
   */
  readonly dimensions: CoordinateDimensions;
  /** The style (`{}` when the input gives none) */
  readonly style: Readonly<FeatureStyle>;
  /** The attributes: the user-defined properties and the values of the library */
  readonly properties: Readonly<Record<string, Value>>;
  /** Whether the row is shown */
  readonly visible: boolean;
  /** Whether the row is locked */
  readonly locked: boolean;
}

/**
 * The rows read from features of GeoJSON, and the features that were left out
 *
 * @experimental
 */
export interface GeoJSONRows {
  /** The rows, in the order of the input */
  readonly rows: GeoJSONRow[];
  /** The features of the input that were not read, in the order of the input, and why */
  readonly skipped: SkippedFeature[];
  /**
   * The dimensions that hold the positions of every row (`xy` for none): the rows are written to a
   * layer of these dimensions or more (`FeatureTablesOptions.dimensionsOf`; `unionDims` of
   * `@sakuzu/tabane` gives the dimensions that hold both)
   */
  readonly dimensions: CoordinateDimensions;
}

/**
 * Reads features of GeoJSON as the values of rows of a layer, as `document.load` reads them
 *
 * The type comes back from `maplibre-gl-draw:featureType`, the style from
 * `maplibre-gl-draw:style` (else from the keys of simplestyle-spec), `visible` and `locked` from
 * their prefixed keys, and the values of the library stay in `properties` with their prefix. A
 * Multi geometry is one row, and a GeometryCollection is folded by type into at most three
 * rows. Every value of a position is kept, the third its `z` and the fourth its `m`, where a load
 * cuts a position to the two values of a Feature: a row of a layer holds them, the layer raised to
 * their dimensions (`dimensions`). The ID
 * the input gives a feature is not the ID of a row: the caller gives the rows their IDs, and
 * `inputId` tells which row a reference to the ID of the input names (rewrite the references
 * with `rewriteReferences`). The layer and the group a feature names are not read: the rows go
 * where the caller writes them.
 *
 * A feature that cannot be read is left out and reported in `skipped`: one a load leaves out, one
 * with a position of more than four values, and a single Image point that embeds its image, which
 * is a file of its own and not a value of a row.
 *
 * @param features - The features of a FeatureCollection
 * @returns The rows and the features left out
 * @throws `DrawError` with the code `invalid-input` when a value of the properties is not a
 *   value, as a load throws
 * @experimental
 */
export function rowsOfGeoJSON(features: readonly GeoJSONFeature[]): GeoJSONRows {
  const rows: GeoJSONRow[] = [];
  const skipped: SkippedFeature[] = [];
  let dimensions: CoordinateDimensions = 'xy';
  features.forEach((feature: unknown, index) => {
    const read = readGeoJSONFeature(feature, false, 'all');
    if (typeof read === 'string') {
      skipped.push({ index, reason: read });
      return;
    }
    if (read.image) {
      skipped.push({ index, reason: 'the feature embeds an image, which a row does not hold' });
      return;
    }
    dimensions = unionDims(dimensions, read.dimensions);
    read.parts.forEach(({ type, geometry }, i) => {
      rows.push({
        index,
        ...(i === 0 && read.inputId !== undefined && { inputId: read.inputId }),
        type,
        geometry,
        dimensions: read.dimensions,
        style: read.style,
        properties: read.parts.length === 1 ? read.properties : { ...read.properties },
        visible: read.visible,
        locked: read.locked,
      });
    });
  });
  return { rows, skipped, dimensions };
}
