// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Custom feature types: the one definition that says how a type is drawn, hit, selected and
 * resized
 */

import type { Geometry, Position } from 'geojson';
import type { BBox } from '../../geometry/types.js';
import type { ScreenPoint } from '../events.js';
import type { Feature, FeaturePatch } from '../model.js';
import type { HitTestContext, ScreenContext, SnapContext } from './context.js';
import type { DrawPointerEvent } from './mode.js';
import type { Hit, SnapCandidate } from './provider.js';
import type { FeatureRenderer } from './render.js';

/** One handle on a selected feature. */
export interface Handle {
  /** The ID of the handle, unique within the feature */
  id: string;
  /** The position of the handle */
  position: Position;
  /** The kind of handle, as its provider names it */
  kind: string;
  /** The CSS cursor over the handle */
  cursor?: string;
}

/**
 * The fields of the features of a type that the moves, rotations and scalings change with their
 * geometry, as the type declares them (`FeatureTypeDefinition.transformFields`): the keys of
 * `properties` that hold them. A feature without a key of them starts from 0 for a rotation and
 * a direction, and from 1 for a size.
 *
 * For example, a type of signboards whose features keep their rotation under `boardAngle` and the
 * factor of their size under `boardScale`, and keep their shape when they are scaled, declares
 * `{ rotationDegreesKey: 'boardAngle', sizeKey: 'boardScale', isScaledUniformly: true }`.
 */
export interface TransformFields {
  /**
   * The key that holds the rotation of a feature, in degrees counterclockwise seen from above.
   * A rotation adds its angle to it, within [0, 360). A rotation of a single feature of a
   * `Point` geometry with this key turns it about its position.
   */
  readonly rotationDegreesKey?: string;
  /**
   * The key that holds a direction of a feature, in degrees clockwise from the north, unlike
   * `rotationDegreesKey` (a turn counterclockwise of the shape itself) (a
   * bearing): the direction a symbol on a point faces, say. A rotation takes its angle away from
   * it, within [0, 360), so the feature still faces the same way on the ground after it.
   */
  readonly bearingDegreesKey?: string;
  /**
   * The key that holds the factor of the size of a feature, 1 for the size it was made at. A
   * scaling multiplies it by `sizeFactor`.
   */
  readonly sizeKey?: string;
  /**
   * Whether a scaling moves the positions of a feature by `sizeFactor` along both the east and
   * the north, so that it keeps its shape, in place of `eastFactor` and `northFactor`; false
   * when it is left out.
   */
  readonly isScaledUniformly?: boolean;
}

/**
 * The definition of a custom feature type. Its handles and snapping candidates are written
 * here; a provider is only for the types an extension does not define.
 */
