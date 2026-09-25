// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Sample plugin
 *
 * A minimal example of plugin development.
 * Logs creation, update and deletion of features to the console.
 */

import type { Plugin, PluginContext } from '@sakuzu/maplibre-gl-draw';

/**
 * Create the logger plugin
 */
export function createLoggerPlugin(): Plugin {
  let context: PluginContext | null = null;
  const handlers = {
    create: (data: { feature: { id: string; type: string } }) => {
      console.log('[Logger] Feature created:', data.feature.id, data.feature.type);
    },
    update: (data: { feature: { id: string } }) => {
      console.log('[Logger] Feature updated:', data.feature.id);
    },
    delete: (data: { feature: { id: string } }) => {
      console.log('[Logger] Feature deleted:', data.feature.id);
    },
    selection: (data: { type: string | null; ids: string[] }) => {
      console.log('[Logger] Selection changed:', data.type, data.ids);
    },
  };

  return {
    name: 'sample-logger',

    onInstall(ctx: PluginContext) {
      context = ctx;

      // Subscribe to the feature creation event
      context.on('feature.create', handlers.create);

      // Subscribe to the feature update event
      context.on('feature.update', handlers.update);

      // Subscribe to the feature deletion event
      context.on('feature.delete', handlers.delete);

      // Subscribe to the selection change event
      context.on('selection.change', handlers.selection);

      console.log('[Logger] Plugin installed');
    },

    onUninstall() {
      if (context) {
        // Unsubscribe from everything
        context.off('feature.create', handlers.create);
        context.off('feature.update', handlers.update);
        context.off('feature.delete', handlers.delete);
        context.off('selection.change', handlers.selection);
        context = null;
      }

      console.log('[Logger] Plugin uninstalled');
    },
  };
}

export default createLoggerPlugin;
