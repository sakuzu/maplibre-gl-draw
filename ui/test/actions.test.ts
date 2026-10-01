// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { flushSync } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeKey } from '../src/actions.js';
import { createDrawUI, type DrawUI } from '../src/index.js';
import { fakeDraw } from './fake-draw.js';

let ui: DrawUI | undefined;
afterEach(() => {
  ui?.destroy();
  ui = undefined;
  document.body.innerHTML = '';
});

function key(target: EventTarget, k: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  flushSync();
  return event;
}

const card = (root: HTMLElement) => root.querySelector<HTMLElement>('[data-role="actions"]');
const row = (root: HTMLElement, id: string) =>
  root.querySelector<HTMLElement>(`[data-role="actions"] [data-action="${id}"]`);

/** A switch whose state lives outside the interface, as an application keeps it */
function switchOf(id: string, shortcut?: string) {
  let on = false;
  const run = vi.fn(() => {
    on = !on;
  });
  return {
    spec: { id, label: `Switch ${id}`, kind: 'toggle' as const, shortcut, run, checked: () => on },
    run,
    set(next: boolean) {
      on = next;
    },
  };
}

describe('the actions', () => {
  it('are added, listed and removed', () => {
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw);
    const remove = ui.actions.add({ id: 'save', label: 'Save', kind: 'action', run: () => {} });
    ui.actions.add({ id: 'open', label: 'Open', kind: 'action', shortcut: 'O', run: () => {} });
    expect(ui.actions.list().map((a) => a.id)).toEqual(['save', 'open']);
    remove();
    remove();
    expect(ui.actions.list().map((a) => a.id)).toEqual(['open']);
    expect(ui.actions.remove('open')).toBe(true);
    expect(ui.actions.remove('open')).toBe(false);
    expect(ui.actions.list()).toEqual([]);
  });

  it('take the initial ones from the options', () => {
    const fake = fakeDraw();
    const a = switchOf('a', 'R');
    ui = createDrawUI(fake.asDraw, { actions: [a.spec] });
    expect(ui.actions.list().map((x) => x.id)).toEqual(['a']);
    expect(row(ui.element, 'a')).not.toBeNull();
  });

  it('draw no card while there are none', () => {
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw);
    expect(card(ui.element)).toBeNull();
    const remove = ui.actions.add({ id: 'x', label: 'X', kind: 'action', run: () => {} });
    flushSync();
    expect(card(ui.element)).not.toBeNull();
    remove();
    flushSync();
    expect(card(ui.element)).toBeNull();
  });

  it('draw a row for each, a switch or a button, with its key', () => {
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw);
    const a = switchOf('a', 'R');
    ui.actions.add(a.spec);
    ui.actions.add({ id: 'b', label: 'Save', kind: 'action', shortcut: 'shift+s', run: () => {} });
    ui.actions.add({ id: 'c', label: 'Nothing', kind: 'action', run: () => {} });
    flushSync();
    const root = ui.element;
    expect(card(root)?.textContent).toContain('Actions');
    const sw = row(root, 'a')?.querySelector<HTMLInputElement>('input[role="switch"]');
    expect(sw).not.toBeNull();
    expect(row(root, 'a')?.textContent).toContain('Switch a');
    expect(row(root, 'a')?.querySelector('kbd')?.textContent).toBe('R');
    const button = row(root, 'b')?.querySelector('button');
    expect(button?.textContent).toContain('Save');
    expect(row(root, 'b')?.querySelector('kbd')?.textContent).toMatch(/Shift\+S|⇧S/);
    expect(row(root, 'c')?.querySelector('kbd')).toBeNull();
  });

  it('take the title of the options and the words of the locale', () => {
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw, { locale: 'ja', actions: [switchOf('a').spec] });
    expect(card(ui.element)?.textContent).toContain('操作');
    ui.destroy();
    ui = createDrawUI(fakeDraw().asDraw, { actionsTitle: 'Demo', actions: [switchOf('a').spec] });
    expect(card(ui.element)?.textContent).toContain('Demo');
  });

  it('run a button when it is pressed', () => {
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw);
    const run = vi.fn();
    ui.actions.add({ id: 'b', label: 'Save', kind: 'action', run });
    flushSync();
    row(ui.element, 'b')?.querySelector('button')?.click();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('show the state of a switch, read again after it runs and on refresh', () => {
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw);
    const a = switchOf('a');
    ui.actions.add(a.spec);
    flushSync();
    const input = () =>
      row(ui!.element, 'a')?.querySelector<HTMLInputElement>('input[role="switch"]');
    expect(input()?.checked).toBe(false);
    input()?.click();
    flushSync();
    expect(a.run).toHaveBeenCalledTimes(1);
    expect(input()?.checked).toBe(true);
    // Changed outside the card: shown after refresh
    a.set(false);
    ui.actions.refresh();
    flushSync();
    expect(input()?.checked).toBe(false);
  });

  it('keep the switch as checked() says when the run does not change it', () => {
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw);
    const run = vi.fn();
    ui.actions.add({ id: 'a', label: 'Stuck', kind: 'toggle', run, checked: () => false });
    flushSync();
    const input = row(ui.element, 'a')?.querySelector<HTMLInputElement>('input[role="switch"]');
    input?.click();
    flushSync();
    expect(run).toHaveBeenCalledTimes(1);
    expect(input?.checked).toBe(false);
  });

  it('dim a disabled action, which neither its row nor its key runs', () => {
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw);
    const run = vi.fn();
    ui.actions.add({
      id: 'b',
      label: 'Save',
      kind: 'action',
      shortcut: 'S',
      run,
      disabled: () => true,
    });
    flushSync();
    const button = row(ui.element, 'b')?.querySelector('button');
    expect(button?.disabled).toBe(true);
    key(document.body, 's');
    expect(run).not.toHaveBeenCalled();
  });

  it('run on their key, and not while an input has the focus', () => {
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw);
    const a = switchOf('a', 'R');
    ui.actions.add(a.spec);
    flushSync();
    const event = key(document.body, 'r');
    expect(a.run).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    expect(
      row(ui.element, 'a')?.querySelector<HTMLInputElement>('input[role="switch"]')?.checked,
    ).toBe(true);
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    key(input, 'r');
    expect(a.run).toHaveBeenCalledTimes(1);
  });

  it('are listed with their labels among the keyboard shortcuts', () => {
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw);
    ui.actions.add({ id: 'b', label: 'Save the drawing', kind: 'action', shortcut: 'S', run() {} });
    flushSync();
    // jsdom has no modal dialogs: open the list in place
    const proto = HTMLDialogElement.prototype as { showModal?: () => void };
    proto.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    key(document.body, '?');
    const dialog = ui.element.querySelector('dialog');
    expect(dialog?.textContent).toContain('Save the drawing');
    expect(dialog?.textContent).toContain('Actions');
  });

  it('have no keys with shortcuts: false', () => {
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw, { shortcuts: false });
    const a = switchOf('a', 'R');
    ui.actions.add(a.spec);
    flushSync();
    expect(row(ui.element, 'a')?.querySelector('kbd')).toBeNull();
    key(document.body, 'r');
    expect(a.run).not.toHaveBeenCalled();
  });

  it('throw when a key is taken', () => {
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw);
    const add = (shortcut: string, id = 'x') =>
      ui!.actions.add({ id, label: 'X', kind: 'action', shortcut, run() {} });
    expect(() => add('P')).toThrow(/"P" of the action "x" is taken by the tool "point"/);
    expect(() => add('v')).toThrow(/the tool "select"/);
    expect(() => add('Delete')).toThrow(/taken by deleting the selection/);
    expect(() => add('Backspace')).toThrow(/taken/);
    expect(() => add('?')).toThrow(/the list of the keyboard shortcuts/);
    expect(() => add('Shift+L')).toThrow(/the layer panel/);
    expect(() => add('Escape')).toThrow(/taken/);
    add('R', 'first');
    expect(() => add('r', 'second')).toThrow(/taken by the action "first"/);
    // Shift makes another key
    expect(() => add('shift+r', 'third')).not.toThrow();
    // A tool of the application, and a tool added after the action
    ui.tools.add({ id: 'ring', mode: 'draw_ring', label: 'Ring', icon: 'circle', shortcut: 'G' });
    expect(() => add('g', 'fourth')).toThrow(/the tool "ring"/);
    expect(() =>
      ui!.tools.add({ id: 'arc', mode: 'draw_arc', label: 'Arc', icon: 'circle', shortcut: 'R' }),
    ).toThrow(/taken by the action "first"/);
  });

  it('throw when an action is not valid or its ID is taken', () => {
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw);
    expect(() => ui!.actions.add({ id: '', label: 'X', kind: 'action', run() {} })).toThrow(/id/);
    expect(() =>
      ui!.actions.add({ id: 'x', label: 'X', kind: 'other' as never, run() {} }),
    ).toThrow(/kind/);
    expect(() => ui!.actions.add({ id: 'x', label: 'X', kind: 'action' } as never)).toThrow(/run/);
    ui.actions.add({ id: 'x', label: 'X', kind: 'action', run() {} });
    expect(() => ui!.actions.add({ id: 'x', label: 'Y', kind: 'action', run() {} })).toThrow(
      /already/,
    );
    expect(() =>
      createDrawUI(fakeDraw().asDraw, {
        actions: [{ id: 'p', label: 'P', kind: 'action', shortcut: 'P', run() {} }],
      }),
    ).toThrow(/taken by the tool "point"/);
  });

  it('fold into one button and open again', () => {
    const fake = fakeDraw();
    ui = createDrawUI(fake.asDraw, { actions: [switchOf('a').spec] });
    const root = ui.element;
    const fold = card(root)?.querySelector<HTMLButtonElement>('button[aria-expanded="true"]');
    fold?.click();
    flushSync();
    expect(row(root, 'a')).toBeNull();
    const opener = card(root)?.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
    expect(opener?.textContent).toContain('Actions');
    opener?.click();
    flushSync();
    expect(row(root, 'a')).not.toBeNull();
  });

  it('write a key one way', () => {
    expect(normalizeKey('Shift+R')).toBe('shift+r');
    expect(normalizeKey('r+shift')).toBe('shift+r');
    expect(normalizeKey('cmd+shift+z')).toBe('mod+shift+z');
    expect(normalizeKey('mod++')).toBe('mod++');
  });
});
