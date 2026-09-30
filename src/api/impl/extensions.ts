// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.extensions`: the collections of plugins, modes, feature types, overlays and providers
 *
 * Every collection is a registry by name over the same core: `add` installs an extension into
 * the engine and returns the function that uninstalls it, `addMany` and `removeMany` do all or
 * nothing. The installing is given by the host (`extension-host.ts`); this file only keeps the
 * names, the order and the errors.
 */

import type { Geometry } from 'geojson';
import { DrawError } from '../errors.js';
import type { FeatureTypeDefinition } from '../extension/feature-type.js';
import type { ModeFactory } from '../extension/mode.js';
import type { Plugin } from '../extension/plugin.js';
import type { CompanionProvider, HandleProvider, SnapProvider } from '../extension/provider.js';
import type { OverlayRenderer } from '../extension/render.js';
import type {
  ExtensionsCollections,
  FeatureTypesCollection,
  ModesCollection,
  OverlaysCollection,
  PluginsCollection,
  ProvidersCollection,
} from '../extensions.js';
import { invalidInput, notFound } from './shared.js';

/**
 * How one kind of extension is installed into the engine
 *
 * @internal
 */
export interface Installer<T> {
  /** What the kind is called in the messages of the errors */
  readonly kind: string;
  /** Throws when the value cannot be installed (its shape) */
  validate(name: string, value: T): void;
  /** Whether the name is taken outside the collection (by the engine or the first API) */
  isTakenElsewhere?(name: string): boolean;
  /**
   * Installs the value
   *
   * @returns The function that uninstalls it
   */
  install(name: string, value: T): () => void;
}

/** One installed extension */
interface Entry<T> {
  readonly value: T;
  readonly uninstall: () => void;
}

/**
 * The registry by name of one kind of extension: the core of every collection
 *
 * @internal
 */
export interface Registry<T> {
  get(name: string): T | undefined;
  names(): string[];
  values(): T[];
  count(): number;
  has(name: string): boolean;
  /**
   * Installs the values, all of them or none; returns the function that removes them. With
   * `overriding`, a name the engine holds can be taken (the value overrides it).
   */
  add(
    entries: readonly (readonly [string, T])[],
    options?: { readonly overriding?: boolean },
  ): () => void;
  /** Removes the named values, all of them or none; throws not-found for a missing name */
  remove(names: readonly string[]): boolean;
  /** Whether the value is the one installed under the name */
  holds(name: string, value: T): boolean;
  /** Uninstalls everything (the instance is destroyed) */
  clear(): void;
}

/**
 * Creates the registry of one kind of extension
 *
 * @internal
 */
export function createRegistry<T>(installer: Installer<T>): Registry<T> {
  const entries = new Map<string, Entry<T>>();

  const requireName = (name: unknown): string => {
    if (typeof name !== 'string' || name === '') {
      throw invalidInput(`The name of the ${installer.kind} must be a non-empty string`);
    }
    return name;
  };

  const uninstall = (name: string, entry: Entry<T>): void => {
    if (entries.get(name) !== entry) return;
    entries.delete(name);
    entry.uninstall();
  };

  return {
    get: (name) => entries.get(name)?.value,
    names: () => [...entries.keys()],
    values: () => [...entries.values()].map((entry) => entry.value),
    count: () => entries.size,
    has: (name) => entries.has(name),
    holds: (name, value) => entries.get(name)?.value === value,

    add(list, options) {
      if (!Array.isArray(list)) throw invalidInput(`The ${installer.kind}s must be an array`);
      const seen = new Set<string>();
      for (const [rawName, value] of list) {
        const name = requireName(rawName);
        installer.validate(name, value);
        const takenElsewhere = !options?.overriding && installer.isTakenElsewhere?.(name);
        if (seen.has(name) || entries.has(name) || takenElsewhere) {
          throw new DrawError(
            'already-exists',
            `There is already a ${installer.kind} named ${JSON.stringify(name)}`,
            { name },
          );
        }
        seen.add(name);
      }

      const added: Array<[string, Entry<T>]> = [];
      try {
        for (const [name, value] of list) {
          const entry: Entry<T> = { value, uninstall: installer.install(name, value) };
          entries.set(name, entry);
          added.push([name, entry]);
        }
      } catch (error) {
        for (let i = added.length - 1; i >= 0; i--) uninstall(added[i][0], added[i][1]);
        throw error;
      }

      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        for (let i = added.length - 1; i >= 0; i--) uninstall(added[i][0], added[i][1]);
      };
    },

    remove(names) {
      if (!Array.isArray(names)) throw invalidInput('The names must be an array');
      for (const name of names) {
        if (!entries.has(name)) throw notFound(installer.kind, name);
      }
      for (const name of new Set(names)) {
        const entry = entries.get(name);
        if (entry) uninstall(name, entry);
      }
      return true;
    },

    clear() {
      for (const [name, entry] of [...entries].reverse()) uninstall(name, entry);
    },
  };
}

