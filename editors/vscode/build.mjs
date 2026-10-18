// Bundles the extension into dist/, next to copies of the server and panel
// bundles, so the VSIX needs no node_modules.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { build } from 'esbuild';

for (const workspace of ['../server', '../view']) {
  execFileSync(process.execPath, ['build.mjs'], { cwd: new URL(workspace, import.meta.url), stdio: 'inherit' });
}
fs.rmSync('dist', { recursive: true, force: true });
fs.cpSync('../server/dist', 'dist/server', { recursive: true });
fs.writeFileSync('dist/server/package.json', '{ "type": "module" }\n');
fs.cpSync('../view/dist', 'dist/view', { recursive: true });

await build({
  entryPoints: { extension: 'src/extension.ts' },
  outdir: 'dist',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  minify: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  logLevel: 'warning',
});
