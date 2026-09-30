// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.extensions`: the collections of plugins, modes, feature types, overlays and providers
 *
 * Every kind of extension is added the same way: `add` registers it and returns the function
 * that removes it, and `remove(name)` removes it by name.
 */

import type { FeatureTypeDefinition } from './extension/feature-type.js';
import type { ModeFactory } from './extension/mode.js';
import type { Plugin } from './extension/plugin.js';
import type { CompanionProvider, HandleProvider, SnapProvider } from './extension/provider.js';
import type { OverlayRenderer } from './extension/render.js';

/** The plugins, in the order they were added. */
export interface PluginsCollection {
  /**
   * Gets a plugin by name.
   *
   * @returns The plugin, or `undefined` when there is none with this name
   */
  get(name: string): Plugin | undefined;
  /** Lists the plugins in the order they were added. */
  list(): Plugin[];
  /** Counts the plugins. */
  count(): number;
  /** Whether a plugin with this name was added. */
  has(name: string): boolean;
  /**
   * Adds a plugin.
   *
   * @returns The function that removes it again
   * @throws `DrawError` with the code `already-exists` when a plugin with the same name was
   *   added
   *   or with `invalid-input` when the value does not have the shape of the contract
   */
  add(plugin: Plugin): () => void;
  /**
   * Adds several plugins in one transaction: all of them or none.
   *
   * @returns The function that removes them again
   * @throws `DrawError` with the code `already-exists` when one of the names is taken, or
   *   `invalid-input` when a value does not have the shape of the contract; nothing is added
   *   then
   */
  addMany(plugins: readonly Plugin[]): () => void;
  /**
   * Removes a plugin, with everything it added.
   *
   * @returns True when it was removed
   * @throws `DrawError` with the code `not-found` when there is no plugin with this name
   */
  remove(name: string): boolean;
  /**
   * Removes several plugins, with everything they added: all of them or none.
   *
   * @returns True when they were removed
   * @throws `DrawError` with the code `not-found` when one of the names does not exist;
   *   nothing is removed then
   */
  removeMany(names: readonly string[]): boolean;
  /**
   * The API a plugin offers to others.
   *
   * @returns The API, or `undefined` when there is no plugin with this name or it offers none
   */
  getApi<T>(name: string): T | undefined;
}

/** The modes that were added, by name. */
export interface ModesCollection {
  /**
   * Gets the factory of a mode by name.
   *
   * @returns The factory, or `undefined` when there is no mode with this name
   */
  get(name: string): ModeFactory | undefined;
  /** Lists the names of the modes. */
  list(): string[];
  /** Counts the modes. */
  count(): number;
  /** Whether a mode with this name was added. */
  has(name: string): boolean;
  /**
   * Adds a mode under a name.
   *
   * @returns The function that removes it again
   * @throws `DrawError` with the code `already-exists` when the name is taken
   *   or with `invalid-input` when the value does not have the shape of the contract
   */
  add(name: string, factory: ModeFactory): () => void;
  /**
   * Adds several modes in one transaction: all of them or none.
   *
   * @returns The function that removes them again
   * @throws `DrawError` with the code `already-exists` when one of the names is taken, or
   *   `invalid-input` when a value does not have the shape of the contract; nothing is added
   *   then
   */
  addMany(entries: readonly { name: string; factory: ModeFactory }[]): () => void;
  /**
   * Removes a mode.
   *
   * @returns True when it was removed
   * @throws `DrawError` with the code `not-found` when there is no mode with this name
   */
  remove(name: string): boolean;
  /**
   * Removes several modes: all of them or none.
   *
   * @returns True when they were removed
   * @throws `DrawError` with the code `not-found` when one of the names does not exist;
   *   nothing is removed then
   */
  removeMany(names: readonly string[]): boolean;
}

/**
 * The custom feature types, by type name, and the definitions that override a built-in type.
 */
export interface FeatureTypesCollection {
  /**
   * Gets the definition of a feature type by name: a type that was added, or the definition
   * that overrides a built-in type.
   *
   * @returns The definition, or `undefined` when there is none with this name
   */
  get(name: string): FeatureTypeDefinition | undefined;
  /** Lists the names of the feature types that were added or overridden. */
  list(): string[];
  /** Counts the feature types that were added or overridden. */
  count(): number;
  /** Whether a feature type with this name was added or overridden. */
  has(name: string): boolean;
  /**
   * Adds a custom feature type. The type takes every feature of its type: its `appliesTo`, if
   * it has one, is ignored.
   *
   * @returns The function that removes it again
   * @throws `DrawError` with the code `already-exists` when the type name is taken
   *   or with `invalid-input` when the value does not have the shape of the contract
   */
  add(definition: FeatureTypeDefinition): () => void;
  /**
   * Adds several custom feature types in one transaction: all of them or none.
   *
   * @returns The function that removes them again
   * @throws `DrawError` with the code `already-exists` when one of the names is taken, or
   *   `invalid-input` when a value does not have the shape of the contract; nothing is added
   *   then
   */
  addMany(definitions: readonly FeatureTypeDefinition[]): () => void;
  /**
   * Overrides a built-in feature type (`Point`, `LineString`, `Polygon`, `Circle`,
   * `Freehand` or `Image`) with a definition of the same `type` and the same kind of
   * `geometry` as the built-in one (`Point` for a circle and an image, `LineString` for a
   * freehand line). The features of the type are drawn by its renderer from then on. Its
   * `hitTest`, `boxSelect`, `bounds`, `outline`, `bbox` and `snapCandidates` replace those of
   * the built-in type when it has them, and the built-in ones stay for the members it leaves
   * out. Its `handles` are shown with those of the built-in type. With `appliesTo`, it takes
   * only the features for which that returns true, and the others keep the built-in type
   * entirely.
   *
   * The built-in type comes back with the function it returns, with `remove(type)`, and, for
   * a plugin that overrode it through its context, when the plugin is removed. `add` keeps
   * refusing the names of the built-in types.
   *
   * @returns The function that puts the built-in type back
   * @throws `DrawError` with the code `invalid-input` when the type is not one of the
   *   built-in types above, its `geometry` is not the one of the built-in type, or the value
   *   does not have the shape of the contract, and `already-exists` when the type is already
   *   overridden
   */
  override(definition: FeatureTypeDefinition): () => void;
  /**
   * Removes a custom feature type, or the definition that overrides a built-in type (the
   * built-in type comes back).
   *
   * @returns True when it was removed
   * @throws `DrawError` with the code `not-found` when there is no type with this name
   */
  remove(name: string): boolean;
  /**
   * Removes several custom feature types: all of them or none.
   *
   * @returns True when they were removed
   * @throws `DrawError` with the code `not-found` when one of the names does not exist;
   *   nothing is removed then
   */
  removeMany(names: readonly string[]): boolean;
}