/** The name of an extension that carries one, as a checked string */
function nameOf(value: unknown, kind: string): string {
  const name = (value as { name?: unknown } | null)?.name;
  if (typeof name !== 'string' || name === '') {
    throw invalidInput(`The ${kind} must have a non-empty name`);
  }
  return name;
}

/**
 * The registries of every kind of extension of one instance
 *
 * @internal
 */
export interface ExtensionRegistries {
  readonly plugins: Registry<Plugin>;
  readonly modes: Registry<ModeFactory>;
  readonly featureTypes: Registry<FeatureTypeDefinition>;
  readonly overlays: Registry<OverlayRenderer>;
  readonly snapProviders: Registry<SnapProvider>;
  readonly handleProviders: Registry<HandleProvider>;
  readonly companionProviders: Registry<CompanionProvider>;
}

/**
 * Where an addition goes: every addition through the returned collections is passed to
 * `record` with the function that removes it, so that a plugin can remove what it added
 */
type Recorder = (remove: () => void) => void;

/** The collection of the extensions that are named by a member */
function namedCollection<T>(
  registry: Registry<T>,
  kind: string,
  record: Recorder | undefined,
): {
  get(name: string): T | undefined;
  list(): string[];
  count(): number;
  has(name: string): boolean;
  add(value: T): () => void;
  addMany(values: readonly T[]): () => void;
  remove(name: string): boolean;
  removeMany(names: readonly string[]): boolean;
} {
  const addAll = (values: readonly T[]): (() => void) => {
    if (!Array.isArray(values)) throw invalidInput(`The ${kind}s must be an array`);
    const remove = registry.add(values.map((value) => [nameOf(value, kind), value] as const));
    record?.(remove);
    return remove;
  };
  return {
    get: (name) => registry.get(name),
    list: () => registry.names(),
    count: () => registry.count(),
    has: (name) => registry.has(name),
    add: (value) => addAll([value]),
    addMany: addAll,
    remove: (name) => registry.remove([name]),
    removeMany: (names) => registry.remove(names),
  };
}

/**
 * The collections of `draw.extensions` over the registries
 *
 * @param record - Receives the remover of every addition; a plugin context passes it to
 *   remove what the plugin added when the plugin is removed
 * @internal
 */
