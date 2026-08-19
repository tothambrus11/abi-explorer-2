import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    svelte(),
    VitePWA({
      // We keep our own service worker (src/sw.ts): the app shell is
      // precached, and the wasm module is too big for that and is cached
      // lazily on first fetch instead.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectRegister: false, // registered from src/pwa.ts so we can show status
      includeAssets: ['icons/*'],
      manifest: {
        name: 'ABI Explorer',
        short_name: 'ABI Explorer',
        description:
          'Visualize C/C++ struct layouts for any LLVM target — clang compiled to WebAssembly, running entirely in your browser.',
        start_url: './',
        scope: './',
        display: 'standalone',
        background_color: '#0f1420',
        theme_color: '#0f1420',
        categories: ['developer tools', 'utilities'],
        icons: [
          { src: 'icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: 'icons/maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,ttf,webmanifest}'],
        // The wasm module is cached lazily by the service worker's own route.
        globIgnores: ['**/vendor/abi/*'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: {
      $core: new URL('./src/core', import.meta.url).pathname,
      $compiler: new URL('./src/compiler', import.meta.url).pathname,
      $state: new URL('./src/state', import.meta.url).pathname,
      $ui: new URL('./src/ui', import.meta.url).pathname,
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: (id) => (id.includes('monaco-editor') ? 'monaco' : undefined),
      },
    },
  },
  worker: { format: 'es' },
  server: { port: 5173, strictPort: false },
  preview: { port: 4173 },
});