/** The renderers that draw above the features or between the layers, by name. */
export interface OverlaysCollection {
  /**
   * Gets an overlay renderer by name.
   *
   * @returns The renderer, or `undefined` when there is none with this name
   */
  get(name: string): OverlayRenderer | undefined;
  /** Lists the names of the overlay renderers. */
  list(): string[];
  /** Counts the overlay renderers. */
  count(): number;
  /** Whether an overlay renderer with this name was added. */
  has(name: string): boolean;
  /**
   * Adds an overlay renderer.
   *
   * @returns The function that removes it again
   * @throws `DrawError` with the code `already-exists` when the name is taken
   *   or with `invalid-input` when the value does not have the shape of the contract
   */
  add(renderer: OverlayRenderer): () => void;
  /**
   * Adds several overlay renderers in one transaction: all of them or none.
   *
   * @returns The function that removes them again
   * @throws `DrawError` with the code `already-exists` when one of the names is taken, or
   *   `invalid-input` when a value does not have the shape of the contract; nothing is added
   *   then
   */
  addMany(renderers: readonly OverlayRenderer[]): () => void;
  /**
   * Removes an overlay renderer.
   *
   * @returns True when it was removed
   * @throws `DrawError` with the code `not-found` when there is none with this name
   */
  remove(name: string): boolean;
  /**
   * Removes several overlay renderers: all of them or none.
   *
   * @returns True when they were removed
   * @throws `DrawError` with the code `not-found` when one of the names does not exist;
   *   nothing is removed then
   */
  removeMany(names: readonly string[]): boolean;
}

/**
 * The providers of one kind, by name: snapping candidates, handles or companions.
 *
 * @typeParam T - The kind of provider
 */
export interface ProvidersCollection<T> {
  /**
   * Gets a provider by name.
   *
   * @returns The provider, or `undefined` when there is none with this name
   */
  get(name: string): T | undefined;
  /** Lists the names of the providers. */
  list(): string[];
  /** Counts the providers. */
  count(): number;
  /** Whether a provider with this name was added. */
  has(name: string): boolean;
  /**
   * Adds a provider.
   *
   * @returns The function that removes it again
   * @throws `DrawError` with the code `already-exists` when the name is taken
   *   or with `invalid-input` when the value does not have the shape of the contract
   */
  add(provider: T): () => void;
  /**
   * Adds several providers in one transaction: all of them or none.
   *
   * @returns The function that removes them again
   * @throws `DrawError` with the code `already-exists` when one of the names is taken, or
   *   `invalid-input` when a value does not have the shape of the contract; nothing is added
   *   then
   */
  addMany(providers: readonly T[]): () => void;
  /**
   * Removes a provider.
   *
   * @returns True when it was removed
   * @throws `DrawError` with the code `not-found` when there is no provider with this name
   */
  remove(name: string): boolean;
  /**
   * Removes several providers: all of them or none.
   *
   * @returns True when they were removed
   * @throws `DrawError` with the code `not-found` when one of the names does not exist;
   *   nothing is removed then
   */
  removeMany(names: readonly string[]): boolean;
}

/**
 * Every collection of extensions of a draw instance.
 */
export interface ExtensionsCollections {
  /** The plugins: bundles of other extensions and state */
  readonly plugins: PluginsCollection;
  /** The modes: ways of receiving input */
  readonly modes: ModesCollection;
  /** The custom feature types */
  readonly featureTypes: FeatureTypesCollection;
  /** The renderers that draw above the features or between the layers */
  readonly overlays: OverlaysCollection;
  /** The providers of snapping candidates */
  readonly snapProviders: ProvidersCollection<SnapProvider>;
  /** The providers of handles on the selected features */
  readonly handleProviders: ProvidersCollection<HandleProvider>;
  /** The providers of companions drawn one step below a feature */
  readonly companionProviders: ProvidersCollection<CompanionProvider>;
}
