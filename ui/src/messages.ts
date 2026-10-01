// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The words of the interface. English and Japanese come with it; an application can replace any
// of them by passing a partial set, which is laid over English.
//
// Some words are shown by the components of kata the interface is built from (the More menu of
// the toolbar, the list of the keyboard shortcuts). They are part of this set too, and applying a
// locale passes them on to kata. kata keeps them for the whole page: every interface on one page
// shows the words of the locale that was applied last.

import { type Messages as KataMessages, setMessages as setKataMessages } from '@sakuzu/kata/svelte';
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
  /** The inspector: its name, read by assistive technology, and what it says with nothing selected */
  inspector: string;
  nothingSelected: string;
  nothingSelectedNote: string;
  /** The language tag the numbers of the inspector are written in (Intl.NumberFormat) */
  numberLocale: string;
  /** The tabs of the inspector of a feature, and the titles of their sections */
  styleTab: string;
  attributesTab: string;
  measurements: string;
  details: string;
  description: string;
  /** The button that removes the style of the features, back to the layer rule and the defaults */
  resetStyle: string;
  /** The names of the fields of the style */
  styleFillColor: string;
  styleFillOpacity: string;
  styleStrokeColor: string;
  styleStrokeWidth: string;
  styleStrokeOpacity: string;
  styleLineStyle: string;
  stylePointColor: string;
  stylePointRadius: string;
  stylePointShape: string;
  stylePointOpacity: string;
  stylePointStrokeColor: string;
  stylePointStrokeWidth: string;
  styleImageOpacity: string;
  /** The choices of the line style and of the shape of a point */
  lineSolid: string;
  lineDashed: string;
  lineDotted: string;
  shapeCircle: string;
  shapeSquare: string;
  shapeTriangle: string;
  shapeStar: string;
  /** The names of the measurements */
  measureLongitude: string;
  measureLatitude: string;
  measureLength: string;
  measureArea: string;
  measurePerimeter: string;
  measureRadius: string;
  measurePoints: string;
  /** The names of the types that are not the names of tools, and of a layer and a group */
  typeMultiPoint: string;
  typeMultiLineString: string;
  typeMultiPolygon: string;
  typeLayer: string;
  typeGroup: string;
  /** The actions of the foot of the inspector, and what it says of a hidden feature */
  lockAction: string;
  unlockAction: string;
  hideAction: string;
  showAction: string;
  hiddenState: string;
  /** The title of a selection of several things; {count} is their number */
  selectedCount: string;
  /** The actions on a selection */
  groupAction: string;
  ungroupAction: string;
  /** The operations on features, and the title of their section */
  operations: string;
  opUnion: string;
  opIntersection: string;
  opDifference: string;
  opSplit: string;
  opBuffer: string;
  /** The dialog of the buffer */
  bufferDescription: string;
  bufferDistance: string;
  bufferUnit: string;
  bufferSegments: string;
  bufferSegmentsHint: string;
  bufferRun: string;
  bufferFailed: string;
  /** The fields of a layer and of a group */
  opacityField: string;
  visibleField: string;
  lockedField: string;
  /** The section of the style rule of a layer, which is only read */
  styleRule: string;
  ruleKind: string;
  ruleProperty: string;
  ruleNone: string;
  ruleSingle: string;
  ruleCategorical: string;
  ruleGraduated: string;
  ruleContinuous: string;
  ruleHint: string;
  deleteLayer: string;
  /**
   * Words kata's components of the inspector show: the name input of the title, a field whose
   * values differ, the list of attributes and the color picker. `removeAttribute` has {key} for
   * the name of the attribute, and `saturationValueText` {s} and {v} for the two percentages
   */
  nameLabel: string;
  addName: string;
  mixed: string;
  cancelLabel: string;
  noAttributes: string;
  attributeName: string;
  attributeValue: string;
  addValue: string;
  addAttribute: string;
  removeAttribute: string;
  locked: string;
  color: string;
  colorRed: string;
  colorOrange: string;
  colorGold: string;
  colorGreen: string;
  colorBlue: string;
  colorPurple: string;
  colorBlack: string;
  colorBrown: string;
  colorWhite: string;
  colorCode: string;
  eyedropper: string;
  hue: string;
  saturation: string;
  lightness: string;
  saturationValue: string;
  saturationValueText: string;
  running: string;
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
  setKataMessages({
    ...kataMessages(messages),
    ...(inspectorKataMessages(messages) as Partial<KataMessages>),
  });
}

/**
 * The words of kata's components of the inspector, by kata's key: the key of the set that holds
 * each, where the two names differ
 */
const INSPECTOR_KATA_WORDS = {
  rename: 'nameLabel',
  addName: 'addName',
  mixed: 'mixed',
  cancel: 'cancelLabel',
  noAttributes: 'noAttributes',
  attributeName: 'attributeName',
  attributeValue: 'attributeValue',
  addValue: 'addValue',
  addAttribute: 'addAttribute',
  locked: 'locked',
  color: 'color',
  colorRed: 'colorRed',
  colorOrange: 'colorOrange',
  colorGold: 'colorGold',
  colorGreen: 'colorGreen',
  colorBlue: 'colorBlue',
  colorPurple: 'colorPurple',
  colorBlack: 'colorBlack',
  colorBrown: 'colorBrown',
  colorWhite: 'colorWhite',
  colorCode: 'colorCode',
  eyedropper: 'eyedropper',
  hue: 'hue',
  saturation: 'saturation',
  lightness: 'lightness',
  saturationValue: 'saturationValue',
  running: 'running',
} as const satisfies Partial<Record<keyof KataMessages, keyof Messages>>;

/** Fills the {name} places of a word with values */
export function fillWord(word: string, values: Record<string, string | number>): string {
  return word.replace(/\{(\w+)\}/g, (all, name: string) =>
    name in values ? String(values[name]) : all,
  );
}

/**
 * The words of the set that kata's components of the inspector show, by kata's keys, as kata
 * takes them (a word with values as a function of them)
 */
export function inspectorKataMessages(messages: Messages): Record<string, unknown> {
  const out: Partial<Record<keyof KataMessages, unknown>> = {};
  for (const [kata, own] of Object.entries(INSPECTOR_KATA_WORDS)) {
    out[kata as keyof KataMessages] = messages[own];
  }
  out.removeAttribute = ({ key }: { key: string }) => fillWord(messages.removeAttribute, { key });
  out.saturationValueText = ({ s, v }: { s: number; v: number }) =>
    fillWord(messages.saturationValueText, { s, v });
  return out;
}
