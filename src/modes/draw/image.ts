// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DrawImageMode
 *
 * Image drawing mode. Emits the draw.image.request event and delegates the
 * responsibility of showing the file selection UI to the demo/host application.
 */

import type { KeyNormalizedEvent } from '../../dispatcher/types.js';
import type { Coordinate, Mode } from '../../store/types.js';
import type { EngineModeContext, EngineModeHandler } from '../handler.js';
import { resolveCommitLayer } from './commit-layer.js';

/**
 * DrawImageMode implementation
 *
 * @internal
 */
export class DrawImageMode implements EngineModeHandler {
  readonly modeName: Mode = 'draw_image';
  readonly writesFeatures = true;

  private context!: EngineModeContext;

  onStart(context: EngineModeContext): void {
    this.context = context;
    const { map, store, eventEmitter } = this.context;

    // Set the cursor to the default
    map.getCanvas().style.cursor = 'default';

    // Clear the selection (not notified as a change)
    store.transact(() => {
      store.setSelection(null, []);
    }, 'silent');

    // The position of the click that led here (a listener of the click entered the mode), or
    // else the center of the map
    const clicked = this.context.getClickPosition?.() ?? null;
    const center = map.getCenter();
    const coordinate: Coordinate = clicked ? [clicked[0], clicked[1]] : [center.lng, center.lat];
    const zoom = map.getZoom();
    // Nothing is requested when no layer can be written (the mode returns to select)
    const layerId = resolveCommitLayer(this.context);
    if (layerId === null) return;

    // Emit the event and delegate the file selection to the demo side
    eventEmitter.emit('image.request', { coordinate, zoom, layerId });

    // Return to the select mode
    this.context.setMode('select');
  }

  onStop(): void {
    this.context.map.getCanvas().style.cursor = '';
  }

  onKeyDown(event: KeyNormalizedEvent): void {
    if (event.key === 'Escape') {
      this.context.setMode('select');
    }
  }
}
