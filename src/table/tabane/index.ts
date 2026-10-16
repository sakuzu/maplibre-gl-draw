// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tabane: rows written as blocks of columns named by their content, and a manifest of the blocks
 * (`README.md` of this folder). A block read is a set of row blocks whose columns are those of the
 * row blocks of the tables (`RowBlock`).
 *
 * A pure module: it depends on nothing outside `/table`, so it runs in a Worker as well.
 */

// biome-ignore-all assist/source/organizeImports: the exports are grouped by task

// Write and read blocks
export type { TabaneBlock, TabaneBlockHead, TabaneBlockInput } from './block.js';
export {
  packTabaneBlock,
  readTabaneBlock,
  readTabaneBlockFile,
  readTabaneBlockHead,
  rewriteTabaneBlock,
  TABANE_TARGET_BYTES,
  TABANE_TARGET_ROWS,
  TABANE_TARGET_VERTICES,
  TABANE_VERSION,
  writeTabaneBlock,
  writeTabaneBlocks,
} from './block.js';
export { readTabaneRowBlock } from './row-block-read.js';
export type {
  TabaneFill,
  TabaneRowBlock,
  TabanePlace,
  TabaneRevision,
  TabaneRow,
} from './types.js';

// The row blocks read as row blocks of the tables, and as rows
export type { RowBlockOfTabaneOptions } from './rows.js';
export { rowBlockOfTabane, tabaneRowsOf } from './rows.js';

// Files and names
export type { TabaneCompressor, TabaneFilePart } from './file.js';
export {
  packTabaneFile,
  readTabaneFilePart,
  listTabaneFileParts,
  tabaneNameOf,
  unpackTabaneFile,
} from './file.js';

// Manifests
export type { TabaneManifest, TabaneManifestEntry } from './manifest.js';
export { readTabaneManifest, tabaneManifestEntryOf, writeTabaneManifest } from './manifest.js';

// Ids and keys
export type { TabaneId } from './ids.js';
export { isTabaneOrigin, parseTabaneId, formatTabaneId, tabaneRowSuffixOf } from './ids.js';
