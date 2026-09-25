// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// Worker setup for maplibre-gl v6. v6 ships the worker as a separate file
// (dist/maplibre-gl-worker.mjs) and by default resolves it relative to the
// import.meta.url of the main module. That resolution does not hold up through
// Vite (the pre-bundled .vite/deps/ has no worker, so it 404s), and when the
// worker cannot start, tile fetching and parsing silently stop altogether and
// only the basemap is drawn. Following the Vite recommendation in the v6
// migration guide, ?worker&url gives a URL that bundles the worker together
// with its dependency (maplibre-gl-shared.mjs), and we set it explicitly. Each
// entry point imports this module for its side effect, so it is configured
// exactly once before the Map is created.
import { setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

setWorkerUrl(workerUrl);
