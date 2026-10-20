#!/usr/bin/env bash
# Opens the pull request on zed-industries/extensions that publishes a version
# of the Zed extension: the `extensions/abi-explorer` submodule pointed at the
# released commit, and its entry in extensions.toml (path `editors/zed`, the
# version). The first one adds both; Zed's maintainers review every one.
#
#   VERSION=0.2.0 COMMIT=<sha> GH_TOKEN=<classic PAT, public_repo> scripts/zed-extensions-pr.sh
#
# The token's user gets (or already has) a fork of zed-industries/extensions,
# which the branch is pushed to. Needs git, gh and Node.js.
set -euo pipefail

: "${VERSION:?set VERSION}" "${COMMIT:?set COMMIT}" "${GH_TOKEN:?set GH_TOKEN}"
REPOSITORY=${REPOSITORY:-https://github.com/tothambrus11/abi-explorer-2.git}
name=abi-explorer
upstream=zed-industries/extensions
user=$(gh api user --jq .login)
branch=$name-v$VERSION
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

gh repo fork "$upstream" --clone=false >/dev/null 2>&1 || true
gh repo sync "$user/extensions" --source "$upstream" >/dev/null
git clone --quiet --depth 1 --filter=blob:none --no-recurse-submodules \
  "https://x-access-token:$GH_TOKEN@github.com/$user/extensions.git" "$work/extensions"
cd "$work/extensions"
git checkout --quiet -b "$branch"

first=false
if ! grep -q "^\[submodule \"extensions/$name\"\]" .gitmodules; then
  first=true
  printf '\n[submodule "extensions/%s"]\n\tpath = extensions/%s\n\turl = %s\n' "$name" "$name" "$REPOSITORY" >>.gitmodules
fi
# The submodule is a commit id in the tree; nothing needs cloning to move it.
git update-index --add --cacheinfo "160000,$COMMIT,extensions/$name"

NAME=$name VERSION=$VERSION node --input-type=module <<'JS'
import fs from 'node:fs';
const { NAME: name, VERSION: version } = process.env;
const entry = `[${name}]\nsubmodule = "extensions/${name}"\npath = "editors/zed"\nversion = "${version}"\n`;
const text = fs.readFileSync('extensions.toml', 'utf8');
const block = new RegExp(`^\\[${name}\\]\\n(?:(?!\\[).*\\n?)*`, 'm');
fs.writeFileSync(
  'extensions.toml',
  block.test(text) ? text.replace(block, entry + '\n') : `${text.trimEnd()}\n\n${entry}`,
);
JS
# Their own script puts both files back in order, as their CI requires.
npm install --silent --no-save --ignore-scripts @iarna/toml@2.2.5 git-submodule-js@1.0.5
node src/sort-extensions.js
rm -rf node_modules

git add .gitmodules extensions.toml
if git diff --cached --quiet; then
  echo "zed-industries/extensions already has $name $VERSION"
  exit 0
fi
title=$([[ $first == true ]] && echo "Add $name" || echo "Update $name to $VERSION")
git -c user.name="$user" -c user.email="$user@users.noreply.github.com" commit --quiet -m "$title"
git push --quiet --force origin "$branch"

if gh pr list --repo "$upstream" --head "$user:$branch" --json number --jq '.[0].number' | grep -q .; then
  echo "the pull request for $branch is already open"
else
  gh pr create --repo "$upstream" --head "$user:$branch" --title "$title" --body \
    "ABI Explorer $VERSION: struct sizes, offsets and padding for C and C++ in hovers and code actions, from the project's own compile flags. Source: https://github.com/tothambrus11/abi-explorer-2/tree/$COMMIT/editors/zed"
fi
