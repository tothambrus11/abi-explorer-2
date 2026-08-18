import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: {
      $core: new URL('./src/core', import.meta.url).pathname,
      $compiler: new URL('./src/compiler', import.meta.url).pathname,
      $state: new URL('./src/state', import.meta.url).pathname,
      $ui: new URL('./src/ui', import.meta.url).pathname,
    },
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    coverage: { provider: 'v8', include: ['src/core/**', 'src/compiler/**', 'src/state/**'] },
  },
});
