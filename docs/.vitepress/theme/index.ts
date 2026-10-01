// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The theme of the documentation site: VitePress's default theme, with the frame that shows a
 * live example on the pages of the examples
 */

import type { Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import { ExampleFrame } from './example-frame.ts';
import './example-frame.css';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('ExampleFrame', ExampleFrame);
  },
} satisfies Theme;
