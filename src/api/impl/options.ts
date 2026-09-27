// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.options` and the options of `createDraw`: their checks, their translation into the
 * configuration of the engine, and their application while the instance runs
 *
 * The options are kept as they were given, merged patch by patch. Each change is translated
 * again from the whole of them into the configuration of the engine (`src/shared/config/`),
 * which the renderers, the modes and the services read in place.
 */

import { MESSAGES_EN, resolveMessages } from '../../messages.js';
import { isColor, toColor } from '../../shared/color.js';
import type { FeatureStyleConfig } from '../../shared/config/feature-style.js';
import { DEFAULT_FEATURE_STYLE_CONFIG } from '../../shared/config/feature-style.js';
import type { BoxSelectionStyleConfig } from '../../shared/config/rendering.js';
import { DEFAULT_BOX_SELECTION_STYLE_CONFIG } from '../../shared/config/rendering.js';
import type { SelectionUIConfig } from '../../shared/config/selection.js';
import { DEFAULT_SELECTION_CONFIG } from '../../shared/config/selection.js';
import type { Color, PointStyle, StrokeStyle } from '../../shared/types/style.js';
import type { AutoNameConfig } from '../../shared/utils/name-generator.js';
import { DrawStore } from '../../store/draw-store.js';
import type { DocumentStore } from '../../store/store.js';
import type { FeatureStyle } from '../model.js';
import type {
  DrawOptions,
  OptionsResource,
  RuntimeOptions,
  SelectionStyleOptions,
} from '../options.js';
import type { Engine } from './engine.js';
import type { EngineOptions } from './engine-context.js';
import { describeStyleProblem } from './import-export/style-validation.js';
import { invalidInput, isRecord, onlyKeys } from './shared.js';

/** The options that can only be given when the instance is created */
const CREATION_KEYS = ['defaultMode', 'store', 'initDefaultLayer'] as const;

/** The options that change while the instance runs */
const RUNTIME_KEYS = [
  'messages',
  'autoName',
  'style',
  'previewStyle',
  'selectionStyle',
  'scaleWithZoom',
  'snapping',
  'tracing',
  'topology',
  'clickTolerance',
  'dragThreshold',
  'rendering',
  'isExternalEntry',
] as const satisfies ReadonlyArray<keyof RuntimeOptions>;

// ============================================================================
// Checks
// ============================================================================

type Record_ = Record<string, unknown>;

/** Runs a check on each key of the object that is given */
function checkFields(
  value: Record_,
  what: string,
  checks: Readonly<Record<string, (value: unknown, what: string) => void>>,
): void {
  onlyKeys(value, Object.keys(checks), what);
  for (const [key, check] of Object.entries(checks)) {
    if (value[key] !== undefined) check(value[key], `${what}.${key}`);
  }
}

const bool = (value: unknown, what: string): void => {
  if (typeof value !== 'boolean') throw invalidInput(`${what} must be a boolean`);
};
const string = (value: unknown, what: string): void => {
  if (typeof value !== 'string') throw invalidInput(`${what} must be a string`);
};
const func = (value: unknown, what: string): void => {
  if (typeof value !== 'function') throw invalidInput(`${what} must be a function`);
};
const nonNegative = (value: unknown, what: string): void => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw invalidInput(`${what} must be a number from 0`);
  }
};
const positive = (value: unknown, what: string): void => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw invalidInput(`${what} must be a number above 0`);
  }
};
const opacity = (value: unknown, what: string): void => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw invalidInput(`${what} must be a number from 0 to 1`);
  }
};
const color = (value: unknown, what: string): void => {
  if (!isColor(value)) throw invalidInput(`${what} must be a CSS color`);
};
const oneOf =
  (...values: string[]) =>
  (value: unknown, what: string): void => {
    if (typeof value !== 'string' || !values.includes(value)) {
      throw invalidInput(`${what} must be one of ${values.join(', ')}`);
    }
  };
const record =
  (checks: Readonly<Record<string, (value: unknown, what: string) => void>>) =>
  (value: unknown, what: string): void => {
    if (!isRecord(value)) throw invalidInput(`${what} must be an object`);
    checkFields(value, what, checks);
  };
const featureStyle = (value: unknown, what: string): void => {
  const problem = describeStyleProblem(value);
  if (problem) throw invalidInput(`${what} is ${problem}`);
};
const numbers = (value: unknown, what: string): void => {
  if (!Array.isArray(value) || value.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
    throw invalidInput(`${what} must be an array of numbers`);
  }
};

