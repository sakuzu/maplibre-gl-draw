// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The subpath `@sakuzu/maplibre-gl-draw/columnar`
 *
 * The parts of the columnar input of the datasets that can run in a Worker: the
 * preparation of a table and the list of its buffers for `postMessage`, with the types of the
 * table. It depends on neither maplibre nor WebGL nor the DOM, so a Worker that reads a file can
 * import it without pulling in the engine.
 *
 * @module columnar
 */

export { columnarTransferables, prepareDatasetColumnar } from './prepare.js';
export type {
  DatasetColumn,
  DatasetColumnarGeometry,
  DatasetColumnarGeometryType,
  DatasetColumnarInput,
  DatasetColumnarPrepared,
  DatasetDictionaryCodes,
  DatasetDictionaryColumn,
} from './types.js';
