// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// Two buttons of the playground that copy the features selected and write the same look to them
// with the bulk edits (`draw.features.duplicate` and `updateAll` on `{ selection: true }`), so that
// they can be tried with the mouse. The values they pass are the playground's own: the copies
// moved 50 m to the east of the center of the box of the selection, and an orange fill and
// outline.

import type { Draw, EditCounts } from '@sakuzu/maplibre-gl-draw';
import { destination } from '@sakuzu/maplibre-gl-draw/geometry';
import { selectionCenter } from './transforms.ts';

/** The look the button writes to every feature selected */
const ORANGE = '#f08c00';

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

/** Puts the two buttons over the map, above those that move, turn and scale the selection */
export function addEditButtons(draw: Draw, container: HTMLElement, ja: boolean): void {
  const bar = document.createElement('div');
  bar.className = 'pg-edits';
  const button = (id: string, label: string, run: () => void) => {
    const element = document.createElement('button');
    element.type = 'button';
    element.dataset.edit = id;
    element.textContent = label;
    element.addEventListener('click', () => {
      if (draw.selection.get().ids.length === 0) {
        console.info('Select features first');
        return;
      }
      run();
    });
    bar.append(element);
  };
  button('duplicate', ja ? '複製する (東へ 50 m)' : 'Copy 50 m east', () => {
    const from = selectionCenter(draw);
    if (!from) return;
    void report(
      'Copy',
      draw.features.duplicate(
        { selection: true },
        { offset: { from, to: destination(from, 50, 90) } },
      ),
    );
  });
  button('updateAll', ja ? '橙に塗る' : 'Paint orange', () => {
    void report(
      'Paint',
      draw.features.updateAll(
        { selection: true },
        { style: { fillColor: ORANGE, strokeColor: ORANGE } },
      ),
    );
  });
  container.append(bar);
}
