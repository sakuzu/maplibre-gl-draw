// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.hidden`: what this client hides without changing the document
 */

/**
 * The IDs this client hides. Hiding changes only what this client draws; the document and its
 * `visible` flags stay as they are.
 */
// TODO(api-2): confirm which IDs it takes (features, layers, groups) and whether an unknown ID throws
export interface HiddenCollection {
  /** Whether this client hides the item with this ID. */
  get(id: string): boolean;
  /** Lists the IDs this client hides. */
  list(): readonly string[];
  /** Counts the IDs this client hides. */
  count(): number;
  /** Whether this client hides the item with this ID; the same as {@link HiddenCollection.get}. */
  has(id: string): boolean;
  /** Hides an item in this client only; the document does not change. */
  add(id: string): void;
  /** Hides several items in this client only, all at once. */
  addMany(ids: readonly string[]): void;
  /** Shows an item this client hid. */
  remove(id: string): void;
  /** Shows several items this client hid, all at once. */
  removeMany(ids: readonly string[]): void;
  /** Shows every item this client hid. */
  clear(): void;
}
