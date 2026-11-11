// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The buffers of row blocks, for `postMessage` with transfer
 *
 * A pure module, so it runs in a Worker as well.
 */

import { blockTransferList } from './row-group-builder.js';
import type { RowBlock, RowBlockData } from './row-group-types.js';

/**
 * Every buffer of row blocks a builder or a merge made, for `postMessage` with transfer (each one
 * once, a `SharedArrayBuffer` left out). After the transfer the arrays are empty on the sending
 * side.
 *
 * @param blocks The row blocks
 * @returns The buffers to pass as the transfer list
 *
 * @example
 * ```ts
 * const rowBlocks = builder.finish();
 * self.postMessage(rowBlocks, { transfer: transferList(rowBlocks) });
 * ```
 */
export function transferList(blocks: readonly RowBlock[]): ArrayBuffer[] {
  return blockTransferList(blocks as readonly RowBlockData[]);
}
