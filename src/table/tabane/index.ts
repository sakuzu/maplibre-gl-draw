// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tabane: rows written as blocks of columns named by their content, and a manifest of the blocks
 * (`README.md` of this folder). A block read is a set of groups whose columns are those of the
 * blocks of rows of the tables.
 *
 * A pure module: it depends on nothing outside `/table`, so it runs in a Worker as well.
 */

// biome-ignore-all assist/source/organizeImports: the exports are grouped by task

// Write and read blocks
export type { TabaneBlock, TabaneBlockInput } from './block.js';
export {
  packTabaneBlock,
  readTabaneBlock,
  readTabaneBlockFile,
  TABANE_BLOCK_BYTES,
  TABANE_GROUP_ROWS,
  TABANE_GROUP_VERTICES,
  TABANE_VERSION,
  writeTabaneBlock,
  writeTabaneBlocks,
} from './block.js';
export { readTabaneGroup } from './group-read.js';
export type {
  TabaneFill,
  TabaneGroup,
  TabanePlace,
  TabaneRevision,
  TabaneRow,
} from './types.js';

// The groups as blocks of rows of the tables, and as rows
export type { TabaneRowBlockOptions } from './rows.js';
export { tabaneRowBlock, tabaneRows } from './rows.js';

// Files and names
export type { TabaneCompression, TabaneFrame } from './file.js';
export {
  packTabaneFile,
  tabaneFrameContent,
  tabaneFrames,
  tabaneName,
  unpackTabaneFile,
} from './file.js';

// Manifests
export type { TabaneManifest, TabaneManifestEntry } from './manifest.js';
export { readTabaneManifest, tabaneManifestEntry, writeTabaneManifest } from './manifest.js';

// Ids and keys
export type { TabaneId } from './ids.js';
export { isTabaneOrigin, parseTabaneId, tabaneIdText, tabaneRowSuffix } from './ids.js';
