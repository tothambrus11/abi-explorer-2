#!/usr/bin/env bash
# Screenshots of the Zed extension and the Neovim plugin on the test fixture,
# under Xvfb, for reviewing what users see. VS Code's come from its e2e test.
#
#   ZED=/path/to/zed.app/bin/zed NVIM=/path/to/nvim scripts/desktop-screenshots.sh
#
# Needs Xvfb, xdotool, ImageMagick's `import`, xterm, Node.js 20+, a Rust
# toolchain with the wasm32-wasip2 target, and the engine files (ABI_ENGINE_PATH,
# default: the web app's public/vendor/abi). Runs Zed and Neovim with a
# throwaway HOME, so the user's own configuration is left alone.
set -euo pipefail

editors=$(cd "$(dirname "$0")/.." && pwd)
engine=${ABI_ENGINE_PATH:-$editors/../public/vendor/abi}
node=$(command -v node)
out=$editors/screenshots
work=$(mktemp -d)
export HOME=$work/home DISPLAY=:${DISPLAY_NUMBER:-99}
mkdir -p "$HOME" "$out"

# The fixture project, with its compile_commands.json pointing at the copy.
project=$work/project
cp -r "$editors/server/test/fixtures/project" "$project"
mkdir "$project/build"
sed "s#\${root}#$project#g" "$project/compile_commands.template.json" > "$project/build/compile_commands.json"
rm "$project/compile_commands.template.json"

(cd "$editors/server" && node build.mjs)
server=("$node" "$editors/server/bin/abi-explorer-lsp.js" --stdio)

Xvfb "$DISPLAY" -screen 0 1500x900x24 &
xvfb=$!
trap 'kill $xvfb 2>/dev/null; rm -rf "$work"' EXIT
sleep 1

shot() { sleep "$1"; import -window root "$out/$2"; }

if [[ -n ${ZED:-} ]]; then
  (cd "$editors/zed" && cargo build --release --target wasm32-wasip2 -q)
  extension=$HOME/.local/share/zed/extensions/installed/abi-explorer
  mkdir -p "$extension" "$HOME/.config/zed"
  cp "$editors/zed/extension.toml" "$extension/"
  cp "$editors/zed/target/wasm32-wasip2/release/zed_abi_explorer.wasm" "$extension/extension.wasm"
  cat > "$HOME/.config/zed/settings.json" <<JSON
{
  "theme": "One Dark",
  "ui_font_size": 15,
  "buffer_font_size": 15,
  "auto_update": false,
  "disable_ai": true,
  "inlay_hints": { "enabled": true },
  "hover_popover_delay": 100,
  "lsp": {
    "abi-explorer-lsp": {
      "binary": { "path": "${server[0]}", "arguments": ["${server[1]}", "--stdio"] },
      "initialization_options": { "enginePath": "$engine" }
    }
  }
}
JSON
  (cd "$project" && ZED_ALLOW_ROOT=true ZED_ALLOW_EMULATED_GPU=1 "$ZED" --foreground . main.cpp >"$work/zed.log" 2>&1 &)
  sleep 15 # the trust prompt can take a while on a software-rendered display
  xdotool key Return # trust the project
  sleep 15
  xdotool mousemove 195 313 # `Packet`
  shot 4 zed-record-hover.png
  xdotool mousemove 900 700
  sleep 2
  xdotool mousemove 290 385 # `checksum`
  shot 4 zed-member-hover.png
  xdotool mousemove 900 700 click 1 mousemove 195 313 click 1 # the caret on `Packet`
  sleep 1
  xdotool key ctrl+period
  shot 4 zed-reorder-action.png
  xdotool key Escape
  # By name: the command line of this script contains $ZED too.
  pkill -x zed-editor || true
fi

if [[ -n ${NVIM:-} ]]; then
  mkdir -p "$HOME/.config/nvim"
  cat > "$HOME/.config/nvim/init.lua" <<LUA
vim.opt.runtimepath:prepend('$editors/neovim')
vim.opt.termguicolors = true
vim.opt.number = true
vim.cmd.colorscheme('habamax')
require('abi-explorer').setup({
  lsp = {
    cmd = { '${server[0]}', '${server[1]}', '--stdio' },
    init_options = { enginePath = '$engine' },
  },
})
LUA
  (cd "$project" && LANG=C.UTF-8 LC_ALL=C.UTF-8 xterm -u8 -geometry 160x47+0+0 -fa 'DejaVu Sans Mono' -fs 11 -bg '#1c1c1c' \
    -e "$NVIM" main.cpp '+call cursor(12, 20)' '+AbiLayout' &)
  shot 12 neovim-layout-split.png
  xdotool type --delay 50 ':call cursor(9, 10)'
  xdotool key Return
  sleep 1
  xdotool type K
  shot 3 neovim-hover.png
  pkill xterm || true
fi
