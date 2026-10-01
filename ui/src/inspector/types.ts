// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The types of the inspector: those of the API, and the members of a draw instance it uses.

import type { Draw, Feature } from '@sakuzu/maplibre-gl-draw';

/** A tab of the inspector of a feature */
export type InspectorTab = 'style' | 'attributes';

/** The units of the measurements and of the distance of a buffer */
export type Units = 'metric' | 'imperial';

/** What the inspector shows */
export interface InspectorOptions {
  /**
   * The tabs of a feature, in order; the first is the one that opens. `['style', 'attributes']`
   * when left out
   */
  tabs?: InspectorTab[];
  /**
   * Whether the measurements of a feature show under its name, before the tabs; true when left
   * out
   */
  measurements?: boolean;
  /** Whether the operations (union, intersection, difference, split, buffer) show; true when left out */
  operations?: boolean;
  /** The units of the measurements; `metric` when left out */
  units?: Units;
}

/** The kind of the control of a field of a section */
export type InspectorFieldKind =
  | 'text'
  | 'number'
  | 'select'
  | 'color'
  | 'toggle'
  | 'slider'
  | 'segmented';

/**
 * A field of a section of the inspector: a name and the control that changes one value. The
 * values are the application's; a unit is text after the value
 */
export interface InspectorField {
  /** The key the change is reported with */
  key: string;
  /** The control */
  kind: InspectorFieldKind;
  /** The name before the control */
  label: string;
  /** The current value */
  value?: unknown;
  /** The features selected do not share one value; no value shows */
  mixed?: boolean;
  /** The choices of `select` and `segmented` */
  options?: { value: string; label: string }[];
  /** The range of `number` and `slider` */
  min?: number;
  max?: number;
  step?: number;
  /** Text after the value, such as `px` or `%` */
  unit?: string;
  /** A word shown while a text or a number is empty */
  placeholder?: string;
  /** The control cannot be changed */
  disabled?: boolean;
  /** A caption under the control */
  hint?: string;
}

/**
 * A section an application adds to the inspector of features. It shows, on the Style tab of one
 * feature and among the fields of several, when `appliesTo` accepts the features selected.
 *
 * The section either lists fields, whose changes go to `onchange`, or draws itself with `render`
 * (or both: the fields first, then what `render` draws).
 */
export interface InspectorSectionSpec {
  /** The name of the section, unique in the inspector */
  id: string;
  /** The title of the section */
  title: string;
  /** Whether the section shows for these features */
  appliesTo: (features: readonly Feature[]) => boolean;
  /** The fields of the section for these features */
  fields?: (features: readonly Feature[]) => InspectorField[];
  /** Called with the key and the value of a field that was changed, and the features */
  onchange?: (key: string, value: unknown, features: readonly Feature[]) => void;
  /**
   * Draws the section into an element, for what fields cannot show. It is called again with a
   * new element when the features change; the function it returns, if any, is called before that
   * and when the section goes away
   */
  render?: (element: HTMLElement, features: readonly Feature[]) => undefined | (() => void);
}

/** The sections of the inspector that an application added */
export interface InspectorSectionsHandle {
  /**
   * Adds a section after the sections added before it
   *
   * @returns The function that removes it again
   * @throws Error when the section is not valid or its ID is taken
   */
  add(spec: InspectorSectionSpec): () => void;
  /**
   * Removes a section
   *
   * @returns Whether there was a section with this ID
   */
  remove(id: string): boolean;
  /** The sections, in order */
  list(): InspectorSectionSpec[];
}

/** An inspector on the page */
export interface InspectorHandle {
  /** The element of the inspector */
  readonly element: HTMLElement;
  /** The sections an application added */
  readonly sections: InspectorSectionsHandle;
  /** Removes the inspector. A second call does nothing */
  destroy(): void;
}

/** The options of the inspector with their defaults applied */
export interface InspectorSettings {
  tabs: InspectorTab[];
  measurements: boolean;
  operations: boolean;
  units: Units;
}

/** The members of a draw instance that the inspector uses */
export type InspectorDraw = Pick<Draw, 'on' | 'off' | 'transact' | 'isReadOnly'> & {
  readonly features: Pick<
    Draw['features'],
    | 'get'
    | 'getMany'
    | 'getAppliedStyle'
    | 'update'
    | 'updateMany'
    | 'isEditable'
    | 'union'
    | 'difference'
    | 'intersection'
    | 'split'
    | 'buffer'
  >;
  readonly selection: Pick<
    Draw['selection'],
    'get' | 'set' | 'clear' | 'delete' | 'group' | 'ungroup'
  >;
  readonly hidden: Pick<Draw['hidden'], 'has' | 'add' | 'remove'>;
  readonly layers: Pick<Draw['layers'], 'get' | 'update' | 'count'>;
  readonly groups: Pick<Draw['groups'], 'get' | 'update'>;
};
