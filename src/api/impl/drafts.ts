// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.drafts`: the edits drawn over the document before they are written
 */

import type { DraftController } from '../../drafts/draft-controller.js';
import type { DraftsCollection } from '../drafts.js';
import { invalidInput, requireId } from './shared.js';

/**
 * Creates `draw.drafts` over the drafts of the engine
 *
 * @internal
 */
export function createDrafts(drafts: DraftController): DraftsCollection {
  return {
    get: (id) => drafts.get(id),
    list: () => drafts.list(),
    count: () => drafts.count(),
    has: (id) => drafts.has(id),
    add: (input) => drafts.add(input),
    addMany: (inputs) => drafts.addMany(inputs),
    update(id, patch) {
      return drafts.update(requireId(id), patch);
    },
    updateMany: (patches) => drafts.updateMany(patches),
    remove(id) {
      return drafts.remove(requireId(id));
    },
    removeMany(ids) {
      if (!Array.isArray(ids)) throw invalidInput('The IDs must be an array');
      return drafts.removeMany(ids);
    },
    commit(id) {
      return drafts.commit(requireId(id));
    },
    commitMany(ids) {
      if (!Array.isArray(ids)) throw invalidInput('The IDs must be an array');
      return drafts.commitMany(ids);
    },
  };
}
