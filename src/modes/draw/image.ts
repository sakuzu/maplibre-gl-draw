// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DrawImageMode
 *
 * Image drawing mode. A click on the map (or `draw.mode.drawing.add`) says where the image goes:
 * the mode emits the image.request event there and leaves the file selection to the application.
 */

import type { KeyNormalizedEvent, MouseNormalizedEvent } from '../../dispatcher/types.js';
import type { Coordinate, Mode } from '../../store/types.js';
import type { EngineModeContext, EngineModeHandler } from '../handler.js';
import { resolveCommitLayer } from './commit-layer.js';

/**
 * DrawImageMode implementation
 *
 * @internal
 */
export class DrawImageMode implements EngineModeHandler {
  readonly modeName: Mode = 'drawImage';
  readonly writesFeatures = true;

  private context!: EngineModeContext;

  onStart(context: EngineModeContext): void {
    this.context = context;
    const { map, store } = this.context;

    // The cursor says that a click places the image
    map.getCanvas().style.cursor = 'crosshair';

    // Clear the selection (not notified as a change)
    store.transact(() => {
      store.setSelection(null, []);
    }, 'silent');
  }

  onStop(): void {
    this.context.map.getCanvas().style.cursor = '';
  }

  onClick(event: MouseNormalizedEvent): void {
    // Where the click was, before any snapping: the image is placed where it was clicked
    const clicked = this.context.getClickPosition?.() ?? null;
    const coordinate: Coordinate = clicked
      ? [clicked[0], clicked[1]]
      : [event.lngLat.lng, event.lngLat.lat];
    // Nothing is requested when no layer can be written (the mode returns to select)
    const layerId = resolveCommitLayer(this.context);
    if (layerId === null) return;
    const zoom = this.context.map.getZoom();

    // Emit the event and delegate the file selection to the application
    this.context.eventEmitter.emit('image.request', { coordinate, zoom, layerId });

    // Done: back to the select mode (or ready for the next image when the mode repeats)
    this.context.setMode('select');
  }

  onKeyDown(event: KeyNormalizedEvent): boolean {
    if (event.key !== 'Escape') return false;
    this.context.setMode('select');
    return true;
  }
}
