// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { flushSync } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { createDrawUI, createInspector, type DrawUI, type InspectorHandle } from '../src/index.js';
import { fakeDocument, makeFeature } from './fake-draw.js';

let handle: InspectorHandle | DrawUI | undefined;
afterEach(() => {
  handle?.destroy();
  handle = undefined;
  document.body.innerHTML = '';
});

const park = makeFeature({
  id: 'a',
  type: 'Polygon',
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [0.001, 0],
        [0.001, 0.001],
        [0, 0],
      ],
    ],
  },
  properties: { name: 'Park', kind: 'green' },
});
const road = makeFeature({
  id: 'b',
  type: 'LineString',
  geometry: {
    type: 'LineString',
    coordinates: [
      [0, 0],
      [0.01, 0],
    ],
  },
});
const stop = makeFeature({
  id: 'c',
  type: 'Point',
  geometry: { type: 'Point', coordinates: [1, 2] },
});

function button(root: ParentNode, name: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === name || b.textContent?.trim() === name,
  );
  if (!found) throw new Error(`no button "${name}"`);
  return found;
}

function hasButton(root: ParentNode, name: string): boolean {
  return [...root.querySelectorAll('button')].some(
    (b) => b.getAttribute('aria-label') === name || b.textContent?.trim() === name,
  );
}

/** The titles of the sections of an inspector, in order */
function headings(root: ParentNode): string[] {
  return [...root.querySelectorAll('[data-role="section-head"]')].map(
    (h) => h.textContent?.trim() ?? '',
  );
}

function click(el: HTMLElement) {
  el.click();
  flushSync();
}

function typeInto(input: HTMLInputElement | HTMLTextAreaElement, text: string) {
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

function mountAlone(fake: ReturnType<typeof fakeDocument>, options = {}) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const inspector = createInspector(fake.asDraw, { target, ...options });
  handle = inspector;
  return inspector;
}

