// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The public surface of the package
 *
 * - The names that src/index.ts (layer 1) and src/webgl/index.ts (layer 2) export are
 *   pinned in two lists (see "The public surface" in CONTRIBUTING.md). Adding or removing a
 *   name means editing these lists as well, so every change to the surface is deliberate.
 * - The emitted declarations (with `stripInternal`) are self-contained: nothing that a
 *   public declaration needs was stripped as `@internal`, and every named type that a
 *   public declaration refers to is exported too, except the pinned lists of known gaps.
 *   A layer 1 declaration counts only the exports of layer 1.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Layer 1: the public API (follows semver) */
const LAYER_1 = [
  'AdditionalHandleInfo',
  'AdditionalResizeHandlesCalculator',
  'applyRuleColor',
  'AutoNameConfig',
  'AutoNameType',
  'AuxiliaryHandle',
  'AuxiliaryHandleContext',
  'AuxiliaryHandleHit',
  'AuxiliaryHandleProvider',
  'BoundingBox',
  'BoundingBoxCoords',
  'BoundingBoxCoordsSimple',
  'BoundingBoxStyle',
  'BoxSelection',
  'BoxSelectionStrategy',
  'BoxSelectionStyleConfig',
  'buildTraceGraph',
  'CenterMarkerStyle',
  'Color',
  'CompanionHit',
  'CompanionHitContext',
  'Coordinate',
  'createGuideSnapProvider',
  'createMapLibreGLDraw',
  'CustomBoundingBoxCalculator',
  'CustomFeatureHandler',
  'CustomFeatureRenderer',
  'CustomOverlayRenderer',
  'CustomRendererDrawContext',
  'CustomResizeCalculator',
  'CustomResizeResult',
  'Data',
  'DEFAULT_SNAP_GUIDE_LINE_STYLE',
  'DEFAULT_SNAP_INDICATOR_STYLES',
  'deriveLegend',
  'DatasetBaseStyle',
  'DatasetChangePayload',
  'DatasetClickEventPayload',
  'DatasetClickPayload',
  'Dataset',
  'DatasetEventMap',
  'DatasetOptions',
  'DatasetOrder',
  'DatasetPlacement',
  'DatasetCollisionThinning',
  'DatasetColumn',
  'DatasetColumnarGeometry',
  'DatasetColumnarGeometryType',
  'DatasetColumnarInput',
  'DatasetColumnarMixedGeometry',
  'DatasetColumnarPrepared',
  'DatasetDictionaryCodes',
  'DatasetDictionaryColumn',
  'DatasetFeatureInput',
  'DatasetFeatureProvider',
  'DatasetHoverPayload',
  'DatasetThinningStats',
  'DatasetZoomScale',
  'DocumentStore',
  'DragEndData',
  'DragNormalizedEvent',
  'DragOperationType',
  'DragStartData',
  'DragState',
  'evaluateStyleRule',
  'EventListener',
  'EventMap',
  'EventPayloads',
  'ExportFormat',
  'ExportOptions',
  'ExportResult',
  'Feature',
  'FeatureCompanionProvider',
  'FeatureCoordinates',
  'FeatureInput',
  'FeatureLockStore',
  'FeaturesChangePayload',
  'FeatureStyle',
  'FeatureStyleConfig',
  'FeatureType',
  'FileData',
  'FillStyle',
  'findTracePath',
  'GeometryAppliedPayload',
  'GeometryBufferOptions',
  'GeometryOperationName',
  'GeometryOperations',
  'getCreatedZoom',
  'getRotation',
  'getScale',
  'getStyleRuleChannel',
  'Group',
  'GuideSnapProviderDeps',
  'GuideSnapProviderOptions',
  'HandleInfo',
  'HandleType',
  'HitTestOptions',
  'HitTestResult',
  'HitTestStrategy',
  'Hooks',
  'HoverEvent',
  'ImageProperties',
  'ImageStyle',
  'InputOperations',
  'InteractionGateStore',
  'isFeatureLocked',
  'isGroupLocked',
  'isInteractionBlocked',
  'KeyNormalizedEvent',
  'Layer',
  'LayerAwareOverlayRenderer',
  'LegendEntry',
  'LineStringFeatureStyle',
  'LineStyle',
  'LngLat',
  'LoadErrorPayload',
  'LoadOptions',
  'LoadResult',
  'MapClickEventPayload',
  'MapLibreGLDraw',
  'MemoryStore',
  'Messages',
  'MESSAGES_EN',
  'Metadata',
  'MidpointHandleStyle',
  'Mode',
  'ModeContext',
  'ModeFactory',
  'ModeHandler',
  'ModifierKeys',
  'MouseLeaveEvent',
  'MouseNormalizedEvent',
  'MutationContext',
  'NormalizedEvent',
  'Options',
  'PixelRatioInput',
  'PixelRatioProvider',
  'Plugin',
  'PluginContext',
  'PointerOriginalEvent',
  'PointerType',
  'PointFeatureStyle',
  'PointFrameExtent',
  'PointFrameExtentProvider',
  'PointShape',
  'PointStyle',
  'PolygonFeatureStyle',
  'RadiusHandleStyle',
  'RadiusLineStyle',
  'RenderingConfig',
  'RenderSlot',
  'ResizeHandleStyle',
  'ResizeState',
  'ResizeStrategy',
  'ResolvedCollisionThinning',
  'ResolvedSnapOptions',
  'resolveFeatureStyle',
  'resolveRuleColor',
  'RotateHandleStyle',
  'RotateInfo',
  'ScreenPoint',
  'Selection',
  'SelectionType',
  'SelectionUIConfig',
  'setCreatedZoom',
  'setRotation',
  'SkippedFeature',
  'SnapCandidate',
  'SnapContext',
  'SnapDisableKey',
  'SnapExcludeVertex',
  'SnapIndicatorStyles',
  'SnapInputType',
  'SnapLngLat',
  'SnapOptions',
  'SnappingOperations',
  'SnapPointCandidate',
  'SnapProvider',
  'SnapProviderContext',
  'SnapResult',
  'SnapSegmentCandidate',
  'SnapTarget',
  'SnapTargetKind',
  'SnapTargetSegment',
  'StateChanges',
  'Store',
  'StoreView',
  'StrokeStyle',
  'StyleRule',
  'StyleRuleChannel',
  'SyntheticInputOptions',
  'SyntheticKeyOptions',
  'SyntheticLngLat',
  'SyntheticModifiers',
  'TentativeState',
  'TentativeStyle',
  'TopologyConfig',
  'TopologyOperations',
  'TraceGraph',
  'TraceGraphEdge',
  'TraceGraphEndpoint',
  'TraceGraphNode',
  'TraceOptions',
  'TracingOperations',
  'UiState',
  'UpdateFeatureOptions',
  'UpdateSource',
  'VertexHandleStyle',
  'VertexHit',
  'VertexRef',
  'VertexSelection',
];

