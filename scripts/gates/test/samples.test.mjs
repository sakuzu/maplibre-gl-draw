// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { check } from '../samples.mjs';
import { cleanUp, packageTree, write } from './fixture.mjs';

afterEach(cleanUp);

const SAMPLE = `import { makeThing, type Thing } from '@sakuzu/maplibre-gl-draw';

const thing: Thing = makeThing('a');
export const moved: boolean = thing.move(1, { fast: true });
`;

const pending = (samples) => ({
  'scripts/gates/api-pending.json': { entries: ['./store'], samples, declarations: {} },
});

describe('the gate of the samples', () => {
  it('passes when every sample type-checks against the build', () => {
    const root = packageTree({ 'api/samples/sample-move.ts': SAMPLE, ...pending({}) });
    expect(check({ root }).errors).toEqual([]);
  });

  it('fails when the build loses a member a sample uses', () => {
    const root = packageTree({ 'api/samples/sample-move.ts': SAMPLE, ...pending({}) });
    const file = join(root, 'dist/api/thing.d.ts');
    write(root, {
      'dist/api/thing.d.ts': readFileSync(file, 'utf8').replace(
        / {4}\/\*\*\n {5}\* Moves[\s\S]*?boolean;\n/,
        '',
      ),
    });
    const errors = check({ root }).errors.join('\n');
    expect(errors).toContain('sample-move.ts');
    expect(errors).toContain("'move'");
  });

  it('lets a sample that does not type-check yet wait in the list', () => {
    const broken = SAMPLE.replace('thing.move(1,', 'thing.turn(1,');
    const root = packageTree({
      'api/samples/sample-move.ts': broken,
      ...pending({ 'sample-move.ts': 1 }),
    });
    const r = check({ root });
    expect(r.errors).toEqual([]);
    expect(r.notes.join('\n')).toContain('sample-move.ts waits');
  });

  it('fails when a waiting sample type-checks, so that its row is removed', () => {
    const root = packageTree({
      'api/samples/sample-move.ts': SAMPLE,
      ...pending({ 'sample-move.ts': 1 }),
    });
    expect(check({ root }).errors.join('\n')).toContain('sample-move.ts type-checks now');
  });

  it('fails when a waiting sample has more type errors than its row allows', () => {
    const broken = SAMPLE.replace('thing.move(1,', 'thing.turn(1,');
    const root = packageTree({
      'api/samples/sample-move.ts': broken.replace("makeThing('a')", 'makeThing(1)'),
      ...pending({ 'sample-move.ts': 1 }),
    });
    expect(check({ root }).errors.join('\n')).toContain(
      'sample-move.ts has 2 type errors, its row in api-pending.json allows 1',
    );
  });
});
