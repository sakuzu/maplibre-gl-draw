// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import type { Layer } from '@sakuzu/maplibre-gl-draw';
import { flushSync } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDrawUI,
  createLayerPanel,
  createLegend,
  type DrawUI,
  type LayerPanelHandle,
  type LegendHandle,
} from '../src/index.js';
import { fakeDraw, feature, group, layer } from './fake-draw.js';

let handle: LayerPanelHandle | LegendHandle | DrawUI | undefined;
afterEach(() => {
  handle?.destroy();
  handle = undefined;
  document.body.innerHTML = '';
});

function sample() {
  return fakeDraw({
    doc: {
      layers: [
        layer('l1', ['a', 'g1', 'b'], { name: 'Sketch' }),
        layer('l2', ['e'], {
          name: 'Places',
          styleRule: {
            kind: 'categorical',
            property: 'kind',
            map: { park: '#00aa00' },
            other: '#999999',
          },
        }),
      ],
      groups: [group('g1', 'l1', ['c'])],
      features: [
        feature('a', 'l1', 'Point'),
        feature('b', 'l1', 'LineString', { properties: { name: 'River' } }),
        feature('c', 'l1', 'Polygon', { groupId: 'g1' }),
        feature('e', 'l2', 'Point', { properties: { name: 'Station' } }),
      ],
      active: 'l1',
    },
  });
}

/** The names of the rows, from the top */
const rowNames = (root: ParentNode) =>
  [...root.querySelectorAll('[role="treeitem"] > [data-role="list-item"]')].map((row) =>
    row.querySelector('.main')?.textContent?.trim(),
  );

function row(root: ParentNode, id: string): HTMLElement {
  const found = root.querySelector<HTMLElement>(
    `[role="treeitem"][data-node="${id}"] > [data-role="list-item"]`,
  );
  if (!found) throw new Error(`no row "${id}"`);
  return found;
}

function rowButton(root: ParentNode, id: string, name: string): HTMLButtonElement {
  const found = [...row(root, id).querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === name,
  );
  if (!found) throw new Error(`no button "${name}" in "${id}"`);
  return found;
}

