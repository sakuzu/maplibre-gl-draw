// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The tilted scene: the drawing of the overview seen with pitch and bearing
 *
 * The same document as the overview, with the camera tilted and turned so that north is not
 * at the top. The area with a hole is selected, as in the overview, so that its frame and
 * vertex handles show on the tilted map.
 */

import { loadDocument, QUIET_BASEMAP, SELECTED_FEATURE } from './overview';
import type { ShowcaseScene } from './scene';

export const tiltedScene: ShowcaseScene = {
  basemap: QUIET_BASEMAP,
  camera: { center: [139.7777, 35.6812], zoom: 15.35, pitch: 58, bearing: -38 },
  mapOnly: true,
  load: loadDocument,
  async finish({ draw }) {
    draw.selection.set('feature', [SELECTED_FEATURE]);
  },
};
