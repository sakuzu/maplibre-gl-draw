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
 */

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

/**
 * Resolves a table: the given entries over the English default
 *
 * Entries that are `undefined` keep the default, and keys the table does not know are
 * ignored.
 *
 * @internal
 */
export function resolveMessages(overrides?: Partial<Messages>): Messages {
  const resolved: Messages = { ...MESSAGES_EN };
  if (!overrides) return resolved;
  for (const key of Object.keys(MESSAGES_EN) as Array<keyof Messages>) {
    const value = overrides[key];
    if (value !== undefined) (resolved as unknown as Record<string, unknown>)[key] = value;
  }
  return resolved;
}
