// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The live example of a page of the examples, in a frame, with a link that opens it alone
 *
 * A page writes a fence of the language `example` holding the name of the example (the folder
 * under examples/), and the configuration renders it as this component. The built site has the
 * examples under /examples/ (`npm run site:build` builds them there). While the site is served
 * by `npm run site:dev`, the frame shows the examples' own dev server, `npm run dev` on port
 * 3200, which runs beside it. A Japanese page shows the example in Japanese (`?locale=ja`).
 */

import { useData, withBase } from 'vitepress';
import { computed, defineComponent, h } from 'vue';

/** Where the examples are served while the site is served by `vitepress dev` */
const DEV_EXAMPLES = 'http://localhost:3200/';

export const ExampleFrame = defineComponent({
  name: 'ExampleFrame',
  props: {
    /** The folder of the example under examples/ */
    name: { type: String, required: true },
  },
  setup(props) {
    const { lang, page } = useData();
    const ja = computed(() => lang.value === 'ja');
    const src = computed(() => {
      const root = import.meta.env.DEV ? DEV_EXAMPLES : withBase('/examples/');
      return `${root}${props.name}/${ja.value ? '?locale=ja' : ''}`;
    });
    return () =>
      h('figure', { class: 'example-frame' }, [
        h('iframe', {
          src: src.value,
          title: `${ja.value ? '動く例' : 'Live example'}: ${page.value.title}`,
          loading: 'lazy',
        }),
        h('figcaption', [
          h('a', { href: src.value, target: '_blank', rel: 'noreferrer' }, [
            ja.value ? '例を別のタブで開く' : 'Open the example in a new tab',
          ]),
        ]),
      ]);
  },
});
