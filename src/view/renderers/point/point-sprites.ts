// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The sheets of pictures the built-in points are drawn with, as the drawing reads them
 *
 * A sheet is a texture of pictures and the question of the picture of each point: a point of the
 * built-in type whose first sheet (in the order they were added) gives it a picture is drawn with
 * that picture, in the place of its marker, by the same drawing as the rows around it; a point no
 * sheet gives one keeps its marker. The rows of a layer held as rows are asked where they are
 * written (`spriteOfRow`), the other points (the Store, the sketches, the rows drawn at once) from
 * their feature (`spriteOfFeature`). The answers are asked again together, once in a frame, when a
 * sheet says its pictures changed: {@link PointSpriteSheets.generation} changes then, and what
 * holds an answer asks again.
 */

import type { LayerTableView } from '../../../api/tables.js';
import type { Feature } from '../../../store/types.js';
import type { RowSpritePictures } from '../rows/rows-format.js';

/**
 * One picture of a point, as the drawing reads it
 *
 * @internal
 */
export interface PointSprite {
  /** The rectangle of the picture in the texture, `[u0, v0, u1, v1]` (the top left first) */
  readonly uv: readonly [number, number, number, number];
  /** The half width and the half height of the picture on screen, in CSS px */
  readonly halfWidth: number;
  readonly halfHeight: number;
  /**
   * Whether the picture turns with the rotation of its point (`maplibre-gl-draw:rotation`), as a
   * marker does; false keeps it upright on screen
   */
  readonly rotates: boolean;
}

/**
 * One sheet of pictures, as the drawing reads it
 *
 * @internal
 */
export interface PointSpriteSheetSource extends RowSpritePictures {
  /**
   * Whether it gives pictures now: false once its texture was given back after a failure, when
   * its points keep their markers
   */
  readonly active: boolean;
  /** The picture of a row of a layer held as rows (null: the point keeps its marker) */
  spriteOfRow(view: LayerTableView, row: number): PointSprite | null;
  /** The picture of a point that is not read as a row (null: the point keeps its marker) */
  spriteOfFeature(feature: Feature): PointSprite | null;
  /** The map gave a WebGL context */
  onAdd(gl: WebGL2RenderingContext): void;
  /** The map took the context away */
  onRemove(): void;
  /** Called once a frame, before anything is drawn */
  beginFrame(): void;
}

/**
 * The sheet a point was given a picture by, and the picture
 *
 * @internal
 */
export interface PointSpriteMatch {
  readonly sheet: PointSpriteSheetSource;
  readonly sprite: PointSprite;
}

/** A picture kept for a feature, while the answers are those of a generation */
interface KeptMatch {
  readonly generation: number;
  readonly match: PointSpriteMatch | null;
}

/**
 * Whether a feature is a point of the built-in type, which the sheets give pictures to
 *
 * @internal
 */
export function isBuiltInPoint(type: string): boolean {
  return type === 'Point' || type === 'MultiPoint';
}

/**
 * The sheets of pictures of one instance, in the order they were added
 *
 * @internal
 */
export class PointSpriteSheets {
  readonly #sheets: PointSpriteSheetSource[] = [];
  #generation = 0;
  /** The largest half size of a picture given so far (CSS px): how far a hit looks */
  #reach = 0;
  #features = new WeakMap<Feature, KeptMatch>();

  /** The sheets, in the order they were added */
  get sheets(): readonly PointSpriteSheetSource[] {
    return this.#sheets;
  }

  /** Whether there is a sheet (false: nothing asks) */
  any(): boolean {
    return this.#sheets.length > 0;
  }

  /** Changes whenever an answer may have changed: a sheet added or removed, or asked again */
  generation(): number {
    return this.#generation;
  }

  /** The answers may have changed: everything that holds one asks again */
  changed(): void {
    this.#generation++;
    this.#features = new WeakMap();
  }

  /**
   * Adds a sheet after the others
   *
   * @returns What removes it
   */
  add(sheet: PointSpriteSheetSource): () => void {
    this.#sheets.push(sheet);
    this.changed();
    return () => {
      const at = this.#sheets.indexOf(sheet);
      if (at === -1) return;
      this.#sheets.splice(at, 1);
      this.changed();
    };
  }

  /** The largest half size of a picture given so far (CSS px) */
  reachPx(): number {
    return this.#reach;
  }

  /** The first picture the sheets give a row of a layer held as rows */
  ofRow(view: LayerTableView, row: number): PointSpriteMatch | null {
    for (const sheet of this.#sheets) {
      if (!sheet.active) continue;
      const sprite = sheet.spriteOfRow(view, row);
      if (sprite) return this.#matched(sheet, sprite);
    }
    return null;
  }

  /**
   * The first picture the sheets give a point that is not read as a row: kept for the feature
   * until the answers change (a feature is a new object once it is written)
   */
  ofFeature(feature: Feature): PointSpriteMatch | null {
    if (this.#sheets.length === 0 || !isBuiltInPoint(feature.type)) return null;
    const kept = this.#features.get(feature);
    if (kept && kept.generation === this.#generation) return kept.match;
    let match: PointSpriteMatch | null = null;
    for (const sheet of this.#sheets) {
      if (!sheet.active) continue;
      const sprite = sheet.spriteOfFeature(feature);
      if (sprite) {
        match = this.#matched(sheet, sprite);
        break;
      }
    }
    this.#features.set(feature, { generation: this.#generation, match });
    return match;
  }

  /** Lets every sheet see the frame begin (what it was asked to do since is done here) */
  beginFrame(): void {
    for (const sheet of this.#sheets) sheet.beginFrame();
  }

  #matched(sheet: PointSpriteSheetSource, sprite: PointSprite): PointSpriteMatch {
    const reach = Math.max(sprite.halfWidth, sprite.halfHeight);
    if (reach > this.#reach) this.#reach = reach;
    return { sheet, sprite };
  }
}
