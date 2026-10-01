// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The words of the interface. English and Japanese come with it; an application can replace any
// of them by passing a partial set, which is laid over English.
//
// Some words are shown by the components of kata the interface is built from (the More menu of
// the toolbar, the list of the keyboard shortcuts). They are part of this set too, and applying a
// locale passes them on to kata. kata keeps them for the whole page: every interface on one page
// shows the words of the locale that was applied last.

import { setMessages as setKataMessages } from '@sakuzu/kata/svelte';
import { en } from './locales/en.js';
import { ja } from './locales/ja.js';

/** The words of the interface */
export interface Messages {
  /** The name of the toolbar, read by assistive technology */
  toolbar: string;
  /** The names of the built-in tools */
  select: string;
  point: string;
  line: string;
  polygon: string;
  circle: string;
  freehand: string;
  image: string;
  /** The delete button of the toolbar */
  delete: string;
  /** The snapping switch of the toolbar */
  snapping: string;
  /** In the list of the keyboard shortcuts: the heading of the tools and of the editing keys */
  toolsGroup: string;
  editGroup: string;
  /** In the list of the keyboard shortcuts: what Delete and Backspace do */
  deleteSelection: string;
  /** The trigger of the menu that holds the tools that do not fit */
  more: string;
  /** The title of the list of the keyboard shortcuts */
  keyboardShortcuts: string;
  /** The close and back buttons of a dialog */
  close: string;
  back: string;
  /** The scrim that closes the panels floating over the map */
  closePanes: string;
  /** The handles that resize a dock and a sheet */
  dockHeight: string;
  sheetHeight: string;
}

/** A locale: one of the sets that come with the interface, or words laid over English */
export type Locale = 'en' | 'ja' | Partial<Messages>;

/** The words of the components of kata, taken from the set */
const KATA_KEYS = [
  'more',
  'keyboardShortcuts',
  'close',
  'back',
  'closePanes',
  'dockHeight',
  'sheetHeight',
] as const satisfies readonly (keyof Messages)[];

/** The full set of words for a locale */
export function resolveMessages(locale: Locale = 'en'): Messages {
  if (locale === 'en') return { ...en };
  if (locale === 'ja') return { ...ja };
  const out: Messages = { ...en };
  for (const [key, value] of Object.entries(locale) as [keyof Messages, unknown][]) {
    if (typeof value === 'string' && key in en) out[key] = value;
  }
  return out;
}

/** The language of a locale, for the lang attribute of the root element, when it is known */
export function localeLanguage(locale: Locale = 'en'): string | null {
  return typeof locale === 'string' ? locale : null;
}

/** The words of the set that kata shows */
export function kataMessages(messages: Messages): Pick<Messages, (typeof KATA_KEYS)[number]> {
  const out = {} as Pick<Messages, (typeof KATA_KEYS)[number]>;
  for (const key of KATA_KEYS) out[key] = messages[key];
  return out;
}

/** Passes the words that kata shows on to kata (for the whole page) */
export function applyKataMessages(messages: Messages): void {
  setKataMessages(kataMessages(messages));
}
