// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The split: cuts a polygon with a line into several features
 */

import type { MultiPolygonCoordinates } from '../../geometry/index.js';
import { splitArea } from '../../geometry/index.js';
import type { Feature, FeatureCoordinates, FeatureType } from '../../store/types.js';
import { applyResult, emitApplied } from './apply.js';
import { toAreaCoordinates, toResultGeometry, toSplitPaths } from './targets.js';
import type { GeometryApiDeps } from './types.js';

/**
 * Runs the split and replaces the polygon with the group of features that result from the
 * split.
 *
 * All the results are gathered into one store.transact (a single undo goes back to the
 * original polygon). Only the first result deletes the original polygon, and the results that
 * follow are stacked just in front of the previous result. The previous result has inherited
 * both the style and the properties from the original polygon, so using it as the one to
 * inherit from does not change the content.
 *
 * @param area The polygon to be cut
 * @param line The cutting line (it is not deleted and remains)
 */
export function runSplit(deps: GeometryApiDeps, area: Feature, line: Feature): string[] {
  const { store } = deps;
  const inputIds = [area.id, line.id];
  const source = toAreaCoordinates(area);
  const paths = toSplitPaths(line);

  const parts: MultiPolygonCoordinates[] = [];
  if (source !== null && paths.length > 0) {
    // A MultiLineString cuts one line at a time in order (it cuts the previous result further)
    let current = splitArea(source, paths[0]);
    for (let i = 1; i < paths.length; i++) {
      current = current.flatMap((part) => splitArea(part, paths[i]));
    }
    parts.push(...current);
  }

  const geometries: { type: FeatureType; coordinates: FeatureCoordinates }[] = [];
  for (const part of parts) {
    const geometry = toResultGeometry(part);
    if (geometry !== null) geometries.push(geometry);
  }

  if (geometries.length < 2) {
    // The line did not divide the polygon. The inputs are not changed at all; only the
    // notification is emitted.
    emitApplied(deps.eventEmitter, {
      operation: 'split',
      inputIds,
      resultId: null,
      resultIds: [],
      status: 'empty',
    });
    return [];
  }

  const resultIds = store.transact(() => {
    const ids: string[] = [];
    let anchor = area;
    for (const geometry of geometries) {
      const id = applyResult(deps, {
        anchor,
        // The original polygon is deleted only on the first pass
        removedIds: ids.length === 0 ? [area.id] : [],
        geometry,
      });
      ids.push(id);
      anchor = store.getFeature(id) ?? anchor;
    }
    store.setSelection('feature', ids);
    return ids;
  });

  emitApplied(deps.eventEmitter, {
    operation: 'split',
    inputIds,
    resultId: resultIds[0],
    resultIds,
    status: 'applied',
  });
  return resultIds;
}
