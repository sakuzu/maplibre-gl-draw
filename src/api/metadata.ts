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
  /** The title and the description; they are written with `tx.document.update`. */
  get(): Metadata;
}
