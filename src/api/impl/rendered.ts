// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.rendered`: the features as this client draws them, and `rendered.changed`
 *
 * A feature as it is drawn is made by the shapes of the instance (`RenderedShapes`), and its
 * selection box by the function the selection UI draws and hits it with (`selectionBoxOf`). The
 * features changed since the last notification are gathered from the
 * changes of the document (the features of a Store of objects and the rows of a Store of rows) and
 * of the sketches, and told once the draw of the map that draws them is done: the one signal of
 * the drawing that a draw is done, after which the screen answers for it. A change of the look
 * (a layer rule, the `style` option, a type added or removed) and of the selection box with the
 * view (its margin) is not told: those are read at each draw.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import type { DraggedRows } from '../../feature-table/dragged-rows.js';
import type { SelectionUIConfig } from '../../shared/config/selection.js';
import { createCoordinateTransform } from '../../shared/math/index.js';
import type { RenderedShapes } from '../../sketches/rendered-shapes.js';
import { featureIdsOfEdit } from '../../sketches/sketch-edits.js';
import type { Store } from '../../store/store.js';
import { selectionBoxOf } from '../../view/ui/bounds.js';
import type { SelectionExtensionRegistry } from '../../view/ui/selection-ui/extension-registry.js';
import type { Footprint } from '../extension/feature-type.js';
import type { Feature } from '../model.js';
import type { RenderedResource } from '../rendered.js';
import type { Sketch } from '../sketches.js';
import type { EventHub } from './events.js';
import { invalidInput } from './shared.js';

/**
 * What the resource reads
 *
 * @internal
 */
export interface RenderedDeps {
  readonly map: MapLibreMap;
  readonly store: Store;
  /** The shapes as they are seen */
  readonly shapes: RenderedShapes;
  /** The features selected now, which an edit of `{ selection: true }` edits */
  selectedIds(): readonly string[];
  /** The look of the selection the instance draws with (its margin is read at each call) */
  readonly selectionStyle: SelectionUIConfig;
  /** The custom boxes and point frames of the instance */
  readonly selectionExtensions: SelectionExtensionRegistry;
  /** The events of the instance, which it listens to and sends `rendered.changed` on */
  readonly events: EventHub;
  /** Calls a listener once each frame is drawn; returns the function that stops it */
  onFrameDrawn(listener: () => void): () => void;
}

/**
 * The resource `draw.rendered` of an instance, with what stops its listening
 *
 * @internal
 */
export function createRendered(deps: RenderedDeps): {
  rendered: RenderedResource;
  stop(): void;
} {
  const { map, store, events, shapes } = deps;

  const rendered: RenderedResource = {
    get: (id) => shapes.get(id) as Feature | undefined,
    getMany(ids) {
      if (!Array.isArray(ids)) throw invalidInput('The IDs must be an array');
      return ids.map((id) => shapes.get(id) as Feature | undefined);
    },
    getSelectionBox: (id) => boxOf(id, deps.selectionStyle.box.margin),
    getFootprint: (id) => boxOf(id, 0),
    getDraggedRows(): DraggedRows | null {
      return shapes.draggedRows();
    },
  };

  /**
   * The box of a feature as it is drawn, made by the function the selection UI draws it with: its
   * footprint with a margin (none for the footprint itself)
   */
  function boxOf(id: string, margin: number): Footprint | null {
    const feature = shapes.get(id);
    if (!feature) return null;
    const box = selectionBoxOf(
      feature,
      createCoordinateTransform(map),
      margin,
      deps.selectionExtensions,
    );
    if (!box) return null;
    const footprint: Footprint =
      box.kind === 'screen'
        ? {
            kind: 'screen',
            position: [box.position[0], box.position[1]],
            halfWidthPx: box.halfWidth,
            halfHeightPx: box.halfHeight,
          }
        : {
            kind: 'ground',
            corners: {
              topLeft: [box.topLeft[0], box.topLeft[1]],
              topRight: [box.topRight[0], box.topRight[1]],
              bottomRight: [box.bottomRight[0], box.bottomRight[1]],
              bottomLeft: [box.bottomLeft[0], box.bottomLeft[1]],
            },
          };
    return footprint;
  }

  // The features whose shape as drawn changed since the last notification
  const changed = new Set<string>();
  // The features each sketch edits, so that an update or an end tells those it no longer edits
  const touched = new Map<string, readonly string[]>();
  const touchedBy = (sketch: Sketch): readonly string[] => {
    const ids = new Set<string>();
    for (const edit of sketch.edits) {
      for (const id of featureIdsOfEdit(edit, deps.selectedIds)) ids.add(id);
    }
    return [...ids];
  };
  const sketchChanged = (sketch: Sketch, ended: boolean): void => {
    for (const id of touched.get(sketch.id) ?? []) changed.add(id);
    if (ended) {
      touched.delete(sketch.id);
      return;
    }
    const now = touchedBy(sketch);
    touched.set(sketch.id, now);
    for (const id of now) changed.add(id);
  };

  const stops = [
    events.on('document.changed', (change) => {
      const features = change.features;
      for (const feature of features?.created ?? []) changed.add(feature.id);
      for (const update of features?.updated ?? []) changed.add(update.id);
      for (const feature of features?.deleted ?? []) changed.add(feature.id);
      // The rows a Store of rows wrote, which it tells by their handles, not as features
      const tables = store.tables;
      if (!change.rows || !tables) return;
      for (const rows of change.rows.layers.values()) {
        for (const handles of [rows.created, rows.updated, rows.deleted]) {
          for (const handle of handles) {
            const id = tables.getRowId(handle);
            if (id !== undefined) changed.add(id);
          }
        }
      }
    }),
    events.on('sketch.added', ({ sketch }) => sketchChanged(sketch, false)),
    events.on('sketch.updated', ({ sketch }) => sketchChanged(sketch, false)),
    events.on('sketch.removed', ({ sketch }) => sketchChanged(sketch, true)),
    // Told once the frame that draws the changes is drawn, with the values of that frame
    deps.onFrameDrawn(() => {
      if (changed.size === 0) return;
      const ids = [...changed];
      changed.clear();
      events.emit('rendered.changed', { ids });
    }),
  ];

  return {
    rendered,
    stop() {
      for (const stop of stops) stop();
      changed.clear();
      touched.clear();
    },
  };
}
