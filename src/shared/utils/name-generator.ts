// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * AutoNameGenerator
 *
 * A utility that automatically generates a name with a sequential number when a Feature is
 * newly created.
 *
 * Every word of a name the library gives a feature, a layer or a group comes from here: from
 * the host's `typeNames`, or from the English defaults below. Nothing else in the library
 * writes such a word inline.
 */

import type { Feature, FeatureType, Group, Layer, StoreChange } from '../types/model.js';

/**
 * What the generator reads from the Store: the current contents and the change notifications,
 * and, optionally, the numbers the Store knows beyond what it lists. The Store satisfies it;
 * declaring only this keeps shared/ below store/. The constructor spells the same shape out,
 * because AutoNameGenerator is public and this name is not.
 *
 * A Store that holds only part of the document lists only that part, so the numbers of the
 * names it does not hold cannot be read from its contents. Such a Store gives them with
 * `getMaxNameNumber` (the largest number it knows to be used for a type, or undefined) and
 * is told each number generated with `recordNameNumber`. A Store without them is numbered
 * from its contents alone.
 */
interface NameSource {
  listFeatures(): Feature[];
  listLayers(): Layer[];
  listGroups(): Group[];
  subscribe(listener: (changes: StoreChange) => void): () => void;
  getMaxNameNumber?(type: AutoNameType): number | undefined;
  recordNameNumber?(type: AutoNameType, number: number): void;
}

/**
 * What automatic naming names: a feature type, a layer or a group
 */
export type AutoNameType = FeatureType | 'Layer' | 'Group';

/**
 * How new features, layers and groups are named automatically ("Point 1", "Layer 2")
 *
 * The engine reads it from the `autoName` option of `createDraw` (left out, it is on with
 * these defaults, and `false` turns it off). Each type counts on its own, and a
 * number is never reused: after "Point 1" and "Point 2" are created and "Point 2" is deleted,
 * the next point is "Point 3". Existing names of the form "<word> <number>" move the count on
 * as well, however they arrived (a load, an import).
 *
 * This is the one place the words of generated names come from, and the words are the host's
 * to translate: the defaults are English, so a host that shows another language passes a
 * word for each type it uses in `typeNames`. The keys are the type ids: the built-in feature
 * types (`Point`, `LineString`, `Polygon`, `Circle`, `Freehand`, `Image`), `Layer`, `Group`,
 * and the type id of every custom feature type an extension draws (a type without a word is
 * named with its id).
 *
 * A layer or a group always has a name. When one is created without a name while `enabled`
 * is false, it gets the word of its type alone, without a number ("Layer", or the
 * `typeNames.Layer` of the host); features get no name then.
 */
export interface AutoNameConfig {
  /**
   * Whether names are generated. When false, features get no name, and a layer or a group
   * created without a name gets the word of its type alone
   *
   * @defaultValue `true`
   */
  enabled: boolean;
  /**
   * The word used for each type in the name, keyed by the type id (a built-in feature type,
   * `Layer`, `Group`, or a custom feature type)
   *
   * @defaultValue English: `'Point'`, `'LineString'`, `'Polygon'`, `'Circle'`, `'Freehand'`,
   *   `'Image'`, `'Layer'`, `'Group'`, and the id itself for any other type
   */
  typeNames?: Partial<Record<AutoNameType, string>>;
  /**
   * Builds the name from the word of the type and the number
   *
   * @defaultValue `` (typeName, number) => `${typeName} ${number}` ``
   */
  formatter?: (typeName: string, number: number) => string;
}

/**
 * Default mapping of type names
 */
const DEFAULT_TYPE_NAMES: Record<string, string> = {
  Point: 'Point',
  LineString: 'LineString',
  Polygon: 'Polygon',
  Circle: 'Circle',
  Freehand: 'Freehand',
  Image: 'Image',
};

/**
 * Default Layer/Group names
 */
const DEFAULT_LAYER_NAME = 'Layer';
const DEFAULT_GROUP_NAME = 'Group';

/**
 * Counter keys of Layer/Group
 *
 * They share the same Map / Set as the counter keys of Feature (FeatureType).
 */
const LAYER_COUNTER_KEY = 'Layer';
const GROUP_COUNTER_KEY = 'Group';

/**
 * Default formatter
 */
function defaultFormatter(typeName: string, number: number): string {
  return `${typeName} ${number}`;
}

/**
 * Extracts the number from a name
 */
function extractNumberFromName(name: string, typeName: string): number | null {
  // Escape the special characters
  const escapedTypeName = typeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`^${escapedTypeName}\\s*(\\d+)$`);
  const match = name.match(regex);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Normalizes an AutoNameConfig
 */
export function normalizeAutoNameConfig(
  config: AutoNameConfig | boolean | undefined,
): AutoNameConfig {
  if (config === undefined || config === true) {
    return { enabled: true };
  }
  if (config === false) {
    return { enabled: false };
  }
  return config;
}

