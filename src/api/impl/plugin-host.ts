// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.use` and the `plugins` option: a plugin of `/extend` put into the extensions of the
 * engine
 *
 * A plugin is installed as an extension of the engine, so that what it adds is removed with it
 * by the same path: its types, modes, companions and overlay go into the registries the engine
 * reads, through the adapters there. What the library calls of a plugin and throws is told in
 * `status.problems`, the same failure once, its count added to.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import type { ModeManager } from '../../modes/manager.js';
import type { Feature as StoredFeature } from '../../store/types.js';
import type { Draw } from '../draw.js';
import { DrawError } from '../errors.js';
import type {
  HandleContext as EngineHandleContext,
  PluginContext as EnginePluginContext,
  TerrainSurface as EngineTerrainSurface,
  ScreenContext,
} from '../extension/context.js';
import type {
  CustomHandle as EngineCustomHandle,
  Footprint as EngineFootprint,
  Handle as EngineHandle,
  FeatureTypeDefinition as EngineTypeDefinition,
} from '../extension/feature-type.js';
import type { DrawPointerEvent, ModeFactory, ModeHandler } from '../extension/mode.js';
import type { Plugin as EnginePlugin } from '../extension/plugin.js';
import type {
  CompanionProvider,
  SnapCandidate as EngineSnapCandidate,
  HandleProvider,
} from '../extension/provider.js';
import type { RenderContext as EngineRenderContext, OverlayRenderer } from '../extension/render.js';
import type { ExtensionsCollections } from '../extensions.js';
import type {
  Feature,
  FeatureRow,
  FeatureStyleResolved,
  FeatureType,
  Properties,
} from '../model.js';
import type {
  CompanionSource,
  CustomHandle,
  FeatureTypeDefinition,
  Footprint,
  Handle,
  HandleContext,
  HandleSource,
  ModeDefinition,
  ModeInput,
  OverlayShape,
  Plugin,
  PluginContext,
  PointerInput,
  RenderContext,
  Rendered,
  ScreenPointContext,
  ScreenProjection,
  SnapCandidate,
  TerrainSurface,
} from '../plugin/types.js';
import type { LayerTableView, RowRef } from '../tables.js';
import { GEOMETRY_OF_FEATURE } from './extensions.js';
import { featureForExtension, readFeatureFields } from './feature-shape.js';
import {
  boxShape,
  drawShape,
  engineFootprintOf,
  hitShape,
  positionCount,
  readShape,
  type Shape,
  snapShape,
} from './plugin-shapes.js';
import type { ProblemInput } from './status.js';

/** The prefix of the names of the library, which a type or a mode of a plugin cannot take */
const RESERVED_PREFIX = 'maplibre-gl-draw:';
/** The most shapes the overlay of one plugin holds */
const MAX_OVERLAY_SHAPES = 1_000;
/** The most positions the overlay of one plugin holds, all its shapes together */
const MAX_OVERLAY_POSITIONS = 10_000;

/**
 * What the plugins are put into
 *
 * @internal
 */
export interface PluginUseDeps {
  /** The collections of the extensions of the engine */
  readonly collections: ExtensionsCollections;
  readonly map: MapLibreMap;
  readonly modeManager: Pick<ModeManager, 'isRepeating'>;
  /** The candidates of a hit are looked for this much farther for a box of the screen */
  readonly hitTestService: {
    registerCandidateReach(type: string, reachPx: () => number): () => void;
  };
  /** The look a feature of the Store is drawn with */
  appliedStyle(feature: StoredFeature): FeatureStyleResolved;
  getDraw(): Draw;
  /** Whether an image of the map is being made, which leaves the overlays out */
  isCapturing(): boolean;
  /** Keeps a failure in `status.problems`, the same failure (`key`) once */
  report(problem: ProblemInput, key: string): void;
}

/**
 * Adds a plugin
 *
 * @internal
 */
