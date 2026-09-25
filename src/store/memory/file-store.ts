// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * FileStore
 *
 * A Map wrapper for embedded files (FileData) such as images. It provides only CRUD,
 * independently of Feature / Layer / Group. Change notification is unnecessary (because the
 * rendering pipeline references the binary data directly).
 */

import type { FileData } from '../types.js';
import { frozenCopy } from './frozen.js';

export class FileStore {
  readonly #files = new Map<string, FileData>();

  create(file: FileData): void {
    if (this.#files.has(file.id)) {
      throw new Error(`File with id "${file.id}" already exists`);
    }
    this.#files.set(file.id, frozenCopy({ ...file }));
  }

  get(id: string): FileData | undefined {
    return this.#files.get(id);
  }

  getAll(): FileData[] {
    return Array.from(this.#files.values());
  }

  delete(id: string): void {
    if (!this.#files.has(id)) {
      throw new Error(`File with id "${id}" not found`);
    }
    this.#files.delete(id);
  }
}
