// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The worker of maplibre-gl v6 is a file of its own, which Vite does not find from the
// pre-bundled module. ?worker&url gives its URL, set once before the first map is created (the
// same setup as the examples of core).
import { setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

setWorkerUrl(workerUrl);