/**
 * AutoNameGenerator
 *
 * A class that generates sequential numbers per Feature type.
 * It accounts for the numbers of existing Features and starts from the next number.
 * A number that has been used once is not reused even after deletion (it leaves gaps).
 *
 * The existing numbers are taken in with a single full scan per type, and after that only the
 * increments are taken in by subscribing to the Store. Scanning everything on every call would
 * make the case of generating one at a time, as in a bulk import, O(n^2).
 *
 * With this incremental approach, the number of a name that was added and then deleted before
 * any generation happened is also recorded (with the old approach it could be reused after the
 * deletion). This is an extension of the "a number used once is not reused" policy, and it can
 * only work in the direction of increasing the gaps.
 *
 * A Store that holds only part of the document can give, per type, the largest number it
 * knows to be used (`getMaxNameNumber`): each generation then takes the number after the
 * larger of that and the count above, and tells the Store the number it took
 * (`recordNameNumber`). With a Store that has neither, the numbering is the count above alone.
 */
export class AutoNameGenerator {
  private readonly store: NameSource;
  private config: AutoNameConfig;
  /** Counter that remembers the largest number already generated per type */
  private readonly counters: Map<string, number> = new Map();
  /** Counter keys whose full scan is done (Layer/Group go into the same Set) */
  private readonly scannedTypes = new Set<string>();
  /** Unsubscribe function of the Store subscription (null when not subscribed) */
  private unsubscribe: (() => void) | null = null;

  constructor(
    store: {
      listFeatures(): Feature[];
      listLayers(): Layer[];
      listGroups(): Group[];
      subscribe(listener: (changes: StoreChange) => void): () => void;
      getMaxNameNumber?(type: AutoNameType): number | undefined;
      recordNameNumber?(type: AutoNameType, number: number): void;
    },
    config: AutoNameConfig | boolean = true,
  ) {
    this.store = store;
    this.config = normalizeAutoNameConfig(config);

    // When disabled, no name is generated, so there is no need to maintain the counters
    if (this.config.enabled) {
      this.unsubscribe = store.subscribe((changes) => {
        this.observeChanges(changes);
      });
    }
  }

  /**
   * Returns whether it is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Replaces the configuration: whether names are generated, the words of the types and the
   * format. The numbers already used are not used again; the names already in the document
   * are read again in the new words.
   */
  configure(config: AutoNameConfig | boolean): void {
    this.config = normalizeAutoNameConfig(config);
    this.scannedTypes.clear();
    if (this.config.enabled && !this.unsubscribe) {
      this.unsubscribe = this.store.subscribe((changes) => {
        this.observeChanges(changes);
      });
    } else if (!this.config.enabled) {
      this.dispose();
    }
  }

  /**
   * Unsubscribes from the Store
   */
  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /**
   * Generates an automatic name for the given type
   *
   * @returns The generated name, or undefined when it is disabled
   */
  generateName(featureType: FeatureType): string | undefined {
    if (!this.config.enabled) {
      return undefined;
    }

    const typeName = this.getTypeName(featureType);
    const nextNumber = this.findNextNumber(featureType, typeName);
    const formatter = this.config.formatter ?? defaultFormatter;

    return formatter(typeName, nextNumber);
  }

  /**
   * Gets the type name
   */
  private getTypeName(featureType: FeatureType): string {
    // Use a custom type name if there is one
    if (this.config.typeNames && featureType in this.config.typeNames) {
      return (
        this.config.typeNames[featureType as keyof typeof this.config.typeNames] ?? featureType
      );
    }
    // Default type name
    return DEFAULT_TYPE_NAMES[featureType] ?? featureType;
  }

  /**
   * Gets the next number
   *
   * Increments the counter by 1 and returns it. The counter holds the largest existing number
   * (the first full scan plus the increments after it), so the number of a deleted Feature is
   * not reused and a gap appears.
   */
  private findNextNumber(featureType: FeatureType, typeName: string): number {
    this.scanOnce(featureType, () => this.getMaxNumberFromFeatures(featureType, typeName));
    return this.takeNextNumber(featureType);
  }

  /**
   * Takes the next number of a counter key: the one after the larger of the counter and the
   * largest number the Store knows (when it gives one), and tells the Store the number taken
   */
  private takeNextNumber(counterKey: AutoNameType): number {
    const known = this.store.getMaxNameNumber?.(counterKey);
    if (known !== undefined && Number.isSafeInteger(known)) {
      this.recordNumber(counterKey, known);
    }

    const nextNumber = (this.counters.get(counterKey) ?? 0) + 1;
    this.counters.set(counterKey, nextNumber);
    this.store.recordNameNumber?.(counterKey, nextNumber);

    return nextNumber;
  }

  /**
   * Takes in the largest existing number only the first time a generation happens for that
   * counter key
   *
   * From the second time onward the counter is maintained incrementally, so it does not scan.
   */
  private scanOnce(counterKey: string, scan: () => number): void {
    if (this.scannedTypes.has(counterKey)) return;
    this.scannedTypes.add(counterKey);
    this.recordNumber(counterKey, scan());
  }

