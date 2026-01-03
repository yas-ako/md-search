// @ts-check
import { defineConfig } from 'astro/config';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

// https://astro.build/config
export default defineConfig({
  markdown: {
    shikiConfig: {
      theme: 'github-light',
    },
    // 数式レンダリングを有効化
    remarkPlugins: [remarkMath],
    rehypePlugins: [rehypeKatex],
  },
});
