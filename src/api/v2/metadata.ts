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
  /** The title and the description. */
  get(): Metadata;
  /**
   * Changes the fields given and returns the metadata after the change.
   *
   * @returns The changed metadata, or `null` when the document is read-only
   * @throws `DrawError` with the code `invalid-input` when a field has the wrong type
   */
  update(patch: Partial<Metadata>): Metadata | null;
}
