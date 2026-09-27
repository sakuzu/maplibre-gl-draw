// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Placeholders for the table types, which the table contract declares
 *
 * Until then, the datasets import these empty stand-ins so that their signatures can name
 * them.
 */

// biome-ignore-all lint/suspicious/noEmptyInterface: stand-ins until the table contract declares them

// TODO(api-2): declared in the table contract
/** A table of rows laid out by column. */
export interface Table {}

// TODO(api-2): declared in the table contract
/** A table with its ranges and index computed ahead of time. */
export interface PreparedTable {}
