#!/bin/sh
# Vendors the clang-wasm assets into vendor/clang/ so the site is fully
# self-contained (no runtime download from the npm registry).
# Requires: curl, tar. Run from the repository root.
set -eu

VERSION="22.0.0-git20542-10"
URL="https://registry.npmjs.org/@yowasp/clang/-/clang-${VERSION}.tgz"
DEST="vendor/clang"

echo "Downloading @yowasp/clang ${VERSION}..."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fSL "$URL" -o "$tmp/clang.tgz"
tar -xzf "$tmp/clang.tgz" -C "$tmp" \
    package/gen/llvm.core.wasm package/gen/llvm.core2.wasm \
    package/gen/llvm.core3.wasm package/gen/llvm.core4.wasm \
    package/gen/llvm-resources.tar
mv "$tmp"/package/gen/llvm.core*.wasm "$tmp"/package/gen/llvm-resources.tar "$DEST/"
echo "Done. $(du -sh "$DEST" | cut -f1) in $DEST/ — the site now loads clang locally."