const LINE_STYLE = oneOf('solid', 'dashed', 'dotted');
const STROKE = record({
  width: nonNegative,
  color,
  opacity,
  lineStyle: LINE_STYLE,
  dashArray: numbers,
});
const POINT = record({
  shape: oneOf('circle', 'square', 'triangle', 'star', 'icon'),
  size: nonNegative,
  fillColor: color,
  fillOpacity: opacity,
  strokeColor: color,
  strokeWidth: nonNegative,
  strokeOpacity: opacity,
  iconId: string,
});

const SELECTION_STYLE_CHECKS = {
  boundingBox: record({ stroke: STROKE, margin: nonNegative }),
  resizeHandle: record({ point: POINT }),
  rotateHandle: record({ point: POINT, distance: nonNegative, connector: STROKE }),
  vertexHandle: record({ point: POINT, selected: POINT, followed: POINT }),
  midpointHandle: record({ point: POINT }),
  radiusHandle: record({ point: POINT }),
  centerMarker: record({ point: POINT }),
  radiusLine: record({ stroke: STROKE }),
  boxSelection: record({
    fillColor: color,
    fillOpacity: opacity,
    strokeColor: color,
    strokeWidth: nonNegative,
  }),
};

const RUNTIME_CHECKS: Readonly<Record<string, (value: unknown, what: string) => void>> = {
  messages(value, what) {
    if (!isRecord(value)) throw invalidInput(`${what} must be an object`);
    onlyKeys(value, Object.keys(MESSAGES_EN), what);
    for (const [key, entry] of Object.entries(value)) {
      const expected = typeof MESSAGES_EN[key as keyof typeof MESSAGES_EN];
      if (entry !== undefined && typeof entry !== expected) {
        throw invalidInput(`${what}.${key} must be a ${expected}`);
      }
    }
  },
  autoName(value, what) {
    if (value === false) return;
    if (!isRecord(value)) throw invalidInput(`${what} must be false or an object`);
    checkFields(value, what, {
      typeNames(names, where) {
        if (!isRecord(names)) throw invalidInput(`${where} must be an object`);
        for (const [key, name] of Object.entries(names)) {
          if (name !== undefined) string(name, `${where}.${key}`);
        }
      },
      formatter: func,
    });
  },
  style: record({
    point: featureStyle,
    line: featureStyle,
    polygon: featureStyle,
    circle: featureStyle,
    image: featureStyle,
  }),
  previewStyle: featureStyle,
  selectionStyle: record(SELECTION_STYLE_CHECKS),
  scaleWithZoom: bool,
  snapping: record({
    enabled: bool,
    tolerancePx: nonNegative,
    disableKey: oneOf('alt', 'shift', 'ctrl', 'meta', 'none'),
    kinds: record({ vertex: bool, edge: bool, intersection: bool, guide: bool }),
    datasets: bool,
    guideStepDegrees: positive,
  }),
  tracing: record({ enabled: bool }),
  topology: record({ sharedVertexDrag: bool }),
  clickTolerance: nonNegative,
  dragThreshold: nonNegative,
  rendering: record({
    renderScale: positive,
    pixelRatio: positive,
    cacheGeometry: bool,
    timeSlicing: bool,
  }),
  isExternalEntry: func,
};

/**
 * Checks the options of `createDraw`
 *
 * @throws `DrawError` with the code `invalid-input` for an unknown option or a value of the
 *   wrong type
 * @internal
 */
export function checkDrawOptions(options: unknown): asserts options is DrawOptions {
  if (!isRecord(options)) throw invalidInput('The options must be an object');
  checkFields(options, 'options', {
    ...RUNTIME_CHECKS,
    defaultMode: string,
    initDefaultLayer: bool,
    store(value, what) {
      if (!isRecord(value) && !(value instanceof DrawStore)) {
        throw invalidInput(`${what} must be a Store`);
      }
      const store = value as Record_;
      for (const method of ['subscribe', 'transact', 'getFeature', 'createFeature']) {
        if (typeof store[method] !== 'function') throw invalidInput(`${what} must be a Store`);
      }
    },
  });
}

/**
 * Checks a patch of `draw.options.update`
 *
 * @internal
 */
function checkPatch(patch: unknown): asserts patch is Partial<RuntimeOptions> {
  if (!isRecord(patch)) throw invalidInput('The options must be an object');
  for (const key of CREATION_KEYS) {
    if (key in patch) throw invalidInput(`${key} can only be given when the instance is created`);
  }
  checkFields(patch, 'options', RUNTIME_CHECKS);
}

