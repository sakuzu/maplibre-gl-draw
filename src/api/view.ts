// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.view`: what this client shows in place of the document
 */

import type { OpenSource, TaskOptions } from './write.js';

/** What this client shows of the document */
export interface View {
  /**
   * Shows another document read-only in place of the document, for this client only, until
   * `null` is given: a past version of the document to look at, say, or edits that were turned
   * down. The source is read as `draw.open` reads it (a document of the library, GeoJSON, a JSON
   * string or a file), into a Store of its own; the document does not change.
   *
   * While it is shown, the instance is read-only (`isReadOnly()` is true), the pointer and the
   * keys move the map only, and the changes the document takes from elsewhere are still taken,
   * drawn once the document is shown again (`draw.document.setShown`). A source given while
   * another is read replaces it: the one read before is not shown.
   *
   * @throws `DrawError` (the promise rejects) with the code `unsupportedFormat` when the source
   *   cannot be read, `invalidInput` when it is not valid, or `aborted` when the signal stopped it
   */
  preview(source: OpenSource | null, options?: TaskOptions): Promise<void>;
}
