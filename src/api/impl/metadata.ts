// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.metadata`: the title and the description of the document
 */

import type { MetadataResource } from '../metadata.js';
import type { ResourceDeps } from './shared.js';
import { optionalString, requireRecord } from './shared.js';

/**
 * Creates `draw.metadata`
 *
 * @internal
 */
export function createMetadata(deps: Pick<ResourceDeps, 'store'>): MetadataResource {
  const { store } = deps;
  return {
    get: () => store.getMetadata(),
    update(patch) {
      requireRecord(patch, 'The patch');
      optionalString(patch as Record<string, unknown>, 'title');
      optionalString(patch as Record<string, unknown>, 'description');
      if (!store.setMetadata(patch)) return null;
      return store.getMetadata();
    },
  };
}
