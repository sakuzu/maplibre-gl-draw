// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Event API
 *
 * Provides on / off for MapLibreGLDraw. Maps the `draw.*` prefix to the internal
 * EventEmitter event names.
 */

import type { EventEmitter } from '../shared/utils/event-emitter.js';
import type { EventPayloads, MapLibreGLDraw } from './api.js';

export type EventApi = Pick<MapLibreGLDraw, 'on' | 'off'>;

export interface EventApiDeps {
  eventEmitter: EventEmitter;
}

export function createEventApi(deps: EventApiDeps): EventApi {
  const { eventEmitter } = deps;

  return {
    on<K extends keyof EventPayloads>(
      event: K,
      handler: (data: EventPayloads[K]) => void,
    ): () => void {
      const internalEvent = event.replace('draw.', '') as Parameters<typeof eventEmitter.on>[0];
      const listener = handler as (data: unknown) => void;
      eventEmitter.on(internalEvent, listener);
      return () => eventEmitter.off(internalEvent, listener);
    },

    off<K extends keyof EventPayloads>(event: K, handler: (data: EventPayloads[K]) => void): void {
      const internalEvent = event.replace('draw.', '') as Parameters<typeof eventEmitter.off>[0];
      eventEmitter.off(internalEvent, handler as (data: unknown) => void);
    },
  };
}
