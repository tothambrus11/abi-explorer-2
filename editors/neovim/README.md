# ABI Explorer for Neovim

Neovim 0.11 or newer. Install the server, then add this directory to your runtime path:

```sh
npm install -g abi-explorer-lsp
```

```lua
-- lazy.nvim: { dir = '…/abi-explorer-2/editors/neovim', config = function() require('abi-explorer').setup() end }
require('abi-explorer').setup()
-- or, to configure the server: require('abi-explorer').setup({ lsp = { init_options = { … } } })
```

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
