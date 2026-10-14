// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The buffers of a table or of blocks of rows, for `postMessage` with transfer
 *
 * A pure module, so it runs in a Worker as well.
 */

import { transferList as tableTransferList } from './prepare.js';
import { blockTransferList } from './row-group-builder.js';
import type { RowBlock, RowBlockData } from './row-group-types.js';
import type { PreparedTable, Table } from './types.js';

/**
 * Every buffer of a table or of blocks of rows, for `postMessage` with transfer (each one once,
 * a `SharedArrayBuffer` left out): a table, the result of `prepareTable`, or the blocks a builder
 * or a merge made. After the transfer the arrays are empty on the sending side.
 *
 * @param value The table, or the blocks
 * @returns The buffers to pass as the transfer list
 *
 * @example
 * ```ts
 * const blocks = builder.finish();
 * self.postMessage(blocks, { transfer: transferList(blocks) });
 * ```
 */
export function transferList(value: Table | PreparedTable | readonly RowBlock[]): ArrayBuffer[] {
  return Array.isArray(value)
    ? blockTransferList(value as readonly RowBlockData[])
    : tableTransferList(value as Table | PreparedTable);
}
