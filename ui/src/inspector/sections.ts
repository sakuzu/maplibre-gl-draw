// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The options of the inspector, and the sections an application adds to it.

import type { Feature } from '@sakuzu/maplibre-gl-draw';
import type { Box } from '../store.js';
import type {
  InspectorOptions,
  InspectorSectionSpec,
  InspectorSectionsHandle,
  InspectorSettings,
  InspectorTab,
  Units,
} from './types.js';

const TABS: readonly InspectorTab[] = ['style', 'attributes'];

/**
 * The options of the inspector with their defaults
 *
 * @param units - The units when the options name none (those of `createDrawUI`)
 * @throws Error when a tab is not `style` or `attributes`
 */
export function inspectorSettings(
  options: InspectorOptions = {},
  units: Units = 'metric',
): InspectorSettings {
  const tabs = options.tabs ?? [...TABS];
  for (const tab of tabs) {
    if (!TABS.includes(tab)) throw new Error(`There is no inspector tab "${tab}"`);
  }
  return {
    tabs: [...new Set(tabs)],
    measurements: options.measurements !== false,
    operations: options.operations !== false,
    units: options.units ?? units,
  };
}

/**
 * Checks a section of the application
 *
 * @throws Error when the ID or the title is missing, or `appliesTo` is not a function
 */
export function checkSection(spec: InspectorSectionSpec): void {
  for (const key of ['id', 'title'] as const) {
    if (typeof spec?.[key] !== 'string' || spec[key] === '') {
      throw new Error(`An inspector section needs a ${key} (a string that is not empty)`);
    }
  }
  if (typeof spec.appliesTo !== 'function') {
    throw new Error(`The inspector section "${spec.id}" needs appliesTo (a function)`);
  }
}

/** The sections that apply to features; a section whose appliesTo throws does not */
export function applicableSections(
  sections: readonly InspectorSectionSpec[],
  features: readonly Feature[],
): InspectorSectionSpec[] {
  return sections.filter((spec) => {
    try {
      return spec.appliesTo(features);
    } catch {
      return false;
    }
  });
}

/** The sections of an inspector, to add to and to remove from */
export function sectionsHandle(sections: Box<InspectorSectionSpec[]>): InspectorSectionsHandle {
  const remove = (id: string): boolean => {
    const now = sections.get();
    const next = now.filter((spec) => spec.id !== id);
    if (next.length === now.length) return false;
    sections.set(next);
    return true;
  };
  return {
    add(spec) {
      checkSection(spec);
      if (sections.get().some((s) => s.id === spec.id)) {
        throw new Error(`There is an inspector section with the ID "${spec.id}" already`);
      }
      const own = { ...spec };
      sections.set([...sections.get(), own]);
      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        const now = sections.get();
        if (now.includes(own)) sections.set(now.filter((s) => s !== own));
      };
    },
    remove,
    list() {
      return sections.get().map((spec) => ({ ...spec }));
    },
  };
}
