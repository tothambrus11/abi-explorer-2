// Bundles the panel into dist/view.js and dist/view.css. Each host writes its
// own HTML around them (a webview needs its CSP, JCEF its bridge).
import { build } from 'esbuild';

await build({
  entryPoints: ['src/view.ts', 'src/view.css'],
  outdir: 'dist',
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['chrome120'],
  logLevel: 'warning',
});