describe('createInspector', () => {
  it('says that nothing is selected, then shows what is', () => {
    const fake = fakeDocument({ features: [park, road] });
    const inspector = mountAlone(fake);
    expect(inspector.element.getAttribute('data-role')).toBe('inspector');
    expect(inspector.element.textContent).toContain('Nothing is selected');
    fake.selectItems('feature', ['a']);
    flushSync();
    expect(hasButton(inspector.element, 'Name')).toBe(true);
    expect(inspector.element.textContent).toContain('Park');
    expect(inspector.element.textContent).toContain('Polygon · Layer 1');
    fake.selectItems('feature', ['a', 'b']);
    flushSync();
    expect(inspector.element.textContent).toContain('2 selected');
    fake.selectItems('layer', ['l1']);
    flushSync();
    expect(hasButton(inspector.element, 'Delete layer')).toBe(true);
    fake.selectItems('feature', []);
    flushSync();
    expect(inspector.element.textContent).toContain('Nothing is selected');
  });

  it('writes a color picked into the style of the feature', () => {
    const fake = fakeDocument({ features: [park], selection: { type: 'feature', ids: ['a'] } });
    const inspector = mountAlone(fake);
    click(button(inspector.element, 'Fill color'));
    click(button(document.body, 'Red'));
    expect(fake.mocks.features.updateMany).toHaveBeenCalledWith([
      { id: 'a', patch: { style: { fillColor: '#E5484D' } } },
    ]);
    expect(fake.mocks.transact).toHaveBeenCalled();
    expect(fake.asDraw.features.get('a')?.style.fillColor).toBe('#E5484D');
  });

  it('writes a color into every feature selected', () => {
    const red = makeFeature({ ...park, style: { strokeColor: '#ff0000' } });
    const fake = fakeDocument({
      features: [red, road],
      selection: { type: 'feature', ids: ['a', 'b'] },
    });
    const inspector = mountAlone(fake);
    // Mixed: no value on the trigger of the shared stroke color
    expect(button(inspector.element, 'Line color').textContent).toContain('Mixed');
    click(button(inspector.element, 'Line color'));
    click(button(document.body, 'Blue'));
    expect(fake.mocks.features.updateMany).toHaveBeenCalledWith([
      { id: 'a', patch: { style: { strokeColor: '#2D7FF9' } } },
      { id: 'b', patch: { style: { strokeColor: '#2D7FF9' } } },
    ]);
  });

  it('renames the feature through properties.name', () => {
    const fake = fakeDocument({ features: [park], selection: { type: 'feature', ids: ['a'] } });
    const inspector = mountAlone(fake);
    click(button(inspector.element, 'Name'));
    const input = inspector.element.querySelector<HTMLInputElement>('input[aria-label="Name"]');
    if (!input) throw new Error('no name input');
    typeInto(input, 'Lake');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    flushSync();
    expect(fake.mocks.features.update).toHaveBeenCalledWith('a', { properties: { name: 'Lake' } });
    expect(inspector.element.textContent).toContain('Lake');
  });

  it('shows a change made elsewhere', () => {
    const fake = fakeDocument({ features: [park], selection: { type: 'feature', ids: ['a'] } });
    const inspector = mountAlone(fake);
    fake.change('a', { properties: { name: 'Garden' } });
    flushSync();
    expect(inspector.element.textContent).toContain('Garden');
  });

  it('lists the attributes without the name and changes them', () => {
    const fake = fakeDocument({ features: [park], selection: { type: 'feature', ids: ['a'] } });
    const inspector = mountAlone(fake, { tabs: ['attributes'] });
    const text = inspector.element.textContent ?? '';
    expect(text).toContain('kind');
    expect(text).toContain('green');
    expect(text).toContain('Description');
    click(button(inspector.element, 'Remove kind'));
    expect(fake.mocks.features.update).toHaveBeenCalledWith('a', {
      properties: { kind: undefined },
    });
  });

  it('writes the description where it stands', () => {
    const fake = fakeDocument({ features: [park], selection: { type: 'feature', ids: ['a'] } });
    const inspector = mountAlone(fake);
    expect(inspector.element.querySelector('textarea')).toBeNull();
    click(button(inspector.element, 'Add a description'));
    const area = inspector.element.querySelector('textarea');
    if (!area) throw new Error('no textarea');
    typeInto(area, 'Open all day');
    area.dispatchEvent(new FocusEvent('blur'));
    flushSync();
    expect(fake.mocks.features.update).toHaveBeenCalledWith('a', {
      properties: { description: 'Open all day' },
    });
    expect(inspector.element.textContent).toContain('Open all day');
    expect(hasButton(inspector.element, 'Description')).toBe(true);
  });

  it('shows the measurements under the head, then the tabs, and the description on top of the content', () => {
    const described = makeFeature({
      ...park,
      properties: { ...park.properties, description: 'Gate' },
    });
    const fake = fakeDocument({
      features: [described],
      selection: { type: 'feature', ids: ['a'] },
    });
    const inspector = mountAlone(fake);
    const el = inspector.element;
    const tablist = el.querySelector('[data-role="tabs"]');
    if (!tablist) throw new Error('no tabs');
    const body = el.querySelector('[data-role="panel"] > .scroll');
    if (!body) throw new Error('no content');
    const precedes = (a: Node, b: Node) =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    const text = (needle: string) =>
      [...el.querySelectorAll('*')].find(
        (n) => n.children.length === 0 && n.textContent?.trim() === needle,
      );
    // The measurements under the head, which stays while the content scrolls
    for (const word of ['Area', 'Perimeter']) {
      const node = text(word);
      if (!node) throw new Error(`no ${word}`);
      expect(precedes(node, tablist)).toBe(true);
      expect(body.contains(node)).toBe(false);
    }
    // The tabs in the head too, and the description first in the content
    expect(body.contains(tablist)).toBe(false);
    const fill = button(el, 'Fill color');
    for (const word of ['Description', 'Gate']) {
      const node = text(word);
      if (!node) throw new Error(`no ${word}`);
      expect(body.contains(node)).toBe(true);
      expect(precedes(node, fill)).toBe(true);
    }
    // The Style tab: the fields and the operations, no measurements
    expect(hasButton(el, 'Buffer')).toBe(true);
    // The Attributes tab: the description, then the list of the attributes only
    click(button(tablist, 'Attributes'));
    expect(el.textContent).toContain('kind');
    expect(hasButton(el, 'Fill color')).toBe(false);
    expect(hasButton(el, 'Buffer')).toBe(false);
    expect(el.textContent).toContain('Area');
    expect(body.textContent).toContain('Gate');
  });

  it('puts the fields of the Style tab under the description, with no title', () => {
    const red = makeFeature({ ...park, style: { fillColor: '#ff0000' } });
    const fake = fakeDocument({ features: [red], selection: { type: 'feature', ids: ['a'] } });
    const inspector = mountAlone(fake);
    inspector.sections.add({
      id: 'extra',
      title: 'Extra',
      appliesTo: () => true,
      fields: () => [{ key: 'size', kind: 'toggle', label: 'Big', value: false }],
    });
    flushSync();
    const el = inspector.element;
    // The content of the tab is a Stack under the tabs: the description to add, then the fields
    const panel = el.querySelector('[data-role="panel"] > .scroll')?.firstElementChild;
    expect(panel?.getAttribute('data-role')).toBe('stack');
    expect(panel?.firstElementChild?.textContent).toContain('Description');
    const first = panel?.children[1];
    expect(first?.getAttribute('data-role')).toBe('block');
    expect(first?.contains(button(el, 'Fill color'))).toBe(true);
    // Only the sections after the fields have titles
    expect(headings(el)).toEqual(['Extra', 'Operations']);
    // The reset of the style is a text action after the fields
    expect(first?.contains(button(el, 'Reset the style'))).toBe(true);
    click(button(el, 'Reset the style'));
    expect(fake.mocks.features.updateMany).toHaveBeenCalledWith([
      { id: 'a', patch: { style: { fillColor: undefined } } },
    ]);
    // The Attributes tab has no title either
    click(button(el, 'Attributes'));
    expect(headings(el)).toEqual([]);
  });

  it('gives the shared fields of a selection, a group and a layer no title', () => {
    const other = makeFeature({ ...park, id: 'd', properties: {} });
    const fake = fakeDocument({
      features: [park, other],
      groups: [
        { id: 'g', layerId: 'l1', name: 'Block', featureIds: ['a'], visible: true, locked: false },
      ],
      selection: { type: 'feature', ids: ['a', 'd'] },
    });
    const inspector = mountAlone(fake);
    const el = inspector.element;
    expect(hasButton(el, 'Fill color')).toBe(true);
    expect(headings(el)).toEqual([]);
    fake.selectItems('group', ['g']);
    flushSync();
    expect(el.querySelector('[aria-label="Visible"]')).not.toBeNull();
    expect(headings(el)).toEqual([]);
    fake.selectItems('layer', ['l1']);
    flushSync();
    expect(el.querySelector('[aria-label="Visible"]')).not.toBeNull();
    expect(headings(el)).toEqual(['Style rule']);
  });

  it('opens on the first tab of the options, and keeps the tab chosen', () => {
    const current = (el: ParentNode) =>
      el.querySelector('[data-role="tabs"] [aria-current="page"]')?.textContent?.trim();
    // Style first by default
    const first = fakeDocument({ features: [park], selection: { type: 'feature', ids: ['a'] } });
    const byDefault = mountAlone(first);
    expect(current(byDefault.element)).toBe('Style');
    expect(hasButton(byDefault.element, 'Fill color')).toBe(true);
    byDefault.destroy();
    document.body.innerHTML = '';
    // Attributes first: it opens on Attributes, and Style is still a tab
    const other = makeFeature({ ...park, id: 'd', properties: { name: 'Pond', depth: '3' } });
    const fake = fakeDocument({
      features: [park, other],
      selection: { type: 'feature', ids: ['a'] },
    });
    const inspector = mountAlone(fake, { tabs: ['attributes', 'style'] });
    const el = inspector.element;
    expect(current(el)).toBe('Attributes');
    expect(el.textContent).toContain('kind');
    expect(hasButton(el, 'Fill color')).toBe(false);
    // The tab chosen is kept for the next feature
    click(button(el, 'Style'));
    expect(hasButton(el, 'Fill color')).toBe(true);
    fake.selectItems('feature', ['d']);
    flushSync();
    expect(current(el)).toBe('Style');
    expect(hasButton(el, 'Fill color')).toBe(true);
  });

  it('shows the measurements in the units of the options', () => {
    const fake = fakeDocument({ features: [stop], selection: { type: 'feature', ids: ['c'] } });
    const inspector = mountAlone(fake);
    expect(inspector.element.textContent).toContain('1.000000°');
    expect(inspector.element.textContent).toContain('Longitude');
  });

  it('leaves out the measurements and the operations when asked', () => {
    const fake = fakeDocument({ features: [stop], selection: { type: 'feature', ids: ['c'] } });
    const inspector = mountAlone(fake, { measurements: false, operations: false });
    expect(inspector.element.textContent).not.toContain('Longitude');
    expect(hasButton(inspector.element, 'Buffer')).toBe(false);
  });

  it('locks, hides and deletes from the foot', () => {
    const fake = fakeDocument({ features: [park], selection: { type: 'feature', ids: ['a'] } });
    const inspector = mountAlone(fake);
    click(button(inspector.element, 'Hide'));
    expect(fake.mocks.hidden.add).toHaveBeenCalledWith('a');
    expect(inspector.element.textContent).toContain('Hidden');
    click(button(inspector.element, 'Show'));
    expect(fake.mocks.hidden.remove).toHaveBeenCalledWith('a');
    click(button(inspector.element, 'Lock'));
    expect(fake.mocks.features.update).toHaveBeenCalledWith('a', { locked: true });
    // Locked: no change of the style, the name or the attributes; unlocking is still possible
    expect(button(inspector.element, 'Fill color').disabled).toBe(true);
    expect(button(inspector.element, 'Delete').disabled).toBe(true);
    expect(hasButton(inspector.element, 'Name')).toBe(false);
    click(button(inspector.element, 'Unlock'));
    click(button(inspector.element, 'Delete'));
    expect(fake.mocks.selection.delete).toHaveBeenCalledOnce();
    expect(inspector.element.textContent).toContain('Nothing is selected');
  });

  it('offers the operations that apply to the selection', () => {
    const other = makeFeature({ ...park, id: 'd', properties: {} });
    const fake = fakeDocument({
      features: [park, other],
      selection: { type: 'feature', ids: ['a', 'd'] },
    });
    const inspector = mountAlone(fake);
    for (const name of ['Union', 'Intersection', 'Difference', 'Buffer', 'Group']) {
      expect(hasButton(inspector.element, name)).toBe(true);
    }
    expect(hasButton(inspector.element, 'Split')).toBe(false);
    // Delete is in the lead of the foot, as for one feature, not among the operations
    const foot = inspector.element.querySelector('[data-role="footer"]');
    if (!foot) throw new Error('no foot');
    expect(foot.querySelector('.lead')?.contains(button(inspector.element, 'Delete'))).toBe(true);
    expect(foot.contains(button(inspector.element, 'Union'))).toBe(false);
    click(button(inspector.element, 'Union'));
    expect(fake.mocks.features.union).toHaveBeenCalledWith(['a', 'd']);
    expect(fake.mocks.selection.set).toHaveBeenLastCalledWith('feature', ['union']);
  });

  it('deletes several layers from the lead of the foot', () => {
    const fake = fakeDocument({
      features: [park],
      layers: [
        { id: 'l1', name: 'Layer 1' },
        { id: 'l2', name: 'Layer 2' },
      ],
      selection: { type: 'layer', ids: ['l1', 'l2'] },
    });
    const inspector = mountAlone(fake);
    const foot = inspector.element.querySelector('[data-role="footer"]');
    if (!foot) throw new Error('no foot');
    const remove = button(inspector.element, 'Delete');
    expect(foot.querySelector('.lead')?.contains(remove)).toBe(true);
    click(remove);
    expect(fake.mocks.selection.delete).toHaveBeenCalledOnce();
  });

  it('changes a layer', () => {
    const fake = fakeDocument({
      layers: [
        { id: 'l1', name: 'Roads' },
        { id: 'l2', name: 'Parks' },
      ],
      selection: { type: 'layer', ids: ['l1'] },
    });
    const inspector = mountAlone(fake);
    expect(inspector.element.textContent).toContain('Roads');
    const toggle = inspector.element.querySelector<HTMLElement>('[aria-label="Visible"]');
    if (!toggle) throw new Error('no toggle');
    click(toggle);
    expect(fake.mocks.layers.update).toHaveBeenCalledWith('l1', { visible: false });
    expect(button(inspector.element, 'Delete layer').disabled).toBe(false);
  });

  it('keeps the only layer', () => {
    const fake = fakeDocument({ selection: { type: 'layer', ids: ['l1'] } });
    const inspector = mountAlone(fake);
    expect(button(inspector.element, 'Delete layer').disabled).toBe(true);
  });

  it('ungroups a group', () => {
    const fake = fakeDocument({
      features: [park],
      groups: [
        { id: 'g', layerId: 'l1', name: 'Block', featureIds: ['a'], visible: true, locked: false },
      ],
      selection: { type: 'group', ids: ['g'] },
    });
    const inspector = mountAlone(fake);
    expect(inspector.element.textContent).toContain('Block');
    click(button(inspector.element, 'Ungroup'));
    expect(fake.mocks.selection.ungroup).toHaveBeenCalledOnce();
  });

  it('shows the sections an application adds', () => {
    const fake = fakeDocument({ features: [park], selection: { type: 'feature', ids: ['a'] } });
    const inspector = mountAlone(fake);
    const seen: unknown[] = [];
    const remove = inspector.sections.add({
      id: 'extra',
      title: 'Extra',
      appliesTo: (fs) => fs.every((f) => f.type === 'Polygon'),
      fields: () => [{ key: 'size', kind: 'toggle', label: 'Big', value: false }],
      onchange: (key, value, fs) =>
        seen.push(
          key,
          value,
          fs.map((f) => f.id),
        ),
    });
    flushSync();
    expect(inspector.sections.list().map((s) => s.id)).toEqual(['extra']);
    expect(inspector.element.textContent).toContain('Extra');
    const toggle = inspector.element.querySelector<HTMLElement>('[aria-label="Big"]');
    if (!toggle) throw new Error('no toggle');
    click(toggle);
    expect(seen).toEqual(['size', true, ['a']]);
    expect(() =>
      inspector.sections.add({ id: 'extra', title: 'X', appliesTo: () => true }),
    ).toThrow(/already/);
    remove();
    flushSync();
    expect(inspector.element.textContent).not.toContain('Extra');
  });

  it('shows the Japanese words', () => {
    const fake = fakeDocument({ features: [park], selection: { type: 'feature', ids: ['a'] } });
    const inspector = mountAlone(fake, { locale: 'ja' });
    expect(inspector.element.textContent).toContain('スタイル');
    expect(hasButton(inspector.element, '塗りの色')).toBe(true);
  });

  it('stops following draw when destroyed', async () => {
    const fake = fakeDocument({ features: [park], selection: { type: 'feature', ids: ['a'] } });
    const inspector = mountAlone(fake);
    expect(fake.listenerCount()).toBeGreaterThan(0);
    inspector.destroy();
    inspector.destroy();
    await Promise.resolve();
    expect(fake.listenerCount()).toBe(0);
    handle = undefined;
  });
});

