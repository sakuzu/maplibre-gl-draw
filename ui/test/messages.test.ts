// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { getMessages } from '@sakuzu/kata/svelte';
import { describe, expect, it } from 'vitest';
import { en } from '../src/locales/en.js';
import { ja } from '../src/locales/ja.js';
import {
  applyKataMessages,
  kataMessages,
  localeLanguage,
  resolveMessages,
} from '../src/messages.js';

describe('the words', () => {
  it('are English by default', () => {
    expect(resolveMessages()).toEqual(en);
    expect(resolveMessages('en')).toEqual(en);
  });

  it('have every word in Japanese', () => {
    expect(Object.keys(ja).sort()).toEqual(Object.keys(en).sort());
    expect(resolveMessages('ja').polygon).toBe('面');
  });

  it('lay a partial set over English', () => {
    const m = resolveMessages({ polygon: 'Area', delete: 'Remove' });
    expect(m).toEqual({ ...en, polygon: 'Area', delete: 'Remove' });
  });

  it('ignore keys they do not have and values that are not strings', () => {
    const m = resolveMessages({ polygon: 3, nothing: 'x' } as never);
    expect(m).toEqual(en);
  });

  it('give the language of the locales that come with the interface', () => {
    expect(localeLanguage('ja')).toBe('ja');
    expect(localeLanguage({ polygon: 'Area' })).toBeNull();
  });

  it('pass the words that kata shows on to kata', () => {
    expect(Object.keys(kataMessages(ja)).sort()).toEqual(
      [
        'back',
        'close',
        'closePanes',
        'dockHeight',
        'keyboardShortcuts',
        'more',
        'sheetHeight',
      ].sort(),
    );
    applyKataMessages(resolveMessages('ja'));
    expect(getMessages().more).toBe('その他');
    expect(getMessages().keyboardShortcuts).toBe('キーボードショートカット');
    applyKataMessages(resolveMessages('en'));
    expect(getMessages().more).toBe('More');
  });
});
