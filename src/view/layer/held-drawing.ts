// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How a write over several tasks is drawn while it is written (a commit too long for one task, an
 * undo of many rows): the two ways are compared on the real thing before one is kept, so this is
 * not an option of the instance
 *
 * - `written` (the default): the rows as they are written, a part at a time; the write is seen
 *   going over a few frames
 * - `kept`: what was drawn before the write, until its last step is written; then every row at
 *   once. The drawing takes nothing in meanwhile (no row written, no part of the delta, no next
 *   version of a row group, no chunk built): a chunk not built yet (a place the map is moved to)
 *   is drawn once the write ends
 *
 * @internal
 */
export const heldDrawing: { mode: 'written' | 'kept' } = { mode: 'written' };
