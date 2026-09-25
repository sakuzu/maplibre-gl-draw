// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the Event API
 */

import { describe, expect, it } from 'vitest';
import { EventEmitterImpl } from '../shared/utils/event-emitter.js';
import { createEventApi } from './event-api.js';

describe('EventApi.on', () => {
  it('returns the function that unsubscribes the handler', () => {
    const eventEmitter = new EventEmitterImpl();
    const api = createEventApi({ eventEmitter });
    const received: string[] = [];

    const off = api.on('draw.mode.change', ({ mode }) => received.push(mode));
    eventEmitter.emit('mode.change', { mode: 'draw_line', previousMode: 'select' });
    off();
    eventEmitter.emit('mode.change', { mode: 'select', previousMode: 'draw_line' });

    expect(received).toEqual(['draw_line']);
  });
});
