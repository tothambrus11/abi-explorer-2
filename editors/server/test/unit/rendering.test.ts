import { describe, expect, it } from 'vitest';
import { gridCells, reorderWarning } from '@abi-explorer/shared/layoutModel';
import { formatOffset, formatSize, formatSizeShort } from '@abi-explorer/shared/format';
import { memberHover, recordHover } from '../../src/layout/hover.ts';
import { svgMap } from '../../src/layout/svgMap.ts';
import { textLayout, textMap } from '../../src/layout/textLayout.ts';
import { characterAt } from '../../src/layout/documentRecords.ts';
import type { AnalysisContext, MemberView, RecordView } from '@abi-explorer/shared/protocol';
import { testRecord } from '../../../shared/test/records.ts';

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
    leaves: [],
    group: null,
  };
}

/** `struct Packet { char type; int length; short checksum; };` */
const packet: RecordView = testRecord({
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
});

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
  it('writes sizes and offsets as the web explorer does', () => {
    expect([formatSize(8), formatSize(16), formatSize(1), formatSize(3)]).toEqual([
      '1 byte',
      '2 bytes',
      '1 bit',
      '3 bits',
    ]);
    expect([formatSizeShort(32), formatSizeShort(3)]).toEqual(['4 B', '3 b']);
    expect([formatOffset(64), formatOffset(67)]).toEqual(['8 B', '8 B + 3 b']);
  });
});

const bit = (label: string, offset: number, size: number): MemberView => ({
  ...member(label, 0, 0, 'unsigned'),
  kind: 'bitfield',
  offsetBits: offset,
  sizeBits: size,
  alignBits: 0,
});

/** `struct Flags { unsigned ready : 1, mode : 3, count : 12; char tag; int value; }` */
const flags = testRecord({
  ...packet,
  name: 'Flags',
  sizeBits: 64,
  paddingBytes: 1,
  members: [
    bit('ready', 0, 1),
    bit('mode', 1, 3),
    bit('count', 4, 12),
    member('tag', 2, 1, 'char'),
    member('value', 4, 4, 'int'),
  ],
});

describe('byte maps', () => {
  it('gives each byte its leaves, and each bit of a bit-field byte its own', () => {
    expect(gridCells(packet).map((cell) => cell.leaves)).toEqual([
      [0],
      [],
      [],
      [],
      [1],
      [1],
      [1],
      [1],
      [2],
      [2],
      [],
      [],
    ]);
    expect(gridCells(flags)[0]!.bits).toEqual([0, 1, 1, 1, 2, 2, 2, 2]);
    expect(gridCells(flags)[1]!.bits).toEqual([2, 2, 2, 2, 2, 2, 2, 2]);
  });

  it('draws the text map without letters, two bits a character', () => {
    expect(textLayout(flags).text.split('\n').slice(5, 8)).toEqual([
      '    +0   +1   +2   +3   +4   +5   +6   +7',
      ' 0  ▌▓██ ████ ▓▓▓▓ ╱╱╱╱ ████ ████ ████ ████',
      '',
    ]);
    // A plain hover shades the member at hand.
    expect(textMap(packet, 1)!.split('\n')[1]).toBe(' 0  ░░░░ ╱╱╱╱ ╱╱╱╱ ╱╱╱╱ ████ ████ ████ ████');
  });

  it('colours the text map in the web colours, outlining the member at the caret', () => {
    const { text, colors } = textLayout(flags, 1);
    const row = text.split('\n').indexOf(' 0  ▌▓██ ████ ▓▓▓▓ ╱╱╱╱ ████ ████ ████ ████');
    const runs = colors.filter(([line]) => line === row).map((color) => color.slice(3));
    expect(runs.slice(0, 4)).toEqual([
      ['muted', null, null],
      ['c-1', 'c-2', 'lit'],
      ['c-2', 'c-2', 'lit'],
      ['c-3', 'c-3', null],
    ]);
    expect(runs).toContainEqual(['baseline', 'grid', null]);
  });

  it('lists the members in the web table, opening nothing', () => {
    const lines = textLayout(packet).text.split('\n');
    const table = lines.slice(lines.findIndex((line) => line.includes('FIELD')));
    expect(table).toEqual([
      '     FIELD     TYPE   OFFSET  SIZE  ALIGN  PADDING AFTER',
      ' ■   type      char      0 B   1 B    1 B           +3 B',
      ' ■   length    int       4 B   4 B    4 B',
      ' ■   checksum  short     8 B   2 B    2 B           +2 B',
    ]);
  });

  it('boxes the size tiles', () => {
    expect(textLayout(packet).text.split('\n').slice(0, 4)).toEqual([
      '╭──────────╮ ╭─────────╮ ╭───────────────╮',
      '│ SIZEOF   │ │ ALIGNOF │ │ PADDING       │',
      '│ 12 bytes │ │ 4 bytes │ │ 5 bytes · 42% │',
      '╰──────────╯ ╰─────────╯ ╰───────────────╯',
    ]);
  });

  it('draws the web grid in the SVG: no letters, bits, hatched padding', () => {
    const svg = svgMap(packet)!;
    expect(svg).not.toMatch(/>[a-c]<\/text>/);
    expect(svg.match(/fill="url\(#pad\)"/g)).toHaveLength(5);
    expect(svg).toContain('>+7</text>');
    const bits = svgMap(flags)!;
    // Byte 0: three fields and padding-free, drawn as eight bits.
    expect(bits.match(/ width="3\.\d+"/g)?.length).toBeGreaterThanOrEqual(8);
  });

  it("draws in the light themes' colours for a light editor", () => {
    expect(svgMap(packet)).toContain('fill="#82aaff"');
    const light = svgMap(packet, { mode: 'light' })!;
    expect(light).toContain('fill="#3b6fd4"');
    expect(light).not.toContain('#82aaff');
  });

  it('outlines a member instead of fading the others', () => {
    const svg = svgMap(packet, { highlightedMember: 2 })!;
    expect(svg).not.toContain('fill-opacity');
    expect(svg.match(/stroke="#ffffff" stroke-width="2"/g)).toHaveLength(2);
  });

  it('draws the web table below the map', () => {
    const svg = svgMap(packet, { table: true })!;
    for (const heading of ['FIELD', 'TYPE', 'OFFSET', 'SIZE', 'ALIGN', 'PADDING AFTER']) {
      expect(svg).toContain(`>${heading}</text>`);
    }
    expect(svg).toContain('>checksum</text>');
    expect(svg).toContain('>+3 B</text>');
  });

  it('does not map huge records', () => {
    expect(textMap(testRecord({ ...packet, sizeBits: 8 * 1024, members: [] }))).toBeNull();
  });
});