export type PluginUse = <Api>(
  plugin: Plugin<Api>,
  options?: { readonly signal?: AbortSignal },
) => Api;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Throws unless the named members are functions, or left out where they are optional */
function requireFunctions(
  what: string,
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): void {
  for (const member of required) {
    if (typeof value[member] !== 'function') {
      throw new DrawError('invalidInput', `The ${what} must have the function ${member}`);
    }
  }
  for (const member of optional) {
    if (value[member] !== undefined && typeof value[member] !== 'function') {
      throw new DrawError('invalidInput', `The ${what} has ${member} that is not a function`);
    }
  }
}

/** The name of a definition, checked: a non-empty string not of the library */
function nameOf(what: string, value: unknown): string {
  if (!isObject(value)) throw new DrawError('invalidInput', `The ${what} must be an object`);
  const name = value.name;
  if (typeof name !== 'string' || name === '') {
    throw new DrawError('invalidInput', `The ${what} must have a non-empty name`);
  }
  if (name.startsWith(RESERVED_PREFIX)) {
    throw new DrawError(
      'invalidInput',
      `The name of the ${what} ${JSON.stringify(name)} starts with ${RESERVED_PREFIX}, which the library keeps`,
    );
  }
  return name;
}

const HANDLE_MEMBERS = [
  'handles',
  'drawHandles',
  'onHandleDragStart',
  'onHandleDrag',
  'onHandleDragEnd',
] as const;

/** The conversion of the engine as the plugins read it */
function projectionOf(screen: ScreenContext): ScreenProjection {
  return {
    project: (at) => screen.project(at),
    unproject: (point) => screen.unproject([point[0], point[1]]),
    metersPerPixel: (at) => screen.metersPerPixel(at),
    get zoom() {
      return screen.zoom;
    },
    get pixelRatio() {
      return screen.pixelRatio;
    },
  };
}

/** A footprint of the engine as the plugins read it */
function footprintOfEngine(footprint: EngineFootprint | null): Footprint | null {
  if (footprint === null) return null;
  if (footprint.kind === 'ground') return { kind: 'ground', corners: footprint.corners };
  return {
    kind: 'screen',
    position: footprint.position,
    halfWidthPixels: footprint.halfWidthPx,
    halfHeightPixels: footprint.halfHeightPx,
  };
}

/** What a drag or a click of the engine is, as an input of the pointer */
function pointerInputOf(type: PointerInput['type'], event: DrawPointerEvent): PointerInput {
  return {
    type,
    position: event.lngLat,
    snapped: event.snapped.lngLat,
    screenPoint: event.point,
    original: event.original,
  };
}

/** A row of a feature, read from the feature itself */
function rowOfFeature(feature: Feature): FeatureRow {
  const fields = readFeatureFields(feature);
  let bbox: [number, number, number, number] | null | undefined;
  return {
    id: feature.id,
    featureType: fields.featureType,
    layerId: fields.layerId ?? '',
    groupId: fields.groupId,
    visible: fields.visible,
    locked: fields.locked,
    get bbox() {
      bbox ??= (readShape(feature.geometry)?.bbox ?? null) as
        | [number, number, number, number]
        | null;
      return bbox;
    },
    property: (key) => (feature.properties as Record<PropertyKey, unknown>)[key] as never,
    toFeature: () => feature,
  };
}

/** A row of a layer held as rows: what is not a value of a key is read from its feature */
function rowOfView(view: LayerTableView, row: RowRef): FeatureRow {
  let made: Feature | undefined;
  const feature = (): Feature => {
    const stored = made === undefined ? view.getRow(row) : undefined;
    if (stored) made = featureForExtension(stored);
    if (!made) throw new DrawError('notFound', 'The row is gone');
    return made;
  };
  return {
    get id() {
      return feature().id;
    },
    featureType: view.getRowType(row) as FeatureType,
    layerId: view.layerId,
    get groupId() {
      return readFeatureFields(feature()).groupId;
    },
    get visible() {
      return readFeatureFields(feature()).visible;
    },
    get locked() {
      return readFeatureFields(feature()).locked;
    },
    get bbox() {
      return view.getRowBBox(row) as [number, number, number, number] | null;
    },
    property: (key) => view.getRowValue(row, String(key)) as never,
    toFeature: feature,
  };
}

