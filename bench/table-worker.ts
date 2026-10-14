// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A Worker of the opening of the measurement of the layers held as rows (`table-worker-core.ts`
 * does the work; this file only connects it to the Worker)
 */

import {
  createOpenWork,
  type TableWorkerMessage,
  type TableWorkerRequest,
} from './table-worker-core';

const work = createOpenWork((message: TableWorkerMessage, transfer: Transferable[] = []) => {
  (self as unknown as Worker).postMessage(message, transfer);
});

self.onmessage = (event: MessageEvent<TableWorkerRequest>) => {
  void work(event.data);
};