export interface FeatureTypeDefinition {
  /** The name of the type; it is registered under this name */
  readonly type: string;
  /** The kind of GeoJSON geometry the features of this type have; one kind per type */
  readonly geometry: Geometry['type'];
  /**
   * How far beyond its geometry a feature of this type can be hit, in pixels, such as the
   * half size of an icon drawn on a point. The candidates of a hit test are gathered this much
   * farther out; 0 when it is left out.
   */
  readonly hitPaddingPx?: number;
  /** How the features of this type are drawn */
  readonly renderer: FeatureRenderer;
  /**
   * Which features of the type the definition takes, for a definition that overrides a
   * built-in type (`extensions.featureTypes.override`). A feature for which it returns false
   * keeps the built-in type: its built-in drawing (drawn in batches with the other features),
   * hit test, box selection, selection frame, handles, snapping candidates and extent. The
   * others are drawn, hit and framed by this definition. Every feature of the type is taken
   * when it is left out.
   *
   * It is asked again whenever a feature changes, so its answer must follow from the feature
   * (its properties, its geometry, its style) and nothing outside it. It is ignored in a
   * definition given to `add`: a custom type takes every feature of its type.
   */
  appliesTo?(feature: Feature): boolean;
  /**
   * The fields of its features that the moves, rotations and scalings change with their
   * geometry: the keys of `properties` that hold their rotation, their direction and their
   * size, and whether a scaling keeps their shape. The bulk edits `rotate` and `scale` write
   * them (and so do the drags of the rotate and resize handles, which write with them), and the
   * computation of moves is given their values (`TransformInput.rotationDegrees`,
   * `bearingDegrees`, `size` and `isScaledUniformly`).
   *
   * A definition that overrides a built-in type can declare them for the features it takes
   * (`appliesTo`): a point that shows a symbol turned to a direction declares the key of that
   * direction. Without it, the moves, rotations and scalings change the geometry of the features
   * only, whatever keys they have; the built-in types have their own (the rotation and the
   * factor of an image, the radius of a circle).
   */
  readonly transformFields?: TransformFields;
  /**
   * The extent of a feature on the map, `[west, south, east, north]` in degrees, for a type
   * that draws beyond its geometry by a distance on the ground. The spatial index takes it:
   * it gathers the candidates of a hit test and of a box selection, answers
   * `features.list({ bbox })`, and decides which features are near enough to the view to be
   * drawn. The extent of the geometry is used when it is left out, and when it returns an
   * extent that is not four finite numbers from the west and south to the east and north.
   *
   * It is measured when a feature changes; call `invalidate({ type })` when it depends on
   * something outside the document. A reach in pixels belongs in `hitPaddingPx`.
   */
  bbox?(feature: Feature): BBox;
  /**
   * Hit tests a feature of this type; the geometry is hit tested when it is left out.
   *
   * @returns What was hit, or `null`
   */
  hitTest?(feature: Feature, ctx: HitTestContext): Hit | null;
  /**
   * Whether a box selection takes a feature of this type.
   *
   * @param box - The corners of the box on the screen, in pixels
   */
  boxSelect?(
    feature: Feature,
    box: { min: ScreenPoint; max: ScreenPoint },
    ctx: HitTestContext,
  ): boolean;
  /**
   * The extent of the selection box of a feature on the screen, in pixels.
   *
   * @returns The corners of the extent, or `null` when the feature has nothing to draw
   */
  bounds?(feature: Feature, ctx: ScreenContext): { min: ScreenPoint; max: ScreenPoint } | null;
  /**
   * The outline of the selection frame of a feature on the screen, in pixels, for a type whose
   * shape turns: its four corners in the order top left, top right, bottom right, bottom left
   * of the shape as it stands unturned, without the margin of the frame
   * (`selectionStyle.boundingBox.margin`). The engine draws the selection frame along it when
   * it is given, and from `bounds` otherwise, with every edge moved the margin outward. For a
   * type of any geometry but `Point`, the resize and rotate handles sit on the corners of that
   * frame too; a `Point` type keeps a frame with no such handles.
   *
   * @returns The four corners; anything else (or an empty array) gives the frame of `bounds`
   */
  outline?(feature: Feature, ctx: ScreenContext): ScreenPoint[];
  /**
   * The handles that resize or reshape a selected feature. The engine draws them with the
   * look of the vertex handles, hit tests them at the same size, and gives their drags to
   * `onHandleDrag`.
   */
  handles?(feature: Feature, ctx: ScreenContext): Handle[];
  /**
   * The change a drag of one of its handles makes.
   *
   * @returns The patch to apply to the feature, or `null` for no change
   */
  onHandleDrag?(feature: Feature, handle: Handle, event: DrawPointerEvent): FeaturePatch | null;
  /**
   * A drag of one of its handles is about to start, before the first `onHandleDrag`.
   *
   * @returns False to refuse the drag; no `onHandleDrag` nor `onHandleDragEnd` follows then
   */
  onHandleDragStart?(feature: Feature, handle: Handle, event: DrawPointerEvent): boolean;
  /**
   * A drag of one of its handles ended, after the last `onHandleDrag` and its patch. It is
   * called once for every drag that started, also when the drag is cut short.
   *
   * @param feature - The feature as it is now, or `null` when it is gone
   */
  onHandleDragEnd?(feature: Feature | null, handle: Handle, event: DrawPointerEvent): void;
  /** The snapping candidates a feature of this type offers. */
  snapCandidates?(feature: Feature, ctx: SnapContext): SnapCandidate[];
}
