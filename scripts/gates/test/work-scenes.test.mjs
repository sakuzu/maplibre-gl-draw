// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { check } from '../work-scenes.mjs';
import { cleanUp, tree, write } from './fixture.mjs';

afterEach(cleanUp);

// The marks are written in pieces, so that this file does not count as one that has them
const SKIP = ['describe', 'skip'].join('.');
const TODO = ['it', 'todo'].join('.');
const SKIP_IF = ['describe', 'skipIf'].join('.');

const TOOLS = `export const WORK_SCENES = {
  select: 'select',
  dragFrame: 'one frame of a drag',
  writeBack: 'write back',
} as const;
`;

const SCENES = `import { describe, it } from 'vitest';
import { WORK_SCENES } from '../../test-utils.js';

describe(WORK_SCENES.select, () => {
  it('makes as many features', () => {});
});

describe('one frame of a drag', () => {
  it('notifies as often', () => {});
});
`;

const scenesTree = (extra = {}) =>
  tree({
    'src/test-utils.ts': TOOLS,
    'src/api/impl/work-scenes.test.ts': SCENES,
    'scripts/gates/work-scenes-pending.json': {
      scenes: { writeBack: 'the work that writes the values back' },
    },
    ...extra,
  });

const errors = (root) => check({ root }).errors.join('\n');

describe('the gate of the scenes whose work is bounded', () => {
  it('passes when every scene has a test or waits for one', () => {
    const r = check({ root: scenesTree() });
    expect(r.errors).toEqual([]);
    expect(r.notes.join('\n')).toContain('2 scenes have tests, 1 wait');
  });

  it('fails when the test of a scene is removed', () => {
    const root = scenesTree();
    write(root, {
      'src/api/impl/work-scenes.test.ts': SCENES.replace(/describe\('one frame[\s\S]*$/, ''),
    });
    expect(errors(root)).toContain(
      'the scene "one frame of a drag" has no test, and scripts/gates/work-scenes-pending.json does not list dragFrame',
    );
  });

  it('fails when the file of the scenes is gone', () => {
    const root = scenesTree();
    rmSync(join(root, 'src/api/impl/work-scenes.test.ts'));
    const e = errors(root);
    expect(e).toContain('the scene "select" has no test');
    expect(e).toContain('the scene "one frame of a drag" has no test');
  });

  it('fails when the test of a scene is left out, by a mark or by a condition', () => {
    const root = scenesTree();
    write(root, {
      'src/api/impl/work-scenes.test.ts': SCENES.replace(
        'describe(WORK_SCENES.select,',
        `${SKIP}(WORK_SCENES.select,`,
      ).replace("describe('one frame", `${SKIP_IF}(true)('one frame`),
    });
    const e = errors(root);
    expect(e).toContain('a test of the scene "select" is left out or let fail');
    expect(e).toContain('a test of the scene "one frame of a drag" is left out or let fail');
  });

  it('fails when a test in the suite of a scene is left out, or is only a note for later', () => {
    const root = scenesTree();
    write(root, {
      'src/api/impl/work-scenes.test.ts': SCENES.replace(
        "it('notifies as often', () => {});",
        `${TODO}('notifies as often');`,
      ),
    });
    const e = errors(root);
    expect(e).toContain('a test of the scene "one frame of a drag" is left out or let fail');
    expect(e).toContain('the scene "one frame of a drag" has no test');
  });

  it('fails when a waiting scene has a test now, and on a row of a scene that is not listed', () => {
    const root = scenesTree({
      'scripts/gates/work-scenes-pending.json': {
        scenes: {
          writeBack: 'the work that writes the values back',
          select: 'the work of the selection',
          unknown: 'the work of a scene that is not there',
        },
      },
    });
    const e = errors(root);
    expect(e).toContain(
      'the scene "select" has a test now; remove select from scripts/gates/work-scenes-pending.json',
    );
    expect(e).toContain(
      'work-scenes-pending.json lists unknown, which is not a scene of WORK_SCENES',
    );
  });

  it('fails on a waiting scene without the work that adds its test', () => {
    const root = scenesTree({
      'scripts/gates/work-scenes-pending.json': { scenes: { writeBack: '' } },
    });
    expect(errors(root)).toContain('writeBack without the work that adds its test');
  });
});
