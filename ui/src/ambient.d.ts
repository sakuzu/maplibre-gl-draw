// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The modules tsc does not read. The type of a component for tsc, which does not read .svelte files (svelte-check reads them
// with their own types). The declarations of the package do not refer to any component.
declare module '*.svelte' {
  import type { Component } from 'svelte';

  const component: Component<Record<string, unknown>>;
  export default component;
}

// The style sheets main.ts imports, which the build gathers into dist/style.css
declare module '*.css';
