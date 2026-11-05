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

import { describeStyleProblem } from '../../shared/style-validation.js';
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

/** The hooks of the select mode a plugin may give */
const SELECT_MODE_HOOKS = ['onSelectedFeatureClick', 'onFeatureDoubleClick'] as const;

/** The members of the exclusive interaction of a plugin besides `isActive`, which it requires */
const EXCLUSIVE_HOOKS = ['finish', 'cancel', 'container'] as const;

/** What each kind requires and allows, besides its name */
const SHAPES: Readonly<
  Record<Exclude<ExtensionKind, 'mode'>, { required: string[]; optional: string[] }>
> = {
  plugin: { required: ['onAdd'], optional: ['onRemove', 'onFeatureCommit'] },
  'feature type': {
    required: [],
    optional: [
      'appliesTo',
      'hitTest',
      'boxSelect',
      'footprint',
      'bbox',
      'handles',
      'onHandleDrag',
      'onHandleDragStart',
      'onHandleDragEnd',
      'drawHandles',
      'snapCandidates',
    ],
  },
  overlay: {
    required: ['onAdd', 'draw', 'onRemove'],
    optional: ['drawForLayer', 'drawVertices', 'hasPendingWork'],
  },
  'snap provider': { required: ['candidates'], optional: [] },
  'handle provider': {
    required: ['handles', 'onHandleDrag'],
    optional: ['globalHandles', 'onHandleDragStart', 'onHandleDragEnd', 'drawHandles'],
  },
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

/**
 * Checks an optional group of functions, such as the input receivers of a plugin: the functions
 * it may have, and those it must have when it is given
 */
function optionalGroup(
  kind: ExtensionKind,
  value: Record<string, unknown>,
  member: string,
  names: readonly string[],
  required: readonly string[] = [],
  prefix = '',
): void {
  const group = value[member];
  if (group === undefined) return;
  const path = `${prefix}${member}`;
  if (!isObject(group)) throw wrongShape(kind, `has ${path} that is not an object`, path);
  requireFunctions(kind, group, required, names, `${path}.`);
}

/** Checks the keys a companion provider declares its answers read: an array of strings */
function optionalClassifyKeys(kind: ExtensionKind, value: Record<string, unknown>): void {
  const keys = (value.rows as Record<string, unknown> | undefined)?.classifyKeys;
  if (keys === undefined) return;
  if (!Array.isArray(keys) || keys.some((key) => typeof key !== 'string')) {
    throw wrongShape(
      kind,
      'has rows.classifyKeys that is not an array of strings',
      'rows.classifyKeys',
    );
  }
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
 * Checks the fields a feature type declares its resize and rotation change: an object whose keys
 * are non-empty strings, two different keys, and a boolean for whether a scaling keeps the shape
 */
function optionalTransformFields(kind: ExtensionKind, value: Record<string, unknown>): void {
  const fields = value.transformFields;
  if (fields === undefined) return;
  if (!isObject(fields)) {
    throw wrongShape(kind, 'has transformFields that is not an object', 'transformFields');
  }
  for (const member of ['angleDegreesKey', 'scaleKey']) {
    const key = fields[member];
    if (key !== undefined && (typeof key !== 'string' || key === '')) {
      const path = `transformFields.${member}`;
      throw wrongShape(kind, `has ${path} that is not a non-empty string`, path);
    }
  }
  if (fields.angleDegreesKey !== undefined && fields.angleDegreesKey === fields.scaleKey) {
    throw wrongShape(
      kind,
      'has transformFields.angleDegreesKey and transformFields.scaleKey that are the same key',
      'transformFields',
    );
  }
  if (fields.uniformScale !== undefined && typeof fields.uniformScale !== 'boolean') {
    const path = 'transformFields.uniformScale';
    throw wrongShape(kind, `has ${path} that is not a boolean`, path);
  }
}

/** Checks the look a feature type declares: a style, checked as the style of a feature is */
function optionalDefaultStyle(kind: ExtensionKind, value: Record<string, unknown>): void {
  const style = value.defaultStyle;
  if (style === undefined) return;
  if (!isObject(style)) {
    throw wrongShape(kind, 'has defaultStyle that is not an object', 'defaultStyle');
  }
  const problem = describeStyleProblem(style);
  if (problem !== null)
    throw wrongShape(kind, `has defaultStyle that is ${problem}`, 'defaultStyle');
}

/** Checks the channel a feature type declares the rule colors: `'fill'`, `'stroke'` or `'point'` */
function optionalStyleRuleChannel(kind: ExtensionKind, value: Record<string, unknown>): void {
  const channel = value.styleRuleChannel;
  if (channel === undefined) return;
  if (channel !== 'fill' && channel !== 'stroke' && channel !== 'point') {
    throw wrongShape(
      kind,
      "has styleRuleChannel that is not 'fill', 'stroke' or 'point'",
      'styleRuleChannel',
    );
  }
}

/**
 * Checks a definition given to `featureTypes.override` beyond the shape of a feature type: it has
 * no `transformFields`, no `defaultStyle` and no `styleRuleChannel`, since a built-in type keeps
 * the fields, the defaults and the channel of its own
 *
 * @throws `DrawError` with the code `invalid-input` when it has
 * @internal
 */
export function validateOverride(definition: {
  readonly transformFields?: unknown;
  readonly defaultStyle?: unknown;
  readonly styleRuleChannel?: unknown;
}): void {
  if (definition.transformFields !== undefined) {
    throw wrongShape(
      'feature type',
      'that overrides a built-in type cannot have transformFields: the built-in type keeps its own',
      'transformFields',
    );
  }
  if (definition.defaultStyle !== undefined) {
    throw wrongShape(
      'feature type',
      'that overrides a built-in type cannot have defaultStyle: the built-in type keeps the defaults of the style option',
      'defaultStyle',
    );
  }
  if (definition.styleRuleChannel !== undefined) {
    throw wrongShape(
      'feature type',
      'that overrides a built-in type cannot have styleRuleChannel: the built-in type keeps the channel of its type',
      'styleRuleChannel',
    );
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
      optionalGroup(kind, value, 'selectMode', SELECT_MODE_HOOKS);
      optionalGroup(kind, value, 'exclusive', EXCLUSIVE_HOOKS, ['isActive']);
      return;
    case 'feature type': {
      if (typeof value.geometry !== 'string' || !GEOMETRY_TYPES.has(value.geometry)) {
        throw wrongShape(kind, 'must name a kind of GeoJSON geometry in geometry', 'geometry');
      }
      const renderer = value.renderer;
      if (!isObject(renderer)) throw wrongShape(kind, 'must have a renderer', 'renderer');
      requireFunctions(kind, renderer, ['onAdd', 'draw', 'onRemove'], [], 'renderer.');
      optionalGroup(kind, renderer, 'rows', [], [], 'renderer.');
      if (isObject(renderer.rows)) {
        optionalGroup(kind, renderer.rows, 'gpu', [], ['create'], 'renderer.rows.');
      }
      optionalGroup(kind, value, 'rows', [], ['appliesTo']);
      optionalNumber(kind, value, 'hitPaddingPx', true);
      optionalTransformFields(kind, value);
      optionalDefaultStyle(kind, value);
      optionalStyleRuleChannel(kind, value);
      return;
    }
    case 'companion provider':
      optionalGroup(kind, value, 'rows', [], ['has']);
      optionalClassifyKeys(kind, value);
      return;
    case 'overlay':
      optionalNumber(kind, value, 'order', false);
      return;
    default:
      return;
  }
}
