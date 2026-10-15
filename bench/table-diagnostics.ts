// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The hooks of measurement of the drawing of the rows, read from the module of the library that
 * holds them, as its own tests read them
 *
 * They are not part of the API of the library: the declarations the pages are checked against
 * (those of its build) leave them out, so the shapes the pages read are declared here.
 */

import type { Draw } from '@sakuzu/maplibre-gl-draw';
import * as hooks from '../src/api/impl/table-diagnostics';

/** What the writes of rows in place hold and did since the instance was made */
export type TableEditStats = Readonly<
  Record<
    | 'styles'
    | 'resolvedStyles'
    | 'overrideBytes'
    | 'groupsDue'
    | 'movedRows'
    | 'uploadedBytes'
    | 'inPlace'
    | 'coordsOnly'
    | 'styleOnly'
    | 'rebuilt'
    | 'restarted'
    | 'reclassified'
    | 'deltaRows'
    | 'cuts'
    | 'versionsSwapped'
    | 'versionsPending'
    | 'versionsMostPending'
    | 'lastMergeMs'
    | 'prerenderMs'
    | 'drawMs',
    number
  >
>;

/**
 * One range of rows drawn in one draw, as the record of the draws gives it: drawn in one draw
 * with rows of every kind (`rows`), from a retained batch of its kind, or at once
 */
export interface TableDrawnRange {
  readonly layerId: string;
  readonly kind: 'rows' | 'polygon' | 'line' | 'point' | 'immediate';
  /** Whether the rows are rows of the delta of the layer */
  readonly delta?: boolean;
}

/** The hooks the pages use */
export interface TableDiagnostics {
  /** Cuts the ranges drawn of every layer held as rows at `count` places (0 for none) */
  setArtificialCuts(count: number): void;
  /**
   * Records the ranges drawn from the next frame on, in the order they are drawn, into the array
   * it returns, until `stopRecording`
   */
  recordDraws(): readonly TableDrawnRange[];
  /** Stops the recording of the ranges drawn */
  stopRecording(): void;
  /** Draws the layers held as rows with one renderer per kind of geometry (true) */
  setDrawingByKind(byKind: boolean): void;
  /** What the writes of rows in place hold and did */
  editStats(): TableEditStats;
  /** Sets the time the next versions of row groups may take to build while the camera moves */
  setVersionBudgetWhileMoving(ms: number): void;
  /** The bytes the GPU holds per renderer */
  gpuBytesByRenderer(): Readonly<Record<string, number>>;
}

/** The hooks of measurement of a draw instance */
export const tableDiagnosticsOf = (
  hooks as unknown as { tableDiagnosticsOf(draw: Draw): TableDiagnostics }
).tableDiagnosticsOf;
