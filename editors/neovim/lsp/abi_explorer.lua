---@brief
---
--- https://github.com/tothambrus11/abi-explorer-2
---
--- Struct and class layouts for C and C++: sizes, offsets and padding in hovers, a warning on
--- member orders that waste space, and code actions that reorder members or pin a layout with
--- `static_assert`. Layouts come from Clang itself, with the project's own compile flags
--- (`compile_commands.json` or `compile_flags.txt`).
---
--- Install the server from a release of https://github.com/tothambrus11/abi-explorer-2:
---
--- ```sh
--- npm install -g https://github.com/tothambrus11/abi-explorer-2/releases/download/editors-v<v>/hylo-lang-abi-explorer-<v>.tgz
--- ```

---@type vim.lsp.Config
return {
  cmd = { 'abi-explorer-lsp', '--stdio' },
  filetypes = { 'c', 'cpp', 'cuda' },
  root_markers = { 'compile_commands.json', 'compile_flags.txt', '.git' },
}
