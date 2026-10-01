// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The overview scene: what the playground opens on, and the first picture of the README
 *
 * Loads the drawing of `overview-data.ts` (five layers with groups, styles, a layer at half
 * opacity, a style rule and an embedded image), adds the dataset of hexagonal cells colored by
 * a graduated rule under the layers, makes the layer Notes active and selects the area with a
 * hole, so that its frame and vertex handles show and the inspector opens on its style, and
 * closes some rows of the layer panel so that the whole stack shows. The Legend tab of the
 * standard UI lists the rules of the layer Land use and of the dataset.
 *
 * The four point shapes are plain Points that name their shape in `style.pointShape`, so
 * nothing needs to be registered on the draw instance.
 */

import {
  ACTIVE_LAYER,
  createDensityGrid,
  createOverviewDocument,
  DENSITY_BASE_STYLE,
  DENSITY_DATASET,
  DENSITY_RULE,
  OVERVIEW_CAMERA,
  SELECTED_FEATURE,
} from './overview-data';
import { nextFrame, type ShowcaseContext, type ShowcaseScene } from './scene';
import station from './station.png?inline';

/** A quiet basemap, so the colors of the drawing stand out */
export const QUIET_BASEMAP = 'https://tiles.openfreemap.org/styles/positron';

export { SELECTED_FEATURE } from './overview-data';

/**
 * The rows of the layer panel to close, so that the whole stack fits the panel: the layer of
 * the selected area stays open, and the dataset shows at the bottom
 */
const COLLAPSE = [
  'group-markers',
  'layer-routes',
  'group-outlines',
  'group-coverage',
  'group-opacity',
  'layer-draft',
  'layer-landuse',
];

export const overviewScene: ShowcaseScene = {
  basemap: QUIET_BASEMAP,
  camera: OVERVIEW_CAMERA,
  load: loadDocument,
  async finish({ draw }) {
    draw.selection.set('feature', [SELECTED_FEATURE]);
    for (const id of COLLAPSE) {
      await nextFrame();
      // The first button of an open row of the tree is its chevron
      document
        .querySelector<HTMLButtonElement>(
          `[role="treeitem"][data-node="${id}"][aria-expanded="true"] button`,
        )
        ?.click();
    }
  },
};

/**
 * Loads the drawing, makes the layer Notes active and adds the dataset under the layers
 *
 * The tilted scene loads the same drawing.
 */
export async function loadDocument({ draw }: ShowcaseContext): Promise<void> {
  await draw.document.load(createOverviewDocument(station));
  draw.layers.setActive(ACTIVE_LAYER);
  draw.datasets.add({
    id: DENSITY_DATASET,
    rows: createDensityGrid(),
    styleRule: DENSITY_RULE,
    baseStyle: DENSITY_BASE_STYLE,
    order: 'below-store',
  });
}
