// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The gate of the scenes whose work is bounded: every scene of `WORK_SCENES` (src/test-utils.ts)
// has a test, or waits for one in scripts/gates/work-scenes-pending.json with the work that adds
// it. A test of a scene is a `describe`, `it` or `test` of a test file of src/ named by the scene
// (`describe(WORK_SCENES.select, ...)`, or the text of its name), with at least one test in it.
//
// The gate fails on a scene with neither a test nor a row, on a row whose scene has a test now
// (the work that adds the test removes the row, so the list only gets shorter), on a row of a
// scene that is not in `WORK_SCENES`, and on a test of a scene that is left out or let fail
// (`skip`, `todo`, `fails`, `skipIf`, `runIf`, `xit`, the same as options, or a `skip()` from the
// test context).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readList, result, walk } from './lib/files.mjs';
import { loadTypeScript } from './lib/ts.mjs';

export const name = 'work-scenes';

const TOOLS = 'src/test-utils.ts';
const SUITES = new Set(['describe', 'suite']);
const TESTS = new Set(['it', 'test']);
const LEFT_OUT = new Set(['skip', 'todo', 'fails', 'skipIf', 'runIf']);

/**
 * The scenes of `WORK_SCENES`: the key and the name of each
 *
 * @returns {Map<string, string> | null} Null when the object is not found
 */
export function scenesOf(root) {
  const file = join(root, TOOLS);
  if (!existsSync(file)) return null;
  const ts = loadTypeScript();
  const sf = ts.createSourceFile(TOOLS, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || d.name.text !== 'WORK_SCENES') continue;
      let init = d.initializer;
      while (init && (ts.isAsExpression(init) || ts.isSatisfiesExpression?.(init))) {
        init = init.expression;
      }
      if (!init || !ts.isObjectLiteralExpression(init)) return null;
      const out = new Map();
      for (const p of init.properties) {
        if (
          ts.isPropertyAssignment(p) &&
          (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
          ts.isStringLiteralLike(p.initializer)
        ) {
          out.set(p.name.text, p.initializer.text);
        }
      }
      return out;
    }
  }
  return null;
}

/**
 * The parts of the callee of a test call: `describe.skip` gives `describe`, `skip`, and
 * `it.skipIf(x)` gives `it`, `skipIf`
 */
function calleeParts(ts, expr) {
  const parts = [];
  let e = expr;
  for (;;) {
    if (ts.isCallExpression(e)) e = e.expression;
    else if (ts.isPropertyAccessExpression(e)) {
      parts.unshift(e.name.text);
      e = e.expression;
    } else if (ts.isIdentifier(e)) {
      parts.unshift(e.text);
      return parts;
    } else return null;
  }
}

/** Whether a call leaves its test out: a mark on the callee, or an option */
function leftOut(ts, call, parts) {
  if (parts[0].startsWith('x') && TESTS.has(parts[0].slice(1))) return true;
  if (parts.slice(1).some((p) => LEFT_OUT.has(p))) return true;
  return call.arguments.some(
    (a) =>
      ts.isObjectLiteralExpression(a) &&
      a.properties.some(
        (p) =>
          ts.isPropertyAssignment(p) &&
          ts.isIdentifier(p.name) &&
          LEFT_OUT.has(p.name.text) &&
          p.initializer.kind !== ts.SyntaxKind.FalseKeyword,
      ),
  );
}

/**
 * The tests of the scenes in the test files of src/
 *
 * @param {Map<string, string>} scenes
 * @returns {Map<string, { tests: number, leftOut: string[] }>} By the key of the scene
 */
export function sceneTests(root, scenes) {
  const ts = loadTypeScript();
  const byName = new Map([...scenes].map(([k, v]) => [v, k]));
  const out = new Map([...scenes.keys()].map((k) => [k, { tests: 0, leftOut: [] }]));
  const sceneOf = (arg) => {
    if (!arg) return null;
    if (
      ts.isPropertyAccessExpression(arg) &&
      ts.isIdentifier(arg.expression) &&
      arg.expression.text === 'WORK_SCENES'
    ) {
      return scenes.has(arg.name.text) ? arg.name.text : null;
    }
    if (ts.isStringLiteralLike(arg)) return byName.get(arg.text) ?? null;
    return null;
  };
  for (const file of walk(root, 'src', (f) => /\.test\.ts$/.test(f))) {
    const text = readFileSync(join(root, file), 'utf8');
    if (!/WORK_SCENES/.test(text) && ![...byName.keys()].some((n) => text.includes(n))) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const where = (n) => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
    /** @param {string | null} scene The scene of the suite the node is in */
    const visit = (n, scene) => {
      if (ts.isCallExpression(n)) {
        const parts = calleeParts(ts, n.expression);
        const kind = parts?.[0].replace(/^x/, '');
        if (parts && (SUITES.has(kind) || TESTS.has(kind))) {
          const own = sceneOf(n.arguments[0]) ?? scene;
          if (own !== null) {
            const entry = out.get(own);
            if (leftOut(ts, n, parts)) entry.leftOut.push(where(n));
            else if (TESTS.has(kind)) entry.tests += 1;
          }
          for (const a of n.arguments) visit(a, own);
          return;
        }
        // A test that leaves itself out from its context
        if (
          scene !== null &&
          parts &&
          parts.length === 2 &&
          parts[1] === 'skip' &&
          ['ctx', 'context', 't', 'task'].includes(parts[0])
        ) {
          out.get(scene).leftOut.push(where(n));
        }
      }
      ts.forEachChild(n, (c) => visit(c, scene));
    };
    visit(sf, null);
  }
  return out;
}

/** @param {{ root: string }} ctx */
export function check(ctx) {
  const { root } = ctx;
  const out = result(name);
  const scenes = scenesOf(root);
  if (scenes === null) {
    out.errors.push(`${TOOLS} has no WORK_SCENES of the names of the scenes`);
    return out;
  }
  const pending = readList(root, 'work-scenes-pending.json').scenes ?? {};
  const tests = sceneTests(root, scenes);
  for (const [key, scene] of scenes) {
    const t = tests.get(key);
    for (const w of t.leftOut) {
      out.errors.push(`${w}: a test of the scene "${scene}" is left out or let fail`);
    }
    const row = pending[key];
    if (t.tests > 0 && row !== undefined) {
      out.errors.push(
        `the scene "${scene}" has a test now; remove ${key} from scripts/gates/work-scenes-pending.json`,
      );
    } else if (t.tests === 0 && row === undefined) {
      out.errors.push(
        `the scene "${scene}" has no test, and scripts/gates/work-scenes-pending.json does not list ${key}`,
      );
    }
  }
  for (const [key, row] of Object.entries(pending)) {
    if (!scenes.has(key)) {
      out.errors.push(`work-scenes-pending.json lists ${key}, which is not a scene of WORK_SCENES`);
    }
    if (typeof row !== 'string' || !row.trim()) {
      out.errors.push(`work-scenes-pending.json: ${key} without the work that adds its test`);
    }
  }
  if (out.errors.length === 0) {
    const waiting = Object.keys(pending).length;
    out.notes.push(`${scenes.size - waiting} scenes have tests, ${waiting} wait`);
  }
  return out;
}
