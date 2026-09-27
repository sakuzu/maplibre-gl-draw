// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.hidden`: what this client hides without changing the document
 */

/**
 * The IDs of the features, groups and layers this client hides. Hiding changes only what this
 * client draws; the document and its `visible` flags stay as they are.
 */
export interface HiddenCollection {
  /** Whether this client hides the item with this ID. */
  get(id: string): boolean;
  /** Lists the IDs this client hides. */
  list(): readonly string[];
  /** Counts the IDs this client hides. */
  count(): number;
  /** Whether this client hides the item with this ID; the same as {@link HiddenCollection.get}. */
  has(id: string): boolean;
  /**
   * Hides a feature, a group or a layer in this client only; the document does not change.
   *
   * @throws `DrawError` with the code `not-found` when the ID is not a feature, a group or a
   *   layer of the document
   */
  add(id: string): void;
  /**
   * Hides several items in this client only, all of them or none.
   *
   * @throws `DrawError` with the code `not-found` when one of the IDs is not in the document;
   *   nothing is hidden then
   */
  addMany(ids: readonly string[]): void;
  /**
   * Shows an item this client hid.
   *
   * @returns False when this client did not hide it
   */
  remove(id: string): boolean;
  /**
   * Shows several items this client hid, all at once.
   *
   * @returns False when this client hid none of them
   */
  removeMany(ids: readonly string[]): boolean;
  /** Shows every item this client hid. */
  clear(): void;
}
