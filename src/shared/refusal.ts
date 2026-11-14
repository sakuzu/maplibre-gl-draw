// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A commit a storage refused, as data (re-exported by the main entry, `api/status.ts`): types
 * only, so that the one shape of a failure (`draw-error.ts`) carries it
 */

/**
 * Why a storage refused a commit. An open union: a storage may give reasons of its own.
 *
 * - `dependsOnRefused`: the commit wrote what a commit refused before it made
 * - `retryLimit`: sent as many times as `Backend.retry` allows, without reaching the storage
 * - `outboxExpired`, `outboxFull`: the place of the device that keeps the commits not sent ran out
 *   of time or of room
 */
export type RefuseReason =
  | 'readOnly'
  | 'invalid'
  | 'rules'
  | 'limit'
  | 'documentDeleted'
  | 'dependsOnRefused'
  | 'retryLimit'
  | 'outboxExpired'
  | 'outboxFull'
  | (string & {});

/**
 * A commit the storage refused: data only, what to do with it is in `draw.backend.refusals`.
 *
 * A commit refused is taken out of the document here, and the commits after it that wrote what it
 * made are refused with it (`dependsOnRefused`). The record stays until it is dismissed.
 */
export interface Refusal {
  /** The ID of the record */
  readonly id: string;
  /** The ID of the commit refused (`Write.id`) */
  readonly commit: string;
  /** The first 1,000 IDs of the features, layers and groups the commit wrote */
  readonly ids: readonly string[];
  /** How many features, layers and groups the commit wrote */
  readonly count: number;
  /** The `label` of the write (`WriteOptions.label`) */
  readonly label: string | undefined;
  readonly reason: RefuseReason;
  /** What the storage said, when it said something */
  readonly message: string | undefined;
  /** Whether sending the same again has a chance to be taken */
  readonly retryable: boolean;
  /** When the commit was made, in milliseconds since the epoch */
  readonly writtenAtMilliseconds: number;
  /** When it was refused, in milliseconds since the epoch */
  readonly refusedAtMilliseconds: number;
}
