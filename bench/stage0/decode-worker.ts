// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A Worker of the page of opening in steps: it decodes a file of segments into blocks of rows
 * (`decode-work.ts`) and sends them back without a copy
 */

import { transferList } from '@sakuzu/maplibre-gl-draw/kasane';
import { type DecodedFile, decodeFile } from './decode-work.ts';

/** What the page asks for: the bytes of a file */
export interface DecodeRequest {
  readonly id: number;
  readonly bytes: ArrayBuffer;
}

/** What the Worker sends back */
export type DecodeReply =
  | ({ readonly id: number; readonly ok: true; readonly ms: number } & DecodedFile)
  | { readonly id: number; readonly ok: false; readonly error: string };

self.onmessage = (event: MessageEvent<DecodeRequest>) => {
  const { id, bytes } = event.data;
  const t0 = performance.now();
  try {
    const decoded = decodeFile(new Uint8Array(bytes));
    const reply: DecodeReply = { id, ok: true, ms: performance.now() - t0, ...decoded };
    (self as unknown as Worker).postMessage(reply, transferList(decoded.blocks));
  } catch (error) {
    const reply: DecodeReply = {
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    (self as unknown as Worker).postMessage(reply);
  }
};
