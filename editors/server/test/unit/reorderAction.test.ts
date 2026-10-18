import { describe, expect, it } from 'vitest';
import type { MemberView, RecordView } from '@abi-explorer/shared/protocol';
import { reorderAction } from '../../src/layout/reorderAction.ts';

/** `struct Packet` declared on `lines`, its members at the given lines. */
function packet(lines: number[]): RecordView {
  const field = (label: string, offset: number, size: number, line: number): MemberView => ({
    kind: 'field',
    label,
    type: 'int',
    offsetBits: offset * 8,
    sizeBits: size * 8,
    alignBits: size * 8,
    nameRange: { start: { line, character: 7 }, end: { line, character: 7 + label.length } },
  });
  return {
    id: 1,
    kind: 'struct',
    name: 'Packet',
    sizeBits: 96,
    alignBits: 32,
    paddingBytes: 5,
    nameRange: null,
    extent: null,
    members: [
      field('type', 0, 1, lines[0]!),
      field('length', 4, 4, lines[1]!),
      field('checksum', 8, 2, lines[2]!),
    ],
    bases: [],
  };
}

function apply(lines: string[], action: NonNullable<ReturnType<typeof reorderAction>>): string[] {
  const result = [...lines];
  for (const edit of action.edits) result[edit.range.start.line] = edit.newText;
  return result;
}

describe('reorderAction', () => {
  it('moves member lines into the tightest order and leaves the rest in place', () => {
    const lines = [
      'struct Packet {',
      '  char type;  // the kind',
      '',
      '  int length;',
      '  // why checksums',
      '  short checksum;',
      '  void reset();',
      '};',
    ];
    const action = reorderAction(packet([1, 3, 5]), lines)!;
    expect(action.title).toBe("Reorder Packet's members by alignment (8 B, 4 B less)");
    expect(apply(lines, action)).toEqual([
      'struct Packet {',
      '  int length;',
      '',
      '  short checksum;',
      '  // why checksums',
      '  char type;  // the kind',
      '  void reset();',
      '};',
    ]);
  });

  it('is not offered where moving lines could change the meaning', () => {
    const lines = (...body: string[]) => ['struct Packet {', ...body, '};'];
    const offered = (text: string[], at: number[]) => reorderAction(packet(at), text) !== null;
    expect(offered(lines('  char type;', '  int length;', '  short checksum;'), [1, 2, 3])).toBe(
      true,
    );
    // Two members in one declaration.
    expect(offered(lines('  char type; int length;', '  short checksum;'), [1, 1, 2])).toBe(false);
    expect(offered(lines('  char type, x;', '  int length;', '  short checksum;'), [1, 2, 3])).toBe(
      false,
    );
    // An access specifier or a preprocessor line between members.
    expect(
      offered(lines('  char type;', 'public:', '  int length;', '  short checksum;'), [1, 3, 4]),
    ).toBe(false);
    expect(
      offered(
        lines('  char type;', '#ifdef X', '  int length;', '#endif', '  short checksum;'),
        [1, 3, 5],
      ),
    ).toBe(false);
    // A declaration over two lines.
    expect(
      offered(lines('  char', '    type;', '  int length;', '  short checksum;'), [2, 3, 4]),
    ).toBe(false);
    // Template arguments are not declarators.
    expect(
      offered(
        lines('  char type;', '  std::map<int, int> length;', '  short checksum;'),
        [1, 2, 3],
      ),
    ).toBe(true);
  });
});
