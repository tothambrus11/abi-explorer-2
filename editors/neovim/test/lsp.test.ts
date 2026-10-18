// The plugin in real Neovim against the real server and engine: hovers, code
// actions and the `:AbiLayout` split on the fixture project.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  copyFixtureProject,
  hasLocalEngine,
  LOCAL_ENGINE,
  type FixtureProject,
} from '../../server/test/support/fixtureProject.ts';
import { findOnPath } from './findOnPath.ts';

const plugin = path.join(import.meta.dirname, '..');
const server = path.join(import.meta.dirname, '..', '..', 'server', 'src', 'main.ts');
const nvim = process.env.NVIM_BIN ?? findOnPath('nvim');
const hasCompiler = findOnPath('c++') !== undefined;

interface Session {
  hover: string;
  actions: string[];
  split: string[];
  hintCount: number;
  otherTarget: string;
}

describe.skipIf(!nvim || !hasLocalEngine || !hasCompiler)('Neovim with the server', () => {
  let project: FixtureProject;
  let session: Session;

  beforeAll(() => {
    project = copyFixtureProject();
    const lua = (value: unknown) => JSON.stringify(value);
    const script = `
      vim.opt.runtimepath:prepend(${lua(plugin)})
      vim.cmd('filetype on')
      require('abi-explorer').setup({
        lsp = {
          cmd = { ${lua(process.execPath)}, ${lua(server)}, '--stdio' },
          root_dir = ${lua(project.root)},
          init_options = { enginePath = ${lua(LOCAL_ENGINE)} },
        },
      })
      vim.cmd.edit(${lua(project.path('main.cpp'))})
      local uri = vim.uri_from_bufnr(0)
      local function request(method, params)
        local replies = vim.lsp.buf_request_sync(0, method, params, 30000) or {}
        for _, reply in pairs(replies) do
          if reply.result then return reply.result end
        end
      end
      local at_packet = { textDocument = { uri = uri }, position = { line = 8, character = 9 } }
      local hover
      vim.wait(90000, function()
        hover = request('textDocument/hover', at_packet)
        return hover ~= nil
      end, 500)
      local actions = request('textDocument/codeAction', {
        textDocument = { uri = uri },
        range = { start = at_packet.position, ['end'] = at_packet.position },
        context = { diagnostics = {} },
      }) or {}
      local hints = vim.lsp.inlay_hint.get({ bufnr = 0 })

      vim.api.nvim_win_set_cursor(0, { 12, 20 })
      require('abi-explorer').toggle()
      local split = {}
      vim.wait(30000, function()
        for _, window in ipairs(vim.api.nvim_list_wins()) do
          local buffer = vim.api.nvim_win_get_buf(window)
          if vim.bo[buffer].filetype == 'abilayout' then
            split = vim.api.nvim_buf_get_lines(buffer, 0, -1, false)
          end
        end
        return split[1] ~= nil and split[1]:find('Packet') ~= nil
      end, 200)

      require('abi-explorer').set_target('armv7-unknown-linux-gnueabihf')
      local other
      vim.wait(90000, function()
        local answer = request('textDocument/hover', at_packet)
        other = answer and answer.contents.value or nil
        return other ~= nil and other:find('armv7', 1, true) ~= nil
      end, 500)

      local result = {
        hover = hover and hover.contents.value or '',
        hintCount = #hints,
        actions = {},
        split = split,
        otherTarget = other or '',
      }
      for _, action in ipairs(actions) do table.insert(result.actions, action.title) end
      io.stdout:write(vim.json.encode(result))
      for _, client in ipairs(vim.lsp.get_clients()) do client:stop(true) end
    `;
    const output = execFileSync(nvim!, ['--headless', '-u', 'NONE', '-l', '-'], {
      input: script,
      cwd: project.root,
      timeout: 150_000,
    });
    session = JSON.parse(output.toString()) as Session;
  }, 160_000);

  afterAll(() => {
    project.remove();
  });

  it('hovers a record with its map as text', () => {
    expect(session.hover).toContain('**struct Packet** · 40 B · align 8 · 9 B padding');
    expect(session.hover).toContain('```text');
    expect(session.hover).not.toContain('data:image');
  });

  it('shows no inlay hints: the hover carries the summary', () => {
    expect(session.hintCount).toBe(0);
  });

  it('offers the code actions', () => {
    expect(session.actions).toEqual([
      'Reorder members by alignment (40 B → 32 B)',
      'Keep this member order',
      'Pin layout with static_assert',
    ]);
  });

  it('lays out for another target after :AbiTarget', () => {
    expect(session.otherTarget).toContain('**struct Packet** · 24 B · align 4 · 5 B padding');
  });

  it('opens the split on the record at the cursor, marking the member there', () => {
    expect(session.split[0]).toContain('Packet');
    expect(session.split.join('\n')).toMatch(/▶c {2}checksum/);
  });
});