describe('hovers', () => {
  it('summarises a record as the inlay hint does, with one image for image clients', () => {
    const markdown = recordHover(packet, context, { images: true });
    expect(markdown.split('\n')[0]).toBe('**struct Packet** · 12 B · align 4 · 5 B padding');
    expect(markdown.match(/!\[Packet layout\]/g)).toHaveLength(1);
    expect(markdown).toContain('*x86_64-linux-gnu · compile_commands.json*');
  });

  it('lays a record out as Unicode text for text clients', () => {
    const markdown = recordHover(packet, context, { images: false });
    expect(markdown).toContain('```text\n╭──');
    expect(markdown).toContain(' 0  ████ ╱╱╱╱ ╱╱╱╱ ╱╱╱╱ ▓▓▓▓ ▓▓▓▓ ▓▓▓▓ ▓▓▓▓');
    expect(markdown).toContain(' ■   checksum  short     8 B   2 B    2 B           +2 B');
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
    expect(markdown.split('\n')[0]).toBe('**Packet::length** `int` · offset 4 B · 4 B · align 4');
    expect(markdown).toContain('Bytes 4–7, after 3 B of padding.');
    expect(memberHover(packet, 2, context, { images: false })).toContain(
      'Bytes 8–9, followed by 2 B of padding.',
    );
    expect(markdown).toContain('flags borrowed from a neighbouring file · 2 errors in this file');
    expect(markdown).toContain('may be incomplete · line 3: expected ;');
  });

  it('lists the members of a record too large to map, even for image clients', () => {
    const huge = testRecord({ ...packet, name: 'Huge', sizeBits: 4096 * 8, paddingBytes: 4086 });
    const markdown = recordHover(huge, context, { images: true });
    expect(markdown).not.toContain('data:image');
    expect(markdown).toContain(' ■   type ');
  });

  it('escapes template arguments', () => {
    expect(recordHover({ ...packet, name: 'Pair<int*>' }, context, { images: false })).toContain(
      '**struct Pair\\<int\\*\\>**',
    );
  });
});

describe('reorderWarning', () => {
  it('says how much ordering the members by alignment would save', () => {
    expect(reorderWarning(packet)).toBe(
      'Packet would take 8 B instead of 12 B with its members ordered as length, checksum, type.',
    );
    // A warning on the name, not part of the hover.
    expect(recordHover(packet, context, { images: false })).not.toContain('8 B instead');
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
    expect(reorderWarning(tight)).toBeNull();
  });

  it('leaves unions, bit-fields, flexible arrays and bases alone', () => {
    expect(reorderWarning({ ...packet, kind: 'union' })).toBeNull();
    const bits = { ...member('flag', 0, 0, 'bool'), kind: 'bitfield' as const, sizeBits: 1 };
    expect(reorderWarning({ ...packet, members: [bits, ...packet.members.slice(1)] })).toBeNull();
    const flexible = { ...member('data', 12, 0, 'int[]'), alignBits: 32 };
    expect(reorderWarning({ ...packet, members: [...packet.members, flexible] })).toBeNull();
    const base = { ...member('Base', 0, 1, 'Base'), kind: 'base' as const };
    expect(reorderWarning({ ...packet, members: [base, ...packet.members.slice(1)] })).toBeNull();
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
    expect(reorderWarning(overAligned)).toBeNull();
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
    expect(reorderWarning(packed)).toBe(
      'Packet would take 6 B instead of 8 B with its members ordered as b, a, c.',
    );
  });
});

describe('characterAt', () => {
  it('turns byte columns into UTF-16 offsets', () => {
    expect(characterAt('struct Größe {', 8)).toBe(7);
    expect(characterAt('/* 😀 */ struct S', 12)).toBe(9);
  });
});
