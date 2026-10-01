// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The actions of the application: the rows of the card at the bottom left of the map, each a
// switch or a button, with its key. The interface keeps nothing of what an action does: a row
// calls `run`, and a switch shows what `checked` returns, read again after each run and on
// `refresh()`.
//
// The key of an action is a shortcut of kata's Shell, listed with `?` in a group of its own. It
// must not take a key of the interface (the keys of the built-in tools and of the tools of the
// toolbar, Delete and Backspace, Escape, the help key and Shift+L) or the key of another action.

import type { Shortcut } from '@sakuzu/kata/svelte';
import type { Messages } from './messages.js';
import { Box } from './store.js';
import { BUILTIN_TOOLS, entryId, TOOL_IDS, toSpec } from './tools.js';
import type { ActionSpec, ActionsHandle, ToolEntry } from './types.js';

const MODIFIERS = ['mod', 'ctrl', 'alt', 'shift'] as const;
const MODIFIER_NAMES: Record<string, (typeof MODIFIERS)[number]> = {
  mod: 'mod',
  cmd: 'mod',
  meta: 'mod',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
};

/**
 * A key written one way: the modifiers in a fixed order, then the key, all in lowercase, so that
 * `Shift+R`, `shift+r` and `r+shift` compare equal
 */
export function normalizeKey(shortcut: string): string {
  const raw = shortcut.trim().toLowerCase();
  const parts = raw.endsWith('++') ? [...raw.slice(0, -2).split('+'), '+'] : raw.split('+');
  const mods = new Set<string>();
  let key = '';
  for (const part of parts.map((p) => p.trim())) {
    const mod = MODIFIER_NAMES[part];
    if (mod) mods.add(mod);
    else if (part) key = part;
  }
  return [...MODIFIERS.filter((m) => mods.has(m)), key].join('+');
}

/** The keys the interface keeps for itself, with what each does, beside those of the tools */
const KEPT_KEYS: Readonly<Record<string, string>> = Object.freeze({
  delete: 'deleting the selection',
  backspace: 'deleting the selection',
  escape: 'closing and cancelling',
  '?': 'the list of the keyboard shortcuts',
  'shift+?': 'the list of the keyboard shortcuts',
  f1: 'the list of the keyboard shortcuts',
  'shift+l': 'the layer panel',
});

/**
 * What already uses a key: a key the interface keeps, a key of a tool (the built-in tools always,
 * and the tools of the toolbar), or the key of another action; null when it is free
 */
function keyOwner(
  key: string,
  tools: readonly ToolEntry[],
  messages: Messages,
  actions: readonly ActionSpec[],
): string | null {
  const kept = KEPT_KEYS[key];
  if (kept) return kept;
  for (const id of TOOL_IDS) {
    if (normalizeKey(BUILTIN_TOOLS[id].shortcut) === key) return `the tool "${id}"`;
  }
  for (const entry of tools) {
    const spec = toSpec(entry, messages);
    if (spec.shortcut && normalizeKey(spec.shortcut) === key) return `the tool "${entryId(entry)}"`;
  }
  for (const action of actions) {
    if (action.shortcut && normalizeKey(action.shortcut) === key) {
      return `the action "${action.id}"`;
    }
  }
  return null;
}

/**
 * Checks an action of the application
 *
 * @throws Error when a field is missing or has the wrong type
 */
export function checkAction(spec: ActionSpec): void {
  for (const key of ['id', 'label'] as const) {
    if (typeof spec?.[key] !== 'string' || spec[key] === '') {
      throw new Error(`An action needs a ${key} (a string that is not empty)`);
    }
  }
  if (spec.kind !== 'action' && spec.kind !== 'toggle') {
    throw new Error(`The kind of the action "${spec.id}" must be "action" or "toggle"`);
  }
  if (typeof spec.run !== 'function') {
    throw new Error(`The action "${spec.id}" needs run (a function)`);
  }
  for (const key of ['checked', 'disabled'] as const) {
    if (spec[key] !== undefined && typeof spec[key] !== 'function') {
      throw new Error(`The ${key} of the action "${spec.id}" must be a function`);
    }
  }
  if (spec.shortcut !== undefined) {
    if (typeof spec.shortcut !== 'string' || !normalizeKey(spec.shortcut).split('+').at(-1)) {
      throw new Error(`The shortcut of the action "${spec.id}" must name a key, such as "R"`);
    }
  }
}

