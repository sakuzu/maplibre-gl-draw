// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Plugin System
 *
 * Public API of the plugin system.
 *
 * Only the symbols that src/index.ts publishes are listed here (see "The public
 * surface" in CONTRIBUTING.md). Internal code imports from the defining file.
 */

export type {
  DragEndData,
  DragStartData,
  Hooks,
  HoverEvent,
  MouseLeaveEvent,
  MutationContext,
  Plugin,
  PluginContext,
} from './plugin.js';
export type { HookName, PluginManager } from './plugin-manager.js';
