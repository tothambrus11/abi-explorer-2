// Bundles the server and its engine worker into dist/, dependencies included,
// so the published package installs with nothing to resolve.
import { build } from 'esbuild';

await build({
  entryPoints: { server: 'src/main.ts', engineWorker: 'src/engine/engineWorker.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  minify: true,
  // `--sourcemap` for debugging; the published package goes without.
  sourcemap: process.argv.includes('--sourcemap') ? 'linked' : false,
  // Some bundled CommonJS dependencies call require(); give ESM output one.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: 'warning',
});