/**
 * Checks that the key of an action is free
 *
 * @throws Error when it is a key of the interface, of a tool or of another action
 */
export function checkActionKey(
  spec: ActionSpec,
  tools: readonly ToolEntry[],
  messages: Messages,
  actions: readonly ActionSpec[],
): void {
  if (!spec.shortcut) return;
  const owner = keyOwner(normalizeKey(spec.shortcut), tools, messages, actions);
  if (owner) {
    throw new Error(
      `The shortcut "${spec.shortcut}" of the action "${spec.id}" is taken by ${owner}`,
    );
  }
}

/** The actions of the card, and the count of their changes that the rows follow */
export interface ActionsState {
  /** The actions in the order of the card */
  readonly list: Box<ActionSpec[]>;
  /** Changed after each run and on `refresh()`, so that the rows read `checked` and `disabled` */
  readonly version: Box<number>;
}

/**
 * The actions of the options, checked
 *
 * @throws Error when an action is not valid, two share an ID, or a key is taken
 */
export function actionsState(
  actions: readonly ActionSpec[] | undefined,
  tools: readonly ToolEntry[],
  messages: Messages,
): ActionsState {
  const out: ActionSpec[] = [];
  for (const spec of actions ?? []) {
    checkAction(spec);
    if (out.some((a) => a.id === spec.id)) throw new Error(`Two actions have the ID "${spec.id}"`);
    checkActionKey(spec, tools, messages, out);
    out.push({ ...spec });
  }
  return { list: new Box(out), version: new Box(0) };
}

/** Runs an action, unless it is disabled, and has the rows read their state again */
export function runAction(state: ActionsState, spec: ActionSpec): void {
  if (spec.disabled?.()) return;
  try {
    spec.run();
  } finally {
    state.version.set(state.version.get() + 1);
  }
}

/** The actions of the card, to add to and to remove from */
export function actionsHandle(
  state: ActionsState,
  tools: Box<ToolEntry[]>,
  messages: Box<Messages>,
): ActionsHandle {
  const remove = (id: string): boolean => {
    const now = state.list.get();
    const next = now.filter((a) => a.id !== id);
    if (next.length === now.length) return false;
    state.list.set(next);
    return true;
  };
  return {
    add(spec: ActionSpec) {
      checkAction(spec);
      const now = state.list.get();
      if (now.some((a) => a.id === spec.id)) {
        throw new Error(`There is an action with the ID "${spec.id}" already`);
      }
      checkActionKey(spec, tools.get(), messages.get(), now);
      const added = { ...spec };
      state.list.set([...now, added]);
      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        if (state.list.get().includes(added)) remove(spec.id);
      };
    },
    remove,
    list() {
      return state.list.get().map((a) => ({ ...a }));
    },
    refresh() {
      state.version.set(state.version.get() + 1);
    },
  };
}

/** The keys of the actions, as shortcuts of kata's Shell under the title of the card */
export function actionShortcuts(state: ActionsState, group: string): Shortcut[] {
  const out: Shortcut[] = [];
  for (const spec of state.list.get()) {
    if (!spec.shortcut) continue;
    out.push({
      key: normalizeKey(spec.shortcut),
      label: spec.label,
      group,
      when: () => !spec.disabled?.(),
      run: () => runAction(state, spec),
    });
  }
  return out;
}

/**
 * Checks that the key of a tool is not the key of an action
 *
 * @throws Error when an action has the key
 */
export function checkToolKey(
  id: string,
  shortcut: string | undefined,
  actions: readonly ActionSpec[],
): void {
  if (!shortcut) return;
  const key = normalizeKey(shortcut);
  const owner = actions.find((a) => a.shortcut && normalizeKey(a.shortcut) === key);
  if (owner) {
    throw new Error(
      `The shortcut "${shortcut}" of the tool "${id}" is taken by the action "${owner.id}"`,
    );
  }
}
