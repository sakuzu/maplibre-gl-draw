// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The entry of the build: the style sheets, which the build gathers into dist/style.css (kata's
// tokens first, so that the rules of the components come after them), then the API. The
// declarations are made from index.ts, which imports no style sheet.

import '@sakuzu/kata/tokens.css';
import './styles/root.css';

export * from './index.js';