/** Layer 2: the building blocks for custom shaders of src/webgl/index.ts */
const WEBGL = [
  'applyDrawBlendState',
  'calculateLngLatOffset',
  'computeQuadVertices',
  'createProgram',
  'dashPattern',
  'DEFAULT_TILE_SIZE',
  'densifyPath',
  'drawBillboardsWithoutDepth',
  'drawQuadSurfaceOnTerrain',
  'OFFSET_MODE_GLSL',
  'PointHitTestStrategy',
  'ProjectionUniformManager',
  'QUAD_GLYPH_STRIDE',
  'QuadDrapeGlyphs',
  'QuadShader',
  'QuadVertices',
  'SDFStrokeOptions',
  'SDFStrokeStyle',
  'splitIntoDashes',
  'terrainTessellationStep',
  'WidthUnit',
];

/**
 * Types that the declarations of layer 1 still refer to but that layer 1 does not export:
 * the services and renderers of the 1.0 contexts (ModeContext, PluginContext,
 * CustomRendererDrawContext) and the terrain diagnostics. The rewrite of layer 1 for 2.0
 * removes these references; until then the list pins them, so that no new one slips in. The
 * three that the webgl entry exports (SDFStrokeOptions, SDFStrokeStyle, WidthUnit) are here
 * because a layer 1 declaration must not depend on layer 2.
 */
const PENDING_LAYER_1 = [
  'AutoNameGenerator',
  'AuxiliaryHandleRegistry',
  'BoxSelectionStrategyRegistry',
  'EventEmitter',
  'FeatureCompanionHitResult',
  'FeatureCompanionRegistry',
  'FillShaderManager',
  'HitTestService',
  'HitTestTopmost',
  'HookName',
  'OffsetUniforms',
  'PluginManager',
  'PointShapeRenderer',
  'SDFLineRenderer',
  'SDFStrokeOptions',
  'SDFStrokeStyle',
  'SelectionExtensionRegistry',
  'SelectionScope',
  'ShaderData',
  'SpatialQuery',
  'TerrainContext',
  'TerrainDiagnostics',
  'TerrainDrapeDebug',
  'TerrainRenderDiagnostics',
  'TerrainRenderState',
  'TopHit',
  'TopmostHitTestOptions',
  'TraceConfig',
  'UnprojectFunction',
  'WidthUnit',
];

/**
 * Types that the building blocks of src/webgl/index.ts refer to without exporting them (the
 * parameter and field types of the quad, projection, dash and terrain helpers). The entry
 * keeps to the symbol list of its design; a caller names these types through the functions
 * that take them (for example `Parameters<typeof drawQuadSurfaceOnTerrain>`).
 */
