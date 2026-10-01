// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The theme of the documentation site: VitePress's default theme, with the frame that shows a
 * live example on the pages of the examples and the gallery of the examples
 */

import { inBrowser, type Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import { redirectToDevServer } from './dev-servers.ts';
import { ExampleFrame } from './example-frame.ts';
import { ExampleGallery } from './example-gallery.ts';
import './example-frame.css';
import './example-gallery.css';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('ExampleFrame', ExampleFrame);
    app.component('ExampleGallery', ExampleGallery);
    if (inBrowser) redirectToDevServer();
  },
} satisfies Theme;
