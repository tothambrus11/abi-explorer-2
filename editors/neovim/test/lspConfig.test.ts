// lsp/abi_explorer.lua on its own, as nvim-lspconfig or Mason would carry it:
// no `setup`, only the file on the runtime path and `vim.lsp.enable`.

import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REQUIRE_ALL } from '../../server/test/support/fixtureProject.ts';
import { findOnPath } from './findOnPath.ts';

// NEOVIM_PLUGIN: another copy, such as the release's unzipped abi-explorer.nvim.
const plugin = process.env.NEOVIM_PLUGIN ?? path.join(import.meta.dirname, '..');
const server =
  process.env.ABI_EXPLORER_SERVER ??
  path.join(import.meta.dirname, '..', '..', 'server', 'src', 'main.ts');
const nvim = process.env.NVIM_BIN ?? findOnPath('nvim');

describe.skipIf(!REQUIRE_ALL && !nvim)('lsp/abi_explorer.lua without the plugin', () => {
  it('starts the server for C++ files with vim.lsp.enable alone', () => {
    const lua = (value: unknown) => JSON.stringify(value);
    const script = `
      vim.opt.runtimepath:prepend(${lua(plugin)})
      vim.cmd('filetype on')
      local config = vim.lsp.config.abi_explorer
      local result = { cmd = config.cmd, filetypes = config.filetypes, root_markers = config.root_markers }
      -- Only the command differs from what an installed server would get.
      vim.lsp.config('abi_explorer', { cmd = { ${lua(process.execPath)}, ${lua(server)}, '--stdio' } })
      vim.lsp.enable('abi_explorer')
      vim.cmd.edit(${lua(path.join(os.tmpdir(), 'abi-explorer-lsp-config', 'main.cpp'))})
      vim.wait(60000, function()
        local client = vim.lsp.get_clients({ bufnr = 0, name = 'abi_explorer' })[1]
        result.server = client and client.initialized and client.server_info and client.server_info.name or nil
        return result.server ~= nil
      end, 100)
      io.stdout:write(vim.json.encode(result))
      vim.cmd('qa!')
    `;
    const output = execFileSync(nvim!, ['--headless', '--clean', '-c', `lua ${script}`], {
      encoding: 'utf8',
      timeout: 90_000,
    });
    expect(JSON.parse(output)).toEqual({
      cmd: ['abi-explorer-lsp', '--stdio'],
      filetypes: ['c', 'cpp', 'cuda'],
      root_markers: ['compile_commands.json', 'compile_flags.txt', '.git'],
      server: 'abi-explorer-lsp',
    });
  });
});
