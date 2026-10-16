// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/** The values of the fields of a row written over a feature */

import { describe, expect, it } from 'vitest';
import { feature } from '../test-utils.js';
import { featureWithFields } from './feature-fields.js';

describe('featureWithFields', () => {
  it('writes an attribute named __proto__ as an own key', () => {
    const before = feature('a', 'Point', [0, 0], { properties: { name: 'a' } });
    const after = featureWithFields(before, new Map([['property:__proto__', 1]]));
    expect(Object.getPrototypeOf(after.properties)).toBe(Object.prototype);
    expect(Object.keys(after.properties).sort()).toEqual(['__proto__', 'name']);
    expect(Object.getOwnPropertyDescriptor(after.properties, '__proto__')?.value).toBe(1);
  });
});
