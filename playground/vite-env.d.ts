// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `'1'` in the GitHub Pages build (scripts/build-site.mjs) */
  readonly VITE_SITE?: string;
}
