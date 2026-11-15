// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Whether the instance knows the type of a feature: the one judgment of the features of a type
 * no part of the instance defines
 *
 * A feature keeps the name of its type (`maplibre-gl-draw:featureType`, a built-in type with
 * the kind of its geometry having no key), whatever the instance knows of it, so that a document
 * opens on an instance that lacks the extension of one of its types. A type is known when it is
 * built in, or when an extension of the instance defines it (`featureTypes.add` or
 * `ctx.addFeatureType`, which register it with its fields, `TransformFieldsRegistry`). A feature
 * of a type the instance does not know is kept with every value it has, and:
 *
 * - is not drawn (neither in the drawing of its layer, nor at once, nor in a sketch), so it is
 *   not hit by a click, a pick or a box, not snapped to, and has no selection box
 * - is read, its attributes written, placed and deleted as any other
 * - refuses every write that changes its geometry (`invalidState`): its type decides how its
 *   geometry goes with its values, and the instance does not know how
 *
 * Once the type is defined (or no longer is), what draws its features and what hits them follows
 * the revision of the registry (`TransformFieldsRegistry.revision`).
 *
 * The rows of a layer held as rows are judged once for each name of a type of a page, never for
 * each row: their names are a dictionary of the page (`rowTypeKnown`).
 *
 * @internal
 */

import type { PageData, PageValues } from '@sakuzu/kasane/render';
import { TYPE_COLUMN } from '../table/feature-row-columns.js';
import type { TransformFieldsRegistry } from './transform-roles.js';

/**
 * The feature types of the library, which an instance always knows
 *
 * @internal
 */
export const BUILT_IN_FEATURE_TYPES: ReadonlySet<string> = new Set([
  'Point',
  'LineString',
  'Polygon',
  'MultiPoint',
  'MultiLineString',
  'MultiPolygon',
  'Image',
  'Circle',
  'Freehand',
]);

/**
 * Whether the instance knows a type: it is built in, or a custom type of the instance
 *
 * @param registry The custom types of the instance (null: none, as for a Store of no instance)
 * @internal
 */
export function isKnownFeatureType(
  type: string,
  registry: TransformFieldsRegistry | null | undefined,
): boolean {
  return BUILT_IN_FEATURE_TYPES.has(type) || registry?.of(type) !== undefined;
}

/**
 * A judgment of the types of many features: each name is judged once, the last name kept
 *
 * @param registry The custom types of the instance
 * @internal
 */
export function knownTypeJudge(
  registry: TransformFieldsRegistry | null | undefined,
): (type: string) => boolean {
  let lastType: string | null = null;
  let lastKnown = false;
  return (type) => {
    if (type !== lastType) {
      lastType = type;
      lastKnown = isKnownFeatureType(type, registry);
    }
    return lastKnown;
  };
}

/** The judgment of the names of the types of a page, as made last */
let judged: {
  column: PageValues;
  registry: TransformFieldsRegistry | null | undefined;
  revision: number;
  known: Uint8Array;
} | null = null;

/**
 * Whether the instance knows the type of a row of a page: judged once for each name of the
 * dictionary of the page (the judgment of a page is kept until another page, another registry or
 * another revision of it is asked for)
 *
 * @param registry The custom types of the instance
 * @internal
 */
export function rowTypeKnown(
  data: PageData,
  row: number,
  registry: TransformFieldsRegistry | null | undefined,
): boolean {
  const column = data.wholes[TYPE_COLUMN] as PageValues;
  const revision = registry?.revision ?? 0;
  let known = judged?.known;
  if (
    !known ||
    judged?.column !== column ||
    judged.registry !== registry ||
    judged.revision !== revision ||
    known.length !== column.values.length
  ) {
    const values = column.values;
    known = new Uint8Array(values.length);
    for (let i = 0; i < values.length; i++) {
      known[i] = isKnownFeatureType(values[i] as string, registry) ? 1 : 0;
    }
    judged = { column, registry, revision, known };
  }
  return known[column.indexes[row]] === 1;
}
