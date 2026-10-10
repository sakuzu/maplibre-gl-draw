// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The public surface of the package
 *
 * - The names that the four entries export are pinned in four lists (see "The public
 *   surface" in CONTRIBUTING.md): src/index.ts, src/geometry/index.ts and src/table/index.ts
 *   (layer 1) and src/webgl/index.ts (layer 2). Adding or removing a name means editing these
 *   lists as well, so every change to the surface is deliberate.
 * - The emitted declarations (with `stripInternal`) are self-contained: nothing that a
 *   public declaration needs was stripped as `@internal`, and every named type that a
 *   public declaration refers to is exported too. A layer 1 declaration counts only the
 *   exports of layer 1.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The main entry (layer 1, follows semver): the symbols of the design, and the types of the
 * collections and resources of `Draw`, which its declaration refers to
 */
const MAIN = [
  'AutoNameOptions',
  'CompanionProvider',
  'createDraw',
  'Dataset',
  'DatasetBaseStyle',
  'DatasetCollisionThinning',
  'DatasetEvents',
  'DatasetOptions',
  'DatasetOrder',
  'DatasetPlacement',
  'DatasetProvider',
  'DatasetRow',
  'DatasetsCollection',
  'DatasetThinningStats',
  'DatasetZoomScale',
  'deriveLegend',
  'DocumentChange',
  'DocumentResource',
  'Draw',
  'DRAW_PROPERTY_PREFIX',
  'DrawDocument',
  'DrawError',
  'DrawErrorCode',
  'DrawEventListener',
  'DrawEvents',
  'DrawingResource',
  'DrawKeyEvent',
  'DrawOptions',
  'DrawPointerEvent',
  'DrawProperties',
  'evaluateStyleRule',
  'ExtensionContext',
  'ExtensionsCollections',
  'Feature',
  'FeatureFilter',
  'FeatureInput',
  'FeaturePatch',
  'FeatureRenderer',
  'FeaturesCollection',
  'featuresToGeoJSON',
  'FeatureStyle',
  'FeatureStyleResolved',
  'featureToGeoJSON',
  'FeatureType',
  'FeatureTypeDefinition',
  'FeatureTypesCollection',
  'FileData',
  'FillRenderer',
  'ToGeoJSONOptions',
  'getStyleRuleChannel',
  'Group',
  'GroupFilter',
  'GroupInput',
  'GroupPatch',
  'GroupsCollection',
  'Handle',
  'HandleProvider',
  'HiddenCollection',
  'Hit',
  'HitTestContext',
  'InputHandlers',
  'isDrawProperty',
  'Layer',
  'LayerFilter',
  'LayerInput',
  'LayerPatch',
  'LayersCollection',
  'LayerStackEntry',
  'LegendEntry',
  'LineRenderer',
  'LineStyle',
  'LoadOptions',
  'LoadResult',
  'LoadSource',
  'Messages',
  'Metadata',
  'MetadataResource',
  'Mode',
  'ModeContext',
  'ModeFactory',
  'ModeHandler',
  'MODES',
  'ModesCollection',
  'Modifiers',
  'MoveTarget',
  'NameGenerator',
  'OffsetUniforms',
  'OptionsResource',
  'OverlayRenderer',
  'OverlaysCollection',
  'ParsedDocument',
  'parseGeoJSON',
  'parseNative',
  'ParseOptions',
  'Plugin',
  'PluginContext',
  'PluginsCollection',
  'PointRenderer',
  'PointShape',
  'Position',
  'ProvidersCollection',
  'RenderContext',
  'RenderingOptions',
  'RuntimeOptions',
  'ScreenContext',
  'ScreenPoint',
  'Selection',
  'SelectionResource',
  'SelectionStyleOptions',
  'SelectionType',
  'ShaderData',
  'SkippedFeature',
  'SnapCandidate',
  'SnapContext',
  'SnappingOptions',
  'SnapPreference',
  'SnapProvider',
  'SnapResult',
  'Store',
  'StoreView',
  'StyleRule',
  'TerrainAnchors',
  'TerrainDiagnostics',
  'TopologyOptions',
  'TracingOptions',
  'TransactOptions',
  'UpdateSource',
  'VertexRef',
  'VertexSelection',
  'VertexSelectionResource',
];

/** The geometry entry (layer 1) */
const GEOMETRY = [
  'along',
  'area',
  'bbox',
  'BBox',
  'bboxContains',
  'bboxIntersects',
  'bearing',
  'buffer',
  'centroid',
  'circle',
  'contains',
  'destination',
  'difference',
  'distance',
  'EARTH_RADIUS_METERS',
  'GeometryError',
  'GeometryErrorCode',
  'intersection',
  'length',
  'makeValid',
  'metersToDegrees',
  'midpoint',
  'nearestPointOnLine',
  'overlaps',
  'perimeter',
  'pointInPolygon',
  'pointOnSurface',
  'rewind',
  'simplify',
  'split',
  'union',
];

/** The table entry (layer 1) */
const TABLE = [
  'Column',
  'createTableBuilder',
  'DictionaryColumn',
  'GeometryType',
  'PreparedTable',
  'prepareTable',
  'Table',
  'TableBuilder',
  'tableFromFeatures',
  'TableGeometry',
  'TableMixedGeometry',
  'transferList',
];

/** Layer 2: the building blocks for custom shaders of src/webgl/index.ts */
const WEBGL = [
  'applyDrawBlendState',
  'BlendCapableGL',
  'calculateLngLatOffset',
  'computeQuadVertices',
  'Coordinate',
  'createProgram',
  'dashPattern',
  'DashSegment',
  'DEFAULT_TILE_SIZE',
  'densifyPath',
  'DrapeQuadCorners',
  'drawBillboardsWithoutDepth',
  'drawQuadSurfaceOnTerrain',
  'MercatorRect',
  'OFFSET_MODE_GLSL',
  'PointHitTestStrategy',
  'ProjectionUniformLocations',
  'ProjectionUniformManager',
  'QUAD_GLYPH_STRIDE',
  'QuadDrapeColor',
  'QuadDrapeFill',
  'QuadDrapeGlyphs',
  'QuadDrapeSurface',
  'QuadShader',
  'QuadVertices',
  'SDFStrokeOptions',
  'SDFStrokeStyle',
  'splitIntoDashes',
  'terrainTessellationStep',
  'TessellationStep',
  'TessellationTiling',
  'WidthUnit',
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

/** The checks of the export list of one entry */
function describeEntry(file: string, list: readonly string[], load: () => Promise<object>): void {
  describe(`the export list of ${file}`, () => {
    it('names every export, with no export *', () => {
      expect(readExports(file).star).toBe(0);
    });

    it('matches the pinned list', () => {
      expect([...readExports(file).names].sort(byName)).toEqual([...list].sort(byName));
    });

    it('exports at runtime exactly the value names of the list', async () => {
      const runtime = Object.keys(await load()).sort(byName);
      expect(runtime).toEqual(readExports(file).values.sort(byName));
    });
  });
}

describeEntry('src/index.ts', MAIN, () => import('./index.js'));
describeEntry('src/geometry/index.ts', GEOMETRY, () => import('./geometry/index.js'));
describeEntry('src/table/index.ts', TABLE, () => import('./table/index.js'));
describeEntry('src/webgl/index.ts', WEBGL, () => import('./webgl/index.js'));

describe('the four entries', () => {
  it('share no name', () => {
    const all = [...MAIN, ...GEOMETRY, ...TABLE, ...WEBGL];
    expect(all.filter((name, index) => all.indexOf(name) !== index)).toEqual([]);
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
  const table = resolve(outDir, 'table/index.d.ts');
  const webgl = resolve(outDir, 'webgl/index.d.ts');
  const entries = [main, geometry, table, webgl];
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
    expect(
      findForgottenExports(program, files, [main, geometry, table], [main, geometry, table]),
    ).toEqual([]);
  }, 60_000);

  it('export every named type that a layer 2 declaration refers to', () => {
    setup();
    expect(findForgottenExports(program, files, entries, [webgl])).toEqual([]);
  }, 60_000);
});
