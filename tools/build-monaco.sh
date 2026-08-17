#!/bin/sh
# Rebuilds vendor/monaco/ (Monaco editor bundled as a single ESM file + its
# editor worker) and vendor/fonts/ (JetBrains Mono woff2). Output is committed,
# so visitors need no build step. Requires node + npm. Run from the repo root.
set -eu
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
cd "$tmp"
npm init -y >/dev/null
npm i --no-fund --no-audit monaco-editor@0.56 esbuild @fontsource/jetbrains-mono >/dev/null
cat > entry.js <<'JS'
import * as monaco from 'monaco-editor/editor/editor.main.js';
import 'monaco-editor/languages/definitions/cpp/register.js';
export { monaco };
JS
out="$OLDPWD/vendor/monaco"; rm -rf "$out"; mkdir -p "$out" "$OLDPWD/vendor/fonts"
npx esbuild entry.js --bundle --format=esm --minify --outdir="$out" \
    --loader:.ttf=file --entry-names=monaco --asset-names='[name]'
npx esbuild node_modules/monaco-editor/esm/vs/editor/editor.worker.js \
    --bundle --format=iife --minify --outfile="$out/editor.worker.js"
cp node_modules/monaco-editor/LICENSE "$out/LICENSE"
cp node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin*-{400,700}-{normal,italic}.woff2 "$OLDPWD/vendor/fonts/"
cp node_modules/@fontsource/jetbrains-mono/LICENSE "$OLDPWD/vendor/fonts/LICENSE-JetBrainsMono"
echo "Built $(du -sh "$out" | cut -f1) into vendor/monaco/"
