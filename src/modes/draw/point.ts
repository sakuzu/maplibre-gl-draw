// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DrawPointMode
 *
 * Point drawing mode. Creates a point on click.
 */

import type { KeyNormalizedEvent, MouseNormalizedEvent } from '../../dispatcher/types.js';
import type { Feature, Mode } from '../../store/types.js';
import type { ModeContext, ModeHandler } from '../handler.js';
import { createdZoomProperty, resolveCommitLayer } from './commit-layer.js';

/**
 * DrawPointMode implementation
 *
 * @internal
 */
export class DrawPointMode implements ModeHandler {
  readonly modeName: Mode = 'draw_point';
  readonly writesFeatures = true;

  private context!: ModeContext;

  onStart(context: ModeContext): void {
    this.context = context;
    // Change the cursor to a crosshair
    this.context.map.getCanvas().style.cursor = 'crosshair';
    // Clear the selection (not notified as a change)
    this.context.store.transact(() => {
      this.context.store.setSelection(null, []);
    }, 'silent');
  }

  onStop(): void {
    // Restore the cursor
    this.context.map.getCanvas().style.cursor = '';
  }

  /**
   * A double click while drawing is two clicks of the drawing; it never zooms the map
   * (consumed by preventing its default action)
   */
  onDoubleClick(event: MouseNormalizedEvent): void {
    event.originalEvent.preventDefault();
  }

  onClick(event: MouseNormalizedEvent): void {
    const { store, generateFeatureId, autoNameGenerator } = this.context;

    // Discard the drawing when no layer can be written any more
    const layerId = resolveCommitLayer(this.context);
    if (layerId === null) return;

    // Generate the automatic name
    const autoName = autoNameGenerator.generateName('Point');

    // Create a new point feature
    const feature: Feature = {
      groupId: undefined,
      id: generateFeatureId(),
      type: 'Point',
      geometry: { type: 'Point', coordinates: [event.lngLat.lng, event.lngLat.lat] },
      layerId,
      properties: {
        ...createdZoomProperty(this.context),
        ...(autoName !== undefined && { name: autoName }),
      },
      locked: false,
      visible: true,
      style: {},
    };

    // Create the feature (notified as a change)
    store.transact(() => {
      store.createFeature(feature);

      // Select the created feature
      store.setSelection('feature', [feature.id]);
    });

    // Transition to the select mode
    // Note: the redraw is triggered automatically by RenderCoordinator subscribing to Store changes
    this.context.setMode('select');
  }

  onKeyDown(event: KeyNormalizedEvent): void {
    // Escape returns to the select mode
    if (event.key === 'Escape') {
      this.context.setMode('select');
    }
  }
}
