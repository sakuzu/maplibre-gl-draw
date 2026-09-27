// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Geometry API (the draw.geometry namespace)
 *
 * Provides the boolean editing operations (union / subtract / intersect), the buffer (buffer)
 * and the split (split) on the selected features. The computation itself lives in the pure
 * functions of the geometry module (src/geometry); this file and api/geometry/ are the
 * integration layer that connects the selection, the transactions, the spatial index and the
 * events.
 *
 * This file holds the namespace and its entry checks. The steps live in api/geometry/.
 *
 *   targets.ts  which features each operation accepts, feature <-> geometry module input and
 *               result, and resolveTargetFeatures (selection / z order / lock / hidden)
 *   apply.ts    the common part: applyResult places one result, commitResult wraps it in one
 *               transaction and moves the selection, emitApplied emits draw.geometry.applied
 *   boolean.ts  union / subtract / intersect on the area types
 *   buffer.ts   the buffer (keeps the inputs, one result per input)
 *   split.ts    the split of a polygon by a line
 *   types.ts    the option and dependency types
 */

import { differenceAll, intersectionAll, unionAll } from '../geometry/boolean.js';
import type { MapLibreGLDraw } from './api.js';
import { resolveSubtractInputs, runAreaOperation } from './geometry/boolean.js';
import { runBuffer } from './geometry/buffer.js';
import { runSplit } from './geometry/split.js';
import {
  isAreaFeature,
  isBufferableFeature,
  isSplitLineFeature,
  resolveTargetFeatures,
} from './geometry/targets.js';
import type { GeometryApiDeps, GeometryBufferOptions } from './geometry/types.js';

export type { GeometryApiDeps, GeometryBufferOptions } from './geometry/types.js';

/**
 * The geometry operations of a draw instance, reached as `draw.geometry`.
 *
 * When the arguments are omitted, the current feature selection is the target (a group or
 * layer selection gives no target). Locked features (either the feature itself, the group it
 * belongs to, or the layer it belongs to) and hidden features (by the shared visible flag or
 * by local hiding) are excluded from the targets, and nothing happens while read-only.
 *
 * Each operation is one transaction, so one undo reverts it, and the result features become
 * selected. When it ran, `draw.geometry.applied` reports the inputs and the results, with
 * `status: 'empty'` when the result had no area and nothing changed. The computation is done
 * by the pure functions of `@sakuzu/maplibre-gl-draw/geometry`.
 *
 * The boolean editing operations (union / subtract / intersect) take the area types
 * (Polygon / MultiPolygon / Circle) and need at least two targets. They replace the inputs
 * with one feature, a Polygon or else a MultiPolygon (a Circle becomes a 64-segment polygon
 * first), which takes the style, the properties and the place of the frontmost input. The
 * buffer and the split instead return an array of IDs, since they can create several
 * features.
 *
 * @example
 * ```typescript
 * draw.on('draw.geometry.applied', ({ operation, status, resultIds }) => {
 *   if (status === 'empty') console.log(operation, 'left nothing');
 * });
 * const merged = draw.geometry.union(); // the selected areas
 * ```
 */
export interface GeometryOperations {
  /**
   * Merges the targets into a single feature.
   *
   * Areas that do not touch give a MultiPolygon.
   *
   * @param ids The IDs of the target features. When omitted, the current selection
   * @returns The ID of the result feature. null when there are fewer than 2 targets
   * @throws {@link geometry!GeometryError} when the computation fails on the input (a degenerate or
   *   malformed ring, for example); nothing changes
   *
   * @example
   * ```typescript
   * const id = draw.geometry.union([parcelA, parcelB]);
   * ```
   */
  union(ids?: string[]): string | null;

  /**
   * Punches out: subtracts the other targets from the target.
   *
   * When `targetId` is given it is a target even when `ids` does not list it. The result
   * still takes the style and the properties of the frontmost input, not of the target.
   *
   * @param targetId The ID of the feature that is subtracted from. When omitted, the
   *   backmost of the targets
   * @param ids The IDs of the target features. When omitted, the current selection
   * @returns The ID of the result feature. null when there are fewer than 2 targets or the
   *   result is empty
   * @throws {@link geometry!GeometryError} when the computation fails on the input; nothing changes
   *
   * @example
   * ```typescript
   * // Subtract the selected features in front from the backmost one
   * draw.geometry.subtract();
   * // Name the feature to subtract from
   * draw.geometry.subtract(parcelId, [parcelId, roadId]);
   * ```
   */
  subtract(targetId?: string, ids?: string[]): string | null;

  /**
   * Keeps the part that is common to all the targets.
   *
   * @param ids The IDs of the target features. When omitted, the current selection
   * @returns The ID of the result feature. null when there are fewer than 2 targets or they
   *   do not overlap
   * @throws {@link geometry!GeometryError} when the computation fails on the input; nothing changes
   *
   * @example
   * ```typescript
   * const id = draw.geometry.intersect();
   * if (id === null) {
   *   // no overlap, or fewer than two targets
   * }
   * ```
   */
  intersect(ids?: string[]): string | null;

