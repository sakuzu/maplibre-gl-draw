// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Generation of the export file name
 */

import type { Metadata } from '../../store/types.js';

/**
 * Replaces characters that cannot be used in a file name with underscores
 */
function sanitize(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '_');
}

/**
 * Builds the export file name
 *
 * Format: `{title}_{YYYY-MM-DD}_{HHMMSS}{suffix}`
 */
export function buildExportFileName(metadata: Metadata, suffix: string): string {
  const title = sanitize(metadata.title || 'drawing');
  const date = new Date();
  const dateStr = date.toISOString().slice(0, 10);
  const timeStr = date.toTimeString().slice(0, 8).replace(/:/g, '');
  return `${title}_${dateStr}_${timeStr}${suffix}`;
}
