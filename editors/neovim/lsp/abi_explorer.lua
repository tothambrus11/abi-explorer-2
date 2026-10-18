-- abi-explorer-lsp for Neovim 0.11+: `vim.lsp.enable('abi_explorer')`.
-- Install the server with `npm install -g abi-explorer-lsp`.
return {
  cmd = { 'abi-explorer-lsp', '--stdio' },
  filetypes = { 'c', 'cpp', 'cuda' },
  root_markers = { 'compile_commands.json', 'compile_flags.txt', '.git' },
  -- Hovers draw the byte map as text; a terminal shows no images.
  init_options = { hoverImages = false, inlayHints = 'records' },
}