  /**
   * Raises the counter up to number (a smaller value does not lower it)
   */
  private recordNumber(counterKey: string, number: number): void {
    if (number > (this.counters.get(counterKey) ?? 0)) {
      this.counters.set(counterKey, number);
    }
  }

  /**
   * Takes in the numbers of names from the changes of the Store
   *
   * The path that keeps the cost proportional to the number of changes and avoids scanning
   * everything on every generation.
   * Deletions are ignored (because a number used once is not reused).
   */
  private observeChanges(changes: StoreChange): void {
    for (const feature of changes.features?.created ?? []) {
      this.observeFeatureName(feature);
    }
    for (const { feature } of changes.features?.updated ?? []) {
      this.observeFeatureName(feature);
    }

    const layerTypeName = this.getLayerTypeName();
    for (const layer of changes.layers?.created ?? []) {
      this.observeName(LAYER_COUNTER_KEY, layerTypeName, layer.name);
    }
    for (const { layer } of changes.layers?.updated ?? []) {
      this.observeName(LAYER_COUNTER_KEY, layerTypeName, layer.name);
    }

    const groupTypeName = this.getGroupTypeName();
    for (const group of changes.groups?.created ?? []) {
      this.observeName(GROUP_COUNTER_KEY, groupTypeName, group.name);
    }
    for (const { group } of changes.groups?.updated ?? []) {
      this.observeName(GROUP_COUNTER_KEY, groupTypeName, group.name);
    }
  }

  /**
   * Takes in the number from the name of a Feature
   */
  private observeFeatureName(feature: Feature): void {
    const name = feature.properties?.name;
    if (typeof name !== 'string') return;
    this.observeName(feature.type, this.getTypeName(feature.type), name);
  }

  /**
   * Extracts the number from a name and takes it into the counter
   */
  private observeName(counterKey: string, typeName: string, name: string): void {
    const number = extractNumberFromName(name, typeName);
    if (number !== null) this.recordNumber(counterKey, number);
  }

  /**
   * Gets the type name of Layer
   */
  private getLayerTypeName(): string {
    return this.config.typeNames?.Layer ?? DEFAULT_LAYER_NAME;
  }

  /**
   * Gets the type name of Group
   */
  private getGroupTypeName(): string {
    return this.config.typeNames?.Group ?? DEFAULT_GROUP_NAME;
  }

  /**
   * Gets the largest number from the existing Features
   */
  private getMaxNumberFromFeatures(featureType: FeatureType, typeName: string): number {
    const features = this.store.listFeatures();
    let maxNumber = 0;

    for (const feature of features) {
      // Only features of the same type are considered
      if (feature.type !== featureType) {
        continue;
      }

      // Get the name property
      const name = feature.properties?.name;
      if (typeof name !== 'string') {
        continue;
      }

      // Extract the number
      const number = extractNumberFromName(name, typeName);
      if (number !== null && number > maxNumber) {
        maxNumber = number;
      }
    }

    return maxNumber;
  }

  /**
   * Generates the name of a new Layer
   *
   * A layer always has a name, so this never gives up: when naming is disabled it returns the
   * word of Layer alone, without a number.
   *
   * @returns The generated name ("Layer 2"), or the word of Layer when it is disabled
   */
  generateLayerName(): string {
    const typeName = this.getLayerTypeName();
    if (!this.config.enabled) {
      return typeName;
    }

    const nextNumber = this.findNextLayerNumber(typeName);
    const formatter = this.config.formatter ?? defaultFormatter;

    return formatter(typeName, nextNumber);
  }

  /**
   * Gets the next Layer number
   */
  private findNextLayerNumber(typeName: string): number {
    this.scanOnce(LAYER_COUNTER_KEY, () => {
      let maxNumber = 0;
      for (const layer of this.store.listLayers()) {
        const number = extractNumberFromName(layer.name, typeName);
        if (number !== null && number > maxNumber) {
          maxNumber = number;
        }
      }
      return maxNumber;
    });
    return this.takeNextNumber(LAYER_COUNTER_KEY);
  }

  /**
   * Generates the name of a new Group
   *
   * A group always has a name, so this never gives up: when naming is disabled it returns the
   * word of Group alone, without a number.
   *
   * @returns The generated name ("Group 2"), or the word of Group when it is disabled
   */
  generateGroupName(): string {
    const typeName = this.getGroupTypeName();
    if (!this.config.enabled) {
      return typeName;
    }

    const nextNumber = this.findNextGroupNumber(typeName);
    const formatter = this.config.formatter ?? defaultFormatter;

    return formatter(typeName, nextNumber);
  }

  /**
   * Gets the next Group number
   */
  private findNextGroupNumber(typeName: string): number {
    this.scanOnce(GROUP_COUNTER_KEY, () => {
      let maxNumber = 0;
      for (const group of this.store.listGroups()) {
        const number = extractNumberFromName(group.name, typeName);
        if (number !== null && number > maxNumber) {
          maxNumber = number;
        }
      }
      return maxNumber;
    });
    return this.takeNextNumber(GROUP_COUNTER_KEY);
  }
}
