import { describe, expect, it } from 'vitest';
import { byteOwners } from '@abi-explorer/shared/layoutModel';
import { formatOffset, formatSize, formatSizeShort } from '@abi-explorer/shared/format';
import { memberHover, recordHover } from '../../src/layout/hover.ts';
import { layoutHints } from '../../src/layout/inlayHints.ts';
import { svgMap } from '../../src/layout/svgMap.ts';
import { textMap, textMemberTable } from '../../src/layout/textLayout.ts';
import { characterAt } from '../../src/layout/documentRecords.ts';
import type { AnalysisContext, MemberView, RecordView } from '@abi-explorer/shared/protocol';

const at = (line: number, start: number, end: number) => ({
  start: { line, character: start },
  end: { line, character: end },
});

function member(
  label: string,
  offset: number,
  size: number,
  type: string,
  line: number | null = null,
): MemberView {
  return {
    kind: 'field',
    label,
    type,
    offsetBits: offset * 8,
    sizeBits: size * 8,
    alignBits: size * 8,
    nameRange: line === null ? null : at(line, 4, 4 + label.length),
  };
}

/** `struct Packet { char type; int length; short checksum; };` */
const packet: RecordView = {
  id: 1,
  kind: 'struct',
  name: 'Packet',
  sizeBits: 96,
  alignBits: 32,
  paddingBytes: 5,
  nameRange: at(0, 7, 13),
  extent: null,
  members: [
    member('type', 0, 1, 'char', 1),
    member('length', 4, 4, 'int', 2),
    member('checksum', 8, 2, 'short', 3),
  ],
  bases: [],
};

const context: AnalysisContext = {
  triple: 'x86_64-linux-gnu',
  cxxAbi: 'itanium',
  clangVersion: '22',
  commandSource: 'compile_commands.json',
  commandInferred: false,
  errorCount: 0,
  otherErrorCount: 0,
  warning: null,
};

describe('format', () => {
  it('writes sizes and offsets', () => {
    expect([formatSize(8), formatSize(16), formatSize(1), formatSize(3)]).toEqual([
      '1 byte',
      '2 bytes',
      '1 bit',
      '3 bits',
    ]);
    expect([formatSizeShort(32), formatSizeShort(3)]).toEqual(['4 B', '3 bits']);
    expect([formatOffset(64), formatOffset(67)]).toEqual(['8', '8.3']);
  });
});

describe('byte maps', () => {
  it('gives each byte its first member, or null for padding', () => {
    expect(byteOwners(packet)).toEqual([0, null, null, null, 1, 1, 1, 1, 2, 2, null, null]);
  });

  it('draws the text map, and highlights one member', () => {
    expect(textMap(packet)).toBe(
      ['    0 1 2 3 4 5 6 7', ' 0  a · · · b b b b', ' 8  c c · ·'].join('\n'),
    );
    expect(textMap(packet, 1)!.split('\n')[1]).toBe(' 0  ░ · · · █ █ █ █');
  });

  it('draws one SVG cell per byte, hatching padding', () => {
    const svg = svgMap(packet)!;
    expect(svg.match(/<rect /g)).toHaveLength(12 + 1);
    expect(svg.match(/fill="url\(#pad\)"/g)).toHaveLength(5);
  });

  it('fades every member but the highlighted one', () => {
    const svg = svgMap(packet, { highlightedMember: 2 })!;
    expect(svg.match(/rx="3" fill="#\w+" fill-opacity="0.9"/g)).toHaveLength(2);
    expect(svg.match(/rx="3" fill="#\w+" fill-opacity="0.15"/g)).toHaveLength(5);
  });

  it('draws the member table beside the map, with the same swatches', () => {
    const svg = svgMap(packet, { table: true })!;
    // 5 rows (3 members, 2 padding runs), each with a swatch.
    expect(svg.match(/<rect /g)).toHaveLength(12 + 1 + 5);
    expect(svg).toContain('>checksum</text>');
    expect(svg).toContain('font-style="italic">padding</text>');
  });

  it('does not map huge records', () => {
    expect(textMap({ ...packet, sizeBits: 8 * 1024, members: [] })).toBeNull();
  });
});

describe('hovers', () => {
  it('summarises a record as the inlay hint does, with one image for image clients', () => {
    const markdown = recordHover(packet, context, { images: true });
    expect(markdown.split('\n')[0]).toBe('**struct Packet** · 12 B · align 4 · 5 B padding');
    expect(markdown.match(/!\[Packet layout\]/g)).toHaveLength(1);
    expect(markdown).toContain('*x86_64-linux-gnu · compile_commands.json*');
  });

  it('lays a record out as monospace text for text clients', () => {
    const markdown = recordHover(packet, context, { images: false });
    expect(markdown).not.toContain('| Member |');
    expect(markdown).toContain(
      [
        '```text',
        '    0 1 2 3 4 5 6 7',
        ' 0  a · · · b b b b',
        ' 8  c c · ·',
        '',
        ' a  type       0  1 B  char',
        ' ·  padding    1  3 B',
        ' b  length     4  4 B  int',
        ' c  checksum   8  2 B  short',
        ' ·  padding   10  2 B',
        '```',
      ].join('\n'),
    );
  });

  it('marks a member in the text table', () => {
    expect(textMemberTable(packet, 2).split('\n')[3]).toBe('▶c  checksum   8  2 B  short');
  });

  it('embeds the map as an image when the editor shows them', () => {
    expect(recordHover(packet, context, { images: true })).toMatch(
      /!\[Packet layout\]\(data:image\/svg\+xml;base64,/,
    );
  });

  it('says how much padding precedes a member, and notes inferred flags and errors', () => {
    const markdown = memberHover(
      packet,
      1,
      { ...context, commandInferred: true, errorCount: 2 },
      { images: false },
    );
    expect(markdown.split('\n')[0]).toBe('**Packet::length** `int` · offset 4 · 4 B · align 4');
    expect(markdown).toContain('Bytes 4–7, after 3 B of padding.');
    expect(memberHover(packet, 2, context, { images: false })).toContain(
      'Bytes 8–9, followed by 2 B of padding.',
    );
    expect(markdown).toContain('flags borrowed from a neighbouring file · 2 errors in this file');
  });

  it('escapes template arguments', () => {
    expect(recordHover({ ...packet, name: 'Pair<int*>' }, context, { images: false })).toContain(
      '**struct Pair\\<int\\*\\>**',
    );
  });
});

describe('layoutHints', () => {
  it('puts one hint after each record name', () => {
    expect(layoutHints([packet], 'records', () => 20)).toEqual([
      { position: { line: 0, character: 13 }, label: '12 B · align 4 · 5 B padding' },
    ]);
  });

  it('adds member hints at line ends, one per line', () => {
    const twoOnOneLine = {
      ...packet,
      members: [member('x', 0, 4, 'int', 1), member('y', 4, 4, 'int', 1)],
    };
    expect(layoutHints([twoOnOneLine], 'members', (line) => line * 10).slice(1)).toEqual([
      { position: { line: 1, character: 10 }, label: '@0 · 4 B, @4 · 4 B' },
    ]);
  });

  it('hints a template declaration once for all its instantiations', () => {
    expect(layoutHints([packet, { ...packet, id: 2 }], 'records', () => 0)).toHaveLength(1);
  });
});

describe('characterAt', () => {
  it('turns byte columns into UTF-16 offsets', () => {
    expect(characterAt('struct Größe {', 8)).toBe(7);
    expect(characterAt('/* 😀 */ struct S', 12)).toBe(9);
  });
});
