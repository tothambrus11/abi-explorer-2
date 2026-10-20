import { describe, expect, it } from 'vitest';
import type { RecordView } from '@abi-explorer/shared/protocol';
import { testRecord, type TestMember } from '../../../shared/test/records.ts';
import { reorderAction } from '@abi-explorer/shared/reorder';

/** `struct Packet` declared on `lines`, its members at the given lines. */
function packet(lines: number[]): RecordView {
  const field = (label: string, offset: number, size: number, line: number): TestMember => ({
    kind: 'field',
    label,
    type: 'int',
    offsetBits: offset * 8,
    sizeBits: size * 8,
    alignBits: size * 8,
    nameRange: { start: { line, character: 7 }, end: { line, character: 7 + label.length } },
  });
  return testRecord({
    id: 1,
    kind: 'struct',
    name: 'Packet',
    sizeBits: 96,
    alignBits: 32,
    paddingBytes: 5,
    nameRange: null,
    extent: { start: { line: 0, character: 0 }, end: { line: 99, character: 0 } },
    members: [
      field('type', 0, 1, lines[0]!),
      field('length', 4, 4, lines[1]!),
      field('checksum', 8, 2, lines[2]!),
    ],
    bases: [],
  });
}

/** The lines with the action's edits applied (whole lines, last first). */
function apply(lines: string[], action: NonNullable<ReturnType<typeof reorderAction>>): string[] {
  const result = [...lines];
  const edits = [...action.edits].sort((a, b) => b.range.start.line - a.range.start.line);
  for (const { range, newText } of edits) {
    result.splice(range.start.line, range.end.line - range.start.line + 1, ...newText.split('\n'));
  }
  return result;
}

/** `struct Packet` over `lines`, each member found by its name in them. */
function packetIn(lines: string[]): RecordView {
  const record = packet([0, 0, 0]);
  const find = (label: string) => {
    for (const [line, text] of lines.entries()) {
      const match = new RegExp(`\\b${label}\\b`).exec(text.replace(/\/\/.*$/, ''));
      if (match) return { line, character: match.index };
    }
    throw new Error(label);
  };
  return {
    ...record,
    members: record.members.map((member) => {
      const start = find(member.label);
      return {
        ...member,
        nameRange: { start, end: { ...start, character: start.character + member.label.length } },
      };
    }),
  };
}

describe('reorderAction', () => {
  it('moves members into the tightest order with their comments, and leaves the rest in place', () => {
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
    expect(action.title).toBe('Reorder members by alignment (12 B → 8 B)');
    expect(apply(lines, action)).toEqual([
      'struct Packet {',
      '  int length;',
      '',
      '  // why checksums',
      '  short checksum;',
      '  char type;  // the kind',
      '  void reset();',
      '};',
    ]);
  });

  it('takes a doc comment of several lines along, and no comment past a blank line', () => {
    const lines = [
      'struct Packet {',
      '  // Not about type.',
      '',
      '  /**',
      '   * The kind.',
      '   */',
      '  char type;',
      '  int length;',
      '  short checksum;',
      '};',
    ];
    expect(apply(lines, reorderAction(packet([6, 7, 8]), lines)!)).toEqual([
      'struct Packet {',
      '  // Not about type.',
      '',
      '  int length;',
      '  short checksum;',
      '  /**',
      '   * The kind.',
      '   */',
      '  char type;',
      '};',
    ]);
  });

  it('splits a line declaring several members into a line per member', () => {
    const reordered = (...body: string[]) => {
      const lines = ['struct Packet {', ...body, '};'];
      const action = reorderAction(packetIn(lines), lines);
      return action && apply(lines, action).slice(1, -1);
    };
    expect(reordered('  char type, other;', '  int length;', '  short checksum;')).toBeNull();
    expect(reordered('  char type; int length;', '  short checksum;')).toEqual([
      '  int length;',
      '  short checksum;',
      '  char type;',
    ]);
    // One declaration, several declarators: each gets the type, and keeps its own `*` or `&`.
    expect(
      reordered('  // the header', '  char type; int length; short checksum;  // all of it'),
    ).toEqual([
      '  // the header',
      '  // all of it',
      '  int length;',
      '  short checksum;',
      '  char type;',
    ]);
    expect(reordered('  unsigned char type;', '  int length = 4, checksum{2};')).toEqual([
      '  int length = 4;',
      '  int checksum{2};',
      '  unsigned char type;',
    ]);
    expect(reordered('  const char *type, *length;', '  short checksum;')).toEqual([
      '  const char *length;',
      '  short checksum;',
      '  const char *type;',
    ]);
    // A declarator that is not a name after its type.
    expect(reordered('  char type;', '  int (*length)(int), checksum;')).toBeNull();
  });

  it('is not offered where moving lines could change the meaning', () => {
    const lines = (...body: string[]) => ['struct Packet {', ...body, '};'];
    const offered = (text: string[], at: number[]) => reorderAction(packet(at), text) !== null;
    expect(offered(lines('  char type;', '  int length;', '  short checksum;'), [1, 2, 3])).toBe(
      true,
    );
    // Something on a member's line that is not a member: it cannot be split off.
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
    // A type or constant a member may use, or an anonymous struct, between members.
    expect(
      offered(
        lines(
          '  char type;',
          '  struct Inner { double d; };',
          '  int length;',
          '  short checksum;',
        ),
        [1, 3, 4],
      ),
    ).toBe(false);
    expect(
      offered(
        lines('  char type;', '  using T = int;', '  T length;', '  short checksum;'),
        [1, 3, 4],
      ),
    ).toBe(false);
    expect(
      offered(
        lines('  char type;', '  struct {', '    int length;', '  };', '  short checksum;'),
        [1, 3, 5],
      ),
    ).toBe(false);
    // A default initializer that reads another member, which might not be set yet.
    expect(
      offered(lines('  char type;', '  int length = 4;', '  short checksum = length;'), [1, 2, 3]),
    ).toBe(false);
    expect(
      offered(lines('  char type{};', '  int length = 4;', '  short checksum{2};'), [1, 2, 3]),
    ).toBe(true);
    expect(
      offered(
        lines(
          '  char type;',
          '  int length;',
          '  short checksum;',
          '  Packet() : type(1), checksum(type) {}',
        ),
        [1, 2, 3],
      ),
    ).toBe(false);
    expect(
      offered(
        lines(
          '  char type;',
          '  int length;',
          '  short checksum;',
          '  Packet() : type(1), checksum(2) {}',
        ),
        [1, 2, 3],
      ),
    ).toBe(true);
    // Template arguments are not declarators.
    expect(
      offered(
        lines('  char type;', '  std::map<int, int> length;', '  short checksum;'),
        [1, 2, 3],
      ),
    ).toBe(true);
  });
});
