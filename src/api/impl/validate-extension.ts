// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The shape of an extension, checked before it is added
 *
 * `draw.extensions.*.add` hands every value to {@link validateExtension} before anything is
 * installed, so a value of the wrong shape is refused with `DrawError('invalid-input')` and
 * nothing is added. The checks follow the contract types: a required member must be there with
 * the right type, and an optional member, when it is given, must have the right type too. The
 * name is checked by the collection itself.
 */

import { DrawError } from '../errors.js';

/**
 * The kinds of extension, as the collections name them in their messages
 *
 * @internal
 */
export type ExtensionKind =
  | 'plugin'
  | 'mode'
  | 'feature type'
  | 'overlay'
  | 'snap provider'
  | 'handle provider'
  | 'companion provider';

/** The kinds of GeoJSON geometry a feature type can declare */
const GEOMETRY_TYPES: ReadonlySet<string> = new Set([
  'Point',
  'LineString',
  'Polygon',
  'MultiPoint',
  'MultiLineString',
  'MultiPolygon',
  'GeometryCollection',
]);

/** The receivers of the input a plugin may give */
const INPUT_HANDLERS = [
  'onPointerDown',
  'onPointerMove',
  'onPointerUp',
  'onPointerLeave',
  'onClick',
  'onDoubleClick',
  'onDragStart',
  'onDrag',
  'onDragEnd',
  'onDragCancel',
  'onKeyDown',
  'onKeyUp',
] as const;

/** The hooks of the interaction of a plugin */
const INTERACTION_HOOKS = [
  'filterSelection',
  'onFeatureClick',
  'onFeatureDoubleClick',
  'onDrawCommit',
  'isBusy',
  'finish',
  'cancel',
  'container',
] as const;

/** What each kind requires and allows, besides its name */
const SHAPES: Readonly<
  Record<Exclude<ExtensionKind, 'mode'>, { required: string[]; optional: string[] }>
> = {
  plugin: { required: ['onAdd'], optional: ['onRemove'] },
  'feature type': {
    required: [],
    optional: [
      'hitTest',
      'boxSelect',
      'bounds',
      'outline',
      'handles',
      'onHandleDrag',
      'snapCandidates',
    ],
  },
  overlay: {
    required: ['onAdd', 'draw', 'onRemove'],
    optional: ['drawForLayer', 'drawVertices', 'hasPendingWork'],
  },
  'snap provider': { required: ['candidates'], optional: [] },
  'handle provider': { required: ['handles', 'onDrag'], optional: ['globalHandles'] },
  'companion provider': { required: ['has', 'draw', 'hitTest'], optional: ['onClick'] },
};

/** The error for a value of the wrong shape */
function wrongShape(kind: ExtensionKind, message: string, member?: string): DrawError {
  return new DrawError(
    'invalid-input',
    `The ${kind} ${message}`,
    member === undefined ? { kind } : { kind, member },
  );
}

/** Whether the value is an object that is not an array */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Checks that the members named are functions: required ones must be there */
function requireFunctions(
  kind: ExtensionKind,
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  prefix = '',
): void {
  for (const member of required) {
    if (typeof value[member] !== 'function') {
      throw wrongShape(kind, `must have the function ${prefix}${member}`, `${prefix}${member}`);
    }
  }
  for (const member of optional) {
    if (value[member] !== undefined && typeof value[member] !== 'function') {
      throw wrongShape(kind, `has ${prefix}${member} that is not a function`, `${prefix}${member}`);
    }
  }
}

/** Checks an optional group of functions, such as the input receivers of a plugin */
function optionalGroup(
  kind: ExtensionKind,
  value: Record<string, unknown>,
  member: string,
  names: readonly string[],
): void {
  const group = value[member];
  if (group === undefined) return;
  if (!isObject(group)) throw wrongShape(kind, `has ${member} that is not an object`, member);
  requireFunctions(kind, group, [], names, `${member}.`);
}

/** Checks an optional number, finite and, when asked, not negative */
function optionalNumber(
  kind: ExtensionKind,
  value: Record<string, unknown>,
  member: string,
  nonNegative: boolean,
): void {
  const number = value[member];
  if (number === undefined) return;
  if (typeof number !== 'number' || !Number.isFinite(number) || (nonNegative && number < 0)) {
    const what = nonNegative ? 'a finite number of 0 or more' : 'a finite number';
    throw wrongShape(kind, `has ${member} that is not ${what}`, member);
  }
}

/**
 * Checks that a value has the shape of an extension of the kind; the name is not checked
 *
 * @param kind - The kind of extension the value is added as
 * @param value - The value given to `add`
 * @throws `DrawError` with the code `invalid-input` when the value does not have the shape
 * @internal
 */
export function validateExtension(kind: ExtensionKind, value: unknown): void {
  if (kind === 'mode') {
    if (typeof value !== 'function') throw wrongShape(kind, 'must be a function');
    return;
  }
  if (!isObject(value)) throw wrongShape(kind, 'must be an object');
  const shape = SHAPES[kind];
  requireFunctions(kind, value, shape.required, shape.optional);

  switch (kind) {
    case 'plugin':
      optionalGroup(kind, value, 'input', INPUT_HANDLERS);
      optionalGroup(kind, value, 'interaction', INTERACTION_HOOKS);
      return;
    case 'feature type': {
      if (typeof value.geometry !== 'string' || !GEOMETRY_TYPES.has(value.geometry)) {
        throw wrongShape(kind, 'must name a kind of GeoJSON geometry in geometry', 'geometry');
      }
      const renderer = value.renderer;
      if (!isObject(renderer)) throw wrongShape(kind, 'must have a renderer', 'renderer');
      requireFunctions(kind, renderer, ['onAdd', 'draw', 'onRemove'], [], 'renderer.');
      optionalNumber(kind, value, 'hitPaddingPx', true);
      return;
    }
    case 'overlay':
      optionalNumber(kind, value, 'order', false);
      return;
    default:
      return;
  }
}