const WEBGL_UNEXPORTED = [
  'BlendCapableGL',
  'DashSegment',
  'DrapeQuadCorners',
  'MercatorRect',
  'OffsetUniforms',
  'ProjectionUniformLocations',
  'QuadDrapeColor',
  'QuadDrapeFill',
  'QuadDrapeSurface',
  'TerrainContext',
  'TerrainRenderState',
  'TessellationStep',
  'TessellationTiling',
];

function byName(a: string, b: string): number {
  return a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0;
}

/** Reads the export statements of an entry point */
function readExports(file: string): { names: string[]; values: string[]; star: number } {
  const fileName = resolve(ROOT, file);
  const text = ts.sys.readFile(fileName) ?? '';
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const names: string[] = [];
  const values: string[] = [];
  let star = 0;
  for (const statement of source.statements) {
    // An export written as a declaration, such as a deprecated alias (`export const`)
    if (
      ts.isVariableStatement(statement) &&
      statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        names.push(declaration.name.text);
        values.push(declaration.name.text);
      }
      continue;
    }
    if (!ts.isExportDeclaration(statement)) continue;
    const clause = statement.exportClause;
    if (!clause || !ts.isNamedExports(clause)) {
      star++;
      continue;
    }
    for (const element of clause.elements) {
      names.push(element.name.text);
      if (!statement.isTypeOnly && !element.isTypeOnly) values.push(element.name.text);
    }
  }
  return { names, values, star };
}

describe('the export list of src/index.ts', () => {
  it('names every export, with no export *', () => {
    expect(readExports('src/index.ts').star).toBe(0);
  });

  it('matches layer 1', () => {
    expect([...readExports('src/index.ts').names].sort(byName)).toEqual([...LAYER_1].sort(byName));
  });

  it('exports at runtime exactly the value names of the list', async () => {
    const runtime = Object.keys(await import('./index.js')).sort(byName);
    expect(runtime).toEqual(readExports('src/index.ts').values.sort(byName));
  });
});

describe('the export list of src/webgl/index.ts', () => {
  it('names every export, with no export *', () => {
    expect(readExports('src/webgl/index.ts').star).toBe(0);
  });

  it('matches layer 2', () => {
    expect([...readExports('src/webgl/index.ts').names].sort(byName)).toEqual(
      [...WEBGL].sort(byName),
    );
  });

  it('shares no name with the main entry', () => {
    expect(LAYER_1.filter((name) => WEBGL.includes(name))).toEqual([]);
  });

  it('exports at runtime exactly the value names of the list', async () => {
    const runtime = Object.keys(await import('./webgl/index.js')).sort(byName);
    expect(runtime).toEqual(readExports('src/webgl/index.ts').values.sort(byName));
  });
});

// ---------------------------------------------------------------------------
// The emitted declarations
// ---------------------------------------------------------------------------

/** Emits the declarations of the build into memory, with the options of tsconfig.build.json */
function emitDeclarations(outDir: string): Map<string, string> {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    resolve(ROOT, 'tsconfig.build.json'),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
      },
    },
  );
  if (!parsed) throw new Error('tsconfig.build.json could not be read');
  const program = ts.createProgram(parsed.fileNames, {
    ...parsed.options,
    noEmit: false,
    emitDeclarationOnly: true,
    declaration: true,
    declarationMap: false,
    composite: false,
    incremental: false,
    tsBuildInfoFile: undefined,
    outDir,
  });
  const files = new Map<string, string>();
  program.emit(undefined, (fileName, text) => {
    files.set(resolve(fileName), text);
  });
  return files;
}

