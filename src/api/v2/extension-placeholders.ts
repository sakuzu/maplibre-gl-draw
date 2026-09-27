// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Placeholders for the types that the resources refer to but that other contracts declare
 *
 * The extension types, the Store types and the table types are declared by their own
 * contracts. Until then, the resources import these empty stand-ins so that their signatures
 * can name them.
 */

// biome-ignore-all lint/suspicious/noEmptyInterface: stand-ins until their contracts declare them

// TODO(api-2): declared in the extension contract
/** A bundle of extensions and state, added with `draw.extensions.plugins.add`. */
export interface Plugin {}

// TODO(api-2): declared in the extension contract
/** A function that creates the handler of a mode. */
export interface ModeFactory {}

// TODO(api-2): declared in the extension contract
/** The definition of a custom feature type. */
export interface FeatureTypeDefinition {}

// TODO(api-2): declared in the extension contract
/** A renderer that draws above the features, or between the layers. */
export interface OverlayRenderer {}

// TODO(api-2): declared in the extension contract
/** An extension that adds snapping candidates. */
export interface SnapProvider {}

// TODO(api-2): declared in the extension contract
/** An extension that adds handles to the selected features. */
export interface HandleProvider {}

// TODO(api-2): declared in the extension contract
/** An extension that draws a companion one step below a feature. */
export interface CompanionProvider {}

// TODO(api-2): declared in the extension contract
/** The place the document is kept, with writes. */
export interface Store {}

// TODO(api-2): declared in the extension contract
/** The read and subscribe side of the Store. */
export interface StoreView {}

// TODO(api-2): declared in the extension contract
/** The changes of one transaction, as the Store delivers them. */
export interface StateChanges {}

// TODO(api-2): declared in the extension contract
/** Where a write came from. */
export type UpdateSource = string;

// TODO(api-2): declared in the table contract
/** A table of rows laid out by column. */
export interface Table {}

// TODO(api-2): declared in the table contract
/** A table with its ranges and index computed ahead of time. */
export interface PreparedTable {}
