// The Neovim split's colours, checked against the shared layout model and,
// when Neovim is installed (`nvim` on PATH, or NVIM), run for real.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { memberColor, PADDING_COLOR } from '@abi-explorer/shared/layoutModel';

const plugin = path.join(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(plugin, 'lua/abi-explorer/init.lua'), 'utf8');
const nvim = process.env.NVIM_BIN ?? findOnPath('nvim');

describe('Neovim colours', () => {
  it('uses the shared palette', () => {
    const palette = /local PALETTE = \{([^}]*)\}/.exec(source)![1]!.match(/#\w{6}/g);
    expect(palette).toEqual(Array.from({ length: 8 }, (_, index) => memberColor(index)));
    expect(source).toContain(`local PADDING_COLOR = '${PADDING_COLOR}'`);
  });

  it.skipIf(!nvim)('colours map cells and table swatches, fading other members', () => {
    const lines = [
      'struct Packet · 12 B · align 4 · 5 B padding',
      '',
      '      0 1 2 3 4 5 6 7',
      '   0  a · · · b b b b',
      '   8  c c · ·',
      '',
      '   a  type       0  1 B  char',
      '   ·  padding    1  3 B',
      '  ▶b  length     4  4 B  int',
    ];
    const script = `
      vim.opt.runtimepath:prepend(${JSON.stringify(plugin)})
      local buffer = vim.api.nvim_create_buf(false, true)
      local lines = vim.json.decode(${JSON.stringify(JSON.stringify(lines))})
      vim.api.nvim_buf_set_lines(buffer, 0, -1, false, lines)
      require('abi-explorer').colorize(buffer, lines, 1)
      local marks = {}
      for _, mark in ipairs(vim.api.nvim_buf_get_extmarks(buffer, -1, 0, -1, { details = true })) do
        local details = mark[4]
        table.insert(marks, { mark[2], mark[3], details.end_col or vim.NIL, details.hl_group or details.line_hl_group })
      end
      io.stdout:write(vim.json.encode(marks))
    `;
    const output = execFileSync(nvim!, ['--headless', '-u', 'NONE', '-l', '-'], { input: script });
    const marks = JSON.parse(output.toString()) as [number, number, number | null, string][];
    const at = (row: number) => marks.filter(([line]) => line === row);

    // Map row 0: `a` faded (not the member at the cursor), padding grey, `b` bright.
    // Columns are bytes, and `·` takes two.
    const charAt = (row: number, byte: number) =>
      Buffer.from(lines[row]!).subarray(byte).toString().charAt(0);
    expect(at(3).map(([, start, , group]) => [charAt(3, start), group])).toEqual([
      ['a', 'AbiExplorerMemberFaded1'],
      ['·', 'AbiExplorerPadding'],
      ['·', 'AbiExplorerPadding'],
      ['·', 'AbiExplorerPadding'],
      ...Array.from({ length: 4 }, () => ['b', 'AbiExplorerMember2']),
    ]);
    // Table swatches keep their colour; the row at the cursor is marked.
    expect(at(6).map(([, , , group]) => group)).toEqual(['AbiExplorerMember1']);
    expect(
      at(8)
        .map(([, , , group]) => group)
        .sort(),
    ).toEqual(['AbiExplorerMember2', 'AbiExplorerSelected']);
    // Header rows and the summary stay plain.
    expect(at(0)).toEqual([]);
    expect(at(2)).toEqual([]);
  });
});

function findOnPath(name: string): string | undefined {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(directory, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}
