// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Sample plugin
 *
 * A minimal example of plugin development.
 * Logs creation, update and deletion of features to the console.
 */

import type { Plugin } from '@sakuzu/maplibre-gl-draw';

/**
 * Create the logger plugin
 */
export function createLoggerPlugin(): Plugin {
  return {
    name: 'sample-logger',

    onAdd(ctx) {
      // What the plugin subscribes to through its context ends by itself when it is removed
      ctx.on('feature.created', ({ feature }) => {
        console.log('[Logger] Feature created:', feature.id, feature.type);
      });
      ctx.on('feature.updated', ({ feature }) => {
        console.log('[Logger] Feature updated:', feature.id);
      });
      ctx.on('feature.deleted', ({ feature }) => {
        console.log('[Logger] Feature deleted:', feature.id);
      });
      ctx.on('selection.changed', ({ selection }) => {
        console.log('[Logger] Selection changed:', selection.type, selection.ids);
      });

      console.log('[Logger] Plugin added');
    },

    onRemove() {
      console.log('[Logger] Plugin removed');
    },
  };
}

export default createLoggerPlugin;
