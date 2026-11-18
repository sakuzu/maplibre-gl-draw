// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Worker of the editing benchmark that builds pages of rows for a Store
 * (`edit-scenes.ts`, the scene `storePages`)
 *
 * It builds the points of the grid of the page into pages and posts them without a copy, and it
 * runs the work a Store hands to its Worker (`StoreOptions.worker`): the merges of pages and the
 * builds of many new rows. Every answer names the request it answers, and posts the buffers of its
 * pages with transfer.
 *
 * An application writes its own: this one only shows the calls (`createRowPageBuilder`,
 * `getRowPageTransferList`, `mergeRowPages`).
 */

import {
  createRowPageBuilder,
  getRowPageTransferList,
  mergeRowPages,
  type RowInput,
  type RowPage,
  type RowPageBuilderOptions,
  type RowPageMergeTask,
} from '@sakuzu/maplibre-gl-draw/store';
import { gridOf } from './edit-document';

/** What the page asks the Worker for */
export type StorePageAsk =
  /** The points of the grid of `n` features, built into pages */
  | { readonly kind: 'grid'; readonly n: number }
  /** Rows of pages merged (`RowPageWorker.merge`) */
  | { readonly kind: 'merge'; readonly task: RowPageMergeTask }
  /** Rows built into pages (`RowPageWorker.build`) */
  | {
      readonly kind: 'build';
      readonly rows: readonly RowInput[];
      readonly options: RowPageBuilderOptions;
    };

/** A request: what is asked, and its number, which the answer names */
export type StorePageRequest = StorePageAsk & { readonly id: number };

/** What the Worker posts back: the pages, or the message of what it threw */
export type StorePageAnswer =
  | { readonly id: number; readonly pages: RowPage[]; readonly buildMs: number }
  | { readonly id: number; readonly error: string };

/** The points of the grid of `n` features, as rows: those of the scenes of the Store */
function gridPages(n: number): RowPage[] {
  const grid = gridOf(n);
  const cellWidth = (grid.east - grid.west) / grid.columns;
  const cellHeight = (grid.north - grid.south) / grid.rows;
  const builder = createRowPageBuilder();
  for (let cell = 0; cell < n; cell++) {
    builder.addRow({
      id: `row-${cell}`,
      type: 'Point',
      geometry: {
        type: 'Point',
        coordinates: [
          grid.west + ((cell % grid.columns) + 0.5) * cellWidth,
          grid.south + (Math.floor(cell / grid.columns) + 0.5) * cellHeight,
        ],
      },
      orderKey: `k${String(cell).padStart(7, '0')}`,
    });
  }
  return builder.finish();
}

/** The pages a request asks for */
function pagesOf(request: StorePageRequest): RowPage[] {
  if (request.kind === 'grid') return gridPages(request.n);
  if (request.kind === 'merge') return mergeRowPages(request.task);
  const builder = createRowPageBuilder(request.options);
  for (const row of request.rows) builder.addRow(row);
  return builder.finish();
}

self.onmessage = (event: MessageEvent<StorePageRequest>) => {
  const request = event.data;
  try {
    const t0 = performance.now();
    const pages = pagesOf(request);
    const answer: StorePageAnswer = { id: request.id, pages, buildMs: performance.now() - t0 };
    self.postMessage(answer, { transfer: getRowPageTransferList(pages) });
  } catch (error) {
    const answer: StorePageAnswer = { id: request.id, error: String(error) };
    self.postMessage(answer);
  }
};