// ============================================================================
// Merging
// ============================================================================

/**
 * The options with a patch merged in: plain objects are merged key by key, every other value
 * (a function, an array, `false`) replaces the one before, and a key given as `undefined`
 * keeps it
 *
 * @internal
 */
export function mergeOptions<T extends object>(base: T, patch: Partial<T>): T {
  const result: Record_ = { ...(base as Record_) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const before = result[key];
    result[key] = isRecord(value) && isRecord(before) ? mergeOptions(before, value) : value;
  }
  return result as T;
}

/** The options that change while the instance runs, out of the options of `createDraw` */
function runtimePart(options: DrawOptions): RuntimeOptions {
  const result: Record_ = {};
  for (const key of RUNTIME_KEYS) {
    if (options[key] !== undefined) result[key] = options[key];
  }
  return mergeOptions({}, result) as RuntimeOptions;
}

// ============================================================================
// The configuration of the engine
// ============================================================================

/** The alpha of a CSS color, 1 when there is none */
function alphaOf(css: string | undefined): number {
  return css === undefined ? 1 : toColor(css)[3];
}

/** A color with another alpha */
function withAlpha(color: Color, alpha: number): Color {
  return [color[0], color[1], color[2], alpha];
}

/**
 * A stroke with the stroke keys of a style: the opacity is folded into the alpha of the color,
 * as the style of a feature does
 */
function applyStroke(stroke: StrokeStyle, style: FeatureStyle, lineStyle = true): void {
  if (style.strokeColor !== undefined || style.strokeOpacity !== undefined) {
    const base = style.strokeColor !== undefined ? toColor(style.strokeColor) : stroke.color;
    const alpha =
      style.strokeOpacity !== undefined
        ? alphaOf(style.strokeColor) * style.strokeOpacity
        : base[3];
    stroke.color = withAlpha(base, alpha);
  }
  if (style.strokeWidth !== undefined) stroke.width = style.strokeWidth;
  if (lineStyle && style.lineStyle !== undefined) stroke.lineStyle = style.lineStyle;
}

/** A point marker with the point and stroke keys of a style */
function applyPoint(point: PointStyle, style: FeatureStyle): void {
  if (style.pointShape !== undefined) point.shape = style.pointShape;
  if (style.pointRadius !== undefined) point.size = style.pointRadius * 2;
  if (style.pointColor !== undefined) point.fillColor = withAlpha(toColor(style.pointColor), 1);
  if (style.pointColor !== undefined || style.pointOpacity !== undefined) {
    point.fillOpacity = alphaOf(style.pointColor) * (style.pointOpacity ?? 1);
  }
  if (style.strokeColor !== undefined) {
    point.strokeColor = withAlpha(toColor(style.strokeColor), 1);
  }
  if (style.strokeColor !== undefined || style.strokeOpacity !== undefined) {
    point.strokeOpacity =
      alphaOf(style.strokeColor) * (style.strokeOpacity ?? style.pointOpacity ?? 1);
  }
  if (style.strokeWidth !== undefined) point.strokeWidth = style.strokeWidth;
}

/** A fill with the fill keys of a style; a color without an opacity keeps the alpha before */
function applyFill(fill: { color: Color }, style: FeatureStyle): void {
  if (style.fillColor === undefined && style.fillOpacity === undefined) return;
  const base = style.fillColor !== undefined ? toColor(style.fillColor) : fill.color;
  const alpha = alphaOf(style.fillColor) * (style.fillOpacity ?? fill.color[3]);
  fill.color = withAlpha(base, alpha);
}

/**
 * The look of the features for the options: the defaults of each type and the look of the
 * geometry being drawn
 *
 * @internal
 */
