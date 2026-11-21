// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// Three buttons of the playground that move, turn and scale the features selected with the bulk
// edits (`draw.features.translate`, `rotate` and `scale` on `{ selection: true }`), so that they
// can be tried with the mouse. The values they pass are the playground's own: 100 m to the east,
// 90 degrees counterclockwise and a factor of 2, about the center of the box of the selection.

import type { Draw, EditCounts, Position } from '@sakuzu/maplibre-gl-draw';
import { bbox, destination } from '@sakuzu/maplibre-gl-draw/geometry';

/** The center of the box of the features selected, or null when none is */
export function selectionCenter(draw: Draw): Position | null {
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  for (const feature of draw.selection.features()) {
    const [w, s, e, n] = bbox(feature);
    west = Math.min(west, w);
    south = Math.min(south, s);
    east = Math.max(east, e);
    north = Math.max(north, n);
  }
  if (!Number.isFinite(west)) return null;
  return [(west + east) / 2, (south + north) / 2];
}

/** Logs what an edit did */
async function report(name: string, edit: Promise<EditCounts | null>): Promise<void> {
  try {
    const counts = await edit;
    if (!counts) {
      console.info(`${name}: refused (read-only, or every feature is locked)`);
      return;
    }
    console.info(
      `${name}: ${counts.changedCount} changed, ${counts.lockedCount} locked` +
        `${counts.stopped ? ', stopped' : ''}`,
    );
  } catch (error) {
    console.info(`${name}: ${error}`);
  }
}

/** Puts the three buttons over the map, above the bar of the drawing tools, in English or in Japanese */
export function addTransformButtons(draw: Draw, container: HTMLElement, ja: boolean): void {
  const bar = document.createElement('div');
  bar.className = 'pg-transforms';
  const button = (id: string, label: string, run: (center: Position) => void) => {
    const element = document.createElement('button');
    element.type = 'button';
    element.dataset.transform = id;
    element.textContent = label;
    element.addEventListener('click', () => {
      const center = selectionCenter(draw);
      if (!center) {
        console.info('Select features first');
        return;
      }
      run(center);
    });
    bar.append(element);
  };
  button('translate', ja ? '動かす (東へ 100 m)' : 'Move 100 m east', (center) => {
    const to = destination(center, 100, 90);
    void report('Move', draw.features.translate({ selection: true }, { from: center, to }));
  });
  button('rotate', ja ? '回す (90°)' : 'Turn 90°', (center) => {
    void report(
      'Turn',
      draw.features.rotate({ selection: true }, { center, counterclockwiseDegrees: 90 }),
    );
  });
  button('scale', ja ? '拡大する (2 倍)' : 'Scale × 2', (center) => {
    void report(
      'Scale',
      draw.features.scale(
        { selection: true },
        { center, eastFactor: 2, northFactor: 2, sizeFactor: 2 },
      ),
    );
  });
  container.append(bar);
}