  /**
   * Creates the area within the given distance of the targets as new features.
   *
   * The inputs remain, and one result is created per input, just in front of it, with its
   * style and properties. The targets are all geometries
   * (Point / MultiPoint / LineString / MultiLineString / Polygon / MultiPolygon / Circle),
   * and every other type is excluded from the targets. It works from a single target.
   * A negative value (shrinking) applies to the area types only; an input that is a point or
   * a line given a negative value produces no result, and parts of an area narrower than twice
   * the distance disappear. A Circle stays a Circle whose radius grows or shrinks. The
   * distance is laid out along great circles, so it holds at any latitude. A distance of 0 or
   * one that is not finite does nothing.
   *
   * @param options The distance (in meters) and the number of segments
   * @returns The IDs of the result features that were created (in z order). An empty array
   *   when nothing was created
   * @throws {@link geometry!GeometryError} when the computation fails on the input; nothing changes
   *
   * @example
   * ```typescript
   * // The area within 100 m of the selected features
   * const ids = draw.geometry.buffer({ distanceMeters: 100 });
   * // Shrink two areas by 50 m
   * draw.geometry.buffer([parcelA, parcelB], { distanceMeters: -50 });
   * ```
   */
  buffer(options: GeometryBufferOptions): string[];
  /**
   * Creates the area within the given distance of the named features as new features (see
   * the other overload for the details).
   *
   * @param ids The IDs of the target features. When undefined, the current selection
   * @param options The distance (in meters) and the number of segments
   * @returns The IDs of the result features that were created (in z order). An empty array
   *   when nothing was created
   */
  buffer(ids: string[] | undefined, options: GeometryBufferOptions): string[];

  /**
   * Cuts a polygon with a line and replaces it with the several features that result from the
   * split.
   *
   * The targets are one polygon (Polygon / MultiPolygon / Circle) and one line (LineString /
   * MultiLineString / Freehand). The side that is omitted is picked from the current
   * selection by type; when it does not come down to exactly one of each, nothing happens and
   * no event is emitted. The cutting line is not deleted and remains, and the results inherit
   * the place, the style and the properties of the original polygon.
   *
   * When the line does not pass through the polygon (it does not intersect, it stops inside
   * the polygon, or it only touches), nothing is changed. When the line crosses several times
   * the polygon is split into three or more, and when only a part of a MultiPolygon is cut the
   * parts that were not cut also become a single feature. A hole stays on the side that holds
   * it.
   *
   * @param targetId The ID of the polygon feature to be cut. When omitted, the selected polygon
   * @param lineId The ID of the line feature that cuts. When omitted, the selected line
   * @returns The IDs of the result features that were created (in z order). An empty array
   *   when nothing was split
   * @throws {@link geometry!GeometryError} when the computation fails on the input; nothing changes
   *
   * @example
   * ```typescript
   * // With one area and one line selected
   * const ids = draw.geometry.split();
   * // Or by name
   * draw.geometry.split(parcelId, cutLineId);
   * ```
   */
  split(targetId?: string, lineId?: string): string[];
}

/** The `geometry` namespace on its own (what `createGeometryApi` returns) */
export type GeometryApi = Pick<MapLibreGLDraw, 'geometry'>;

/**
 * Creates the draw.geometry namespace.
 */
export function createGeometryApi(deps: GeometryApiDeps): GeometryApi {
  const { store } = deps;

  // While readOnly, writes to the Store become a no-op, so an operation would report results
  // that were never created. It is rejected at the entry point.
  const blocked = (): boolean => store.isReadOnly();

  return {
    geometry: {
      union(ids?: string[]): string | null {
        if (blocked()) return null;
        const inputs = resolveTargetFeatures(store, ids, isAreaFeature);
        if (inputs.length < 2) return null;
        return runAreaOperation(deps, 'union', inputs, (areas) => unionAll(areas));
      },

      subtract(targetId?: string, ids?: string[]): string | null {
        if (blocked()) return null;
        const resolved = resolveSubtractInputs(store, targetId, ids);
        if (resolved === null) return null;

        const { inputs, targetIndex } = resolved;
        return runAreaOperation(deps, 'subtract', inputs, (areas) =>
          differenceAll(
            areas[targetIndex],
            areas.filter((_, index) => index !== targetIndex),
          ),
        );
      },

      intersect(ids?: string[]): string | null {
        if (blocked()) return null;
        const inputs = resolveTargetFeatures(store, ids, isAreaFeature);
        if (inputs.length < 2) return null;
        return runAreaOperation(deps, 'intersect', inputs, (areas) => intersectionAll(areas));
      },

      buffer(
        idsOrOptions: string[] | GeometryBufferOptions | undefined,
        maybeOptions?: GeometryBufferOptions,
      ): string[] {
        // It accepts the two forms buffer(options) and buffer(ids, options).
        const ids = Array.isArray(idsOrOptions) ? idsOrOptions : undefined;
        const options = Array.isArray(idsOrOptions) ? maybeOptions : idsOrOptions;
        if (blocked() || options === undefined) return [];

        // A distance of 0 is "a copy of the original shape", a non-finite value is meaningless.
        // The operation itself is not performed.
        const { distanceMeters } = options;
        if (!Number.isFinite(distanceMeters) || distanceMeters === 0) return [];

        const inputs = resolveTargetFeatures(store, ids, isBufferableFeature);
        // Unlike the boolean operations, it works from a single target.
        if (inputs.length === 0) return [];
        return runBuffer(deps, inputs, options);
      },

      split(targetId?: string, lineId?: string): string[] {
        if (blocked()) return [];

        // The polygon and the line are resolved separately. When omitted, both are picked from
        // the current selection by type.
        const areas = resolveTargetFeatures(
          store,
          targetId === undefined ? undefined : [targetId],
          isAreaFeature,
        );
        const lines = resolveTargetFeatures(
          store,
          lineId === undefined ? undefined : [lineId],
          isSplitLineFeature,
        );
        // When it does not come down to exactly one polygon and one line, nothing is done.
        if (areas.length !== 1 || lines.length !== 1) return [];

        return runSplit(deps, areas[0], lines[0]);
      },
    },
  };
}
