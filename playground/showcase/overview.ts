// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The overview scene: what the playground opens on, and the first picture of the README
 *
 * Loads the drawing of `overview-data.ts`, makes its first layer active and selects one area,
 * so that its frame and handles show and the inspector opens on its style. The legend of the
 * second layer's style rule is in the Legend tab of the standard UI.
 */

import {
  ACTIVE_LAYER,
  createOverviewDocument,
  OVERVIEW_CAMERA,
  SELECTED_FEATURE,
} from './overview-data';
import type { ShowcaseContext, ShowcaseScene } from './scene';
import station from './station.png?inline';

/** A quiet basemap, so the colors of the drawing stand out */
export const QUIET_BASEMAP = 'https://tiles.openfreemap.org/styles/positron';

export { SELECTED_FEATURE } from './overview-data';

export const overviewScene: ShowcaseScene = {
  basemap: QUIET_BASEMAP,
  camera: OVERVIEW_CAMERA,
  load: loadDocument,
  async finish({ draw }) {
    draw.selection.set('feature', [SELECTED_FEATURE]);
  },
};

/**
 * Loads the drawing and makes its first layer active
 *
 * The tilted scene loads the same drawing.
 */
export async function loadDocument({ draw }: ShowcaseContext): Promise<void> {
  await draw.document.load(createOverviewDocument(station));
  draw.layers.setActive(ACTIVE_LAYER);
}