describe('the inspector of createDrawUI', () => {
  // The stand-in of fakeDocument has the members of the inspector only
  const ALONE = { layers: false, legend: false } as const;
  const region = (ui: DrawUI) => ui.element.querySelector('[data-region="right"]');

  it('opens while something is selected and closes when the selection is empty', () => {
    const fake = fakeDocument({ features: [park] });
    const ui = createDrawUI(fake.asDraw, ALONE);
    handle = ui;
    expect(ui.inspector).not.toBeNull();
    expect(region(ui)).toBeNull();
    fake.selectItems('feature', ['a']);
    flushSync();
    expect(region(ui)?.querySelector('[data-role="inspector"]')).not.toBeNull();
    fake.selectItems('feature', []);
    flushSync();
    expect(region(ui)).toBeNull();
  });

  it('clears the selection with its close button', () => {
    const fake = fakeDocument({ features: [park], selection: { type: 'feature', ids: ['a'] } });
    const ui = createDrawUI(fake.asDraw, ALONE);
    handle = ui;
    flushSync();
    const inspector = ui.inspector?.element;
    if (!inspector) throw new Error('no inspector');
    click(button(inspector, 'Close'));
    expect(fake.mocks.selection.clear).toHaveBeenCalled();
    expect(region(ui)).toBeNull();
  });

  it('has no inspector with inspector: false, and can remove it', () => {
    const fake = fakeDocument({ features: [park], selection: { type: 'feature', ids: ['a'] } });
    const ui = createDrawUI(fake.asDraw, { ...ALONE, inspector: false });
    handle = ui;
    expect(ui.inspector).toBeNull();
    expect(region(ui)).toBeNull();
    ui.destroy();
    const again = createDrawUI(fake.asDraw, ALONE);
    handle = again;
    flushSync();
    expect(region(again)).not.toBeNull();
    again.inspector?.destroy();
    flushSync();
    expect(again.inspector).toBeNull();
    expect(region(again)).toBeNull();
  });

  it('takes the units of the interface', () => {
    const fake = fakeDocument({ features: [road], selection: { type: 'feature', ids: ['b'] } });
    const ui = createDrawUI(fake.asDraw, { ...ALONE, units: 'imperial' });
    handle = ui;
    flushSync();
    expect(ui.inspector?.element.textContent).toMatch(/\d ft/);
  });
});
