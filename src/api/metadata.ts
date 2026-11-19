// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.metadata`: the title and the description of the document
 */

import type { Metadata } from './model.js';

/**
 * The title and the description of the document.
 */
export interface MetadataResource {
  /** The title, the description and the keys of the extensions. */
  get(): Metadata;
  /**
   * Changes the keys given and returns the metadata after the change: the other keys keep
   * what they have, and a key given as `undefined` is taken off.
   *
   * @returns The changed metadata, or `null` when the document is read-only
   * @throws `DrawError` with the code `invalidInput` when a key has the wrong type, or a key of
   *   an extension a value that JSON does not hold
   */
  update(patch: Partial<Metadata>): Metadata | null;
}
