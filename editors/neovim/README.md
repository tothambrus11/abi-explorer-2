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
  another order would make it.
- `vim.lsp.buf.code_action()` (`gra`) on a struct offers to pin its layout with `static_assert`,
  and, on one with that warning, to reorder its members by alignment.
- `:AbiLayout` toggles a split with the layout of the struct at the cursor; the member at the
  cursor is marked `▶` and its bytes and letter are filled, while the others show in colour. Colours match the other
  editors (`termguicolors`); override the `AbiExplorerMember1`…`8`, `AbiExplorerMemberFaded1`…`8`,
  `AbiExplorerPadding` and `AbiExplorerSelected` highlight groups to change them.
- `:AbiTarget armv7-unknown-linux-gnueabihf` lays structs out for another target, with the
  engine's bundled headers; `:AbiTarget` alone goes back to the project's own. Tab completes
  common targets.

Compile flags come from `compile_commands.json` or `compile_flags.txt`, found the way clangd finds
them.
