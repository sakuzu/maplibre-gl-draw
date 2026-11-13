// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Messages
 *
 * The table of every string the library returns as a value (legend labels, the
 * descriptions of the snapping guides). The library never builds such a string inline;
 * it reads it from the table of the instance, so the host application can show them in
 * its own language.
 *
 * - The keys are typed. A value is either a string or a function that formats one (it
 *   receives numbers already turned into strings)
 * - `MESSAGES_EN` is the default, in English. The library ships no other language
 * - `DrawOptions.messages` overrides part of the table for one instance. The table belongs to
 *   the instance and is never module-level state
 * - There is no locale detection and no automatic switching: the host passes the table
 *   it wants
 * - The words of the names generated for features, layers and groups are not in this table:
 *   they come from the `autoName` option
 * - An extension adds keys of its own: it declares them in `Messages` by declaration merging and
 *   gives their English defaults to `defineMessages`, which keeps them for every instance (the
 *   keys are global, as the declaration is). The table of an instance has them through its
 *   prototype, so a key defined after the instance was made is read too
 */

import { DrawError } from './shared/draw-error.js';

/**
 * The table of the strings the library returns as values: legend labels and the descriptions
 * of the snapping guides
 *
 * The library builds no such string inline; it reads it from the table of the instance, so
 * the host can show them in its own language. Pass the entries to replace as the `messages`
 * option of `createDraw`; the entries left out keep the English defaults. A value is a string,
 * or a function that formats one from numbers already turned into strings. There is no locale
 * detection and no other built-in language. The words of generated names ("Layer 1") are
 * translated through the `autoName` option, not here.
 *
 * An extension adds keys of its own by declaration merging, and gives their English defaults
 * to {@link defineMessages}; the `messages` option then takes them as it takes the keys of the
 * library, and the extension reads them from the table of the instance (`ctx.messages`).
 *
 * @example
 * ```ts
 * const draw = createDraw(map, {
 *   messages: {
 *     legendOther: 'Sonstige',
 *     legendRange: (lower, upper) => `${lower} bis unter ${upper}`,
 *   },
 * });
 * ```
 */
export interface Messages {
  /** The label of the single legend entry of a `single` style rule */
  legendAll: string;
  /** The label of the legend entry for values the rule could not resolve (`other`) */
  legendOther: string;
  /** The label of the first class of a `graduated` rule (values below `upper`) */
  legendBelow: (upper: string) => string;
  /** The label of the last class of a `graduated` rule (values of `lower` or more) */
  legendAtLeast: (lower: string) => string;
  /** The label of a middle class of a `graduated` rule (`lower` or more, below `upper`) */
  legendRange: (lower: string, upper: string) => string;
  /** The description of the north-based snapping guide */
  snapNorth: string;
  /** The description of the snapping guide that extends the previous segment */
  snapExtension: string;
  /** The description of the snapping guide perpendicular to the previous segment */
  snapPerpendicular: string;
  /** The description of a snapping candidate at the intersection of two edges */
  snapIntersection: string;
}

/**
 * The default table of {@link Messages}, in English (`'All'`, `'Other'`, `` `Below ${upper}` ``
 * and so on)
 */
export const MESSAGES_EN: Readonly<Messages> = Object.freeze({
  legendAll: 'All',
  legendOther: 'Other',
  legendBelow: (upper: string) => `Below ${upper}`,
  legendAtLeast: (lower: string) => `${lower} or more`,
  legendRange: (lower: string, upper: string) => `${lower} to below ${upper}`,
  snapNorth: 'North',
  snapExtension: 'Extension',
  snapPerpendicular: 'Perpendicular',
  snapIntersection: 'Intersection',
});

/** Whether an object has a key of its own */
function hasOwn(object: object, key: string): boolean {
  return Object.getOwnPropertyDescriptor(object, key) !== undefined;
}

/** The English defaults of the keys the extensions defined (`defineMessages`), by key */
const definedMessages: Record<string, unknown> = Object.create(null);

/**
 * Adds the English defaults of message keys of an extension, which it declares in
 * {@link Messages} by declaration merging. The `messages` option of every instance then takes
 * them, as it takes the keys of the library, and the table of every instance, made before or
 * after, has them (`ctx.messages` of an extension); a key the option leaves out has its default.
 * Call it before the instance whose `messages` option names the keys is created, such as when
 * the extension makes its plugin.
 *
 * Defining a key again with the same value does nothing, so that each plugin of an extension may
 * define its keys.
 *
 * @example
 * ```ts
 * declare module '@sakuzu/maplibre-gl-draw' {
 *   interface Messages {
 *     pinLabel: string;
 *   }
 * }
 *
 * defineMessages({ pinLabel: 'Pin' });
 * const draw = createDraw(map, { messages: { pinLabel: 'Épingle' } });
 * ```
 *
 * @param defaults - The keys and their English defaults: a string, or a function that formats
 *   one
 * @throws `DrawError` with the code `invalidInput` when a key is one of the library or a default
 *   is neither a string nor a function, or `alreadyExists` when a key was defined with another
 *   value; nothing is defined then
 */
export function defineMessages(defaults: Partial<Messages>): void {
  if (defaults === null || typeof defaults !== 'object' || Array.isArray(defaults)) {
    throw new DrawError('invalidInput', 'The defaults of the messages must be an object');
  }
  const entries = Object.entries(defaults);
  for (const [key, value] of entries) {
    if (hasOwn(MESSAGES_EN, key)) {
      throw new DrawError(
        'invalidInput',
        `The message ${JSON.stringify(key)} is one of the library, which an extension does not define`,
      );
    }
    if (typeof value !== 'string' && typeof value !== 'function') {
      throw new DrawError(
        'invalidInput',
        `The default of the message ${JSON.stringify(key)} must be a string or a function`,
      );
    }
    if (hasOwn(definedMessages, key) && definedMessages[key] !== value) {
      throw new DrawError(
        'alreadyExists',
        `The message ${JSON.stringify(key)} is defined with another default`,
      );
    }
  }
  for (const [key, value] of entries) definedMessages[key] = value;
}

/**
 * The default of a key of the table: of the library, or of an extension (`defineMessages`)
 *
 * @returns The default, or `undefined` for a key nothing defines
 * @internal
 */
export function messageDefaultOf(key: string): unknown {
  if (hasOwn(MESSAGES_EN, key)) return MESSAGES_EN[key as keyof typeof MESSAGES_EN];
  return hasOwn(definedMessages, key) ? definedMessages[key] : undefined;
}

/**
 * Resolves a table: the given entries over the English defaults
 *
 * The keys of the library and the entries given are its own; the defaults of the keys of the
 * extensions come through its prototype, so a key defined later is read too. Entries that are
 * `undefined` keep the default, and keys nothing defines are ignored.
 *
 * @internal
 */
export function resolveMessages(overrides?: Partial<Messages>): Messages {
  const resolved = Object.assign(Object.create(definedMessages), MESSAGES_EN) as Messages;
  if (!overrides) return resolved;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || messageDefaultOf(key) === undefined) continue;
    (resolved as unknown as Record<string, unknown>)[key] = value;
  }
  return resolved;
}