export function toFeatureStyleConfig(options: RuntimeOptions): FeatureStyleConfig {
  const config = structuredClone(DEFAULT_FEATURE_STYLE_CONFIG);
  const style = options.style ?? {};
  if (style.point) applyPoint(config.point.point, style.point);
  if (style.line) applyStroke(config.lineString.stroke, style.line);
  if (style.polygon) {
    applyStroke(config.polygon.stroke, style.polygon);
    applyFill(config.polygon.fill, style.polygon);
  }
  if (style.circle) {
    const circle = structuredClone(config.polygon);
    applyStroke(circle.stroke, style.circle);
    applyFill(circle.fill, style.circle);
    config.circle = circle;
  }
  if (style.image?.imageOpacity !== undefined) {
    config.image = { opacity: style.image.imageOpacity };
  }

  const preview = options.previewStyle;
  if (preview) {
    const tentative = config.tentative;
    applyStroke(tentative.stroke, preview);
    // The line to the pointer keeps its dashes
    applyStroke(tentative.tentativeStroke, preview, false);
    for (const vertex of [tentative.vertex, tentative.highlightedVertex]) {
      applyPoint(vertex, { ...preview, strokeWidth: undefined });
    }
    // The highlighted vertex stays larger than the others
    if (preview.pointRadius !== undefined) {
      tentative.highlightedVertex.size = preview.pointRadius * 2 + 4;
    }
    for (const marker of [tentative.circleCenterMarker, tentative.circleRadiusHandle]) {
      if (preview.strokeColor !== undefined) {
        marker.strokeColor = withAlpha(toColor(preview.strokeColor), 1);
      }
    }
  }
  return config;
}

/** A stroke of the selection from its options */
function toStroke(stroke: StrokeStyle, given: Record_ | undefined): void {
  if (!given) return;
  if (given.color !== undefined) stroke.color = toColor(given.color as string);
  if (given.width !== undefined) stroke.width = given.width as number;
  if (given.opacity !== undefined) stroke.opacity = given.opacity as number;
  if (given.lineStyle !== undefined) stroke.lineStyle = given.lineStyle as StrokeStyle['lineStyle'];
  if (given.dashArray !== undefined) stroke.dashArray = [...(given.dashArray as number[])];
}

/** A handle of the selection from its options */
function toPoint(point: PointStyle, given: Record_ | undefined): void {
  if (!given) return;
  for (const [key, value] of Object.entries(given)) {
    if (value === undefined) continue;
    const target = point as unknown as Record_;
    target[key] = key === 'fillColor' || key === 'strokeColor' ? toColor(value as string) : value;
  }
}

/**
 * The look of the selection for the options
 *
 * @internal
 */
export function toSelectionConfig(options: RuntimeOptions): SelectionUIConfig {
  const config = structuredClone(DEFAULT_SELECTION_CONFIG);
  const given = (options.selectionStyle ?? {}) as Record<string, Record_ | undefined>;
  const part = (key: keyof SelectionStyleOptions): Record_ => given[key] ?? {};
  const sub = (key: keyof SelectionStyleOptions, name: string) =>
    part(key)[name] as Record_ | undefined;

  toStroke(config.boundingBox.stroke, sub('boundingBox', 'stroke'));
  if (part('boundingBox').margin !== undefined) {
    config.boundingBox.margin = part('boundingBox').margin as number;
  }
  toPoint(config.resizeHandle.point, sub('resizeHandle', 'point'));
  toPoint(config.rotateHandle.point, sub('rotateHandle', 'point'));
  toStroke(config.rotateHandle.connector, sub('rotateHandle', 'connector'));
  if (part('rotateHandle').distance !== undefined) {
    config.rotateHandle.distance = part('rotateHandle').distance as number;
  }
  toPoint(config.vertexHandle.point, sub('vertexHandle', 'point'));
  toPoint(config.vertexHandle.selected, sub('vertexHandle', 'selected'));
  toPoint(config.vertexHandle.followed, sub('vertexHandle', 'followed'));
  toPoint(config.midpointHandle.point, sub('midpointHandle', 'point'));
  toPoint(config.radiusHandle.point, sub('radiusHandle', 'point'));
  toPoint(config.centerMarker.point, sub('centerMarker', 'point'));
  toStroke(config.radiusLine.stroke, sub('radiusLine', 'stroke'));
  return config;
}

/**
 * The rectangle of a box selection for the options
 *
 * @internal
 */
export function toBoxSelectionStyle(options: RuntimeOptions): BoxSelectionStyleConfig {
  const config = structuredClone(DEFAULT_BOX_SELECTION_STYLE_CONFIG);
  const box = options.selectionStyle?.boxSelection as
    | Partial<NonNullable<SelectionStyleOptions['boxSelection']>>
    | undefined;
  if (!box) return config;
  if (box.fillColor !== undefined || box.fillOpacity !== undefined) {
    const base = box.fillColor !== undefined ? toColor(box.fillColor) : config.fillColor;
    config.fillColor = withAlpha(
      base,
      alphaOf(box.fillColor) * (box.fillOpacity ?? config.fillColor[3]),
    );
  }
  if (box.strokeColor !== undefined) config.strokeColor = toColor(box.strokeColor);
  if (box.strokeWidth !== undefined) config.strokeWidth = box.strokeWidth;
  return config;
}

