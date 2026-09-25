// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Utility for merging state changes
 *
 * Provides a function that merges StateChanges objects cumulatively
 */

import type { StateChanges } from './types.js';

/**
 * Merges new changes into the existing pendingChanges
 *
 * Because multiple changes occur during a transaction,
 * they need to be gathered into a single StateChanges object.
 *
 * @internal
 */
export function mergeChanges(pendingChanges: StateChanges, changes: StateChanges): StateChanges {
  const result = { ...pendingChanges };

  // features
  if (changes.features) {
    if (!result.features) {
      result.features = {};
    }
    if (changes.features.created) {
      result.features.created = [...(result.features.created || []), ...changes.features.created];
    }
    if (changes.features.updated) {
      result.features.updated = [...(result.features.updated || []), ...changes.features.updated];
    }
    if (changes.features.deleted) {
      result.features.deleted = [...(result.features.deleted || []), ...changes.features.deleted];
    }
  }

  // layers
  if (changes.layers) {
    if (!result.layers) {
      result.layers = {};
    }
    if (changes.layers.created) {
      result.layers.created = [...(result.layers.created || []), ...changes.layers.created];
    }
    if (changes.layers.updated) {
      result.layers.updated = [...(result.layers.updated || []), ...changes.layers.updated];
    }
    if (changes.layers.deleted) {
      result.layers.deleted = [...(result.layers.deleted || []), ...changes.layers.deleted];
    }
    if (changes.layers.orderChanged) {
      result.layers.orderChanged = changes.layers.orderChanged;
    }
  }

  // groups
  if (changes.groups) {
    if (!result.groups) {
      result.groups = {};
    }
    if (changes.groups.created) {
      result.groups.created = [...(result.groups.created || []), ...changes.groups.created];
    }
    if (changes.groups.updated) {
      result.groups.updated = [...(result.groups.updated || []), ...changes.groups.updated];
    }
    if (changes.groups.deleted) {
      result.groups.deleted = [...(result.groups.deleted || []), ...changes.groups.deleted];
    }
  }

  // layerReorder (dedicated to reordering within a layer)
  if (changes.layerReorder) {
    result.layerReorder = changes.layerReorder;
  }

  // groupReorder (dedicated to reordering within a group)
  if (changes.groupReorder) {
    result.groupReorder = changes.groupReorder;
  }

  // selection
  if (changes.selection) {
    result.selection = changes.selection;
  }

  // editing
  if (changes.editing) {
    if (!result.editing) {
      result.editing = {};
    }
    if (changes.editing.started) {
      result.editing.started = [...(result.editing.started || []), ...changes.editing.started];
    }
    if (changes.editing.ended) {
      result.editing.ended = [...(result.editing.ended || []), ...changes.editing.ended];
    }
  }

  // tentative
  if (changes.tentative) {
    result.tentative = changes.tentative;
  }

  // mode
  if (changes.mode) {
    result.mode = changes.mode;
  }

  // uiStateChanged
  if (changes.uiStateChanged) {
    result.uiStateChanged = true;
  }

  // metadata
  if (changes.metadata) {
    result.metadata = changes.metadata;
  }

  return result;
}
