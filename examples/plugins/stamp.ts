// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The stamp plugin of the plugins example: a mode of its own that puts a stamp (a star-shaped
// point) where the user clicks, an event it listens to, and an api that the page asks.

import type { Feature, FeatureStyle, ModeFactory, Plugin } from '@sakuzu/maplibre-gl-draw';

/** The states of a stamp, kept in its `stamp` attribute, and the color of each */
export const STAMP_COLORS = { planned: '#e0a800', done: '#2a9d8f' } as const;
export type StampState = keyof typeof STAMP_COLORS;

/** What the plugin offers the page (`draw.extensions.plugins.getApi('stamp')`) */
export interface StampApi {
  /** The stamps created since the plugin was added: by its mode, by a load or by code */
  count(): number;
}

/** Whether a feature is a stamp */
export function isStamp(feature: Feature): boolean {
  return feature.properties.stamp !== undefined;
}

/** The look of a stamp in a state */
export function stampStyle(state: StampState): FeatureStyle {
  return { pointShape: 'star', pointRadius: 11, pointColor: STAMP_COLORS[state] };
}

/**
 * A plugin that adds the mode `stamp`
 *
 * @param onStamp Called with the count after each stamp is created
 */
export function createStampPlugin(onStamp?: (count: number) => void): Plugin<StampApi> {
  let stamps = 0;

  // A mode receives the input through its handlers; this one needs clicks and keys. `writes`
  // keeps it from starting while no layer can be written
  const stampMode: ModeFactory = (ctx) => ({
    writes: true,
    onEnter() {
      ctx.cursor.set('crosshair');
    },
    onClick(event) {
      // Created as the built-in modes create: in the writable layer, with an automatic name
      ctx.commitFeature({
        type: 'Point',
        geometry: { type: 'Point', coordinates: event.lngLat },
        properties: { stamp: 'planned' },
        style: stampStyle('planned'),
      });
    },
    onKeyDown(event) {
      if (event.key === 'Escape') ctx.setMode('select');
    },
  });

  return {
    name: 'stamp',
    api: { count: () => stamps },
    onAdd(ctx) {
      // What the plugin adds through its context is removed with it
      ctx.extensions.modes.add('stamp', stampMode);
      // After every creation, whatever made it
      ctx.on('feature.created', ({ feature }) => {
        if (!isStamp(feature)) return;
        stamps += 1;
        onStamp?.(stamps);
      });
    },
  };
}

/** The icon of the stamp tool: SVG markup drawn with `currentColor` */
export const STAR_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
  ' stroke-width="2" stroke-linejoin="round"><polygon points="12 2 14.5 8.6 21.5 8.9 16 13.3' +
  ' 17.9 20.1 12 16.2 6.1 20.1 8 13.3 2.5 8.9 9.5 8.6"/></svg>';
