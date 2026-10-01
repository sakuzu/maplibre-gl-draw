// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The gallery of the examples: a card for each, in the order of docs/examples/catalog.json
 * (the playground first), with its picture, its title and its one sentence
 *
 * The gallery page (docs/examples/index.md) writes an empty fence of the language
 * `example-gallery`, and the configuration renders it as this component. A card leads to the
 * page of the example, which shows it live with its code. The pictures are
 * docs/public/examples/<name>.png, taken by `npm run site:thumbnails`.
 */

import { useData, withBase } from 'vitepress';
import { defineComponent, h } from 'vue';
import catalog from '../../examples/catalog.json';

interface Example {
  name: string;
  title: string;
  titleJa: string;
  description: string;
  descriptionJa: string;
  order: number;
}

const EXAMPLES: Example[] = Object.entries(catalog)
  .map(([name, entry]) => ({ name, ...entry }))
  .sort((a, b) => a.order - b.order);

export const ExampleGallery = defineComponent({
  name: 'ExampleGallery',
  setup() {
    const { lang } = useData();
    return () => {
      const ja = lang.value === 'ja';
      return h(
        'ul',
        { class: 'example-gallery' },
        EXAMPLES.map((example) =>
          h('li', { key: example.name }, [
            h('a', { href: withBase(`${ja ? '/ja' : ''}/examples/${example.name}.html`) }, [
              h('img', {
                src: withBase(`/examples/${example.name}.png`),
                alt: '',
                width: 640,
                height: 400,
                loading: 'lazy',
              }),
              h('span', { class: 'title' }, ja ? example.titleJa : example.title),
              h('span', { class: 'description' }, ja ? example.descriptionJa : example.description),
            ]),
          ]),
        ),
      );
    };
  },
});