/**
 * Creates `draw.use`
 *
 * @internal
 */
export function createPluginUse(deps: PluginUseDeps): PluginUse {
  // The render contexts of the engine as the plugins read them, one each
  const renderContexts = new WeakMap<EngineRenderContext, RenderContext>();
  const projections = new WeakMap<ScreenContext, ScreenProjection>();
  const terrains = new WeakMap<EngineTerrainSurface, TerrainSurface>();

  const projection = (screen: ScreenContext): ScreenProjection => {
    let made = projections.get(screen);
    if (!made) {
      made = projectionOf(screen);
      projections.set(screen, made);
    }
    return made;
  };
  const terrainOf = (terrain: EngineTerrainSurface): TerrainSurface => {
    let made = terrains.get(terrain);
    if (!made) {
      made = {
        elevation: (at) => terrain.elevation(at),
        occlusionOpacity: (at) => terrain.occlusionOpacity(at),
        elevationVersion: () => terrain.generation(),
      };
      terrains.set(terrain, made);
    }
    return made;
  };
  const renderContextOf = (context: EngineRenderContext): RenderContext => {
    let made = renderContexts.get(context);
    if (!made) {
      made = {
        screen: projection(context.screen),
        terrain: terrainOf(context.terrain),
        opacity: context.opacity,
        line: {
          draw: (coordinates, style, options) =>
            context.line.draw(
              coordinates,
              {
                width: style.width,
                color: style.color,
                opacity: style.opacity,
                lineStyle: style.lineStyle,
              },
              options && {
                ...(options.closed !== undefined && { closed: options.closed }),
                ...(options.widthUnit !== undefined && { widthUnit: options.widthUnit }),
                ...(options.referenceZoom !== undefined && {
                  referenceZoom: options.referenceZoom,
                }),
              },
            ),
        },
        fill: {
          draw: (rings, style) =>
            context.fill.draw(rings, { color: style.color, opacity: style.opacity }),
        },
        point: {
          draw: (at, style, options) =>
            context.point.draw(
              at,
              {
                shape: style.shape,
                size: style.sizePixels,
                fillColor: style.fillColor,
                fillOpacity: style.fillOpacity,
                strokeColor: style.strokeColor,
                strokeWidth: style.strokeWidth,
                strokeOpacity: style.strokeOpacity,
              },
              options?.referenceZoom === undefined
                ? undefined
                : { referenceZoom: options.referenceZoom },
            ),
        },
        appliedStyle: (feature) => context.appliedStyle(feature),
      };
      renderContexts.set(context, made);
    }
    return made;
  };

  return function use<Api>(plugin: Plugin<Api>, options?: { readonly signal?: AbortSignal }): Api {
    const name = nameOf('plugin', plugin);
    requireFunctions('plugin', plugin as unknown as Record<string, unknown>, ['setup'], []);
    if (options !== undefined && !isObject(options)) {
      throw new DrawError('invalidInput', 'The options must be an object');
    }
    const given = options?.signal;
    if (given !== undefined && !(given instanceof AbortSignal)) {
      throw new DrawError('invalidInput', 'The signal must be an AbortSignal');
    }

    const controller = new AbortController();
    let removed = false;
    let api: Api | undefined;
    /** What is added beside the collections, taken back with the plugin */
    const extras: Array<() => void> = [];
    /** The modes of the plugin, left when it is removed */
    const modes = new Set<string>();

    const failed = (part: string, error: unknown): void => {
      const message = error instanceof Error ? error.message : String(error);
      deps.report(
        {
          type: 'failed',
          error: new DrawError(
            'invalidState',
            `The plugin ${JSON.stringify(name)} failed in ${part}: ${message}`,
            { cause: error },
          ),
          label: name,
          commit: null,
          count: 1,
        },
        `plugin\u0000${name}\u0000${part}\u0000${message}`,
      );
    };
    /** Calls what the plugin gave, a failure told as a problem and answered by `fallback` */
    const call = <T>(part: string, run: () => T, fallback: T): T => {
      try {
        return run();
      } catch (error) {
        failed(part, error);
        return fallback;
      }
    };
    /**
     * A renderer of the plugin that stops once it throws: it is not called again until the plugin
     * is added again, and the library draws on
     */
    const stoppedOnFailure = (
      part: string,
      run: (feature: Feature, context: EngineRenderContext) => void,
    ): ((feature: Feature, context: EngineRenderContext) => void) => {
      let stopped = false;
      return (feature, context) => {
        if (stopped) return;
        try {
          run(feature, context);
        } catch (error) {
          stopped = true;
          failed(part, error);
        }
      };
    };
    const takeBack = (): void => {
      for (const take of extras.splice(0).reverse()) take();
    };

    const installed: EnginePlugin = {
      name,
      onAdd(engine) {
        try {
          api = plugin.setup(contextOf(engine));
        } catch (error) {
          removed = true;
          controller.abort();
          takeBack();
          throw error;
        }
      },
      onRemove() {
        removed = true;
        // A mode of the plugin is left first, then the plugin is told, then what it added goes
        const draw = deps.getDraw();
        if (modes.has(draw.getMode())) draw.setMode('select');
        controller.abort();
        takeBack();
      },
    };

    /** The context of the plugin over the context of the engine */
    function contextOf(engine: EnginePluginContext): PluginContext {
      const { extensions } = engine;
      const open = (what: string): void => {
        if (removed) {
          throw new DrawError(
            'invalidState',
            `The plugin ${JSON.stringify(name)} is removed: it cannot add ${what}`,
          );
        }
      };
      const handleContextOf = (context: EngineHandleContext): HandleContext => ({
        screen: projection(context.screen),
        get selectionBox() {
          return footprintOfEngine(context.selectionBox);
        },
        get selectionStyle() {
          return context.selectionStyle;
        },
      });
      // The handles the plugin gave, kept with those of the engine made of them
      const givenHandles = new WeakMap<EngineHandle, Handle>();
      const engineHandleOf = (handle: Handle): EngineHandle => {
        const cursor = handle.cursor !== undefined && { cursor: handle.cursor };
        const made: EngineHandle =
          handle.kind === 'custom'
            ? {
                kind: 'custom',
                id: handle.id,
                position: handle.position,
                sizePx: handle.sizePixels,
                ...cursor,
              }
            : { kind: handle.kind, id: handle.id, position: handle.position, ...cursor };
        givenHandles.set(made, handle);
        return made;
      };
      const handleOf = (handle: EngineHandle): Handle =>
        givenHandles.get(handle) ??
        (handle.kind === 'custom'
          ? {
              kind: 'custom',
              id: handle.id,
              position: handle.position,
              sizePixels: handle.sizePx,
              ...(handle.cursor !== undefined && { cursor: handle.cursor }),
            }
          : handle);
      const customOf = (handle: EngineCustomHandle): CustomHandle =>
        handleOf(handle) as CustomHandle;

      /** The members of the handles of a source as those of the engine */
      const handleMembersOf = <F extends Feature | null>(
        source: HandleSource<Properties, F>,
        label: string,
      ) => {
        const { drawHandles, onHandleDragStart, onHandleDrag, onHandleDragEnd } = source;
        return {
          ...(drawHandles && {
            drawHandles(
              feature: F,
              handles: readonly EngineCustomHandle[],
              context: EngineRenderContext,
            ) {
              call(
                `drawHandles of ${label}`,
                () =>
                  drawHandles.call(
                    source,
                    feature,
                    handles.map(customOf),
                    renderContextOf(context),
                  ),
                undefined,
              );
            },
          }),
          ...(onHandleDragStart && {
            onHandleDragStart(feature: F, handle: EngineHandle, event: DrawPointerEvent) {
              return call(
                `onHandleDragStart of ${label}`,
                () =>
                  onHandleDragStart.call(
                    source,
                    feature,
                    handleOf(handle),
                    pointerInputOf('pointerdown', event),
                  ) !== false,
                false,
              );
            },
          }),
          onHandleDrag(feature: F, handle: EngineHandle, event: DrawPointerEvent) {
            if (!onHandleDrag) return null;
            return call(
              `onHandleDrag of ${label}`,
              () =>
                onHandleDrag.call(
                  source,
                  feature,
                  handleOf(handle),
                  pointerInputOf('pointermove', event),
                ),
              null,
            );
          },
          ...(onHandleDragEnd && {
            onHandleDragEnd(
              feature: Feature | null,
              handle: EngineHandle,
              event: DrawPointerEvent,
            ) {
              call(
                `onHandleDragEnd of ${label}`,
                () =>
                  onHandleDragEnd.call(
                    source,
                    feature,
                    handleOf(handle),
                    pointerInputOf('pointerup', event),
                  ),
                undefined,
              );
            },
          }),
        };
      };

      /** The handles a source gives, as those of the engine */
      const handlesOf = (part: string, give: () => readonly Handle[] | undefined): EngineHandle[] =>
        call(part, () => {
          const handles = give() ?? [];
          if (!Array.isArray(handles)) throw new TypeError('The handles are not an array');
          return handles.map(engineHandleOf);
        }, []);

      function addFeatureType(definition: FeatureTypeDefinition): void {
        open('a feature type');
        const type = nameOf('feature type', definition);
        requireFunctions(
          'feature type',
          definition as unknown as Record<string, unknown>,
          ['footprint'],
          ['render', 'hitTest', 'snapCandidates', ...HANDLE_MEMBERS],
        );
        const screen = engine.screen;
        const label = `the feature type ${JSON.stringify(type)}`;

        // The footprint of each feature, measured once: the plugin reads the feature and its own
        // measures only. `invalidate` measures the type again
        let version = 0;
        const shapes = new WeakMap<Feature, { version: number; shape: Shape | null }>();
        // How far a box of the screen reaches past its position, the largest measured
        let reach = 0;
        const shapeOf = (feature: Feature): Shape | null => {
          const kept = shapes.get(feature);
          if (kept && kept.version === version) return kept.shape;
          let shape: Shape | null | undefined;
          try {
            shape = readShape(definition.footprint(feature));
            if (shape === undefined) throw new TypeError('It gave a footprint that is not one');
          } catch (error) {
            failed(`footprint of ${label}`, error);
            // The feature is drawn and hit as the geometry it has in the document
            shape = readShape(feature.geometry) ?? null;
          }
          if (shape?.kind === 'screen') reach = Math.max(reach, shape.halfWidth, shape.halfHeight);
          shapes.set(feature, { version, shape });
          return shape;
        };
        const pointerOf = (context: {
          readonly point: [number, number];
          readonly lngLat: GeoJSON.Position;
          readonly tolerancePx: number;
        }): ScreenPointContext => ({
          screenPoint: context.point,
          position: context.lngLat,
          tolerancePixels: context.tolerancePx,
        });
        const { render, hitTest, snapCandidates, handles } = definition;
        const renders = stoppedOnFailure(`render of ${label}`, (feature, context) =>
          render?.call(definition, feature, renderContextOf(context)),
        );

        const installed: EngineTypeDefinition = {
          type,
          // The geometry of each feature decides what the definition does not declare
          geometry: 'GeometryCollection',
          ...(definition.transformFields !== undefined && {
            transformFields: definition.transformFields,
          }),
          ...(definition.defaultStyle !== undefined && { defaultStyle: definition.defaultStyle }),
          ...(definition.styleRuleChannel !== undefined && {
            styleRuleChannel: definition.styleRuleChannel,
          }),
          render: render
            ? (feature, context) => renders(feature, context)
            : (feature, context) => {
                // Without a renderer, its footprint is drawn
                const shape = shapeOf(feature);
                if (shape) drawShape(shape, context.appliedStyle(feature), context);
              },
          footprint: (feature) => {
            const shape = shapeOf(feature);
            return shape ? engineFootprintOf(shape) : null;
          },
          // The extent of the footprint, or of the geometry for a footprint of nothing (null for
          // an empty geometry, which the engine measures itself)
          bbox: (feature) =>
            (shapeOf(feature)?.bbox ?? readShape(feature.geometry)?.bbox ?? null) as never,
          hitTest(feature, context) {
            // What this client moves as a whole is not hit
            if (context.excludeIds?.has(feature.id)) return null;
            const pointer = pointerOf(context);
            if (hitTest) {
              const distance = call(
                `hitTest of ${label}`,
                () => hitTest.call(definition, feature, pointer),
                null,
              );
              return typeof distance === 'number' && Number.isFinite(distance)
                ? { distancePx: distance }
                : null;
            }
            const shape = shapeOf(feature);
            const distance = shape ? hitShape(shape, pointer, screen) : null;
            return distance === null ? null : { distancePx: distance };
          },
          boxSelect(feature, box) {
            const shape = shapeOf(feature);
            return shape ? boxShape(shape, box, screen) : false;
          },
          snapCandidates(feature, context) {
            const pointer = pointerOf(context);
            const candidates: readonly SnapCandidate[] = snapCandidates
              ? call(
                  `snapCandidates of ${label}`,
                  () => snapCandidates.call(definition, feature, pointer) ?? [],
                  [],
                )
              : (() => {
                  const shape = shapeOf(feature);
                  return shape ? snapShape(shape, pointer, screen) : [];
                })();
            return candidates.map(
              (candidate): EngineSnapCandidate => ({
                position: candidate.position,
                kind: candidate.kind,
                ...(candidate.priority !== undefined && { priority: candidate.priority }),
              }),
            );
          },
          ...(handles && {
            handles: (feature: Feature, context: EngineHandleContext) =>
              handlesOf(`handles of ${label}`, () =>
                handles.call(definition, feature, handleContextOf(context)),
              ),
            ...handleMembersOf(definition, label),
          }),
        };
        GEOMETRY_OF_FEATURE.add(installed);
        extensions.featureTypes.add(installed);
        // A box of the screen reaches past its position by its size
        const stopReach = deps.hitTestService.registerCandidateReach(type, () => reach);
        const invalidate = (): void => {
          version++;
        };
        invalidations.set(type, invalidate);
        extras.push(() => {
          stopReach();
          invalidations.delete(type);
        });
      }
      // What measures each type of the plugin again
      const invalidations = new Map<string, () => void>();

      function addMode(definition: ModeDefinition): void {
        open('a mode');
        const mode = nameOf('mode', definition);
        requireFunctions(
          'mode',
          definition as unknown as Record<string, unknown>,
          ['input'],
          ['enter', 'exit'],
        );
        if (definition.cursor !== undefined && typeof definition.cursor !== 'string') {
          throw new DrawError('invalidInput', 'The cursor of the mode must be a string');
        }
        const label = `the mode ${JSON.stringify(mode)}`;
        const factory: ModeFactory = (context) => {
          /** Gives an input to the mode: whether it took it */
          const give = (input: ModeInput): boolean =>
            call(
              `input of ${label}`,
              () => {
                const taken = definition.input(input);
                if (taken !== null && typeof taken === 'object' && 'then' in taken) {
                  (taken as Promise<unknown>).then(undefined, (error: unknown) =>
                    failed(`input of ${label}`, error),
                  );
                  return true;
                }
                return taken === true;
              },
              false,
            );
          const pointer =
            (type: PointerInput['type']) =>
            (event: DrawPointerEvent): boolean =>
              give(pointerInputOf(type, event));
          const handler: ModeHandler = {
            onEnter() {
              if (definition.cursor !== undefined) context.cursor.set(definition.cursor);
              const enter = definition.enter;
              if (enter) {
                call(
                  `enter of ${label}`,
                  () => enter.call(definition, { repeat: deps.modeManager.isRepeating() }),
                  undefined,
                );
              }
            },
            onExit() {
              const exit = definition.exit;
              if (exit) call(`exit of ${label}`, () => exit.call(definition), undefined);
            },
            onPointerDown: pointer('pointerdown'),
            onPointerMove: pointer('pointermove'),
            // Past the threshold of a drag, the moves of the pointer are drags of the engine
            onDragStart: pointer('pointermove'),
            onDrag: pointer('pointermove'),
            onPointerUp: pointer('pointerup'),
            onClick: pointer('click'),
            onDoubleClick: pointer('dblclick'),
            onKeyDown(event) {
              const taken = give({ type: 'keydown', key: event.key, original: event.original });
              if (taken || event.key !== 'Escape') return taken;
              // An Escape the mode does not take goes back to select
              deps.getDraw().setMode('select');
              return true;
            },
          };
          return handler;
        };
        extensions.modes.add(mode, factory);
        modes.add(mode);
        extras.push(() => modes.delete(mode));
      }

      function addCompanion(source: CompanionSource): void {
        open('a companion');
        const companion = nameOf('companion', source);
        requireFunctions(
          'companion',
          source as unknown as Record<string, unknown>,
          ['has'],
          ['render', 'hitTest', 'onClick', 'globalHandles', ...HANDLE_MEMBERS],
        );
        const keys = source.dependsOnProperties;
        if (
          keys !== undefined &&
          (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string'))
        ) {
          throw new DrawError(
            'invalidInput',
            'The dependsOnProperties of the companion must be an array of strings',
          );
        }
        const label = `the companion ${JSON.stringify(companion)}`;
        const { has, render, hitTest, onClick, handles, globalHandles } = source;
        const asks = (row: () => FeatureRow): boolean =>
          call(`has of ${label}`, () => has.call(source, row()) === true, false);
        const provider: CompanionProvider = {
          name: companion,
          has: (feature) => asks(() => rowOfFeature(feature)),
          rows: {
            has: (view, row) => asks(() => rowOfView(view, row)),
            ...(keys !== undefined && { classifyKeys: [...keys] }),
          },
          draw: stoppedOnFailure(`render of ${label}`, (feature, context) =>
            render?.call(source, feature, renderContextOf(context)),
          ),
          hitTest(feature, context) {
            if (!hitTest) return null;
            const hit = call(
              `hitTest of ${label}`,
              () =>
                hitTest.call(source, feature, {
                  screenPoint: context.point,
                  position: context.lngLat,
                  tolerancePixels: context.tolerancePx,
                }),
              null,
            );
            return hit ? { id: hit.id, distancePx: hit.distancePixels } : null;
          },
          ...(onClick && {
            onClick: (feature, hit, event) =>
              call(
                `onClick of ${label}`,
                () =>
                  onClick.call(source, feature, hit.id, pointerInputOf('click', event)) === true,
                false,
              ),
          }),
        };
        const handled = handles || globalHandles || HANDLE_MEMBERS.some((m) => source[m]);
        const handleProvider: HandleProvider | null = handled
          ? {
              name: companion,
              handles: (feature, context) =>
                handles
                  ? handlesOf(`handles of ${label}`, () =>
                      handles.call(source, feature, handleContextOf(context)),
                    )
                  : [],
              ...(globalHandles && {
                globalHandles: (context: EngineHandleContext) =>
                  handlesOf(`globalHandles of ${label}`, () =>
                    globalHandles.call(source, handleContextOf(context)),
                  ),
              }),
              ...handleMembersOf<Feature | null>(source, label),
            }
          : null;
        const removeCompanion = extensions.companionProviders.add(provider);
        if (handleProvider) {
          try {
            extensions.handleProviders.add(handleProvider);
          } catch (error) {
            removeCompanion();
            throw error;
          }
        }
      }

      // The overlay of the plugin: added with its first shapes
      let overlay: readonly OverlayShape[] = [];
      let overlayAdded = false;
      const looks = new WeakMap<OverlayShape, { shape: Shape; look: FeatureStyleResolved }>();
      const overlayRenderer: OverlayRenderer = {
        name: `\u0000plugin:${name}`,
        draw(context) {
          if (deps.isCapturing()) return;
          for (const given of overlay) {
            const kept = looks.get(given);
            if (kept) drawShape(kept.shape, kept.look, context);
          }
        },
      };
      function setOverlay(shapes: readonly OverlayShape[]): void {
        open('an overlay');
        if (!Array.isArray(shapes)) {
          throw new DrawError('invalidInput', 'The shapes of the overlay must be an array');
        }
        if (shapes.length > MAX_OVERLAY_SHAPES) {
          throw new DrawError(
            'tooLarge',
            `The overlay holds ${MAX_OVERLAY_SHAPES} shapes at most, not ${shapes.length}`,
          );
        }
        let positions = 0;
        const read: Array<{ given: OverlayShape; shape: Shape }> = [];
        for (const given of shapes) {
          const shape = isObject(given) ? readShape(given.geometry) : undefined;
          if (shape?.kind !== 'geometry') {
            throw new DrawError('invalidInput', 'A shape of the overlay must have a geometry');
          }
          if (given.style !== undefined && !isObject(given.style)) {
            throw new DrawError(
              'invalidInput',
              'The style of a shape of the overlay must be an object',
            );
          }
          positions += positionCount(shape.geometry);
          read.push({ given, shape });
        }
        if (positions > MAX_OVERLAY_POSITIONS) {
          throw new DrawError(
            'tooLarge',
            `The overlay holds ${MAX_OVERLAY_POSITIONS} positions at most, not ${positions}`,
          );
        }
        for (const { given, shape } of read) {
          if (looks.has(given)) continue;
          // The look of a shape is that of a feature of its geometry with its style
          const look = deps.appliedStyle({
            id: '',
            type: shape.kind === 'geometry' ? shape.geometry.type : 'Polygon',
            geometry: (shape as Extract<Shape, { kind: 'geometry' }>).geometry,
            layerId: '',
            groupId: undefined,
            properties: {},
            style: { ...(given.style ?? {}) },
            visible: true,
            locked: false,
          } as StoredFeature);
          looks.set(given, { shape, look });
        }
        overlay = [...shapes];
        if (!overlayAdded && overlay.length > 0) {
          extensions.overlays.add(overlayRenderer);
          overlayAdded = true;
        }
        deps.map.triggerRepaint();
      }

      const draw = deps.getDraw();
      const rendered: Rendered = {
        get: (id) => draw.rendered.get(id),
        getMany: (ids) => draw.rendered.getMany(ids),
        getFootprint: (id) => footprintOfEngine(draw.rendered.getFootprint(id)),
        getSelectionBox: (id) => footprintOfEngine(draw.rendered.getSelectionBox(id)),
        changed: draw.rendered.changed,
      };

      return {
        get draw() {
          return deps.getDraw();
        },
        map: deps.map,
        signal: controller.signal,
        addFeatureType: (definition) => addFeatureType(definition as FeatureTypeDefinition),
        addMode,
        addCompanion: (source) => addCompanion(source as CompanionSource),
        setOverlay,
        rendered,
        screen: projection(engine.screen),
        names: { next: (featureType) => engine.names.next(featureType) },
        invalidate(filter) {
          if (filter !== undefined && !isObject(filter)) {
            throw new DrawError('invalidInput', 'The filter must be an object');
          }
          const featureType = filter?.featureType;
          if (featureType === undefined) {
            for (const each of invalidations.values()) each();
            engine.invalidate();
          } else {
            invalidations.get(featureType)?.();
            engine.invalidate({ type: featureType });
          }
        },
        webgl: engine.webgl,
      };
    }

    const remove = deps.collections.plugins.add(installed);
    if (given) {
      if (given.aborted) remove();
      else {
        given.addEventListener('abort', remove, { once: true });
        extras.unshift(() => given.removeEventListener('abort', remove));
      }
    }
    return api as Api;
  };
}
