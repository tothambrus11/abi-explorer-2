// The Neovim split's colours, checked against the shared layout model and,
// when Neovim is installed (`nvim` on PATH, or NVIM), run for real.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MEMBER_COLORS } from '@abi-explorer/shared/layoutModel';
import { TARGETS } from '@abi-explorer/shared/targets';
import type { TextColor } from '@abi-explorer/shared/protocol';
import { findOnPath } from './findOnPath.ts';

const plugin = path.join(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(plugin, 'lua/abi-explorer/init.lua'), 'utf8');
const nvim = process.env.NVIM_BIN ?? findOnPath('nvim');

describe('Neovim colours', () => {
  it("uses the web explorer's palettes", () => {
    for (const mode of ['dark', 'light'] as const) {
      const block = new RegExp(`${mode} = \\{([^}]*)\\}`).exec(source)![1]!;
      const colors = Object.fromEntries(
        [...block.matchAll(/\['([\w-]+)'\] = '(#\w{6})'/g)].map(
          ([, slot, hex]) => [slot!, hex!] as const,
        ),
      );
      expect(colors).toEqual(MEMBER_COLORS[mode]);
    }
  });

  it(':AbiTarget completes the targets VS Code offers', () => {
    const targets = /local TARGETS = \{([^}]*)\}/.exec(source)![1]!.match(/'[^']+'/g);
    expect(targets?.map((quoted) => quoted.slice(1, -1))).toEqual(
      TARGETS.map((target) => target.triple),
    );
  });

  it.skipIf(!nvim)("paints the server's runs in the web colours", () => {
    const lines = [' 0  ▌▓██ ╱╱╱╱', ' ■   type   char'];
    const colors: TextColor[] = [
      [0, 4, 7, 'c-1', 'c-2', 'lit'],
      [0, 14, 26, 'baseline', 'grid', null],
      [1, 1, 4, 'c-1', null, null],
    ];
    const script = `
      vim.opt.runtimepath:prepend(${JSON.stringify(plugin)})
      vim.o.background = 'dark'
      local buffer = vim.api.nvim_create_buf(false, true)
      vim.api.nvim_buf_set_lines(buffer, 0, -1, false, vim.json.decode(${JSON.stringify(JSON.stringify(lines))}))
      require('abi-explorer').colorize(buffer, vim.json.decode(${JSON.stringify(JSON.stringify(colors))}), 0)
      local marks = {}
      for _, mark in ipairs(vim.api.nvim_buf_get_extmarks(buffer, -1, 0, -1, { details = true })) do
        local hl = vim.api.nvim_get_hl(0, { name = mark[4].hl_group })
        table.insert(marks, {
          mark[2], mark[3], mark[4].end_col,
          hl.fg and string.format('#%06x', hl.fg) or vim.NIL,
          hl.bg and string.format('#%06x', hl.bg) or vim.NIL,
          hl.underline or false,
        })
      end
      io.stdout:write(vim.json.encode(marks))
    `;
    const output = execFileSync(nvim!, ['--headless', '-u', 'NONE', '-l', '-'], { input: script });
    expect(JSON.parse(output.toString())).toEqual([
      // Two bits, two members: Nocturne's first colour over its second, outlined (underlined).
      [0, 4, 7, '#82aaff', '#f78c6c', true],
      // Padding: the grid's hatching.
      [0, 14, 26, '#383835', '#2c2c2a', false],
      [1, 1, 4, '#82aaff', null, false],
    ]);
  });
});
