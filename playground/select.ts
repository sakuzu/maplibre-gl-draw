// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// A button of the playground that selects every feature of every layer at once, without an array
// of their IDs (`draw.selection.set('feature', { layerIds })`), so that it can be tried with the
// mouse, and the number of the features selected next to it. The standard UI selects the
// features of a layer one press at a time, or the layer itself.

import type { Draw } from '@sakuzu/maplibre-gl-draw';

/** Puts the button over the map, above those that copy and paint the selection */
export function addSelectAllButton(draw: Draw, container: HTMLElement, ja: boolean): void {
  const bar = document.createElement('div');
  bar.className = 'pg-select';
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.select = 'layers';
  button.textContent = ja ? 'すべてのレイヤーの地物を選ぶ' : 'Select every feature of the layers';
  const count = document.createElement('output');
  count.dataset.select = 'count';
  const show = () => {
    const { type, ids } = draw.selection.get();
    const n = type === 'feature' ? ids.count() : 0;
    count.textContent = ja ? `${n} 件を選択中` : `${n} selected`;
  };
  button.addEventListener('click', () => {
    if (!draw.selection.set('feature', { layerIds: draw.layers.getOrder() })) {
      console.info('No feature can be selected');
    }
  });
  draw.on('selection.changed', show);
  show();
  bar.append(button, count);
  container.append(bar);
}
