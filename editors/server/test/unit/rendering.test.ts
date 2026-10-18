import { describe, expect, it } from 'vitest';
import { byteOwners, reorderNote } from '@abi-explorer/shared/layoutModel';
import { formatOffset, formatSize, formatSizeShort } from '@abi-explorer/shared/format';
import { memberHover, recordHover } from '../../src/layout/hover.ts';
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
  firstError: null,
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
    expect([formatSizeShort(32), formatSizeShort(3), formatSizeShort(1)]).toEqual([
      '4 B',
      '3 bits',
      '1 bit',
    ]);
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

  it('draws a highlighted union member over all of its bytes', () => {
    const union: RecordView = {
      ...packet,
      kind: 'union',
      sizeBits: 64,
      members: [member('i', 0, 4, 'int'), member('d', 0, 8, 'double')],
    };
    expect(textMap(union)!.split('\n')[1]).toBe('0  a a a a b b b b');
    expect(textMap(union, 1)!.split('\n')[1]).toBe('0  █ █ █ █ █ █ █ █');
    expect(textMap(union, 1, { shade: false })!.split('\n')[1]).toBe('0  b b b b b b b b');
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
      { ...context, commandInferred: true, errorCount: 2, firstError: 'line 3: expected ;' },
      { images: false },
    );
    expect(markdown.split('\n')[0]).toBe('**Packet::length** `int` · offset 4 · 4 B · align 4');
    expect(markdown).toContain('Bytes 4–7, after 3 B of padding.');
    expect(memberHover(packet, 2, context, { images: false })).toContain(
      'Bytes 8–9, followed by 2 B of padding.',
    );
    expect(markdown).toContain('flags borrowed from a neighbouring file · 2 errors in this file');
    expect(markdown).toContain('may be incomplete · line 3: expected ;');
  });

  it('lists the members of a record too large to map, even for image clients', () => {
    const huge = { ...packet, name: 'Huge', sizeBits: 4096 * 8, paddingBytes: 4086 };
    const markdown = recordHover(huge, context, { images: true });
    expect(markdown).not.toContain('data:image');
    expect(markdown).toContain('```text\n a  type');
  });

  it('escapes template arguments', () => {
    expect(recordHover({ ...packet, name: 'Pair<int*>' }, context, { images: false })).toContain(
      '**struct Pair\\<int\\*\\>**',
    );
  });
});

describe('reorderNote', () => {
  it('says how much ordering the members by alignment would save', () => {
    expect(reorderNote(packet)).toBe(
      'Ordered as length, checksum, type, the members would fit in 8 B, 4 B less.',
    );
    expect(recordHover(packet, context, { images: false })).toContain('would fit in 8 B');
  });

  it('says nothing when the order is already the tightest', () => {
    const tight = {
      ...packet,
      sizeBits: 64,
      paddingBytes: 1,
      members: [
        member('length', 0, 4, 'int'),
        member('checksum', 4, 2, 'short'),
        member('type', 6, 1, 'char'),
      ],
    };
    expect(reorderNote(tight)).toBeNull();
  });

  it('leaves unions, bit-fields, flexible arrays and bases alone', () => {
    expect(reorderNote({ ...packet, kind: 'union' })).toBeNull();
    const bits = { ...member('flag', 0, 0, 'bool'), kind: 'bitfield' as const, sizeBits: 1 };
    expect(reorderNote({ ...packet, members: [bits, ...packet.members.slice(1)] })).toBeNull();
    const flexible = { ...member('data', 12, 0, 'int[]'), alignBits: 32 };
    expect(reorderNote({ ...packet, members: [...packet.members, flexible] })).toBeNull();
    const base = { ...member('Base', 0, 1, 'Base'), kind: 'base' as const };
    expect(reorderNote({ ...packet, members: [base, ...packet.members.slice(1)] })).toBeNull();
  });

  it('says nothing where its rules do not reproduce the layout, as with alignas on a member', () => {
    // { alignas(8) char x; alignas(8) char y; }: the members report char's alignment.
    const overAligned: RecordView = {
      ...packet,
      sizeBits: 128,
      alignBits: 64,
      paddingBytes: 14,
      members: [member('x', 0, 1, 'char'), member('y', 8, 1, 'char')],
    };
    expect(reorderNote(overAligned)).toBeNull();
  });

  it('aligns members no further than a packed record allows', () => {
    // #pragma pack(2): { char a; int b; char c; } is 8 B, align 2; reordered, 6 B.
    const packed: RecordView = {
      ...packet,
      sizeBits: 64,
      alignBits: 16,
      paddingBytes: 2,
      members: [member('a', 0, 1, 'char'), member('b', 2, 4, 'int'), member('c', 6, 1, 'char')],
    };
    expect(reorderNote(packed)).toBe('Ordered as b, a, c, the members would fit in 6 B, 2 B less.');
  });
});

describe('characterAt', () => {
  it('turns byte columns into UTF-16 offsets', () => {
    expect(characterAt('struct Größe {', 8)).toBe(7);
    expect(characterAt('/* 😀 */ struct S', 12)).toBe(9);
  });
});
