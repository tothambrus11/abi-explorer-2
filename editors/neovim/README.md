# ABI Explorer for Neovim

Neovim 0.11 or newer. Install the server, then add this directory to your runtime path:

```sh
npm install -g abi-explorer-lsp
```

```lua
-- lazy.nvim: { dir = '…/abi-explorer-2/editors/neovim', config = function() require('abi-explorer').setup() end }
require('abi-explorer').setup({
  inlay_hints = true,             -- `40 B · align 8 · 7 B padding` after each struct name
  lsp = { init_options = { inlayHints = 'members' } }, -- also `@4 · 4 B` after each member
})
```

- `K` on a struct or member name shows its byte map and member table.
- `:AbiLayout` toggles a split with the layout of the struct at the cursor; the member at the
  cursor is marked `▶` in the member table.

Compile flags come from `compile_commands.json` or `compile_flags.txt`, found the way clangd finds
them. `vim.lsp.inlay_hint.enable` is per buffer, not per server, so turning hints on also shows
other servers' hints (clangd's parameter names, for example).