/** The configuration of the automatic names */
function toAutoName(autoName: RuntimeOptions['autoName']): AutoNameConfig | boolean {
  if (autoName === undefined) return true;
  if (autoName === false) return false;
  return { enabled: true, typeNames: autoName.typeNames, formatter: autoName.formatter };
}

/**
 * The options of the engine for the options of `createDraw`
 *
 * @param isExternalEntry - The function the engine asks about the entries of the stacking
 *   order; the one of the options is reached through it, so that it can change
 * @internal
 */
export function toEngineOptions(
  options: DrawOptions,
  isExternalEntry: (id: string) => boolean,
): EngineOptions {
  const runtime = runtimePart(options);
  const result: EngineOptions = {
    messages: runtime.messages,
    autoName: toAutoName(runtime.autoName),
    // Always given, so that the engine gets copies it can change in place
    style: toFeatureStyleConfig(runtime),
    selectionStyle: toSelectionConfig(runtime),
    renderingStyle: {
      boxSelectionStyle: toBoxSelectionStyle(runtime),
      storeRetained: runtime.rendering?.cacheGeometry ?? true,
      timeSlicing: runtime.rendering?.timeSlicing ?? true,
    },
    snap: runtime.snapping,
    trace: runtime.tracing,
    topology: runtime.topology,
    pixelRatio: runtime.rendering?.pixelRatio,
    isExternalEntry,
  };
  if (options.defaultMode !== undefined) result.defaultMode = options.defaultMode;
  if (options.initDefaultLayer !== undefined) result.initDefaultLayer = options.initDefaultLayer;
  if (runtime.scaleWithZoom !== undefined) result.scaleWithZoom = runtime.scaleWithZoom;
  if (runtime.clickTolerance !== undefined) result.clickTolerance = runtime.clickTolerance;
  if (runtime.dragThreshold !== undefined) result.dragThreshold = runtime.dragThreshold;
  if (options.store !== undefined) {
    // A Store of the library is used as it is; the Store of an application keeps the document,
    // and the instance keeps the state of this client around it
    result.store =
      options.store instanceof DrawStore
        ? options.store
        : (options.store as unknown as DocumentStore);
  }
  return result;
}

// ============================================================================
// draw.options
// ============================================================================

/**
 * Changes an object of the configuration in place to the value of another, so that everything
 * holding it sees the new value
 */
function assignInPlace(target: Record_, source: Record_): void {
  for (const key of Object.keys(target)) {
    if (!(key in source)) delete target[key];
  }
  for (const [key, value] of Object.entries(source)) {
    const before = target[key];
    if (isRecord(value) && isRecord(before)) assignInPlace(before, value);
    else target[key] = value;
  }
}

/**
 * The options of a running instance
 *
 * @internal
 */
export interface OptionsState extends OptionsResource {
  /** Applies the options given at creation that the engine does not take (the render scale) */
  applyCreation(): void;
}

/**
 * Creates `draw.options` over the engine
 *
 * @param engine - The engine of the instance
 * @param options - The options the instance was created with
 * @param setExternalEntry - Replaces the function that tells the entries from outside the
 *   document
 * @internal
 */
