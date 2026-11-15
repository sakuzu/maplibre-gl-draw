// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Plug a storage or an extension into the library.
 *
 * This entry is for the one who writes an extension of the library or the storage of its
 * documents, not for an application that only draws, edits and reads features: the main entry
 * has all of that. It holds what a storage is ({@link Backend}: `load` and `send`) and what it
 * answers ({@link Answer}); the values a storage receives: a commit sent as JSON
 * ({@link ValueBatch}), the operations on the records of a document ({@link ValueOperation}),
 * the one way they apply ({@link applyOperations}, which runs on a server as it is) and the
 * collector of the parts of a large commit ({@link createPartCollector}); a value that changes
 * over time of the shape of the library ({@link createObservable}); and the pictures an extension
 * draws points with, among the rows of their layer ({@link RowSprite}, {@link RowSpriteSource}).
 *
 * A storage applies the operations it is sent as they name things: a commit that moves a group, or
 * deletes a layer or a group, names what it held where it was made. Commits made at the same time,
 * or a commit refused under later ones, can then leave records that no longer fit in one tree.
 * Every instance reads such a document by the same rules, and so does what reads it on a server:
 *
 * - A member of a group is in the layer of its group: its `maplibre-gl-draw:layerId` is not read
 * - A feature whose group is not there is in its own layer (`maplibre-gl-draw:layerId`), at its own
 *   key, and back in the group once the group is there again
 * - A feature or a group whose layer is not there is not shown. It is shown again with the layer,
 *   what was written to it meanwhile included, once the layer is there again
 * - A group with no member is not shown, and is once a member comes
 *
 * The records are kept as they are: the document is not written to fit the rules.
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

// The storage of the documents
export type { Answer, Backend, BackendBase, Task } from '../api/backend/backend.js';

// The values a storage receives
export type {
  Batch,
  BatchHeader,
  FeatureRecord,
  FileRecord,
  GroupRecord,
  LayerRecord,
  StoredDocument,
  UnsetKeys,
  ValueBatch,
  ValueOperation,
} from '../api/backend/values.js';
export { applyOperations, createStoredDocument } from '../api/backend/values.js';
export type { PartCollector } from '../api/backend/parts.js';
export { createPartCollector } from '../api/backend/parts.js';

// A value that changes over time
export { createObservable } from '../api/backend/observable.js';
