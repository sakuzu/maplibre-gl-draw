// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The two ways the components follow a value that lives outside them.
//
// - follow(): a value of the draw instance, read again whenever one of its events fires or one of
//   the observables it follows tells a change. The draw instance stays the only source of truth;
//   nothing is copied
// - Box: a setting of the interface itself (the tools shown, the words), which the functions of
//   the API change and the components read

import type { Draw, DrawEvents, Observable } from '@sakuzu/maplibre-gl-draw';
import { createSubscriber } from 'svelte/reactivity';

/** The members of a draw instance that subscribing needs */
export type DrawEventSource = Pick<Draw, 'on'>;

/** What a value followed is read again after: an event of the draw instance, or an observable */
export type FollowSource = keyof DrawEvents | Observable<unknown>;

/** Calls a function at each change an observable tells after it is subscribed to */
function afterChanges(observable: Observable<unknown>, update: () => void): () => void {
  let subscribed = false;
  const stop = observable.subscribe(() => {
    if (subscribed) update();
  });
  subscribed = true;
  return stop;
}

/**
 * A value of the draw instance that the components follow. Read inside a component (or an
 * effect), it is read again after each of the events and each change an observable tells;
 * elsewhere it is a plain read.
 *
 * `refresh` reads it again without an event, for a value that core changes without one.
 */
export function follow<T>(
  draw: DrawEventSource,
  sources: readonly FollowSource[],
  read: () => T,
): { get(): T; refresh(): void } {
  const updates = new Set<() => void>();
  const subscribe = createSubscriber((update) => {
    updates.add(update);
    const offs = sources.map((source) =>
      typeof source === 'string' ? draw.on(source, update) : afterChanges(source, update),
    );
    return () => {
      updates.delete(update);
      for (const off of offs) off();
    };
  });
  return {
    get() {
      subscribe();
      return read();
    },
    refresh() {
      for (const update of updates) update();
    },
  };
}

/** A setting of the interface that the components follow */
export class Box<T> {
  #value: T;
  readonly #updates = new Set<() => void>();
  readonly #subscribe = createSubscriber((update) => {
    this.#updates.add(update);
    return () => {
      this.#updates.delete(update);
    };
  });

  constructor(value: T) {
    this.#value = value;
  }

  /** The value; inside a component it is followed */
  get(): T {
    this.#subscribe();
    return this.#value;
  }

  set(value: T): void {
    this.#value = value;
    for (const update of this.#updates) update();
  }
}
