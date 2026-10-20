# ABI Explorer for Neovim

Neovim 0.11 or newer, and Node.js 20 or newer. Install the server from the
[release](https://github.com/tothambrus11/abi-explorer-2/releases) (replace `<v>` with its version):

```sh
npm install -g https://github.com/tothambrus11/abi-explorer-2/releases/download/editors-v<v>/hylo-lang-abi-explorer-<v>.tgz
```

Each release's GitHub page has this directory as `abi-explorer-neovim-<version>.zip`; unzip it
and point a plugin manager at it:

```lua
-- lazy.nvim
{ dir = '/path/to/abi-explorer.nvim', main = 'abi-explorer', opts = {} }
-- or the runtime path
vim.opt.runtimepath:append('/path/to/abi-explorer.nvim')
require('abi-explorer').setup()
```

`setup` takes the server's configuration too:
`require('abi-explorer').setup({ lsp = { init_options = { target = 'armv7-unknown-linux-gnueabihf' } } })`.
To work on the plugin, add `editors/neovim` of a checkout to the runtime path instead.

The server alone, without `:AbiLayout` and the colours, needs only
[`lsp/abi_explorer.lua`](lsp/abi_explorer.lua) on the runtime path (the plugin puts it there) and
`vim.lsp.enable('abi_explorer')`. That file is written the way nvim-lspconfig's are, so it can go
into nvim-lspconfig, and the server into Mason's registry, unchanged ([RELEASING.md](../RELEASING.md#neovim-nvim-lspconfig-and-mason)).

- `K` on a struct or member name shows its byte map and member table, and so does `K` on any use
  of a struct, library types included (`std::string`).
- A struct whose member order wastes space gets a warning (`vim.diagnostic`) saying how small
  another order would make it. `// abi-explorer: keep order` above a struct (the warning's
  other code action writes it) says the order is meant.
- `vim.lsp.buf.code_action()` (`gra`) on a struct offers to pin its layout with `static_assert`,
  and, on one with that warning, to reorder its members by alignment.
- `:AbiLayout` toggles a split with the web explorer's layout view of the struct at the cursor,
  in Unicode: a tab per struct, the size tiles, the byte grid (four characters a byte, two bits a
  character, so bit-fields show where each starts) and the member table. Colours are the web's
  (`termguicolors`; Nocturne's with a dark `background`). The member at the cursor is underlined in
  the grid and tinted in the table. In the split, `<CR>` on a tab opens that struct, on a row with
  others inside opens or shuts it, and on any other row jumps to the member; `gd` on a compound
  member opens its struct. The source line of the row under the cursor is marked, and members of
  the struct at the cursor get a dot in their colour.
- `:AbiTarget armv7-unknown-linux-gnueabihf` lays structs out for another target, with the
  engine's bundled headers; `:AbiTarget` alone goes back to the project's own. Tab completes
  common targets.

Compile flags come from `compile_commands.json` or `compile_flags.txt`, found the way clangd finds
them.
