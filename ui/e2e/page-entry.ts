// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The script of the test page: core from its build (the root dist, as an application gets it
// from npm), the interface from its sources with its style sheet, and maplibre-gl from the import
// map of the page. The harness creates the map and the interface through `window.e2e`.

import { createDraw } from '@sakuzu/maplibre-gl-draw';
import * as maplibregl from 'maplibre-gl';
import { createDrawUI } from '../src/main.ts';

Object.assign(window, { e2e: { maplibregl, createDraw, createDrawUI } });
