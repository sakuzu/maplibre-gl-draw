// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.metadata`: the title, the description and the keys of the extensions of the document
 *
 * Each key is written on its own: the keys the patch does not give keep what they have, and a key
 * given as `undefined` is taken off. A key with a prefix (`<prefix>:<name>`) belongs to an
 * application or an extension and holds a value JSON holds; a key without a prefix the library
 * does not know is kept as it is.
 */

import { jsonProblem } from '../../store/built-in/validate.js';
import type { MetadataResource } from '../metadata.js';
import type { ResourceDeps } from './shared.js';
import { invalidInput, optionalString, requireRecord } from './shared.js';

/** Whether a key of the metadata is one of an application or an extension: `<prefix>:<name>` */
function isPrefixed(key: string): boolean {
  const at = key.indexOf(':');
  return at > 0 && at < key.length - 1;
}

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
      const record = patch as Record<string, unknown>;
      optionalString(record, 'title');
      optionalString(record, 'description');
      for (const key of Object.keys(record)) {
        const value = record[key];
        if (value === undefined || !isPrefixed(key)) continue;
        const problem = jsonProblem(value, []);
        if (problem !== null) {
          throw invalidInput(
            `The key ${JSON.stringify(key)} holds a value JSON does not hold: ${problem}`,
          );
        }
      }
      if (!store.setMetadata(patch)) return null;
      return store.getMetadata();
    },
  };
}
