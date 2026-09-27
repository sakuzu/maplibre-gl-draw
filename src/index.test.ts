// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The public surface of the package
 *
 * - The names that src/index.ts exports are pinned in two lists, one per layer (see "The
 *   public surface" in CONTRIBUTING.md). Adding or removing a name means editing these lists
 *   as well, so every change to the surface is deliberate.
 * - The emitted declarations (with `stripInternal`) are self-contained: every named type
 *   that a public declaration refers to is exported too, and nothing that a public
 *   declaration needs was stripped as `@internal`.
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

/** Layer 2: building blocks for extension authors (may change in a minor release) */
const LAYER_2 = [
  'anchorElevationMeters',
  'anchorGhostOpacity',
  'applyDrawBlendState',
  'AutoNameGenerator',
  'AuxiliaryHandleRegistry',
  'BlendCapableGL',
  'BoxSelectionStrategyRegistry',
  'calculateLngLatOffset',
  'calculateOffsetUniforms',
  'computeBoundingBox',
  'computeQuadVertices',
  'createFeatureCompanionRegistry',
  'createGeometryApi',
  'createOBB',
  'createProgram',
  'createSelectionExtensionRegistry',
  'DashSegment',
  'DEFAULT_POINT_FRAME_SIZE',
  'DEFAULT_TILE_SIZE',
  'DEFAULT_VIEWPORT_EXPANSION_FACTOR',
  'densifyPath',
  'distanceToOBB',
  'DrapeQuadCorners',
  'drawBillboardsWithoutDepth',
  'drawQuadSurfaceOnTerrain',
  'EventEmitter',
  'FeatureCompanionHitResult',
  'FeatureCompanionRegistry',
  'FillShaderManager',
  'GeometryApi',
  'GeometryApiDeps',
  'getAnchorElevationGeneration',
  'getContrastColor',
  'getExpandedViewportBounds',
  'getOBBAABB',
  'getProjectionTransitionUniform',
  'getSelectedFeatureIds',
  'getStrokeDashPattern',
  'getTerrainTessellationStep',
  'hasZeroArea',
  'HitTestService',
  'HitTestTopmost',
  'HookName',
  'lngLatToMercator',
  'MercatorCoord',
  'MercatorRect',
  'metersToMercatorScale',
  'OBB',
  'OBBCorners',
  'OFFSET_MODE_GLSL',
  'OffsetUniforms',
  'pixelsToDegreesLat',
  'pixelsToDegreesLng',
  'PluginManager',
  'PointHitTestStrategy',
  'PointShapeRenderer',
  'ProjectionUniformLocations',
  'ProjectionUniformManager',
  'QUAD_GLYPH_STRIDE',
  'QuadDrapeColor',
  'QuadDrapeFill',
  'QuadDrapeSurface',
  'QuadDrapeGlyphs',
  'QuadShader',
  'QuadVertices',
  'rectangleIntersectsOBB',
  'resolvePixelRatio',
  'SDFLineRenderer',
  'SDFStrokeOptions',
  'SDFStrokeStyle',
  'SelectionExtensionRegistry',
  'SelectionScope',
  'ShaderData',
  'SpatialQuery',
  'splitIntoDashes',
  'TerrainContext',
  'TerrainDiagnostics',
  'TerrainDrapeDebug',
  'TerrainRenderDiagnostics',
  'TerrainRenderState',
  'TessellationStep',
  'TessellationTiling',
  'TopHit',
  'TopmostHitTestOptions',
  'TraceConfig',
  'UnprojectFunction',
  'WidthUnit',
];

const LAYER_2_MARKER = '// Layer 2:';

function byName(a: string, b: string): number {
  return a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0;
}

/** Reads the export statements of src/index.ts, split at the layer 2 marker */
function readIndexExports(): {
  layer1: string[];
  layer2: string[];
  values: string[];
  star: number;
} {
  const fileName = resolve(ROOT, 'src/index.ts');
  const text = ts.sys.readFile(fileName) ?? '';
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const boundary = text.indexOf(LAYER_2_MARKER);
  const layer1: string[] = [];
  const layer2: string[] = [];
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
        const name = declaration.name.text;
        (boundary >= 0 && statement.getStart(source) > boundary ? layer2 : layer1).push(name);
        values.push(name);
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
      const name = element.name.text;
      (boundary >= 0 && statement.getStart(source) > boundary ? layer2 : layer1).push(name);
      if (!statement.isTypeOnly && !element.isTypeOnly) values.push(name);
    }
  }
  return { layer1, layer2, values, star };
}

describe('the export list of src/index.ts', () => {
  it('names every export, with no export *', () => {
    expect(readIndexExports().star).toBe(0);
  });

  it('matches layer 1 and layer 2 section by section', () => {
    const { layer1, layer2 } = readIndexExports();
    expect([...layer1].sort(byName)).toEqual([...LAYER_1].sort(byName));
    expect([...layer2].sort(byName)).toEqual([...LAYER_2].sort(byName));
  });

  it('keeps the two layers disjoint', () => {
    const both = LAYER_1.filter((name) => LAYER_2.includes(name));
    expect(both).toEqual([]);
  });

  it('exports at runtime exactly the value names of the list', async () => {
    const runtime = Object.keys(await import('./index.js')).sort(byName);
    expect(runtime).toEqual(readIndexExports().values.sort(byName));
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
 * Walks every named type reachable from the exports and returns the ones that are not
 * exported. A type alias whose name and definition are identical to an exported one counts
 * as exported (the two are the same type to a caller).
 */
function findForgottenExports(program: ts.Program, files: Map<string, string>, entries: string[]) {
  const checker = program.getTypeChecker();
  const ours = (node: ts.Node) => files.has(resolve(node.getSourceFile().fileName));
  const resolveAlias = (symbol: ts.Symbol) =>
    symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const exported = new Set<ts.Symbol>();
  const exportedAliases = new Map<string, string>();
  for (const entry of entries) {
    const source = program.getSourceFile(entry);
    const moduleSymbol = source && checker.getSymbolAtLocation(source);
    if (!moduleSymbol) throw new Error(`no module symbol for ${entry}`);
    for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
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
  const visitSymbol = (symbol: ts.Symbol, from: string) => {
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
    if (!sameAlias) {
      const file = declarations[0].getSourceFile().fileName;
      forgotten.add(
        `${target.name} (${file.slice(file.indexOf('__api_check__') + 14)}) <- ${from}`,
      );
    }
    for (const declaration of declarations) walk(declaration, target.name);
  };
  const walk = (node: ts.Node, from: string): void => {
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
      if (symbol) visitSymbol(symbol, from);
    }
    ts.forEachChild(node, (child) => walk(child, from));
  };
  for (const symbol of exported) {
    for (const declaration of symbol.declarations ?? []) {
      if (ours(declaration)) walk(declaration, symbol.name);
    }
  }
  return [...forgotten].sort(byName);
}

describe('the emitted declarations', () => {
  const outDir = resolve(ROOT, '__api_check__');
  const entries = [resolve(outDir, 'index.d.ts'), resolve(outDir, 'geometry/index.d.ts')];
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

  it('export every named type that a public declaration refers to', () => {
    setup();
    expect(findForgottenExports(program, files, entries)).toEqual([]);
  }, 60_000);
});