/** A program over the emitted declarations, starting from the entry points of package.json */
function createDeclarationProgram(files: Map<string, string>, entries: string[]): ts.Program {
  const host = ts.createCompilerHost({});
  const fallback = { ...host };
  const outDir = dirname(entries[0]);
  host.fileExists = (fileName) => files.has(resolve(fileName)) || fallback.fileExists(fileName);
  host.readFile = (fileName) => files.get(resolve(fileName)) ?? fallback.readFile(fileName);
  host.directoryExists = (dir) =>
    resolve(dir).startsWith(outDir) || (ts.sys.directoryExists?.(dir) ?? false);
  host.realpath = (fileName) => fileName;
  host.getSourceFile = (fileName, languageVersion, ...rest) => {
    const text = files.get(resolve(fileName));
    return text === undefined
      ? fallback.getSourceFile(fileName, languageVersion, ...rest)
      : ts.createSourceFile(fileName, text, languageVersion, true);
  };
  return ts.createProgram(
    entries,
    {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2020,
      lib: ['lib.es2020.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
      strict: true,
      noEmit: true,
      types: [],
    },
    host,
  );
}

function isTopLevel(declaration: ts.Declaration): boolean {
  const statement = ts.isVariableDeclaration(declaration) ? declaration.parent.parent : declaration;
  return ts.isSourceFile(statement.parent);
}

/**
 * Walks every named type reachable from the exports of `from` and returns the names of the
 * ones that the entries of `exportedBy` do not export. A type alias whose name and definition
 * are identical to an exported one counts as exported (the two are the same type to a caller).
 */
function findForgottenExports(
  program: ts.Program,
  files: Map<string, string>,
  exportedBy: string[],
  from: string[],
) {
  const checker = program.getTypeChecker();
  const ours = (node: ts.Node) => files.has(resolve(node.getSourceFile().fileName));
  const resolveAlias = (symbol: ts.Symbol) =>
    symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const exported = new Set<ts.Symbol>();
  const exportedAliases = new Map<string, string>();
  const exportsOf = (entry: string) => {
    const source = program.getSourceFile(entry);
    const moduleSymbol = source && checker.getSymbolAtLocation(source);
    if (!moduleSymbol) throw new Error(`no module symbol for ${entry}`);
    return checker.getExportsOfModule(moduleSymbol);
  };
  for (const entry of exportedBy) {
    for (const symbol of exportsOf(entry)) {
      const target = resolveAlias(symbol);
      exported.add(target);
      for (const declaration of target.declarations ?? []) {
        if (ts.isTypeAliasDeclaration(declaration)) {
          exportedAliases.set(symbol.name, declaration.type.getText());
        }
      }
    }
  }
  const seen = new Set<ts.Symbol>(exported);
  const forgotten = new Set<string>();
  const visitSymbol = (symbol: ts.Symbol) => {
    const target = resolveAlias(symbol);
    if (seen.has(target)) return;
    const declarations = (target.declarations ?? []).filter(
      (declaration) => ours(declaration) && isTopLevel(declaration),
    );
    if (declarations.length === 0) return;
    seen.add(target);
    const sameAlias = declarations.every(
      (declaration) =>
        ts.isTypeAliasDeclaration(declaration) &&
        exportedAliases.get(target.name) === declaration.type.getText(),
    );
    if (!sameAlias) forgotten.add(target.name);
    for (const declaration of declarations) walk(declaration);
  };
  const walk = (node: ts.Node): void => {
    if (
      (ts.isPropertyDeclaration(node) || ts.isMethodDeclaration(node)) &&
      ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Private
    ) {
      return;
    }
    let name: ts.Node | undefined;
    if (ts.isTypeReferenceNode(node)) name = node.typeName;
    else if (ts.isExpressionWithTypeArguments(node)) name = node.expression;
    else if (ts.isTypeQueryNode(node)) name = node.exprName;
    else if (ts.isImportTypeNode(node)) name = node.qualifier;
    if (name) {
      const symbol = checker.getSymbolAtLocation(ts.isQualifiedName(name) ? name.right : name);
      if (symbol) visitSymbol(symbol);
    }
    ts.forEachChild(node, (child) => walk(child));
  };
  for (const symbol of from.flatMap(exportsOf).map(resolveAlias)) {
    for (const declaration of symbol.declarations ?? []) {
      if (ours(declaration)) walk(declaration);
    }
  }
  return [...forgotten].sort(byName);
}

describe('the emitted declarations', () => {
  const outDir = resolve(ROOT, '__api_check__');
  const main = resolve(outDir, 'index.d.ts');
  const geometry = resolve(outDir, 'geometry/index.d.ts');
  const webgl = resolve(outDir, 'webgl/index.d.ts');
  const entries = [main, geometry, webgl];
  let files: Map<string, string>;
  let program: ts.Program;

  const setup = () => {
    files ??= emitDeclarations(outDir);
    program ??= createDeclarationProgram(files, entries);
  };

  it('type-check on their own (nothing public refers to a stripped declaration)', () => {
    setup();
    const errors = program
      .getSourceFiles()
      .filter((source) => files.has(resolve(source.fileName)))
      .flatMap((source) => program.getSemanticDiagnostics(source))
      .map((diagnostic) => {
        const file = diagnostic.file?.fileName ?? '';
        return `${file.slice(file.indexOf('__api_check__') + 14)}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`;
      });
    expect(errors).toEqual([]);
  }, 60_000);

  it('export every named type that a layer 1 declaration refers to, from layer 1', () => {
    setup();
    expect(findForgottenExports(program, files, [main, geometry], [main, geometry])).toEqual(
      [...PENDING_LAYER_1].sort(byName),
    );
  }, 60_000);

  it('export every named type that a layer 2 declaration refers to', () => {
    setup();
    expect(findForgottenExports(program, files, entries, [webgl])).toEqual(
      [...WEBGL_UNEXPORTED].sort(byName),
    );
  }, 60_000);
});
