// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// A button of the playground that takes back the last edit of this page, one step a press, so
// that writing back can be tried with the mouse and the keys: a vertex dragged, features deleted
// with the Delete key, a selection moved with the buttons. It is written with the public entry
// alone, in the form of the sample of the declarations that takes edits back: the edits of the
// page are listened to with the values before (`draw.document.subscribe` with `previousValues`),
// the changes of one operation make one step, and a step is given to `draw.features.restore`.
// The library keeps no list of the edits itself.
//
// The layers and the metadata are not taken back here (the sample writes them back with
// `draw.layers` and `draw.metadata`): the features and the groups are.

import type { Draw, FeatureValues } from '@sakuzu/maplibre-gl-draw';

/** The source of the writing back, whose changes are not recorded */
const SOURCE = 'playground-back';

/** The most steps kept: the oldest are let go of beyond it */
const MAX_STEPS = 50;

/** Puts the button over the map, above the one that selects every feature of the layers */
export function addTakeBackButton(draw: Draw, container: HTMLElement, ja: boolean): void {
  /** The steps, the last edit last: the values of the changes of one operation each */
  const steps: FeatureValues[][] = [];
  /** The step of the operation still being written, by its number */
  const open = new Map<number, FeatureValues[]>();
  let writing = false;

  const bar = document.createElement('div');
  bar.className = 'pg-back';
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.back = 'last';
  const show = () => {
    button.textContent = ja ? `戻す (${steps.length})` : `Take back (${steps.length})`;
    button.disabled = steps.length === 0 || writing;
  };

  draw.document.subscribe(
    (change) => {
      if (change.reset) {
        // The whole document was replaced: nothing recorded applies to it any more
        draw.features.releaseValues([...steps.flat(), ...[...open.values()].flat()]);
        steps.length = 0;
        open.clear();
        show();
        return;
      }
      if (change.source !== 'local') return;
      const step = open.get(change.operationId) ?? [];
      if (change.previousValues) step.push(change.previousValues);
      if (change.hasMoreParts) {
        open.set(change.operationId, step);
        return;
      }
      open.delete(change.operationId);
      if (step.length === 0) return;
      steps.push(step);
      while (steps.length > MAX_STEPS) draw.features.releaseValues(steps.shift() ?? []);
      show();
    },
    { previousValues: ['local'] },
  );

  button.addEventListener('click', async () => {
    const step = steps.pop();
    if (!step || writing) return;
    writing = true;
    show();
    try {
      // An edit still being written (a drag let go of a moment ago) ends first
      await draw.waitForWrites();
      const counts = await draw.features.restore(step, { source: SOURCE, ignoreLocks: true });
      if (!counts || counts.stopped) {
        // Refused or stopped (read-only): the step stays, and the next press writes the rest
        steps.push(step);
        console.info(counts ? 'Take back: stopped' : 'Take back: refused (read-only)');
        return;
      }
      draw.features.releaseValues(step);
      console.info(`Take back: ${counts.changedCount} changed`);
    } catch (error) {
      // Values that cannot be written back any more are let go of with their step
      draw.features.releaseValues(step);
      console.info(`Take back: ${error}`);
    } finally {
      writing = false;
      show();
    }
  });

  show();
  bar.append(button);
  container.append(bar);
}
