// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.status`: the state of the instance in one value, made again when one of its parts changes
 * (the steps of undo, the saving and the connection, whether the document can be written, the
 * failures nobody waits for), and the same object while none does
 */

import type { DrawError } from '../../shared/draw-error.js';
import type { Store } from '../../store/store.js';
import { createObservable } from '../backend/observable.js';
import type { Sender } from '../backend/sender.js';
import type { Observable } from '../events.js';
import type { Connection, DocumentState, Problem, SaveState, Status } from '../status.js';
import type { EventHub } from './events.js';
import type { History } from './history.js';

/** The most problems kept */
const MAX_PROBLEMS = 20;

const OPEN: DocumentState = Object.freeze({ state: 'open' });
const NO_CONNECTION: Connection = Object.freeze({ state: 'none' });
const NOT_SAVED: SaveState = Object.freeze({
  stage: 'local',
  stages: Object.freeze(['local']),
  unsaved: 0,
  refused: 0,
  savedAtMilliseconds: null,
  sending: null,
}) as SaveState;

/**
 * A problem to keep: what it is about, without its ID and its time
 *
 * @internal
 */
export type ProblemInput = Omit<Problem, 'id' | 'atMilliseconds'>;

/**
 * The state of an instance, and the problems it keeps
 *
 * @internal
 */
export interface StatusResource {
  readonly status: Observable<Status>;
  /**
   * Keeps a problem, the newest first. A problem of the same `key` as one kept is the same
   * failure again: it takes the place of the one kept, newest, its `count` added to it
   */
  problem(problem: ProblemInput, key?: string): void;
  /** Makes the state again: something it is made of changed */
  changed(): void;
  /** Stops following what it is made of */
  stop(): void;
}

/**
 * Creates the state of an instance
 *
 * @param sender - What sends the commits to the storage (`null` without one)
 * @internal
 */
export function createStatus(deps: {
  readonly store: Store;
  readonly history: History;
  readonly events: EventHub;
  readonly sender: () => Sender | null;
}): StatusResource {
  const { store, history, events } = deps;
  let problems: readonly Problem[] = Object.freeze([]);
  let nextId = 1;
  const make = (before: Status | null): Status => {
    const sender = deps.sender();
    const saving = sender?.saving ?? NOT_SAVED;
    const connection = sender?.connection ?? NO_CONNECTION;
    const steps = history.state();
    const editable = !store.isReadOnly();
    if (
      before &&
      before.saving === saving &&
      before.connection === connection &&
      before.history === steps &&
      before.editable === editable &&
      before.problems === problems
    ) {
      return before;
    }
    return Object.freeze({
      document: OPEN,
      saving,
      connection,
      history: steps,
      editable,
      problems,
    });
  };
  const value = createObservable<Status>(make(null));
  const changed = (): void => value.set(make(value.value));
  // The problems kept under a key, which the same failure again adds its count to
  const keyed = new Map<string, Problem>();
  const problem = (input: ProblemInput, key?: string): void => {
    const before = key === undefined ? undefined : keyed.get(key);
    const same = before !== undefined && problems.includes(before) ? before : undefined;
    const kept: Problem = Object.freeze({
      ...input,
      count: input.count + (same?.count ?? 0),
      id: nextId++,
      atMilliseconds: Date.now(),
    });
    const others = same === undefined ? problems : problems.filter((each) => each !== same);
    problems = Object.freeze([kept, ...others].slice(0, MAX_PROBLEMS));
    if (key !== undefined) keyed.set(key, kept);
    for (const [name, each] of keyed) if (!problems.includes(each)) keyed.delete(name);
    changed();
  };
  const stops = [
    history.onChange(changed),
    events.on('readOnly.changed', changed),
    // What failed with no caller to throw to: the image a mode asked for, a load of a feature
    events.on('error', ({ error }: { readonly error: DrawError }) =>
      problem({ type: 'failed', error, label: undefined, commit: null, count: 1 }),
    ),
  ];
  return {
    status: {
      subscribe: value.subscribe,
      get value() {
        return value.value;
      },
    },
    problem,
    changed,
    stop() {
      for (const stop of stops.splice(0)) stop();
    },
  };
}
