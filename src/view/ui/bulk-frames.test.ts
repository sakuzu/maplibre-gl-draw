// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The frames of the features selected in bulk: one instance per row of a group, the extent of
 * the row from the origin of the group and the extent of the marker of a row of one position,
 * drawn in one instanced draw of four sides per row group, made again only when the rows change.
 */

import { describe, expect, it } from 'vitest';
import type { RowGroup } from '../../feature-table/layer-table.js';
import { DEFAULT_SELECTION_CONFIG } from '../../shared/config/selection.js';
import type { RowStateBinding } from '../renderers/row-state.js';
import { BulkFramesRenderer, buildBulkFramesVertexSource } from './bulk-frames.js';

/** A WebGL2 context that records the calls it gets */
function recordingGl() {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const gl = new Proxy(
    { drawingBufferWidth: 800, drawingBufferHeight: 600 } as Record<string, unknown>,
    {
      get(target, name) {
        if (name in target) return target[name as string];
        if (typeof name !== 'string') return undefined;
        if (/^[A-Z_0-9]+$/.test(name)) return 1;
        return (...args: unknown[]) => {
          calls.push({ name, args });
          if (name === 'getShaderParameter' || name === 'getProgramParameter') return true;
          if (name === 'getUniformLocation') return { name: args[1] };
          return {};
        };
      },
    },
  ) as unknown as WebGL2RenderingContext;
  return { gl, calls };
}

function groupOf(bounds: number[]): RowGroup {
  return {
    handle: 7,
    data: { length: bounds.length / 4, rowBounds: Float64Array.from(bounds) },
  } as unknown as RowGroup;
}

const binding = {
  texture: { texture: {}, width: 128, height: 1, rows: 3 },
  translations: new Float32Array(8),
} as unknown as RowStateBinding;

const SHADER = { vertexShaderPrelude: '', define: '', variantName: 'mercator' };

/** The projection data of a frame (the identity matrix) */
const PROJECTION = { mainMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] };

describe('the frames of the features selected in bulk', () => {
  it('give each row its extent from the origin of its group, and a row of one position its marker', () => {
    const { gl, calls } = recordingGl();
    const renderer = new BulkFramesRenderer(gl, 2);
    renderer.ensureShader(SHADER as never);
    renderer.setScreenScale({ zoom: 10, centerLatitude: 0, transition: 0 });
    const group = groupOf([
      10,
      20,
      11,
      21,
      12,
      22,
      12,
      22,
      Number.NaN,
      Number.NaN,
      Number.NaN,
      Number.NaN,
    ]);
    renderer.drawGroup(group, binding, 1, PROJECTION as never, 10, DEFAULT_SELECTION_CONFIG, () => [
      8, 5,
    ]);
    const data = calls.find((call) => call.name === 'bufferData')?.args[1] as Float32Array;
    expect(Array.from(data.subarray(0, 8))).toEqual([0, 0, 1, 1, 0, 0, 0, 0]);
    expect(Array.from(data.subarray(8, 16))).toEqual([2, 2, 2, 2, 1, 8, 5, 0]);
    // A row without a geometry is drawn nowhere
    expect(data[20]).toBe(-1);
    const draw = calls.find((call) => call.name === 'drawArraysInstanced');
    expect(draw?.args.slice(1)).toEqual([0, 24, 3]);
  });

  it('make the instances of a group again only when its rows change', () => {
    const { gl, calls } = recordingGl();
    const renderer = new BulkFramesRenderer(gl);
    renderer.ensureShader(SHADER as never);
    renderer.setScreenScale({ zoom: 10, centerLatitude: 0, transition: 0 });
    const group = groupOf([0, 0, 1, 1]);
    const draw = (revision: number) =>
      renderer.drawGroup(
        group,
        binding,
        revision,
        PROJECTION as never,
        10,
        DEFAULT_SELECTION_CONFIG,
        () => null,
      );
    draw(1);
    draw(1);
    expect(calls.filter((call) => call.name === 'bufferData')).toHaveLength(1);
    draw(2);
    expect(calls.filter((call) => call.name === 'bufferData')).toHaveLength(2);
    expect(calls.filter((call) => call.name === 'deleteBuffer')).toHaveLength(1);
    renderer.retain(new Set());
    expect(calls.filter((call) => call.name === 'deleteBuffer')).toHaveLength(2);
  });

  it('read the state of the rows and move them by their moving set', () => {
    const source = buildBulkFramesVertexSource('', '');
    expect(source).toContain('#define TABLE_ROWS');
    expect(source).toContain('readRowState(a_meta.x)');
    expect(source).toContain('(state & 8u) == 0u');
    expect(source).toContain('rowStateMove(state,');
  });

  it('widen the extent moved as the row is, and outline it as the line of the selection UI is', () => {
    const source = buildBulkFramesVertexSource('', '');
    // The margin after the move (a resize does not scale it)
    expect(source.indexOf('rowStateMove(state, a_bounds.xw)')).toBeLessThan(
      source.indexOf('q[0] += (-right - down) * u_margin'),
    );
    // The miters of StrokeRenderer, within its limit, and the band of the coverage
    expect(source).toContain('miterAt(corners[(k + 3) % 4], corners[k], corners[(k + 1) % 4])');
    expect(source).toContain('scale > 4.0');
    expect(source).toContain('float reach = u_half_width + 1.0');
  });

  it('frame a row of one position by the margin alone while the rows are turned', () => {
    const source = buildBulkFramesVertexSource('', '');
    expect(source).toContain('bool marker = a_meta.y > 0.0 && u_rotating < 0.5');
    const { gl, calls } = recordingGl();
    const renderer = new BulkFramesRenderer(gl);
    renderer.ensureShader(SHADER as never);
    renderer.setScreenScale({ zoom: 10, centerLatitude: 0, transition: 0 });
    const draw = () =>
      renderer.drawGroup(
        groupOf([0, 0, 0, 0]),
        binding,
        1,
        PROJECTION as never,
        10,
        DEFAULT_SELECTION_CONFIG,
        () => [8, 5],
      );
    const rotating = () => {
      const set = calls.filter(
        (call) =>
          call.name === 'uniform1f' && (call.args[0] as { name: string }).name === 'u_rotating',
      );
      return set[set.length - 1]?.args[1];
    };
    draw();
    expect(rotating()).toBe(0);
    renderer.setRotating(true);
    draw();
    expect(rotating()).toBe(1);
  });
});
