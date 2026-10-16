// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The buffers of a table or of row blocks, for `postMessage` with transfer
 *
 * A pure module, so it runs in a Worker as well.
 */

import { transferList as tableTransferList } from './prepare.js';
import { blockTransferList } from './row-group-builder.js';
import type { RowBlock, RowBlockData } from './row-group-types.js';
import type { PreparedTable, Table } from './types.js';

/**
 * Every buffer of a table or of row blocks, for `postMessage` with transfer (each one once,
 * a `SharedArrayBuffer` left out): a table, the result of `prepareTable`, or the row blocks a builder
 * or a merge made. After the transfer the arrays are empty on the sending side.
 *
 * @param value The table, or the row blocks
 * @returns The buffers to pass as the transfer list
 *
 * @example
 * ```ts
 * const rowBlocks = builder.finish();
 * self.postMessage(rowBlocks, { transfer: transferList(rowBlocks) });
 * ```
 */
export function transferList(value: Table | PreparedTable | readonly RowBlock[]): ArrayBuffer[] {
  return Array.isArray(value)
    ? blockTransferList(value as readonly RowBlockData[])
    : tableTransferList(value as Table | PreparedTable);
}