describe('createLayerPanel', () => {
  it('shows the layers, the groups and the features from the front', () => {
    const fake = sample();
    const target = document.createElement('div');
    document.body.appendChild(target);
    handle = createLayerPanel(fake.asDraw, { target });
    expect(rowNames(target)).toEqual([
      'Places',
      'Station',
      'Sketch',
      'River',
      'Group g1',
      'Polygon',
      'Point',
    ]);
    expect(handle.element.getAttribute('data-role')).toBe('layer-panel');
    expect(target.querySelector(':scope > .mgd-ui')).not.toBeNull();
  });

  it('marks the active layer', () => {
    const fake = sample();
    handle = createLayerPanel(fake.asDraw, { target: fake.container });
    expect(row(fake.container, 'l1').querySelector('[aria-label="Active layer"]')).not.toBeNull();
    expect(row(fake.container, 'l2').querySelector('[aria-label="Active layer"]')).toBeNull();
  });

  it('shows and hides through update({ visible })', () => {
    const fake = sample();
    handle = createLayerPanel(fake.asDraw, { target: fake.container });
    rowButton(fake.container, 'l2', 'Hide').click();
    expect(fake.draw.layers.update).toHaveBeenCalledWith('l2', { visible: false });
    rowButton(fake.container, 'g1', 'Hide').click();
    expect(fake.draw.groups.update).toHaveBeenCalledWith('g1', { visible: false });
    rowButton(fake.container, 'b', 'Hide').click();
    expect(fake.draw.features.update).toHaveBeenCalledWith('b', { visible: false });
    flushSync();
    rowButton(fake.container, 'b', 'Show').click();
    expect(fake.draw.features.update).toHaveBeenLastCalledWith('b', { visible: true });
  });

  it('shows again what this client hid', () => {
    const fake = sample();
    handle = createLayerPanel(fake.asDraw, { target: fake.container });
    fake.hide('a');
    flushSync();
    rowButton(fake.container, 'a', 'Show').click();
    expect(fake.draw.hidden.remove).toHaveBeenCalledWith('a');
    expect(fake.draw.features.update).not.toHaveBeenCalled();
  });

  it('locks through update({ locked })', () => {
    const fake = sample();
    handle = createLayerPanel(fake.asDraw, { target: fake.container });
    rowButton(fake.container, 'c', 'Lock').click();
    expect(fake.draw.features.update).toHaveBeenCalledWith('c', { locked: true });
  });

  it('selects through selection.set, one type at a time', () => {
    const fake = sample();
    handle = createLayerPanel(fake.asDraw, { target: fake.container });
    row(fake.container, 'b').click();
    expect(fake.draw.selection.set).toHaveBeenLastCalledWith('feature', ['b']);
    flushSync();
    expect(
      row(fake.container, 'b').closest('[role="treeitem"]')?.getAttribute('aria-selected'),
    ).toBe('true');
    row(fake.container, 'a').dispatchEvent(
      new MouseEvent('click', { bubbles: true, metaKey: true }),
    );
    expect(fake.draw.selection.set).toHaveBeenLastCalledWith('feature', ['b', 'a']);
    flushSync();
    // A layer pressed with ⌘ keeps its own kind
    row(fake.container, 'l2').dispatchEvent(
      new MouseEvent('click', { bubbles: true, metaKey: true }),
    );
    expect(fake.draw.selection.set).toHaveBeenLastCalledWith('layer', ['l2']);
    expect(fake.draw.layers.setActive).toHaveBeenLastCalledWith('l2');
    flushSync();
    expect(row(fake.container, 'l2').querySelector('[aria-label="Active layer"]')).not.toBeNull();
  });

  it('follows the selection made elsewhere', () => {
    const fake = sample();
    handle = createLayerPanel(fake.asDraw, { target: fake.container });
    fake.setSelection('group', ['g1']);
    flushSync();
    const selected = [
      ...fake.container.querySelectorAll('[role="treeitem"][aria-selected="true"]'),
    ];
    expect(selected.map((el) => el.getAttribute('data-node'))).toEqual(['g1']);
  });

  it('follows the document', () => {
    const fake = sample();
    handle = createLayerPanel(fake.asDraw, { target: fake.container });
    fake.change(({ layers }) => {
      layers.set('l2', { ...(layers.get('l2') as Layer), name: 'Stations' });
    });
    flushSync();
    expect(rowNames(fake.container)[0]).toBe('Stations');
  });

  it('shows the groups alone with features: false, and no add menu with add: false', () => {
    const fake = sample();
    handle = createLayerPanel(fake.asDraw, {
      target: fake.container,
      features: false,
      add: false,
    });
    expect(rowNames(fake.container)).toEqual(['Places', 'Sketch', 'Group g1']);
    expect(fake.container.querySelector('[aria-haspopup="menu"]')).toBeNull();
  });

  it('shows the words of the locale', () => {
    const fake = sample();
    handle = createLayerPanel(fake.asDraw, { target: fake.container, locale: 'ja' });
    expect(rowNames(fake.container).at(-1)).toBe('点');
    expect(rowButton(fake.container, 'a', '隠す')).toBeDefined();
  });

  it('stops following draw and leaves the target when destroyed', async () => {
    const fake = sample();
    handle = createLayerPanel(fake.asDraw, { target: fake.container });
    expect(fake.listenerCount()).toBeGreaterThan(0);
    handle.destroy();
    handle.destroy();
    await Promise.resolve();
    expect(fake.listenerCount()).toBe(0);
    expect(fake.container.querySelector('.mgd-ui')).toBeNull();
  });
});

