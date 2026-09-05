import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: {
      // The share-link package, on its source: no build step between an edit
      // there and the app seeing it. The published package ships `dist`.
      '@ambrus-toth/abi-explorer-share-link': new URL(
        './packages/share-link/src/index.ts',
        import.meta.url,
      ).pathname,
      $core: new URL('./src/core', import.meta.url).pathname,
      $compiler: new URL('./src/compiler', import.meta.url).pathname,
      $state: new URL('./src/state', import.meta.url).pathname,
      $ui: new URL('./src/ui', import.meta.url).pathname,
    },
  },
  test: {
    include: ['tests/unit/**/*.test.ts', 'packages/*/tests/**/*.test.ts'],
    environment: 'node',
    coverage: { provider: 'v8', include: ['src/core/**', 'src/compiler/**', 'src/state/**'] },
  },
});
