// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where the writes of the document come from
 */

import type { DocumentChange } from '../events.js';

/**
 * Where a write came from, as it arrives in {@link DocumentChange.source} and in the `source` of
 * the events.
 *
 * - `local`: an operation of the user or a call of the API (the default of `draw.transact`)
 * - `silent`: a change that a subscriber keeping the edits of the user leaves out, such as the
 *   layer an application creates when the document has none
 * - `load`: a load of any format (`document.load`, `document.loadMany`), with the replacement
 *   of `mode: 'replace'`; only the instance writes it (a document opened by writing to the
 *   Store directly is written with `remote`)
 * - `batch`: a bulk change of an application or an extension, to be taken as one edit; the
 *   library does not write it
 * - `remote`: a change made outside the instance and written to the Store directly
 * - `import`: data an application or an extension loads by its own means
 *
 * Any other string can be used by an application or an extension for the changes it writes, such
 * as the values it writes back.
 */
export type UpdateSource =
  | 'local'
  | 'silent'
  | 'load'
  | 'batch'
  | 'remote'
  | 'import'
  | (string & Record<never, never>);
