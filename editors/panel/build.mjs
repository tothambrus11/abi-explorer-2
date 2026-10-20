// Bundles the panel into dist/panel.js and dist/panel.css. Each host writes its
// own HTML around them (a webview needs its CSP, JCEF its bridge).
import { build } from 'esbuild';

await build({
  entryPoints: [
    { in: 'src/main.ts', out: 'panel' },
    { in: 'src/panel.css', out: 'panel' },
  ],
  outdir: 'dist',
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['chrome120'],
  logLevel: 'warning',
});
