// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Serves the documentation site for a local check: the pages, the examples and the playground
 *
 * Starts three dev servers with `npm run`, each in a process group of its own:
 *
 * - `npm run dev`: the examples, on port 3200
 * - `npm run dev:playground`: the playground, on port 3300
 * - `npm run site:dev:docs`: the API reference, then VitePress, on port 5173 (`--strictPort`)
 *
 * The pages frame the examples and the playground from their dev servers
 * (docs/.vitepress/theme/dev-servers.ts), so a change to an example, to the library or to a
 * page shows on reload. Once all three answer, it prints the address to open. Ctrl-C (or
 * SIGTERM) stops all three; when one of them stops on its own, the others are stopped too.
 * The dev servers do not open a browser (`BROWSER=none`).
 *
 * The examples and the playground take the standard UI from its build: run `npm run build`
 * and `npm run ui:build` first.
 *
 * Usage: npm run site:dev
 */

import { execFileSync, spawn } from 'node:child_process';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'http://localhost:5173/maplibre-gl-draw/';
const SERVERS = [
  { name: 'examples', script: 'dev', port: 3200, url: 'http://localhost:3200/get-started/' },
  { name: 'playground', script: 'dev:playground', port: 3300, url: 'http://localhost:3300/' },
  { name: 'site', script: 'site:dev:docs', port: 5173, url: SITE },
];
/** How long the servers may take to answer, VitePress after the API reference */
const READY_TIMEOUT = 180_000;
const windows = process.platform === 'win32';

try {
  execFileSync(process.execPath, [join(root, 'scripts/need-ui.mjs')], { stdio: 'inherit' });
} catch {
  process.exit(1);
}

/** Whether a server already listens on a port of localhost */
function listening(port) {
  return new Promise((resolve) => {
    const socket = connect({ port, host: 'localhost' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

// Each server keeps its port (the pages find the others there), so one that is taken stops here,
// before an answer from another server could be taken for this one's
const taken = [];
for (const { name, port } of SERVERS) {
  if (await listening(port)) taken.push(`${port} (${name})`);
}
if (taken.length > 0) {
  console.error(`site:dev: a server already listens on port ${taken.join(', ')}; stop it first`);
  process.exit(1);
}

let stopping = false;
let exitCode = 0;

/**
 * Prints each line of a stream with the name of its server in front, until the servers are
 * being stopped (npm then reports each script it stops as failed)
 */
function prefix(stream, name, out) {
  let rest = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    const lines = (rest + chunk).split('\n');
    rest = lines.pop() ?? '';
    if (stopping) return;
    for (const line of lines) out.write(`[${name}] ${line}\n`);
  });
  stream.on('end', () => {
    if (rest && !stopping) out.write(`[${name}] ${rest}\n`);
  });
}

const children = SERVERS.map(({ name, script }) => {
  const child = spawn(windows ? 'npm.cmd' : 'npm', ['run', script], {
    cwd: root,
    env: { ...process.env, BROWSER: 'none', FORCE_COLOR: process.env.FORCE_COLOR ?? '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    // A group of its own, so that stopping it stops the server under npm and its shell too
    detached: !windows,
    shell: windows,
  });
  prefix(child.stdout, name, process.stdout);
  prefix(child.stderr, name, process.stderr);
  child.on('close', (code, signal) => {
    child.exited = true;
    if (!stopping) {
      console.error(`[${name}] stopped (${signal ?? `exit code ${code}`}): stopping the others`);
      exitCode = 1;
      stop('SIGTERM');
    }
    if (children.every((c) => c.exited)) process.exit(exitCode);
  });
  return child;
});

/** Sends a signal to every server that still runs */
function stop(signal) {
  stopping = true;
  for (const child of children) {
    if (child.exited) continue;
    try {
      if (windows) child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch {
      // Already gone
    }
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (stopping) return;
    console.log('\nStopping the dev servers');
    stop(signal);
  });
}

/** Resolves once the address answers, or rejects after the timeout */
async function waitFor(url) {
  const until = Date.now() + READY_TIMEOUT;
  while (!stopping) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not listening yet
    }
    if (Date.now() > until) throw new Error(`${url} did not answer`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

try {
  await Promise.all(SERVERS.map(({ url }) => waitFor(url)));
  if (!stopping) {
    console.log(`\n  The site, with the examples and the playground: ${SITE}\n`);
    console.log('  Press Ctrl-C to stop the three servers.\n');
  }
} catch (error) {
  if (!stopping) console.error(String(error));
}