describe('the datasets of the layer panel', () => {
  function stacked() {
    return fakeDraw({
      doc: {
        layers: [layer('l1', [], { name: 'Survey' }), layer('l2', [], { name: 'Route' })],
        datasets: [
          { id: 'buildings', rows: 12_345 },
          { id: 'places', order: 'above-store', rows: 7 },
        ],
        order: ['l1', 'buildings', 'l2'],
      },
    });
  }

  it('shows each dataset as a row of the stack, in its place among the layers', () => {
    const fake = stacked();
    handle = createLayerPanel(fake.asDraw, { target: fake.container });
    expect(rowNames(fake.container)).toEqual([
      'places 7 rows',
      'Route',
      'buildings 12,345 rows',
      'Survey',
    ]);
    const buildings = row(fake.container, 'buildings');
    expect(buildings.querySelector('.lucide-database')).not.toBeNull();
    expect(buildings.querySelector('[aria-label="Datasets"]')).not.toBeNull();
    // Not expandable
    expect(buildings.closest('[role="treeitem"]')?.getAttribute('aria-expanded')).toBeNull();
  });

  it('has the eye, bound to setVisible, and no lock', () => {
    const fake = stacked();
    handle = createLayerPanel(fake.asDraw, { target: fake.container });
    // The panel follows the datasets once its effects have run
    flushSync();
    const buildings = fake.datasets[0];
    expect(
      [...row(fake.container, 'buildings').querySelectorAll('button')].map((b) =>
        b.getAttribute('aria-label'),
      ),
    ).toEqual(['Hide']);
    rowButton(fake.container, 'buildings', 'Hide').click();
    expect(buildings.setVisible).toHaveBeenCalledWith(false);
    flushSync();
    // The dataset told of the change: the row shows it hidden
    rowButton(fake.container, 'buildings', 'Show').click();
    expect(buildings.setVisible).toHaveBeenLastCalledWith(true);
    expect(fake.draw.layers.update).not.toHaveBeenCalled();
    // A layer keeps both, after its chevron
    expect(
      [...row(fake.container, 'l1').querySelectorAll('button')].map((b) =>
        b.getAttribute('aria-label'),
      ),
    ).toEqual(['Collapse', 'Hide', 'Lock']);
  });

  it('is not selected by a press, and is not renamed', () => {
    const fake = stacked();
    handle = createLayerPanel(fake.asDraw, { target: fake.container });
    fake.setSelection('layer', ['l1']);
    flushSync();
    row(fake.container, 'buildings').click();
    row(fake.container, 'buildings').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    flushSync();
    expect(fake.draw.selection.set).not.toHaveBeenCalled();
    expect(fake.draw.selection.get()).toEqual({ type: 'layer', ids: ['l1'] });
    expect(row(fake.container, 'buildings').querySelector('input')).toBeNull();
  });

  it('is dragged among the layers only when it is placed among them', () => {
    const fake = stacked();
    handle = createLayerPanel(fake.asDraw, { target: fake.container });
    // The one in front of every layer stays, and shows no grip
    expect(row(fake.container, 'places').querySelector('[data-fixed]')).not.toBeNull();
    expect(row(fake.container, 'buildings').querySelector('[data-fixed]')).toBeNull();
  });

  it('follows the datasets that come, go and change', () => {
    const fake = stacked();
    handle = createLayerPanel(fake.asDraw, { target: fake.container });
    flushSync();
    fake.addDataset({ id: 'trees', order: 'below-store', rows: 2 });
    flushSync();
    expect(rowNames(fake.container).at(-1)).toBe('trees 2 rows');
    fake.datasets[0].setRowCount(10);
    flushSync();
    expect(rowNames(fake.container)[2]).toBe('buildings 10 rows');
    fake.datasets[0].setVisible(false);
    flushSync();
    expect(row(fake.container, 'buildings').querySelector('[aria-label="Show"]')).not.toBeNull();
    fake.removeDataset('places');
    flushSync();
    expect(rowNames(fake.container)[0]).toBe('Route');
    handle.destroy();
    handle = undefined;
    expect(fake.datasets.every((d) => d.listening() === 0)).toBe(true);
  });

  it('shows none with datasets: false', () => {
    const fake = stacked();
    handle = createLayerPanel(fake.asDraw, { target: fake.container, datasets: false });
    expect(rowNames(fake.container)).toEqual(['Route', 'Survey']);
  });

  it('counts the rows in the words of the locale', () => {
    const fake = stacked();
    handle = createLayerPanel(fake.asDraw, { target: fake.container, locale: 'ja' });
    expect(rowNames(fake.container)[2]).toBe('buildings 12,345 行');
  });
});

