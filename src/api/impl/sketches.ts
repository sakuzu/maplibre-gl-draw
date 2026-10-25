// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.sketches`: the edits drawn over the document before they are written
 */

import type { SketchController } from '../../sketches/sketch-controller.js';
import type { SketchesCollection } from '../sketches.js';
import { invalidInput, requireId } from './shared.js';

/**
 * Creates `draw.sketches` over the sketches of the engine
 *
 * @internal
 */
export function createSketches(sketches: SketchController): SketchesCollection {
  return {
    get: (id) => sketches.get(id),
    list: () => sketches.list(),
    count: () => sketches.count(),
    has: (id) => sketches.has(id),
    add: (input) => sketches.add(input),
    addMany: (inputs) => sketches.addMany(inputs),
    update(id, patch) {
      return sketches.update(requireId(id), patch);
    },
    updateMany: (patches) => sketches.updateMany(patches),
    remove(id) {
      return sketches.remove(requireId(id));
    },
    removeMany(ids) {
      if (!Array.isArray(ids)) throw invalidInput('The IDs must be an array');
      return sketches.removeMany(ids);
    },
    commit(id) {
      return sketches.commit(requireId(id));
    },
    commitMany(ids) {
      if (!Array.isArray(ids)) throw invalidInput('The IDs must be an array');
      return sketches.commitMany(ids);
    },
  };
}