export function createExtensionsCollections(
  registries: ExtensionRegistries,
  record?: Recorder,
): ExtensionsCollections {
  const plugins = namedCollection(registries.plugins, 'plugin', record);
  const pluginsCollection: PluginsCollection = {
    get: (name) => registries.plugins.get(name),
    list: () => registries.plugins.values(),
    count: plugins.count,
    has: plugins.has,
    add: plugins.add,
    addMany: plugins.addMany,
    remove: plugins.remove,
    removeMany: plugins.removeMany,
    getApi: <A>(name: string) => registries.plugins.get(name)?.api as A | undefined,
  };

  const modes: ModesCollection = {
    get: (name) => registries.modes.get(name),
    list: () => registries.modes.names(),
    count: () => registries.modes.count(),
    has: (name) => registries.modes.has(name),
    add: (name, factory) => modes.addMany([{ name, factory }]),
    addMany(entries) {
      if (!Array.isArray(entries)) throw invalidInput('The modes must be an array');
      const remove = registries.modes.add(
        entries.map((entry) => {
          if (typeof entry !== 'object' || entry === null) {
            throw invalidInput('A mode must be given as { name, factory }');
          }
          return [entry.name, entry.factory] as const;
        }),
      );
      record?.(remove);
      return remove;
    },
    remove: (name) => registries.modes.remove([name]),
    removeMany: (names) => registries.modes.remove(names),
  };

  const byType = namedCollectionByType(registries.featureTypes, record);
  const overlays: OverlaysCollection = namedCollection(registries.overlays, 'overlay', record);
  const snapProviders: ProvidersCollection<SnapProvider> = namedCollection(
    registries.snapProviders,
    'snap provider',
    record,
  );
  const handleProviders: ProvidersCollection<HandleProvider> = namedCollection(
    registries.handleProviders,
    'handle provider',
    record,
  );
  const companionProviders: ProvidersCollection<CompanionProvider> = namedCollection(
    registries.companionProviders,
    'companion provider',
    record,
  );

  return {
    plugins: pluginsCollection,
    modes,
    featureTypes: byType,
    overlays,
    snapProviders,
    handleProviders,
    companionProviders,
  };
}

/**
 * The built-in feature types a definition can override, with the kind of geometry their
 * features hold
 *
 * @internal
 */
export const OVERRIDABLE_TYPES: ReadonlyMap<string, Geometry['type']> = new Map<
  string,
  Geometry['type']
>([
  ['Point', 'Point'],
  ['LineString', 'LineString'],
  ['Polygon', 'Polygon'],
  ['Circle', 'Point'],
  ['Freehand', 'LineString'],
  ['Image', 'Point'],
]);

/** The type of a feature type definition, as a checked string */
function typeOf(definition: FeatureTypeDefinition): string {
  const type = (definition as { type?: unknown } | null)?.type;
  if (typeof type !== 'string' || type === '') {
    throw invalidInput('A feature type must have a non-empty type');
  }
  return type;
}

/** The feature types, named by their `type` */
function namedCollectionByType(
  registry: Registry<FeatureTypeDefinition>,
  record: Recorder | undefined,
): FeatureTypesCollection {
  const addAll = (definitions: readonly FeatureTypeDefinition[]): (() => void) => {
    if (!Array.isArray(definitions)) throw invalidInput('The feature types must be an array');
    const remove = registry.add(
      definitions.map((definition) => [typeOf(definition), definition] as const),
    );
    record?.(remove);
    return remove;
  };
  return {
    override(definition) {
      const type = typeOf(definition);
      const geometry = OVERRIDABLE_TYPES.get(type);
      if (geometry === undefined) {
        throw invalidInput(
          `${JSON.stringify(type)} is not a built-in type that can be overridden`,
          {
            type,
          },
        );
      }
      if (definition.geometry !== geometry) {
        throw invalidInput(
          `A definition that overrides ${type} must have the geometry ${geometry}`,
          {
            type,
            geometry: definition.geometry,
          },
        );
      }
      const remove = registry.add([[type, definition]], { overriding: true });
      record?.(remove);
      return remove;
    },
    get: (name) => registry.get(name),
    list: () => registry.names(),
    count: () => registry.count(),
    has: (name) => registry.has(name),
    add: (definition) => addAll([definition]),
    addMany: addAll,
    remove: (name) => registry.remove([name]),
    removeMany: (names) => registry.remove(names),
  };
}