export function createOptions(
  engine: Engine,
  options: DrawOptions,
  setExternalEntry: (fn: ((id: string) => boolean) | undefined) => void,
): OptionsState {
  const { context, map, customLayer } = engine;
  let current = runtimePart(options);

  const apply = (patch: Partial<RuntimeOptions>): void => {
    let redraw = false;
    let rebuild = false;
    const next = current;

    if (patch.messages !== undefined) {
      Object.assign(context.messages, resolveMessages(next.messages));
    }
    if (patch.autoName !== undefined) {
      context.autoNameGenerator.configure(toAutoName(next.autoName));
    }
    if (patch.style !== undefined || patch.previewStyle !== undefined) {
      assignInPlace(
        context.featureStyle as unknown as Record_,
        toFeatureStyleConfig(next) as unknown as Record_,
      );
      rebuild = true;
    }
    if (patch.selectionStyle !== undefined) {
      assignInPlace(
        context.selectionStyle as unknown as Record_,
        toSelectionConfig(next) as unknown as Record_,
      );
      assignInPlace(
        context.renderingConfig.boxSelectionStyle as unknown as Record_,
        toBoxSelectionStyle(next) as unknown as Record_,
      );
      rebuild = true;
    }
    if (patch.scaleWithZoom !== undefined) context.options.scaleWithZoom = patch.scaleWithZoom;

    const snapping = patch.snapping;
    if (snapping) {
      const { snapService, snapOptions } = context;
      if (snapping.enabled !== undefined) snapService.setEnabled(snapping.enabled);
      if (snapping.tolerancePx !== undefined) {
        snapService.setTolerance(snapping.tolerancePx);
        snapOptions.tolerancePx = snapping.tolerancePx;
      }
      if (snapping.disableKey !== undefined) {
        snapService.setDisableKey(snapping.disableKey);
        // The shared vertices read the same key
        snapOptions.disableKey = snapping.disableKey;
      }
      for (const [kind, enabled] of Object.entries(snapping.kinds ?? {})) {
        if (enabled === undefined) continue;
        snapService.setKindEnabled(kind as keyof NonNullable<typeof snapping.kinds>, enabled);
      }
      if (snapping.datasets !== undefined) snapService.setDatasetsEnabled(snapping.datasets);
      if (snapping.guideStepDegrees !== undefined) {
        snapService.setGuideStep(snapping.guideStepDegrees);
      }
    }
    if (patch.tracing?.enabled !== undefined) context.trace.enabled = patch.tracing.enabled;
    if (patch.topology?.sharedVertexDrag !== undefined) {
      context.topology.sharedVertexDrag = patch.topology.sharedVertexDrag;
    }
    if (patch.clickTolerance !== undefined) {
      context.options.clickTolerance = patch.clickTolerance;
      context.hitTestService.setClickTolerance(patch.clickTolerance);
    }
    if (patch.dragThreshold !== undefined) {
      context.options.dragThreshold = patch.dragThreshold;
      engine.runtime.setDragThreshold(patch.dragThreshold);
    }

    const rendering = patch.rendering;
    if (rendering) {
      if (rendering.renderScale !== undefined) {
        if (context.pixelRatioSource.setScaleFactor(rendering.renderScale)) redraw = true;
      }
      if (rendering.pixelRatio !== undefined) {
        context.pixelRatio = rendering.pixelRatio;
        if (context.pixelRatioSource.setPixelRatio(rendering.pixelRatio)) redraw = true;
      }
      if (rendering.cacheGeometry !== undefined) {
        context.renderingConfig.storeRetained = rendering.cacheGeometry;
        rebuild = true;
      }
      if (rendering.timeSlicing !== undefined) {
        engine.runtime.setTimeSlicing(rendering.timeSlicing);
        rebuild = true;
      }
    }
    if (patch.isExternalEntry !== undefined) {
      setExternalEntry(patch.isExternalEntry);
      rebuild = true;
    }

    if (rebuild && 'refresh' in customLayer) customLayer.refresh();
    else if (redraw) map.triggerRepaint();
  };

  return {
    get(): Readonly<RuntimeOptions> {
      const { snapService, trace, topology, pixelRatioSource, renderingConfig } = context;
      const snap = snapService.getOptions();
      const values: RuntimeOptions = {
        ...current,
        scaleWithZoom: context.options.scaleWithZoom,
        clickTolerance: context.options.clickTolerance,
        dragThreshold: context.options.dragThreshold,
        snapping: {
          enabled: snap.enabled,
          tolerancePx: snap.tolerancePx,
          disableKey: snap.disableKey,
          kinds: { ...snap.kinds },
          datasets: snap.datasets,
          guideStepDegrees: snap.guideStepDegrees,
        },
        tracing: { enabled: trace.enabled },
        topology: { sharedVertexDrag: topology.sharedVertexDrag },
        rendering: {
          ...current.rendering,
          renderScale: pixelRatioSource.getScaleFactor(),
          cacheGeometry: renderingConfig.storeRetained !== false,
          timeSlicing: renderingConfig.timeSlicing !== false,
        },
      };
      return structuredCloneOptions(values);
    },

    update(patch: Partial<RuntimeOptions>): void {
      checkPatch(patch);
      current = mergeOptions(current, patch);
      apply(patch);
    },

    applyCreation(): void {
      const scale = current.rendering?.renderScale;
      if (scale !== undefined) apply({ rendering: { renderScale: scale } });
    },
  };
}

/** A copy of the options that shares the functions and nothing else */
function structuredCloneOptions<T>(value: T): T {
  if (Array.isArray(value)) return value.map(structuredCloneOptions) as T;
  if (!isRecord(value)) return value;
  const copy: Record_ = {};
  for (const [key, entry] of Object.entries(value)) copy[key] = structuredCloneOptions(entry);
  return copy as T;
}
