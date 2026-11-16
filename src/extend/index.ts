// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Plug a storage or an extension into the library.
 *
 * This entry is for the one who writes an extension of the library or the storage of its
 * documents, not for an application that only draws, edits and reads features: the main entry
 * has all of that. For now it holds the pictures an extension draws points with, among the rows
 * of their layer ({@link RowSprite}, {@link RowSpriteSource}).
 *
 * @module extend
 */

// biome-ignore-all assist/source/organizeImports: the exports are grouped by task

// Pictures of points drawn with the rows
export type {
  RowSprite,
  RowSpriteScaleStop,
  RowSpriteSource,
} from '../view/renderers/rows/rows-format.js';

// Quads an extension paints its rows with, among the rows of their layer (a prototype)
export type {
  RowQuadDataTexture,
  RowQuadExternalTexture,
  RowQuadOut,
  RowQuadSource,
  RowQuadTables,
  RowQuadTexture,
} from '../view/renderers/rows/rows-format.js';