describe('createLegend', () => {
  it('shows the rows of the rule of each layer that has one', () => {
    const fake = sample();
    handle = createLegend(fake.asDraw, { target: fake.container });
    const text = handle.element.textContent ?? '';
    expect(text).toContain('Places');
    expect(text).toContain('park');
    expect(text).toContain('Other');
    expect(text).not.toContain('Sketch');
    expect(handle.element.querySelectorAll('[data-role="mark"]')).toHaveLength(2);
  });

  it('says so when no layer has a rule', () => {
    const fake = sample();
    handle = createLegend(fake.asDraw, { target: fake.container });
    fake.change(({ layers }) => {
      layers.set('l2', { ...(layers.get('l2') as Layer), styleRule: undefined });
    });
    flushSync();
    expect(handle.element.textContent).toContain('No layer has a style rule.');
  });
});

describe('createDrawUI on the left', () => {
  it('has the layers and the legend in two tabs', () => {
    const fake = sample();
    const ui = createDrawUI(fake.asDraw);
    handle = ui;
    const tabs = [...ui.element.querySelectorAll('[data-region="left"] button')].filter((b) =>
      ['Layers', 'Legend'].includes(b.textContent?.trim() ?? ''),
    );
    expect(tabs.map((b) => b.textContent?.trim())).toEqual(['Layers', 'Legend']);
    expect(ui.layers?.element.getAttribute('data-role')).toBe('layer-panel');
    expect(rowNames(ui.element)).toContain('River');
    (tabs[1] as HTMLElement).click();
    flushSync();
    expect(ui.element.querySelector('[data-role="legend"]')?.textContent).toContain('park');
  });

  it('has no left region with layers: false and legend: false', () => {
    const fake = sample();
    const ui = createDrawUI(fake.asDraw, { layers: false, legend: false });
    handle = ui;
    expect(ui.layers).toBeNull();
    expect(ui.legend).toBeNull();
    expect(ui.element.querySelector('[data-region="left"]')).toBeNull();
  });

  it('removes the layer panel alone, and then the legend', () => {
    const fake = sample();
    const ui = createDrawUI(fake.asDraw);
    handle = ui;
    ui.layers?.destroy();
    flushSync();
    expect(ui.layers).toBeNull();
    expect(ui.legend).not.toBeNull();
    expect(ui.element.querySelector('[data-role="legend"]')).not.toBeNull();
    ui.legend?.destroy();
    flushSync();
    expect(ui.element.querySelector('[data-region="left"]')).toBeNull();
  });

  it('opens and closes the left region with Shift+L', () => {
    const fake = sample();
    const ui = createDrawUI(fake.asDraw);
    handle = ui;
    const press = () => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'L', shiftKey: true, bubbles: true, cancelable: true }),
      );
      flushSync();
    };
    press();
    expect(ui.element.querySelector('[data-region="left"]')).toBeNull();
    press();
    expect(ui.element.querySelector('[data-region="left"]')).not.toBeNull();
  });

  it('opens the closed left region again from a button over the map', () => {
    const fake = sample();
    const ui = createDrawUI(fake.asDraw);
    handle = ui;
    const reopen = () => ui.element.querySelector<HTMLElement>('[data-role="reopen"]');
    // Open: no button
    expect(reopen()).toBeNull();
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'L', shiftKey: true, bubbles: true, cancelable: true }),
    );
    flushSync();
    expect(ui.element.querySelector('[data-region="left"]')).toBeNull();
    // Closed: the button lies over the map, a child of the root, outside the shell's regions
    const place = reopen();
    expect(place?.parentElement).toBe(ui.element);
    const button = place?.querySelector<HTMLButtonElement>('button[aria-label="Layers"]');
    if (!button) throw new Error('no button');
    expect(place?.querySelector('[data-role="floating"]')).not.toBeNull();
    button.click();
    flushSync();
    expect(ui.element.querySelector('[data-region="left"]')).not.toBeNull();
    expect(reopen()).toBeNull();
  });

  it('has no button to open a left region it does not have', () => {
    const fake = sample();
    const ui = createDrawUI(fake.asDraw, { layers: false, legend: false });
    handle = ui;
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'L', shiftKey: true, bubbles: true, cancelable: true }),
    );
    flushSync();
    expect(ui.element.querySelector('[data-role="reopen"]')).toBeNull();
  });
});
